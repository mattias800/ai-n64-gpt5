import { readFileAsArrayBuffer, readFileAsText, fetchSampleConfig, normalizeConfig } from './ui';
import type { Sm64TitleConfig } from './types';
import { runSm64TitleFrames } from './sm64_title_runner';

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
      const cfg: Sm64TitleConfig = normalizeConfig(rawCfg);
      const frames = Math.max(1, Math.min(8, Number(framesEl.value || '2') | 0));
      log(logEl, `Running frames=${frames} (video ${cfg.video.width}x${cfg.video.height}, origin=0x${cfg.video.origin.toString(16)})...`);

      // Run
      const { frameImages, crc32Hex } = await runSm64TitleFrames(romBytes, cfg, frames);

      // Render and CRCs
      if (canvas.width !== cfg.video.width || canvas.height !== cfg.video.height) {
        canvas.width = cfg.video.width; canvas.height = cfg.video.height;
      }
      for (let i = 0; i < frameImages.length; i++) {
        ctx.putImageData(frameImages[i]!, 0, 0);
        const crc = crc32Hex[i]!;
        const expected = cfg.expectedCrc32?.[i];
        const match = expected ? (crc.toLowerCase() === expected.toLowerCase().replace(/^0x/, '')) : undefined;
        if (match === undefined) log(logEl, `frame ${i}: crc=${crc}`);
        else log(logEl, `frame ${i}: crc=${crc} ${match ? 'PASS' : `FAIL (expected ${expected})`}`);
      }
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
