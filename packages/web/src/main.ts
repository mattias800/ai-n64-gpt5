import { readFileAsArrayBuffer, readFileAsText, fetchSampleConfig, normalizeConfig } from './ui';
import type { Sm64TitleConfig } from './types';
import { runSm64TitleFrames } from './sm64_title_runner';
import { runF3dexFromConfig } from './f3dex_runner';

const qs = <T extends HTMLElement>(sel: string): T => document.querySelector(sel)! as T;

const log = (el: HTMLElement, msg: string): void => { el.textContent = `${el.textContent ?? ''}${msg}\n`; el.scrollTop = el.scrollHeight; };
const clearLog = (el: HTMLElement): void => { el.textContent = ''; };

const main = (): void => {
  const romFileEl = qs<HTMLInputElement>('#romFile');
  const cfgFileEl = qs<HTMLInputElement>('#cfgFile');
  const framesEl = qs<HTMLInputElement>('#frames');
  const runBtn = qs<HTMLButtonElement>('#runBtn');
  const resetBtn = qs<HTMLButtonElement>('#resetBtn');
  const canvas = qs<HTMLCanvasElement>('#fb');
  const ctx = canvas.getContext('2d')!;
  const logEl = qs<HTMLDivElement>('#log');

  const setUIEnabled = (en: boolean): void => {
    romFileEl.disabled = !en; cfgFileEl.disabled = !en; framesEl.disabled = !en; runBtn.disabled = !en; resetBtn.disabled = !en;
  };

  // Auto-run when a ROM file is selected
  try {
    romFileEl.addEventListener('change', () => {
      if (romFileEl.files && romFileEl.files.length > 0) {
        // Small defer to allow UI to settle
        setTimeout(() => { if (!runBtn.disabled) runBtn.click(); }, 50);
      }
    });
  } catch {}

  runBtn.onclick = async () => {
    try {
      setUIEnabled(false);
      clearLog(logEl);
      // ROM
      const romFile = romFileEl.files?.[0];
      if (!romFile) { log(logEl, 'Please choose a ROM file (.z64/.n64/.v64).'); setUIEnabled(true); return; }
      log(logEl, `Reading ROM: ${romFile.name} (${romFile.size} bytes)`);
      const romBytes = await readFileAsArrayBuffer(romFile);

      // Config
      let rawCfg: unknown;
      const cfgFile = cfgFileEl.files?.[0];
      if (cfgFile) {
        log(logEl, `Reading config: ${cfgFile.name}`);
        const text = await readFileAsText(cfgFile);
        rawCfg = JSON.parse(text);
      } else {
        log(logEl, 'No config chosen; using sample config.');
        rawCfg = await fetchSampleConfig();
      }
      // Decide mode based on config shape
      const looksF3dex = !!(rawCfg as any)?.f3dex || Array.isArray((rawCfg as any)?.frames);
      const framesReq = Math.max(1, Math.min(8, Number(framesEl.value || '2') | 0));

      // Attempt ROM boot first when no explicit config chosen (foundation for accuracy)
      let frameImages: ImageData[] | null = null;
      let crc32Hex: string[] = [];
      if (!cfgFile) {
        log(logEl, 'No config file provided: attempting ROM boot (HLE) for a short run...');
        try {
          const { runRomBootFrames } = await import('./rom_boot_runner.js');
          const cyclesEl = document.querySelector('#cycles') as HTMLInputElement | null;
          const viEl = document.querySelector('#viInterval') as HTMLInputElement | null;
          const vecEl = document.querySelector('#vectorAuto') as HTMLInputElement | null;
          const fastEl = document.querySelector('#fastbootHle') as HTMLInputElement | null;
          const jumpEl = document.querySelector('#jumpHeader') as HTMLInputElement | null;
          const viInitEl = document.querySelector('#viInit') as HTMLInputElement | null;
          const skipEl = document.querySelector('#skipAt') as HTMLInputElement | null;
          const cycles = Math.max(1, Number(cyclesEl?.value || '15000000') | 0);
          const viInterval = Math.max(1000, Number(viEl?.value || '10000') | 0);
          const vectorAuto = !!vecEl?.checked;
          const fastboot = !!fastEl?.checked;
          const jumpHeader = !!jumpEl?.checked;
          const viInit = !!viInitEl?.checked;
          const skipAt = String(skipEl?.value || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => (s.startsWith('0x')||s.startsWith('0X')) ? parseInt(s,16)>>>0 : (Number(s)>>>0))
            .filter((n) => Number.isFinite(n));
          const res = await runRomBootFrames(romBytes, { cycles, viInterval, vectorAutoReturn: vectorAuto, fastboot, skipAt, jumpHeader, viInit });
          if (res.frameImages.length > 0) {
            frameImages = res.frameImages;
            crc32Hex = res.crc32Hex;
            log(logEl, `ROM boot produced ${frameImages.length} frame(s).`);
          } else {
            log(logEl, 'ROM boot produced no frames; falling back to config-driven run.');
          }
        } catch (e) {
          log(logEl, `ROM boot attempt failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (!frameImages) {
        log(logEl, `Running ${looksF3dex ? 'f3dex-run-table' : 'sm64-rom-title'} frames=${framesReq}...`);
        const out = looksF3dex
          ? await runF3dexFromConfig(romBytes, rawCfg)
          : await runSm64TitleFrames(romBytes, normalizeConfig(rawCfg), framesReq);
        frameImages = out.frameImages;
        crc32Hex = out.crc32Hex;
      }

      // Render and CRCs
      const targetW = frameImages[0]?.width ?? canvas.width;
      const targetH = frameImages[0]?.height ?? canvas.height;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW; canvas.height = targetH;
      }
      for (let i = 0; i < frameImages.length; i++) {
        ctx.putImageData(frameImages[i]!, 0, 0);
        const crc = crc32Hex[i]!;
        const expected = looksF3dex ? undefined : (normalizeConfig(rawCfg as any).expectedCrc32?.[i]);
        const match = expected ? (crc.toLowerCase() === expected.toLowerCase().replace(/^0x/, '')) : undefined;
        if (match === undefined) log(logEl, `frame ${i}: crc=${crc}`);
        else log(logEl, `frame ${i}: crc=${crc} ${match ? 'PASS' : `FAIL (expected ${expected})`}`);
      }

      // Baseline CRC automation (no manual testing needed)
      try {
        const keyBase = `crcBaseline:${canvas.width}x${canvas.height}`;
        const keyLast = `crcLast:${canvas.width}x${canvas.height}`;
        const firstCrc = String(crc32Hex[0] || '');
        const prevBaseline = localStorage.getItem(keyBase);
        const prevLast = localStorage.getItem(keyLast);
        // Save current as last-run CRCs
        localStorage.setItem(keyLast, JSON.stringify(crc32Hex));
        if (!prevBaseline && firstCrc) {
          // First time: save baseline automatically (likely current gradient); future runs will be diffed
          localStorage.setItem(keyBase, firstCrc);
          log(logEl, `[baseline] saved baseline for ${canvas.width}x${canvas.height}: ${firstCrc}`);
        } else if (prevBaseline) {
          const same = firstCrc.toLowerCase() === prevBaseline.toLowerCase();
          if (same) {
            log(logEl, `[baseline] unchanged vs baseline (${canvas.width}x${canvas.height}): ${firstCrc}`);
          } else {
            log(logEl, `[baseline] CHANGED vs baseline (${canvas.width}x${canvas.height}): was ${prevBaseline}, now ${firstCrc}`);
          }
          // Optional: also diff against last run to surface any changes between runs
          if (prevLast) {
            try {
              const lastArr: string[] = JSON.parse(prevLast);
              const lastFirst = String(lastArr?.[0] || '');
              if (lastFirst && lastFirst.toLowerCase() !== firstCrc.toLowerCase()) {
                log(logEl, `[delta] first-frame CRC changed vs last run: ${lastFirst} -> ${firstCrc}`);
              }
            } catch {}
          }
        }
      } catch {}

      // Attempt auto-run if no frames or baseline unchanged
      try {
        const firstCrcNow = String(crc32Hex[0] || '');
        const keyBase = `crcBaseline:${canvas.width}x${canvas.height}`;
        const prevBaselineAgain = localStorage.getItem(keyBase);
        const unchanged = !!(prevBaselineAgain && firstCrcNow && firstCrcNow.toLowerCase() === prevBaselineAgain.toLowerCase());
        if (frameImages.length === 0 || unchanged) {
          log(logEl, `[auto] initiating auto-run attempts to get game-rendered frames...`);
          const { runRomBootFrames } = await import('./rom_boot_runner.js');
          // Escalate cycles across attempts
          const attempts = [25_000_000, 50_000_000, 100_000_000, 200_000_000];
          let gotChange = false;
          for (let i = 0; i < attempts.length; i++) {
            const cyc = attempts[i]!;
            log(logEl, `[auto] attempt ${i+1}/${attempts.length}, cycles=${cyc}...`);
            const res = await runRomBootFrames(romBytes, {
              cycles: cyc,
              viInterval: 10000,
              vectorAutoReturn: true,
              fastboot: true,
              skipAt: [0x8005c800 >>> 0],
              jumpHeader: true,
              viInit: true,
            });
            // Re-render current best frames
            if (res.frameImages.length > 0) {
              frameImages = res.frameImages;
              crc32Hex = res.crc32Hex;
              const targetW2 = frameImages[0]?.width ?? canvas.width;
              const targetH2 = frameImages[0]?.height ?? canvas.height;
              if (canvas.width !== targetW2 || canvas.height !== targetH2) { canvas.width = targetW2; canvas.height = targetH2; }
              for (let k = 0; k < frameImages.length; k++) ctx.putImageData(frameImages[k]!, 0, 0);
            }
            const crcNow = String(crc32Hex[0] || '');
            const prevBase = localStorage.getItem(keyBase);
            if (prevBase && crcNow && crcNow.toLowerCase() !== prevBase.toLowerCase()) {
              log(logEl, `[auto] success: first-frame CRC changed vs baseline: ${prevBase} -> ${crcNow}`);
              gotChange = true; break;
            } else if (!prevBase && crcNow) {
              // Establish baseline if none
              localStorage.setItem(keyBase, crcNow);
              log(logEl, `[auto] set new baseline (no prior baseline present): ${crcNow}`);
              // Not a change vs baseline, but we’ve saved one; continue attempts
            }
          }
          if (!gotChange) log(logEl, `[auto] completed all attempts; no CRC change vs baseline yet.`);
        }
      } catch {}

      log(logEl, 'Done.');
    } catch (e: unknown) {
      log(logEl, `Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUIEnabled(true);
    }
  };

  resetBtn.onclick = () => {
    clearLog(logEl);
    const w = canvas.width, h = canvas.height;
    const blank = ctx.createImageData(w, h);
    ctx.putImageData(blank, 0, 0);
  };
};

main();
