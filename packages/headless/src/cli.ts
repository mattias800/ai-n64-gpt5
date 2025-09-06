#!/usr/bin/env node
import { Bus, RDRAM, CPU, System, runSM64TitleDemoDP, runSM64TitleDemoSPDP, writeSM64TitleTasksToRDRAM, scheduleSPTitleTasksFromRDRAMAndRun, writeRSPTitleDLsToRDRAM, scheduleRSPDLFramesAndRun, writeUcAsRspdl, f3dToUc, scheduleRSPDLFromTableAndRun, scheduleF3DEXFromTableAndRun, translateF3DEXAndExecNow, hlePiLoadSegments, decompressMIO0, viScanout, PI_BASE, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, PI_STATUS_IO_BUSY, hlePifControllerStatus, hlePifReadControllerState, getHle3DStats, resetHle3DStats } from '@n64/core';
import { crc32 } from './lib.js';

function parseNum(val: string | undefined, def: number): number {
  if (val === undefined) return def;
  const s = val.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16) >>> 0;
  const n = Number(s);
  return Number.isFinite(n) ? (n >>> 0) : def;
}


async function maybeWriteImage(out: Uint8Array, w: number, h: number, filePath?: string) {
  if (!filePath) return;
  const [{ existsSync, mkdirSync, createWriteStream, writeFileSync }, pathMod] = await Promise.all([
    import('node:fs').then(m => ({
      existsSync: (m as any).existsSync as (p: string) => boolean,
      mkdirSync: (m as any).mkdirSync as (p: string, opts?: any) => void,
      createWriteStream: (m as any).createWriteStream as (p: string) => any,
      writeFileSync: (m as any).writeFileSync as (p: string, data: any) => void,
    })),
    import('node:path') as Promise<typeof import('node:path')>,
  ]);
  const dir = pathMod.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) {
    const mod: any = await import('pngjs');
    const PNG = mod.PNG || mod.default?.PNG || mod.default || mod;
    const png = new PNG({ width: w, height: h });
    // out is RGBA8888 already
    (png as any).data = Buffer.from(out);
    await new Promise<void>((resolve, reject) => {
      png.pack().pipe(createWriteStream(filePath)).on('finish', resolve).on('error', reject);
    });
    // eslint-disable-next-line no-console
    console.log(`[snapshot] wrote ${filePath}`);
  } else {
    // Fallback to PPM (P6)
    const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
    const data = Buffer.alloc(w * h * 3);
    for (let i = 0, di = 0; i < out.length; i += 4) {
      data[di++] = out[i]!;
      data[di++] = out[i + 1]!;
      data[di++] = out[i + 2]!;
    }
    writeFileSync(filePath, Buffer.concat([header, data]));
    // eslint-disable-next-line no-console
    console.log(`[snapshot] wrote ${filePath}`);
  }
}

function printUsage() {
  console.log(`Usage:
  n64-headless sm64-demo [--frames N] [--width W] [--height H] [--origin 0xADDR] [--spacing N] [--start CYC] [--interval CYC] [--mode dp|spdp|sptask|rspdl] [--sp-offset CYC] [--snapshot path.ppm]
  n64-headless rspdl-ci8-ring [--frames N] [--width W] [--height H] [--origin 0xADDR] [--start CYC] [--interval CYC] [--sp-offset CYC] [--snapshot path.png]
  n64-headless uc-run <config.json> [--snapshot path.png]
  n64-headless f3d-run <config.json> [--snapshot path.png]
  n64-headless f3d-run-table <config.json> [--snapshot path.png]
  n64-headless f3dex-run-table <config.json> [--snapshot path.png]
   n64-headless f3dex-rom-run <config.json> [--snapshot path.png]
  n64-headless sm64-rom-title <config.json> [--snapshot path.png]
   n64-headless rom-boot-run <rom.z64> [--cycles N] [--vi-interval CYC] [--width W] [--height H] [--snapshot path.png]
     [--discover] [--boot path.json] [--bridge] [--bridge-any] [--bridge-log] [--ipl-hle] [--jump-header]
     [--vi-init] [--vi-vblank] [--fastboot-hle] [--skip-reserved-at 0xADDR[,0xADDR2,...]] [--vector-autoreturn]
     [--sram-file path.bin] [--sram-size BYTES] [--sram-save-on-exit]
     [--flash-file path.bin] [--flash-size BYTES] [--flash-save-on-exit]
     [--timing-profile dev|fast|realistic] [--trace-timing [path.csv]]
  n64-headless rom-scan-mio0 <rom.z64> [--out path.json] [--extract-dir dir] [--limit N] [--min-size BYTES]
  n64-headless curate-images <dir> [--top N] [--out path.json] [--copy-top dir] [--recursive]
  n64-headless trace-compare --trace path/to/cen64.log --rom /abs/SM64.z64 [--max-steps N] [--skip N] [--report out.json]
    [--compare pc|full] [--regs-shift N] [--mmio-ring N] [--mmio-recent N]
 
 Examples:
   n64-headless sm64-demo --frames 1
   n64-headless sm64-demo --frames 2 --snapshot tmp/sm64_2f.ppm
   n64-headless f3dex-rom-run tmp/rom_demo.json --snapshot tmp/rom.png
   n64-headless rom-boot-run mario64.z64 --cycles 5000000 --vi-interval 10000 --width 320 --height 240 --snapshot tmp/boot/boot.png --sram-file saves/mario64.sram --sram-save-on-exit
   n64-headless rom-scan-mio0 mario64.z64 --out tmp/mio0_scan.json --extract-dir tmp/mio0
 `);
}

async function runRomScanMio0(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('rom-scan-mio0 requires a ROM file path'); process.exit(1); }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const outPath = opts['out'];
  const extractDir = opts['extract-dir'] || opts['extractDir'];
  const limit = parseNum(opts['limit'], 0);
  const minSize = parseNum(opts['min-size'] || opts['minSize'], 0);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const rom = fs.readFileSync(file);
  const romU8 = new Uint8Array(rom.buffer, rom.byteOffset, rom.length);

  type Entry = { off: number; size: number };
  const entries: Entry[] = [];
  let count = 0;
  for (let i = 0; i + 4 <= romU8.length; i++) {
    if (romU8[i] === 0x4d /*'M'*/ && romU8[i+1] === 0x49 /*'I'*/ && romU8[i+2] === 0x4f /*'O'*/ && romU8[i+3] === 0x30 /*'0'*/) {
      try {
        const data = decompressMIO0(romU8, i);
        const size = data.length >>> 0;
        if (size >= minSize) {
          entries.push({ off: i >>> 0, size });
          if (extractDir) {
            const dir = path.resolve(extractDir);
            if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
            const outBin = path.join(dir, `mio0_${i.toString(16)}_decomp.bin`);
            (fs as any).writeFileSync(outBin, Buffer.from(data));
          }
          count++;
          if (limit > 0 && count >= limit) break;
        }
      } catch {
        // not a valid MIO0 block; skip
      }
    }
  }
  // sort by size descending
  entries.sort((a,b) => b.size - a.size);
  const summary = {
    rom: file,
    count: entries.length,
    entries: entries.map(e => ({ off: `0x${e.off.toString(16)}`, size: e.size }))
  };
  if (outPath) {
    const dir = path.dirname(outPath);
    if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
    (fs as any).writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`[mio0] wrote ${outPath} (${entries.length} entries)`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function runCurateImages(args: string[]) {
  const root = args.find(a => !a.startsWith('--'));
  if (!root) { console.error('curate-images requires a directory path'); process.exit(1); }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a.startsWith('--')) { const key = a.slice(2); const next = (i + 1 < args.length) ? args[i + 1] : undefined; const val = (next && !next.startsWith('--')) ? args[++i]! : '1'; opts[key] = val; } }
  const top = parseNum(opts['top'], 16);
  const outPath = opts['out'] ? String(opts['out']) : undefined;
  const copyTop = opts['copy-top'] ? String(opts['copy-top']) : undefined;
  const recursive = Object.prototype.hasOwnProperty.call(opts, 'recursive');

  const fs = await import('node:fs');
  const path = await import('node:path');
  const mod: any = await import('pngjs');
  const PNG = mod.PNG || mod.default?.PNG || mod.default || mod;
  const PNGSync = (mod as any).PNG?.sync || (mod as any).default?.PNG?.sync || (mod as any).sync;

  const listPngs = (dir: string): string[] => {
    const out: string[] = [];
    const entries = (fs as any).readdirSync(dir, { withFileTypes: true }) as any[];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory && e.isDirectory()) { if (recursive) out.push(...listPngs(p)); }
      else if (String(e.name).toLowerCase().endsWith('.png')) out.push(p);
    }
    return out;
  };

  const files = listPngs(root);
  if (files.length === 0) { console.error(`[curate] no PNG files in ${root}`); process.exit(1); }

  type Entry = { file: string; score: number; stddev: number; grad: number; hash64: string };
  const results: Entry[] = [];

  function toGray(r: number, g: number, b: number): number { return Math.round(0.299 * r + 0.587 * g + 0.114 * b) >>> 0; }
  function aHash64(w: number, h: number, rgba: Uint8Array): string {
    const gx = 8, gy = 8;
    const samples: number[] = [];
    let sum = 0;
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const cx = Math.min(w - 1, Math.max(0, Math.floor(((i + 0.5) * w) / gx)));
        const cy = Math.min(h - 1, Math.max(0, Math.floor(((j + 0.5) * h) / gy)));
        const idx = (cy * w + cx) * 4;
        const g = toGray(rgba[idx]!, rgba[idx+1]!, rgba[idx+2]!);
        samples.push(g);
        sum += g;
      }
    }
    const avg = sum / (gx * gy);
    let bits = '';
    for (const v of samples) bits += (v >= avg ? '1' : '0');
    // Convert 64-bit binary string to hex (16 hex digits)
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      const nibble = parseInt(bits.slice(i, i + 4), 2) & 0xF;
      hex += nibble.toString(16);
    }
    return hex;
  }

  for (const f of files) {
    try {
      const buf = (fs as any).readFileSync(f);
      const png = PNGSync?.read ? PNGSync.read(buf) : null;
      const w = png?.width >>> 0;
      const h = png?.height >>> 0;
      const data: Uint8Array = png?.data;
      if (!data || !w || !h) continue;
      const N = w * h;
      // Mean and stddev of grayscale
      let sum = 0;
      const gray = new Uint8Array(N);
      for (let i = 0, pi = 0; i < N; i++, pi += 4) {
        const g = toGray(data[pi]!, data[pi+1]!, data[pi+2]!);
        gray[i] = g;
        sum += g;
      }
      const mean = sum / N;
      let varSum = 0;
      for (let i = 0; i < N; i++) { const d = gray[i]! - mean; varSum += d * d; }
      const stddev = Math.sqrt(varSum / N);
      // Gradient magnitude (simple abs diffs)
      let gsum = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const v = gray[i]!;
          const vx = x > 0 ? Math.abs(v - gray[i - 1]!) : 0;
          const vy = y > 0 ? Math.abs(v - gray[i - w]!) : 0;
          gsum += vx + vy;
        }
      }
      const gradAvg = gsum / (N * 2);
      const score = stddev + 0.5 * gradAvg;
      const hash64 = aHash64(w, h, data);
      results.push({ file: f, score, stddev, grad: gradAvg, hash64 });
    } catch {}
  }

  results.sort((a,b) => b.score - a.score);
  const topN = results.slice(0, Math.min(top, results.length));

  if (outPath) {
    try {
      await (await import('node:fs')).promises.mkdir((await import('node:path')).dirname(outPath), { recursive: true });
      await (await import('node:fs')).promises.writeFile(outPath, JSON.stringify({ dir: root, total: results.length, top: topN }, null, 2), 'utf8');
      console.log(`[curate] wrote ${outPath}`);
    } catch (e) {
      console.error('[curate] failed to write summary:', e);
    }
  }
  if (copyTop) {
    try {
      (fs as any).mkdirSync(copyTop, { recursive: true });
      for (const e of topN) {
        const base = path.basename(e.file);
        (fs as any).copyFileSync(e.file, path.join(copyTop, base));
      }
      console.log(`[curate] copied ${topN.length} files to ${copyTop}`);
    } catch (e) {
      console.error('[curate] failed to copy top files:', e);
    }
  }

  console.log(JSON.stringify({ command: 'curate-images', dir: root, total: results.length, top: topN }, null, 2));
}

async function runRomProbeMio0(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('rom-probe-mio0 requires a ROM file path'); process.exit(1); }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const off = parseNum(opts['off'] || opts['offset'], 0);
  if (!off) { console.error('--off is required'); process.exit(1); }
  const width = parseNum(opts['w'] || opts['width'], 192);
  const height = parseNum(opts['h'] || opts['height'], 120);
  const x = parseNum(opts['x'], 32);
  const y = parseNum(opts['y'], 20);
  const tileW = parseNum(opts['tile-w'] || opts['tileW'], 64);
  const tileH = parseNum(opts['tile-h'] || opts['tileH'], 32);
  const format = String(opts['format'] || 'ci8').toLowerCase();
  const palIdx = parseNum(opts['pal'] || opts['palette'], 0) & 0xF;
  const tlutOff = parseNum(opts['tlut-off'] || opts['tlutOff'], 0);
  const pixOff = parseNum(opts['pix-off'] || opts['pixOff'], 0x200);
  const outDir = String(opts['outdir'] || opts['out-dir'] || 'tmp/probe');
  const sweep = Object.prototype.hasOwnProperty.call(opts, 'sweep');
  const stitch = Object.prototype.hasOwnProperty.call(opts, 'stitch');
  const stitchCount = parseNum(opts['stitch-count'] || opts['stitchCount'], 4);
  const stitchGap = parseNum(opts['stitch-gap'] || opts['stitchGap'], 2);
  const stitchStepBytes = parseNum(opts['stitch-step'] || opts['stitchStep'], 0);
  const stitchRows = parseNum(opts['stitch-rows'] || opts['stitchRows'], 1);
  const stitchRowGap = parseNum(opts['stitch-row-gap'] || opts['stitchRowGap'], 2);
  const stitchStepRowBytes = parseNum(opts['stitch-step-row'] || opts['stitchStepRow'], 0);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const romBuf = fs.readFileSync(file);
  const romU8 = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);

  let decomp: Uint8Array;
  try { decomp = decompressMIO0(romU8, off); } catch (e) { console.error('Failed to decompress MIO0 at off=0x' + off.toString(16), e); process.exit(1); return; }

  // Prepare system
  const rdram = new RDRAM(8 * 1024 * 1024);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  // Configure VI so we can scanout
  const fbOrigin = 0xF000 >>> 0;
  (bus.vi as any).writeU32(0x14, fbOrigin >>> 0);
  (bus.vi as any).writeU32(0x18, width >>> 0);

  // Choose a DRAM base to copy decompressed blob
  const base = 0x300000 >>> 0;
  for (let i = 0; i < decomp.length; i++) bus.storeU8((base + i) >>> 0, decomp[i]!);
  // Scratch area for any expanded CI4 -> CI8 buffers
  const scratchBase = (((base + decomp.length + 0x1000) >>> 0) & ~0xFFF) >>> 0;
  let nextScratch = scratchBase >>> 0;

  // Helper to execute one hypothesis and write snapshot using the simpler RSPDL path
  async function execOne(tag: string, fmt: 'CI8'|'CI4', tlutRel: number, pixRel: number, W: number, H: number, pal?: number) {
    const tlutAddr = (base + (tlutRel >>> 0)) >>> 0;
    let pixAddrUse = (base + (pixRel >>> 0)) >>> 0;

    // If CI4, expand to CI8 with palette bank offset pal*16
    if (fmt === 'CI4') {
      const total = (W >>> 0) * (H >>> 0);
      const bytesNeeded = (total + 0) >>> 0;
      const dst = nextScratch >>> 0;
      nextScratch = (nextScratch + bytesNeeded + 0x10) >>> 0;
      const palBase = ((pal ?? 0) & 0xF) * 16;
      // Expand from the decompressed source directly
      for (let i = 0; i < total; i++) {
        const srcByte = decomp[(pixRel >>> 0) + (i >> 1)] ?? 0;
        const nib = ((i & 1) === 0) ? ((srcByte >>> 4) & 0xF) : (srcByte & 0xF);
        const idx = (palBase + nib) & 0xFF;
        bus.storeU8((dst + i) >>> 0, idx >>> 0);
      }
      pixAddrUse = dst >>> 0;
      fmt = 'CI8';
    }

    // Build a tiny UC DL: Gradient + SetTLUT + DrawCI8/CI4 + End
    const strideWords = 64 >>> 0;
    const dlBase = 0xA0000 >>> 0;
    const dlAddr = (dlBase + 0x100) >>> 0;
    const start = 2, interval = 3, frames = 1, spOffset = 1;

    // Write UC ops via helper (uses the same path as uc-run)
    const cmds: any[] = [
      { op: 'Gradient', bgStart: ((0<<11)|(0<<6)|(31<<1)|1)>>>0, bgEnd: ((0<<11)|(31<<6)|(31<<1)|1)>>>0 },
      { op: 'SetTLUT', tlutAddr: tlutAddr>>>0, count: (fmt==='CI8'?256:16) >>> 0 },
    ];
    if (fmt === 'CI8') cmds.push({ op: 'DrawCI8', w: W>>>0, h: H>>>0, addr: pixAddrUse>>>0, x: x>>>0, y: y>>>0 });
    else cmds.push({ op: 'DrawCI4', w: W>>>0, h: H>>>0, addr: pixAddrUse>>>0, x: x>>>0, y: y>>>0 });
    cmds.push({ op: 'End' });
    writeUcAsRspdl(bus as any, dlAddr>>>0, cmds, strideWords);

    const total = start + interval * frames + 2;
    const { frames: imgs } = scheduleRSPDLFramesAndRun(
      cpu, bus, sys, fbOrigin, width, height,
      dlAddr>>>0, frames, start, interval, total, spOffset, strideWords,
    );
    const outImg = (imgs && imgs.length > 0) ? imgs[0]! : viScanout(bus, width, height);
    await (async () => {
      const dir = path.resolve(outDir); if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
      const fname = `${tag}.png`;
      await maybeWriteImage(outImg, width, height, path.join(dir, fname));
    })();
  }

  async function execStitch(tag: string, fmtIn: 'CI8'|'CI4', tlutRel: number, pixRelStart: number, W: number, H: number, pal: number|undefined, count: number, gap: number, stepBytesOpt: number, rowCount: number, rowGap: number, rowStepBytesOpt: number) {
    const tlutAddr = (base + (tlutRel >>> 0)) >>> 0;
    const strideWords = 128 >>> 0;
    const dlBase = 0xB0000 >>> 0;
    const dlAddr = (dlBase + 0x100) >>> 0;
    const start = 2, interval = 3, frames = 1, spOffset = 1;

    const cmds: any[] = [
      { op: 'Gradient', bgStart: ((0<<11)|(0<<6)|(31<<1)|1)>>>0, bgEnd: ((0<<11)|(31<<6)|(31<<1)|1)>>>0 },
      { op: 'SetTLUT', tlutAddr: tlutAddr>>>0, count: (fmtIn==='CI8'?256:16) >>> 0 },
    ];
    const stepDefault = fmtIn === 'CI8' ? ((W>>>0)*(H>>>0)) >>> 0 : ((((W>>>0)*(H>>>0))>>>1) >>> 0);
    const stepBytes = (stepBytesOpt && stepBytesOpt > 0) ? (stepBytesOpt>>>0) : stepDefault;
    const rowStepDefault = fmtIn === 'CI8' ? ((W>>>0)*(H>>>0)) >>> 0 : ((((W>>>0)*(H>>>0))>>>1) >>> 0);
    const rowStepBytes = (rowStepBytesOpt && rowStepBytesOpt > 0) ? (rowStepBytesOpt>>>0) : rowStepDefault;
    for (let r = 0; r < Math.max(1, rowCount|0); r++) {
      const yk = (y >>> 0) + ((r * ((H >>> 0) + (rowGap >>> 0))) >>> 0);
      const basePixRel = (pixRelStart >>> 0) + ((r * rowStepBytes) >>> 0);
      for (let i = 0; i < count; i++) {
        const pixRel = (basePixRel >>> 0) + ((i * stepBytes) >>> 0);
        let addrUse = (base + (pixRel >>> 0)) >>> 0;
        let fmt = fmtIn;
        if (fmt === 'CI4') {
          const total = (W >>> 0) * (H >>> 0);
          const bytesNeeded = (total + 0) >>> 0;
          const dst = nextScratch >>> 0;
          nextScratch = (nextScratch + bytesNeeded + 0x10) >>> 0;
          const palBase = ((pal ?? 0) & 0xF) * 16;
          for (let j = 0; j < total; j++) {
            const srcByte = decomp[(pixRel >>> 0) + (j >> 1)] ?? 0;
            const nib = ((j & 1) === 0) ? ((srcByte >>> 4) & 0xF) : (srcByte & 0xF);
            const idx = (palBase + nib) & 0xFF;
            bus.storeU8((dst + j) >>> 0, idx >>> 0);
          }
          addrUse = dst >>> 0;
          fmt = 'CI8';
        }
        const xk = (x >>> 0) + ((i * ((W >>> 0) + (gap >>> 0))) >>> 0);
        if (fmt === 'CI8') cmds.push({ op: 'DrawCI8', w: W>>>0, h: H>>>0, addr: addrUse>>>0, x: xk>>>0, y: yk>>>0 });
        else cmds.push({ op: 'DrawCI4', w: W>>>0, h: H>>>0, addr: addrUse>>>0, x: xk>>>0, y: yk>>>0 });
      }
    }
    cmds.push({ op: 'End' });
    writeUcAsRspdl(bus as any, dlAddr>>>0, cmds, strideWords);

    const total = start + interval * frames + 2;
    const { frames: imgs } = scheduleRSPDLFramesAndRun(
      cpu, bus, sys, fbOrigin, width, height,
      dlAddr>>>0, frames, start, interval, total, spOffset, strideWords,
    );
    const outImg = (imgs && imgs.length > 0) ? imgs[0]! : viScanout(bus, width, height);
    await (async () => {
      const dir = path.resolve(outDir); if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
      const fname = `${tag}.png`;
      await maybeWriteImage(outImg, width, height, path.join(dir, fname));
    })();
  }
  if (sweep) {
    const tlutCandidates = [0x000, 0x200, 0x400, 0x800];
    const neighborSteps = [-0x40, -0x20, 0x00, 0x20, 0x40];
    const basePixRelCI8 = (t: number) => [t + 0x200, t + 0x400, t + 0x800, t + 0x1000];
    const pixCandidatesFrom = (t: number): number[] => {
      const out: number[] = [];
      const seen = new Set<number>();
      for (const b of basePixRelCI8(t)) for (const d of neighborSteps) {
        const v = (b + d) >>> 0;
        if (!seen.has(v)) { seen.add(v); out.push(v); }
      }
      return out;
    };
    const sizes = [ [64,32], [64,64], [128,32], [32,32], [32,64], [64,16], [128,64] ] as Array<[number,number]>;
    for (const t of tlutCandidates) {
      const pixCands = pixCandidatesFrom(t);
      for (const [W,H] of sizes) {
        for (const pRel of pixCands) {
          const tag = `off_${off.toString(16)}_ci8_w${W}_h${H}_tlut${t.toString(16)}_pix${pRel.toString(16)}`;
          await execOne(tag, 'CI8', t, pRel, W, H);
        }
      }
    }
    // Also try CI4 with a few palettes (0..3), with neighbor steps
    const palList = [0, 1, 2, 3];
    const tlutC4 = [0x000, 0x040, 0x080, 0x100]; // 16*2 bytes per palette is 32 bytes
    const basePixRelCI4 = (t: number) => [t + 0x040, t + 0x080, t + 0x100, t + 0x200];
    const pixCandsCI4 = (t: number): number[] => {
      const out: number[] = [];
      const seen = new Set<number>();
      for (const b of basePixRelCI4(t)) for (const d of neighborSteps) {
        const v = (b + d) >>> 0;
        if (!seen.has(v)) { seen.add(v); out.push(v); }
      }
      return out;
    };
    for (const t of tlutC4) {
      const pixCands = pixCandsCI4(t);
      for (const [W,H] of sizes) {
        for (const pRel of pixCands) for (const pal of palList) {
          const tag = `off_${off.toString(16)}_ci4_pal${pal}_w${W}_h${H}_tlut${t.toString(16)}_pix${pRel.toString(16)}`;
          await execOne(tag, 'CI4', t, pRel, W, H, pal);
        }
      }
    }
  } else if (stitch) {
    const fmt: 'CI8'|'CI4' = (format === 'ci4') ? 'CI4' : 'CI8';
    const tag = `off_${off.toString(16)}_${fmt.toLowerCase()}_stitch${stitchCount}x${stitchRows}_gap${stitchGap}_${stitchRowGap}_w${tileW}_h${tileH}_tlut${tlutOff.toString(16)}_pix${pixOff.toString(16)}` + (fmt==='CI4'?`_pal${palIdx}`:'') + (stitchStepBytes?`_step${stitchStepBytes.toString(16)}`:'') + (stitchStepRowBytes?`_rstep${stitchStepRowBytes.toString(16)}`:'');
    await execStitch(tag, fmt, tlutOff, pixOff, tileW, tileH, palIdx, stitchCount, stitchGap, stitchStepBytes, stitchRows, stitchRowGap, stitchStepRowBytes);
  } else {
    const fmt: 'CI8'|'CI4' = (format === 'ci4') ? 'CI4' : 'CI8';
    const tag = `off_${off.toString(16)}_${fmt.toLowerCase()}_w${tileW}_h${tileH}_tlut${tlutOff.toString(16)}_pix${pixOff.toString(16)}` + (fmt==='CI4'?`_pal${palIdx}`:'');
    await execOne(tag, fmt, tlutOff, pixOff, tileW, tileH, palIdx);
  }

  console.log(JSON.stringify({ command: 'rom-probe-mio0', rom: file, off: `0x${off.toString(16)}`, outDir, sweep: !!sweep, width, height }, null, 2));
}

async function runSm64Demo(args: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const width = parseNum(opts['width'], 192);
  const height = parseNum(opts['height'], 120);
  const origin = parseNum(opts['origin'], 0xF000);
  const spacing = parseNum(opts['spacing'], 10);
  const start = parseNum(opts['start'], 2);
  const interval = parseNum(opts['interval'], 3);
  const frameCount = parseNum(opts['frames'], 1);
  const snapshot = opts['snapshot'];
  const mode = (opts['mode'] || 'dp').toLowerCase();
  const spOffset = parseNum(opts['sp-offset'], 1);

  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  const cfg = {
    width,
    height,
    origin,
    spacing,
    startCycle: start,
    interval,
    frames: frameCount,
    bgStart5551: ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0, // blue
    bgEnd5551:   ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0, // cyan
    spOffset,
  } as const;

  let image: Uint8Array;
  let frameImages: Uint8Array[];
  let res: any;
  if (mode === 'spdp') {
    ({ image, frames: frameImages, res } = runSM64TitleDemoSPDP(cpu, bus, sys, cfg));
  } else if (mode === 'sptask') {
    // Write tasks to RDRAM and schedule SP->DP using task descriptors
    const fbBytes = (width * height * 2) >>> 0;
    const base = ((origin + fbBytes + 0x1000) >>> 0) || 0x40000; // place tasks past framebuffer
    writeSM64TitleTasksToRDRAM(bus, base, frameCount, spacing, cfg.bgStart5551, cfg.bgEnd5551);
    const totalCycles = cfg.startCycle + cfg.interval * frameCount + 2;
    ({ image, frames: frameImages, res } = scheduleSPTitleTasksFromRDRAMAndRun(
      cpu, bus, sys, cfg.origin, cfg.width, cfg.height,
      base, frameCount, cfg.startCycle, cfg.interval, totalCycles, spOffset,
    ));
  } else if (mode === 'rspdl') {
    // Write RSP DLs into RDRAM and schedule SP->DP to execute them
    const fbBytes = (width * height * 2) >>> 0;
    const base = ((origin + fbBytes + 0x2000) >>> 0) || 0x60000; // separate region from sptask
    const strideWords = 16;
    writeRSPTitleDLsToRDRAM(bus, base, frameCount, spacing, cfg.bgStart5551, cfg.bgEnd5551, strideWords);
    const totalCycles = cfg.startCycle + cfg.interval * frameCount + 2;
    ({ image, frames: frameImages, res } = scheduleRSPDLFramesAndRun(
      cpu, bus, sys, cfg.origin, cfg.width, cfg.height,
      base, frameCount, cfg.startCycle, cfg.interval, totalCycles, spOffset, strideWords,
    ));
  } else {
    ({ image, frames: frameImages, res } = runSM64TitleDemoDP(cpu, bus, sys, cfg));
  }
  const perFrame: string[] = [];
  for (let i = 0; i < frameImages.length; i++) {
    const img = frameImages[i]!;
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const base = snapshot.replace(/\.(png|ppm)$/i, '');
      const path = `${base}_f${i}${ext}`;
      await maybeWriteImage(img, width, height, path);
    }
    perFrame.push(crc32(img));
  }
  if (snapshot && frameImages.length === 0) {
    await maybeWriteImage(image, width, height, snapshot);
  }
  const hash = crc32(image);
  console.log(JSON.stringify({
    command: `sm64-demo:${mode}`,
    cfg,
    crc32: hash,
    perFrameCRC32: perFrame,
    acks: res,
    snapshot: snapshot || null,
  }, null, 2));
}

async function runRspdlCi8Ring(args: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const width = parseNum(opts['width'], 192);
  const height = parseNum(opts['height'], 120);
  const origin = parseNum(opts['origin'], 0xF000);
  const start = parseNum(opts['start'], 2);
  const interval = parseNum(opts['interval'], 3);
  const frameCount = parseNum(opts['frames'], 2);
  const spOffset = parseNum(opts['sp-offset'], 1);
  const snapshot = opts['snapshot'];

  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  const fbBytes = width * height * 2;
  const base = (origin + fbBytes + 0x3000) >>> 0;
  const tlutAddr = base;
  const pixAddr = (base + 0x1000) >>> 0;
  const dlBase = (base + 0x2000) >>> 0;

  // Green5551
  const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
  // TLUT[1] = GREEN
  for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, i === 1 ? GREEN : 0);
  // CI8 ring 32x32 at pixAddr
  const W = 32, H = 32, cx = 16, cy = 16, rO = 14, rI = 10;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x + 0.5) - cx, dy = (y + 0.5) - cy; const d2 = dx*dx + dy*dy;
    const v = (d2 <= rO*rO && d2 >= rI*rI) ? 1 : 0;
    bus.storeU8(pixAddr + (y*W + x), v);
  }

  const strideWords = 32;
  for (let i = 0; i < frameCount; i++) {
    let addr = (dlBase + i * strideWords * 4) >>> 0;
    // GRADIENT blue->cyan
    bus.storeU32(addr, 0x00000001); addr += 4;
    bus.storeU32(addr, ((0<<11)|(0<<6)|(31<<1)|1) >>> 0); addr += 4; // blue
    bus.storeU32(addr, ((0<<11)|(31<<6)|(31<<1)|1) >>> 0); addr += 4; // cyan
    // SET_TLUT
    bus.storeU32(addr, 0x00000020); addr += 4;
    bus.storeU32(addr, tlutAddr >>> 0); addr += 4;
    bus.storeU32(addr, 256 >>> 0); addr += 4;
    // DRAW_CI8 32x32
    bus.storeU32(addr, 0x00000021); addr += 4;
    bus.storeU32(addr, W >>> 0); addr += 4;
    bus.storeU32(addr, H >>> 0); addr += 4;
    bus.storeU32(addr, pixAddr >>> 0); addr += 4;
    bus.storeU32(addr, (10 + i) >>> 0); addr += 4;
    bus.storeU32(addr, 10 >>> 0); addr += 4;
    // END
    bus.storeU32(addr, 0x00000000);
  }

  const total = start + interval * frameCount + 2;
  const { image, frames, res } = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dlBase, frameCount, start, interval, total, spOffset, strideWords);
  const perFrame: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const path = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(frames[i]!, width, height, path);
    }
    perFrame.push(crc32(frames[i]!));
  }
  console.log(JSON.stringify({ command: 'rspdl-ci8-ring', cfg: { width, height, origin, start, interval, frameCount, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
}

async function runUcRun(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('uc-run requires a JSON file path');
    process.exit(1);
  }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const snapshot = opts['snapshot'];
  const fs = await import('node:fs');
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text);
  function num(v: any): number {
    if (typeof v === 'number') return v >>> 0;
    if (typeof v === 'string') return parseNum(v, 0);
    return 0;
  }
  const width = num(cfg.video?.width) || 192;
  const height = num(cfg.video?.height) || 120;
  const origin = num(cfg.video?.origin) || 0xF000;
  const start = num(cfg.timing?.start) || 2;
  const interval = num(cfg.timing?.interval) || 3;
  const frames = Array.isArray(cfg.frames) ? cfg.frames.length : (num(cfg.timing?.frames) || 1);
  const spOffset = num(cfg.timing?.spOffset) || 1;
  const allocBase = num(cfg.allocBase) || ((origin + width*height*2 + 0x8000) >>> 0);

  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  // Load TLUTs
  if (Array.isArray(cfg.tluts)) {
    for (const t of cfg.tluts) {
      const addr = num(t.addr);
      const entries: string[] = Array.isArray(t.entries) ? t.entries : [];
      for (let i = 0; i < entries.length; i++) bus.storeU16(addr + i*2, parseNum(entries[i]!, 0));
    }
  }
  // Load blobs (CI8/CI4)
  if (Array.isArray(cfg.blobs)) {
    for (const b of cfg.blobs) {
      const addr = num(b.addr);
      const dataHex: string = b.dataHex || '';
      // write bytes from hex string (pairs)
      for (let i = 0, off = 0; i + 1 < dataHex.length; i += 2, off++) {
        const byte = parseInt(dataHex.slice(i, i+2), 16) & 0xff;
        bus.storeU8(addr + off, byte);
      }
    }
  }

  // Build per-frame DLs
  const strideWords = 128;
  const dlBase = allocBase >>> 0;
  for (let i = 0; i < frames; i++) {
    const dlAddr = (dlBase + i * strideWords * 4) >>> 0;
    const cmds = cfg.frames?.[i] || [];
    // Convert numeric-like strings to numbers for known fields
    const normalized = cmds.map((c: any) => {
      if (!c || !c.op) return c;
      const op = String(c.op);
      const n = (v: any) => num(v);
      switch (op) {
        case 'Gradient': return { op, bgStart: n(c.bgStart), bgEnd: n(c.bgEnd) };
        case 'SetTLUT': return { op, tlutAddr: n(c.tlutAddr), count: n(c.count) };
        case 'DrawCI8': return { op, w: n(c.w), h: n(c.h), addr: n(c.addr), x: n(c.x), y: n(c.y) };
        case 'DrawCI4': return { op, w: n(c.w), h: n(c.h), addr: n(c.addr), x: n(c.x), y: n(c.y) };
        case 'End': return { op };
        default: return c;
      }
    });
    writeUcAsRspdl(bus as any, dlAddr, normalized, strideWords);
  }

  const total = start + interval * frames + 2;
  const { image, frames: imgs, res } = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dlBase, frames, start, interval, total, spOffset, strideWords);
  const perFrame: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const path = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(imgs[i]!, width, height, path);
    }
    perFrame.push(crc32(imgs[i]!));
  }
  console.log(JSON.stringify({ command: 'uc-run', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
}

async function runF3dRun(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3d-run requires a JSON file path');
    process.exit(1);
  }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const snapshot = opts['snapshot'];
  const fs = await import('node:fs');
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text);
  const num = (v: any) => (typeof v === 'number' ? v >>> 0 : (typeof v === 'string' ? parseNum(v, 0) : 0));

  const width = num(cfg.video?.width) || 192;
  const height = num(cfg.video?.height) || 120;
  const origin = num(cfg.video?.origin) || 0xF000;
  const start = num(cfg.timing?.start) || 2;
  const interval = num(cfg.timing?.interval) || 3;
  const frames = Array.isArray(cfg.frames) ? cfg.frames.length : (num(cfg.timing?.frames) || 1);
  const spOffset = num(cfg.timing?.spOffset) || 1;
  const allocBase = num(cfg.allocBase) || ((origin + width*height*2 + 0xA000) >>> 0);

  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  // Optional TLUTs/blobs like uc-run for assets
  if (Array.isArray(cfg.tluts)) {
    for (const t of cfg.tluts) {
      const addr = num(t.addr);
      const entries: string[] = Array.isArray(t.entries) ? t.entries : [];
      for (let i = 0; i < entries.length; i++) bus.storeU16(addr + i*2, parseNum(entries[i]!, 0));
    }
  }
  if (Array.isArray(cfg.blobs)) {
    for (const b of cfg.blobs) {
      const addr = num(b.addr);
      const dataHex: string = b.dataHex || '';
      for (let i = 0, off = 0; i + 1 < dataHex.length; i += 2, off++) {
        const byte = parseInt(dataHex.slice(i, i+2), 16) & 0xff;
        bus.storeU8(addr + off, byte);
      }
    }
  }

  const strideWords = num(cfg.strideWords) || 128;
  const dlBase = allocBase >>> 0;
  for (let i = 0; i < frames; i++) {
    const dlAddr = (dlBase + i * strideWords * 4) >>> 0;
    const f3dCmds = cfg.frames?.[i] || [];
    // Normalize numbers (0x-strings -> number) on known fields
    const n = (v: any) => num(v);
    const norm = f3dCmds.map((c: any) => {
      if (!c || !c.op) return c;
      const op = String(c.op);
      switch (op) {
        case 'G_GRADIENT': return { op, bgStart: n(c.bgStart), bgEnd: n(c.bgEnd) };
        case 'G_SETTLUT': return { op, addr: n(c.addr), count: n(c.count) };
        case 'G_SETCIMG': return { op, format: String(c.format), addr: n(c.addr), w: n(c.w), h: n(c.h) };
        case 'G_SETTIMG': return { op, format: String(c.format), addr: n(c.addr) };
        case 'G_SPRITE': return { op, x: n(c.x), y: n(c.y), w: n(c.w), h: n(c.h) };
        case 'G_SM64_SLICE': return { op, spacing: n(c.spacing), offsetX: n(c.offsetX) };
        case 'G_END': return { op };
        default: return c;
      }
    });
    const uc = f3dToUc(norm as any);
    writeUcAsRspdl(bus as any, dlAddr, uc, strideWords);
  }

  const total = start + interval * frames + 2;
  const { image, frames: imgs, res } = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dlBase, frames, start, interval, total, spOffset, strideWords);
  const perFrame: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const path = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(imgs[i]!, width, height, path);
    }
    perFrame.push(crc32(imgs[i]!));
  }
  console.log(JSON.stringify({ command: 'f3d-run', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
}

async function runF3dRunTable(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3d-run-table requires a JSON file path');
    process.exit(1);
  }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const snapshot = opts['snapshot'];
  const fs = await import('node:fs');
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text);
  const num = (v: any) => (typeof v === 'number' ? v >>> 0 : (typeof v === 'string' ? parseNum(v, 0) : 0));

  const width = num(cfg.video?.width) || 192;
  const height = num(cfg.video?.height) || 120;
  const origin = num(cfg.video?.origin) || 0xF000;
  const start = num(cfg.timing?.start) || 2;
  const interval = num(cfg.timing?.interval) || 3;
  const frames = Array.isArray(cfg.frames) ? cfg.frames.length : (num(cfg.timing?.frames) || 1);
  const spOffset = num(cfg.timing?.spOffset) || 1;
  const allocBase = num(cfg.allocBase) || ((origin + width*height*2 + 0xC000) >>> 0);

  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  // Optional TLUTs/blobs for assets
  if (Array.isArray(cfg.tluts)) {
    for (const t of cfg.tluts) {
      const addr = num(t.addr);
      const entries: string[] = Array.isArray(t.entries) ? t.entries : [];
      for (let i = 0; i < entries.length; i++) bus.storeU16(addr + i*2, parseNum(entries[i]!, 0));
    }
  }
  if (Array.isArray(cfg.blobs)) {
    for (const b of cfg.blobs) {
      const addr = num(b.addr);
      const dataHex: string = b.dataHex || '';
      for (let i = 0, off = 0; i + 1 < dataHex.length; i += 2, off++) {
        const byte = parseInt(dataHex.slice(i, i+2), 16) & 0xff;
        bus.storeU8(addr + off, byte);
      }
    }
  }

  const strideWords = num(cfg.strideWords) || 0x1000 >>> 2;
  const tableBase = allocBase >>> 0;
  const dl0 = (tableBase + 0x100) >>> 0;
  for (let i=0;i<frames;i++){
    const dlAddr = (dl0 + i * strideWords * 4) >>> 0;
    bus.storeU32(tableBase + i*4, dlAddr>>>0);
    const f3dCmds = cfg.frames?.[i] || [];
    const n = (v: any) => num(v);
    const norm = f3dCmds.map((c: any) => {
      if (!c || !c.op) return c;
      const op = String(c.op);
      switch (op) {
        case 'G_GRADIENT': return { op, bgStart: n(c.bgStart), bgEnd: n(c.bgEnd) };
        case 'G_SETTLUT': return { op, addr: n(c.addr), count: n(c.count) };
        case 'G_SETCIMG': return { op, format: String(c.format), addr: n(c.addr), w: n(c.w), h: n(c.h) };
        case 'G_SETTIMG': return { op, format: String(c.format), addr: n(c.addr) };
        case 'G_SPRITE': return { op, x: n(c.x), y: n(c.y), w: n(c.w), h: n(c.h) };
        case 'G_SM64_SLICE': return { op, spacing: n(c.spacing), offsetX: n(c.offsetX) };
        case 'G_END': return { op };
        default: return c;
      }
    });
    const uc = f3dToUc(norm as any);
    writeUcAsRspdl(bus as any, dlAddr, uc, strideWords);
  }

  const total = start + interval * frames + 2;
  const { image, frames: imgs, res } = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, start, interval, total, spOffset, strideWords);
  const perFrame: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const path = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(imgs[i]!, width, height, path);
    }
    perFrame.push(crc32(imgs[i]!));
  }
  console.log(JSON.stringify({ command: 'f3d-run-table', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
}

async function runF3dexRunTable(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3dex-run-table requires a JSON file path');
    process.exit(1);
  }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const snapshot = opts['snapshot'];
  const fs = await import('node:fs');
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text);
  const num = (v: any) => (typeof v === 'number' ? v >>> 0 : (typeof v === 'string' ? parseNum(v, 0) : 0));

  const width = num(cfg.video?.width) || 192;
  const height = num(cfg.video?.height) || 120;
  const origin = num(cfg.video?.origin) || 0xF000;
  const start = num(cfg.timing?.start) || 2;
  const interval = num(cfg.timing?.interval) || 3;
  const frames = Array.isArray(cfg.frames) ? cfg.frames.length : (num(cfg.timing?.frames) || 1);
  const spOffset = num(cfg.timing?.spOffset) || 1;
  const allocBase = num(cfg.allocBase) || ((origin + width*height*2 + 0xE000) >>> 0);
  const stagingBase = num(cfg.stagingBase) || ((allocBase + 0x4000) >>> 0);

  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  // Optional TLUTs/blobs for assets
  if (Array.isArray(cfg.tluts)) {
    for (const t of cfg.tluts) {
      const addr = num(t.addr);
      const entries: string[] = Array.isArray(t.entries) ? t.entries : [];
      for (let i = 0; i < entries.length; i++) bus.storeU16(addr + i*2, parseNum(entries[i]!, 0));
    }
  }
  if (Array.isArray(cfg.blobs)) {
    for (const b of cfg.blobs) {
      const addr = num(b.addr);
      const dataHex: string = b.dataHex || '';
      for (let i = 0, off = 0; i + 1 < dataHex.length; i += 2, off++) {
        const byte = parseInt(dataHex.slice(i, i+2), 16) & 0xff;
        bus.storeU8(addr + off, byte);
      }
    }
  }

  const strideWords = num(cfg.strideWords) || 256;
  const dlStrideWords = num(cfg.dlStrideWords) || 0x400 >>> 2;
  const tableBase = allocBase >>> 0;
  const dl0 = (tableBase + 0x100) >>> 0;
  for (let i = 0; i < frames; i++) {
    const dlAddr = (dl0 + i * dlStrideWords * 4) >>> 0;
    bus.storeU32(tableBase + i*4, dlAddr>>>0);
    const frame = cfg.frames?.[i];
    const words = Array.isArray(frame?.dlWords) ? frame.dlWords : [];
    for (let w = 0, p = dlAddr; w < words.length; w++, p = (p + 4) >>> 0) {
      const val = num(words[w]);
      bus.storeU32(p, val >>> 0);
    }
  }

  const total = start + interval * frames + 2;
  const { image, frames: imgs, res } = scheduleF3DEXFromTableAndRun(
    cpu, bus, sys, origin, width, height,
    tableBase, frames, stagingBase, strideWords,
    start, interval, total, spOffset,
  );
  const perFrame: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const path = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(imgs[i]!, width, height, path);
    }
    perFrame.push(crc32(imgs[i]!));
  }
  console.log(JSON.stringify({ command: 'f3dex-run-table', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
}

async function runF3dexRomRun(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3dex-rom-run requires a JSON config path');
    process.exit(1);
  }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const snapshot = opts['snapshot'];
  const fs = await import('node:fs');
  const path = await import('node:path');
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text);
  const toNum = (v: any, d=0) => (typeof v === 'number' ? v>>>0 : (typeof v === 'string' ? parseNum(v, d) : d)) >>> 0;

  const width = toNum(cfg.video?.width, 192);
  const height = toNum(cfg.video?.height, 120);
  const origin = toNum(cfg.video?.origin, 0xF000);
  const start = toNum(cfg.timing?.start, 2);
  const interval = toNum(cfg.timing?.interval, 3);
  const frames = toNum(cfg.timing?.frames, 1);
  const spOffset = toNum(cfg.timing?.spOffset, 1);

  const tableBase = toNum(cfg.f3dex?.tableBase, 0);
  const stagingBase = toNum(cfg.f3dex?.stagingBase, (origin + width*height*2 + 0x8000)>>>0);
  const strideWords = toNum(cfg.f3dex?.strideWords, 256);

  const bgStart = cfg.bg ? toNum(cfg.bg.start5551, undefined as any) : undefined;
  const bgEnd = cfg.bg ? toNum(cfg.bg.end5551, undefined as any) : undefined;

  const romPath = String(cfg.rom || cfg.romPath || '');
  if (!romPath) { console.error('Config must include rom or romPath'); process.exit(1); }
  const romAbs = path.isAbsolute(romPath) ? romPath : path.resolve(path.dirname(file), romPath);
  const romBytes = fs.readFileSync(romAbs);

  const rdram = new RDRAM(1 << 22); // allow a larger RDRAM region for ROM loads
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  bus.setROM(new Uint8Array(romBytes));

  if (Array.isArray(cfg.piLoads)) {
    const segs = cfg.piLoads.map((s: any) => ({ cartAddr: toNum(s.cartAddr), dramAddr: toNum(s.dramAddr), length: toNum(s.length) }));
    hlePiLoadSegments(bus, segs, true);
  }

  const total = start + interval * frames + 2;
  // Reset HLE3D counters for this run
  resetHle3DStats();
  const { image, frames: imgs, res } = scheduleF3DEXFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, stagingBase, strideWords, start, interval, total, spOffset, bgStart, bgEnd);
  const perFrame: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const outPath = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(imgs[i]!, width, height, outPath);
    }
    perFrame.push(crc32(imgs[i]!));
  }
  const hle3dLog = !!(process.env.HLE3D_LOG || process.env.N64_HLE3D_LOG);
  const hle3dStats = hle3dLog ? getHle3DStats() : undefined;
  console.log(JSON.stringify({ command: 'f3dex-rom-run', cfg: { width, height, origin, start, interval, frames, spOffset, tableBase, stagingBase, strideWords }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null, hle3d: hle3dStats }, null, 2));
}

type TileCfg = {
  format: 'CI8' | 'CI4';
  tlutAddr: number;
  tlutCount?: number;
  pixAddr: number;
  w: number;
  h: number;
  x: number;
  y: number;
  ci4Palette?: number; // 0..15
};

function writeF3dexTileDL(bus: Bus, pStart: number, tile: TileCfg): number {
  let p = pStart >>> 0;
  function storeU32(v: number) { bus.storeU32(p, v >>> 0); p = (p + 4) >>> 0; }
  function fp(x: number) { return (x << 2) >>> 0; }
  function pack12(hi: number, lo: number) { return (((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0; }
  const OP_SETTIMG = 0xFD << 24;
  const SIZ = tile.format === 'CI8' ? (1 << 19) : (0 << 19);
  storeU32((OP_SETTIMG | SIZ) >>> 0); storeU32(tile.pixAddr >>> 0);
  const OP_LOADTLUT = 0xF0 << 24; storeU32((OP_LOADTLUT | (tile.tlutCount ?? (tile.format === 'CI8' ? 256 : 32))) >>> 0); storeU32(tile.tlutAddr >>> 0);
  const OP_SETTILESIZE = 0xF2 << 24; storeU32((OP_SETTILESIZE | pack12(fp(0), fp(0))) >>> 0); storeU32(pack12(fp(tile.w - 1), fp(tile.h - 1)) >>> 0);
  if (tile.format === 'CI4' && tile.ci4Palette !== undefined) {
    // G_SETTILE to carry palette in w1 bits 20..23
    const OP_SETTILE = 0xF5 << 24; const pal = (tile.ci4Palette & 0xF) >>> 0; const w1 = (pal << 20) >>> 0; storeU32(OP_SETTILE >>> 0); storeU32(w1 >>> 0);
  }
  const OP_TEXRECT = 0xE4 << 24; storeU32((OP_TEXRECT | pack12(fp(tile.x), fp(tile.y))) >>> 0); storeU32(pack12(fp(tile.x + tile.w), fp(tile.y + tile.h)) >>> 0);
  return p >>> 0;
}

async function runSm64RomTitle(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('sm64-rom-title requires a JSON config path'); process.exit(1); }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a.startsWith('--')) { const key = a.slice(2); const next = (i + 1 < args.length) ? args[i + 1] : undefined; const val = (next && !next.startsWith('--')) ? args[++i]! : '1'; opts[key] = val; } }
  const snapshot = opts['snapshot'];
  const fs = await import('node:fs');
  const path = await import('node:path');
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text);
  const num = (v: any, d=0) => (typeof v === 'number' ? v>>>0 : (typeof v === 'string' ? parseNum(v, d) : d)) >>> 0;

  const width = num(cfg.video?.width, 192);
  const height = num(cfg.video?.height, 120);
  const origin = num(cfg.video?.origin, 0xF000);
  const start = num(cfg.timing?.start, 2);
  const interval = num(cfg.timing?.interval, 3);
  const frames = num(cfg.timing?.frames, 2);
  const spOffset = num(cfg.timing?.spOffset, 1);

  const romPath = String(cfg.rom || cfg.romPath || '');
  if (!romPath) { console.error('Config must include rom or romPath'); process.exit(1); }
  const romAbs = path.isAbsolute(romPath) ? romPath : path.resolve(path.dirname(file), romPath);
  const romBytes = fs.readFileSync(romAbs);

  const rdram = new RDRAM(1 << 22);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  bus.setROM(new Uint8Array(romBytes));

  // Load assets via PI or MIO0 as directed
  const piLoads: { cartAddr: number; dramAddr: number; length: number }[] = [];
  if (Array.isArray(cfg.assets?.loads)) {
    for (const L of cfg.assets.loads) {
      const kind = String(L.kind || L.type || 'rom');
      if (kind === 'rom') {
        piLoads.push({ cartAddr: num(L.srcRom), dramAddr: num(L.dest), length: num(L.length) });
      } else if (kind === 'mio0') {
        const srcOff = num(L.srcRom); const dest = num(L.dest);
        const decompressed = decompressMIO0(new Uint8Array(romBytes), srcOff);
        for (let i = 0; i < decompressed.length; i++) bus.storeU8(dest + i, decompressed[i]!);
      }
    }
  }
  if (piLoads.length) hlePiLoadSegments(bus, piLoads, true);

  // Build per-frame F3DEX DLs for tiles
  const tilesIn: any[] = Array.isArray(cfg.assets?.tiles) ? cfg.assets.tiles : [];
  const tileCfgBase: TileCfg[] = tilesIn.map((t) => ({
    format: (String(t.format || 'CI8') as 'CI8'|'CI4'),
    tlutAddr: num(t.tlutAddr),
    tlutCount: t.tlutCount !== undefined ? num(t.tlutCount) : undefined,
    pixAddr: num(t.pixAddr),
    w: num(t.w), h: num(t.h), x: num(t.x), y: num(t.y),
    ci4Palette: t.ci4Palette !== undefined ? num(t.ci4Palette) : undefined,
  }));

  const fbBytes = width * height * 2;
  const base = num(cfg.allocBase, (origin + fbBytes + 0x9000) >>> 0);
  const tableBase = base >>> 0;
  const dl0 = (base + 0x400) >>> 0;
  const stagingBase = num(cfg.stagingBase, (base + 0x8000) >>> 0);
  const strideWords = num(cfg.strideWords, 1024 >>> 2);

  for (let f=0; f<frames; f++) {
    const dlAddr = (dl0 + f * strideWords * 4) >>> 0;
    let p = dlAddr >>> 0;
    // optional background gradient
    if (cfg.bg) { bus.storeU32(p, 0x00000001); p+=4; bus.storeU32(p, num(cfg.bg.start5551)); p+=4; bus.storeU32(p, num(cfg.bg.end5551)); p+=4; }
    // tiles for this frame; allow small X offset per frame
    const dx = num(cfg.layout?.offsetPerFrameX, 1) * f;
    for (const t of tileCfgBase) {
      const t2: TileCfg = { ...t, x: (t.x + dx)|0 };
      p = writeF3dexTileDL(bus as any, p, t2);
    }
    bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
    bus.storeU32(tableBase + f*4, dlAddr>>>0);
  }

  const total = start + interval * frames + 2;
  // If bg is provided, pass it through so the renderer composes a gradient even when there are no tiles.
  const bgStart = cfg.bg ? num(cfg.bg.start5551) : undefined;
  const bgEnd = cfg.bg ? num(cfg.bg.end5551) : undefined;
  // Reset HLE3D counters for this run
  resetHle3DStats();
  const { image, frames: imgs, res } = scheduleF3DEXFromTableAndRun(
    cpu, bus, sys, origin, width, height,
    tableBase, frames, stagingBase, strideWords,
    start, interval, total, spOffset,
    bgStart, bgEnd,
  );
  const perFrame: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    if (snapshot) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const outPath = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(imgs[i]!, width, height, outPath);
    }
    perFrame.push(crc32(imgs[i]!));
  }
  const hle3dLog = !!(process.env.HLE3D_LOG || process.env.N64_HLE3D_LOG);
  const hle3dStats = hle3dLog ? getHle3DStats() : undefined;
  console.log(JSON.stringify({ command: 'sm64-rom-title', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null, hle3d: hle3dStats }, null, 2));
}

async function runRomBootRun(args: string[]) {
  // Arguments: <rom> [--cycles N] [--vi-interval CYC] [--width W] [--height H] [--snapshot path.png] [--discover] [--boot path.json] [--boot-out path.json] [--trace-boot N]
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('rom-boot-run requires a ROM file path'); process.exit(1); }
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = (i + 1 < args.length) ? args[i + 1] : undefined;
      const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
      opts[key] = val;
    }
  }
  const cycles = parseNum(opts['cycles'], 5_000_000);
  const viInterval = parseNum(opts['vi-interval'], 10000);
  const width = parseNum(opts['width'], 320);
  const height = parseNum(opts['height'], 240);
  const snapshot = opts['snapshot'];
  const discover = Object.prototype.hasOwnProperty.call(opts, 'discover');
  const discoverNoPrestage = Object.prototype.hasOwnProperty.call(opts, 'discover-no-prestage') || Object.prototype.hasOwnProperty.call(opts, 'discover_noprestage') || Object.prototype.hasOwnProperty.call(opts, 'discoverNoPrestage');
  const bootPath = opts['boot'];
  const bootOut = opts['boot-out'];
  const discoverOut = opts['discover-out'] ? String(opts['discover-out']) : undefined;
  const iplHle = Object.prototype.hasOwnProperty.call(opts, 'ipl-hle');
  const bridge = Object.prototype.hasOwnProperty.call(opts, 'bridge');
  const bridgeTest = Object.prototype.hasOwnProperty.call(opts, 'bridge-test');
  // Diagnostic: force an SP gfx task injection at a specific cycle
  const forceSpAt = opts['force-sp-at'] ? parseNum(opts['force-sp-at'], 0) >>> 0 : 0;
  const viInit = Object.prototype.hasOwnProperty.call(opts, 'vi-init');
  const noViVblank = Object.prototype.hasOwnProperty.call(opts, 'no-vi-vblank') || Object.prototype.hasOwnProperty.call(opts, 'noViVblank') || Object.prototype.hasOwnProperty.call(opts, 'no_vi_vblank');
  const viVblank = Object.prototype.hasOwnProperty.call(opts, 'vi-vblank') || Object.prototype.hasOwnProperty.call(opts, 'viVblank') || Object.prototype.hasOwnProperty.call(opts, 'vi_vblank');
  const fastbootHle = Object.prototype.hasOwnProperty.call(opts, 'fastboot-hle');
  const timerHle = Object.prototype.hasOwnProperty.call(opts, 'timer-hle') || Object.prototype.hasOwnProperty.call(opts, 'timerHle') || Object.prototype.hasOwnProperty.call(opts, 'timer_hle');
  const skipReservedAtOpt = opts['skip-reserved-at'] || opts['skipReservedAt'] || opts['skip_reserved_at'] || '';
  const vectorAutoReturn = Object.prototype.hasOwnProperty.call(opts, 'vector-autoreturn') || Object.prototype.hasOwnProperty.call(opts, 'vectorAutoReturn') || Object.prototype.hasOwnProperty.call(opts, 'vector_auto_return');
  const iplCart = parseNum(opts['ipl-cart'], 0);
  const iplLen = parseNum(opts['ipl-len'], 2 * 1024 * 1024);
  const traceBoot = parseNum(opts['trace-boot'], 0);
  const traceBootSkip = parseNum(opts['trace-boot-skip'], 0);
  // Memory dump options (KSEG0/KSEG1 VA -> phys)
  const dumpWordsVA = opts['dump-words'] ? parseNum(opts['dump-words'], 0) >>> 0 : null;
  const dumpCount = parseNum(opts['dump-count'], 64) >>> 0;
  // Post-step memory dump options (one or more comma-separated base VAs)
  const dumpWordsAfterList = opts['dump-words-after'] ? String(opts['dump-words-after']) : null;
  const dumpCountAfter = parseNum(opts['dump-count-after'], 32) >>> 0;
  // Disassembler options (KSEG0/KSEG1 VA -> phys)
  const disasmVA = opts['disasm'] ? parseNum(opts['disasm'], 0) >>> 0 : null;
  const disasmCount = parseNum(opts['disasm-count'], 64) >>> 0; // number of 32-bit words
  // Memory poke options: --poke32 "0xADDR=0xVAL,0xADDR=0xVAL,..."
  const poke32List = opts['poke32'] ? String(opts['poke32']) : null;
  // Scheduled memory pokes during execution: --poke32-at "CYC:0xADDR=0xVAL,0xADDR2=0xVAL2;CYC2:0xADDR3=0xVAL3"
  const poke32AtList = opts['poke32-at'] ? String(opts['poke32-at']) : null;
  // CP0 trace options
  const traceCp0 = Object.prototype.hasOwnProperty.call(opts, 'trace-cp0') || Object.prototype.hasOwnProperty.call(opts, 'traceCp0') || Object.prototype.hasOwnProperty.call(opts, 'trace_cp0');
  const traceCp0Interval = parseNum(opts['trace-cp0-interval'] || opts['traceCp0Interval'] || opts['trace_cp0_interval'], 100000);
  const jumpHeader = Object.prototype.hasOwnProperty.call(opts, 'jump-header');
  // Manual pre-staging flags
  const stageCartOpt = opts['stage-cart'] ? parseNum(opts['stage-cart'], 0) >>> 0 : null;
  const stageLenOpt = opts['stage-len'] ? parseNum(opts['stage-len'], 0) >>> 0 : null;
  const stageAtOpt = opts['stage-at'] ? parseNum(opts['stage-at'], 0) >>> 0 : null;
  // Bridge tuning flags
  const bridgeStagingBaseOpt = opts['bridge-staging-base'] ? parseNum(opts['bridge-staging-base'], 0) >>> 0 : null;
  const bridgeStrideWordsOpt = opts['bridge-stride-words'] ? parseNum(opts['bridge-stride-words'], 0) >>> 0 : null;
  const bridgeBgStartOpt = opts['bridge-bg-start'] ? parseNum(opts['bridge-bg-start'], 0) >>> 0 : null;
  const bridgeBgEndOpt = opts['bridge-bg-end'] ? parseNum(opts['bridge-bg-end'], 0) >>> 0 : null;
  const bridgeLog = Object.prototype.hasOwnProperty.call(opts, 'bridge-log');
  const bridgeAny = Object.prototype.hasOwnProperty.call(opts, 'bridge-any');
  // Event filtering: when enabled, only record SI/PI/SP/DP to deviceEvents
  const eventsSlim = Object.prototype.hasOwnProperty.call(opts, 'events-slim') || Object.prototype.hasOwnProperty.call(opts, 'eventsSlim') || Object.prototype.hasOwnProperty.call(opts, 'events_slim');
  const allowEvent = (t: string) => (!eventsSlim || t === 'pi' || t === 'si' || t === 'sp' || t === 'dp');
  // PI STATUS trace toggle: off by default to avoid massive spam; enable with --trace-pi-status
  const tracePiStatus = Object.prototype.hasOwnProperty.call(opts, 'trace-pi-status') || Object.prototype.hasOwnProperty.call(opts, 'tracePiStatus') || Object.prototype.hasOwnProperty.call(opts, 'trace_pi_status');
  // Timing profile and trace options (for cycle-aware progress)
  const timingProfile = String(opts['timing-profile'] || opts['timingProfile'] || 'dev').toLowerCase();
  const traceTimingOpt = opts['trace-timing'] || opts['traceTiming'] || '';
  const traceTimingEnabled = Object.prototype.hasOwnProperty.call(opts, 'trace-timing') || Object.prototype.hasOwnProperty.call(opts, 'traceTiming');
  const traceTimingPath = traceTimingEnabled && traceTimingOpt && traceTimingOpt !== '1' ? String(traceTimingOpt) : '';
  // Optional PI kick DMA injection (for diagnostics)
  const kickPiCart = opts['kick-pi-cart'] ? parseNum(opts['kick-pi-cart'], 0) >>> 0 : null;
  const kickPiDram = opts['kick-pi-dram'] ? parseNum(opts['kick-pi-dram'], 0) >>> 0 : null;
  const kickPiLen  = opts['kick-pi-len']  ? parseNum(opts['kick-pi-len'], 0)  >>> 0 : null;
  const kickPiAt   = opts['kick-pi-at']   ? parseNum(opts['kick-pi-at'], 10000) >>> 0 : 0;
  // Optional one-shot PIF controller handshake (status+state) without enabling full fastboot
  const pifHandshake = Object.prototype.hasOwnProperty.call(opts, 'pif-handshake') || Object.prototype.hasOwnProperty.call(opts, 'pifHandshake') || Object.prototype.hasOwnProperty.call(opts, 'pif_handshake');

  const fs = await import('node:fs');
  const rom = fs.readFileSync(file);

  // Parse ROM header to obtain the main program initial PC (kseg0)
  const { normalizeRomToBigEndian, parseHeader } = await import('@n64/core');
  const { data: beRom } = normalizeRomToBigEndian(new Uint8Array(rom));
  const headerInitialPC = parseHeader(beRom).initialPC >>> 0;
  const vaToPhys = (va: number): number | null => {
    const a = va >>> 0;
    const seg = a >>> 29; // top 3 bits
    if (seg === 0b100 || seg === 0b101) return (a - 0x80000000) >>> 0; // KSEG0
    if (seg === 0b101) return (a - 0xA0000000) >>> 0; // unreachable due to previous case, but kept for clarity
    if (seg === 0) return a >>> 0; // KUSEG low, assume identity
    return null;
  };

  // Bigger RDRAM so KSEG0 physical addresses are in range
  const rdram = new RDRAM(8 * 1024 * 1024);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  // Targeted reserved-instruction skip support: allow specifying one or more PCs to treat as NOPs
  if (skipReservedAtOpt && typeof skipReservedAtOpt === 'string') {
    const parts = skipReservedAtOpt.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const pc = parseNum(p, 0) >>> 0;
      if (pc) {
        try { cpu.addReservedSkipPC(pc >>> 0); } catch { (cpu as any).addReservedSkipPC?.(pc >>> 0); }
      }
    }
  }

  // Compact timing trace (CSV-like) and simple PI latency profiles
  const timingLines: string[] = [];
  function emitTiming(evt: string, dev: string, fields?: Record<string, number | string>) {
    if (!traceTimingEnabled) return;
    if (timingLines.length === 0) timingLines.push('cycle,device,event,details');
    const parts: string[] = [];
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'number') parts.push(`${k}=0x${(((v as number) >>> 0) >>> 0).toString(16)}`);
        else parts.push(`${k}=${String(v)}`);
      }
    }
    timingLines.push(`${sys.cycle >>> 0},${dev},${evt},${parts.join(';')}`);
  }
  function piLatencyCycles(len: number): number {
    const L = (len >>> 0);
    switch (timingProfile) {
      case 'fast': return 16;
      case 'realistic': return Math.max(80, Math.floor(80 + L * 0.5));
      default: return 64;
    }
  }
  const trace: { pc: string, instr: string }[] = [];
  const events: any[] = [];
  const cpuWarnings: { pc: string; instr: string; kind: string; details?: Record<string, any> }[] = [];
  const cp0Trace: { cyc: number; status: string; cause: string; count: string; compare: string }[] = [];
  // Capture first-occurrence decode warnings (unknown/reserved) with a cap to avoid huge logs
  cpu.onDecodeWarn = (w) => {
    if (cpuWarnings.length >= 64) return;
    const details = w.details && typeof w.details === 'object' ? Object.fromEntries(Object.entries(w.details).map(([k, v]) => [k, typeof v === 'number' ? `0x${((v as number)>>>0).toString(16)}` : v])) : undefined;
    cpuWarnings.push({ pc: `0x${w.pc.toString(16)}`, instr: `0x${w.instr.toString(16)}`, kind: String(w.kind), details });
  };
  if (traceBoot > 0) {
    cpu.onTrace = (pc, instr) => {
      if (sys.cycle < traceBootSkip) return;
      if (trace.length < traceBoot) trace.push({ pc: `0x${pc.toString(16)}`, instr: `0x${instr.toString(16)}` });
    };
  }
  if (vectorAutoReturn) {
    try { (cpu as any).vectorAutoReturn = true; } catch {}
  }

  // Utility to hex-encode a byte array
  const toHex = (arr: Uint8Array) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  const be32 = (arr: Uint8Array, off: number) => (((arr[off]! << 24) | (arr[off+1]! << 16) | (arr[off+2]! << 8) | (arr[off+3]!)) >>> 0);

  // HLE boot sets PC from header and makes ROM available to PI
  // Use PIF/IPL3 HLE boot so the ROM's own boot code runs from 0xA4000040
  // Optional SRAM load/persist configuration
  const sramFile = opts['sram-file'] ? String(opts['sram-file']) : undefined;
  // support alias --sram-autosave as well
  const sramAutosave = Object.prototype.hasOwnProperty.call(opts, 'sram-save-on-exit') || Object.prototype.hasOwnProperty.call(opts, 'sram-autosave');
  const sramSizeOpt = opts['sram-size'] ? parseNum(opts['sram-size'], 0) >>> 0 : 0;
  let sramMem: Uint8Array | null = null;
  if (sramFile) {
    try {
      const exists = (fs as any).existsSync(sramFile);
      let size = 0x8000 >>> 0; // default 32 KiB
      if (exists) {
        const stat = (fs as any).statSync(sramFile);
        const fileSize = Number(stat.size) >>> 0;
        size = (sramSizeOpt && sramSizeOpt > 0) ? sramSizeOpt : (fileSize > 0 ? fileSize >>> 0 : size);
      } else {
        if (sramSizeOpt && sramSizeOpt > 0) size = sramSizeOpt >>> 0;
      }
      sramMem = new Uint8Array(size >>> 0);
      sramMem.fill(0);
      if (exists) {
        try {
          const data = (fs as any).readFileSync(sramFile) as Buffer;
          const n = Math.min(sramMem.length, data.length);
          sramMem.set(new Uint8Array(data.buffer, data.byteOffset, n), 0);
        } catch {}
      }
      bus.setSRAM(sramMem);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[sram] failed to initialize SRAM from file:', e);
    }
  }

  // Optional FlashRAM load/persist configuration
  const flashFile = opts['flash-file'] ? String(opts['flash-file']) : undefined;
  const flashAutosave = Object.prototype.hasOwnProperty.call(opts, 'flash-save-on-exit') || Object.prototype.hasOwnProperty.call(opts, 'flash-autosave');
  const flashSizeOpt = opts['flash-size'] ? parseNum(opts['flash-size'], 0) >>> 0 : 0;
  let flashMem: Uint8Array | null = null;
  if (flashFile) {
    try {
      const exists = (fs as any).existsSync(flashFile);
      let size = 0x20000 >>> 0; // default 128 KiB (1 Mbit)
      if (exists) {
        const stat = (fs as any).statSync(flashFile);
        const fileSize = Number(stat.size) >>> 0;
        size = (flashSizeOpt && flashSizeOpt > 0) ? flashSizeOpt : (fileSize > 0 ? fileSize >>> 0 : size);
      } else {
        if (flashSizeOpt && flashSizeOpt > 0) size = flashSizeOpt >>> 0;
      }
      flashMem = new Uint8Array(size >>> 0);
      flashMem.fill(0);
      if (exists) {
        try {
          const data = (fs as any).readFileSync(flashFile) as Buffer;
          const n = Math.min(flashMem.length, data.length);
          flashMem.set(new Uint8Array(data.buffer, data.byteOffset, n), 0);
        } catch {}
      }
      bus.setFlashRAM(flashMem);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[flash] failed to initialize FlashRAM from file:', e);
    }
  }

  const { hlePifBoot, hlePiLoadSegments } = await import('@n64/core');
  const boot = hlePifBoot(cpu, bus, new Uint8Array(rom));

  // Optional timer interrupt HLE for non-fastboot runs: enable CP0 IE+IM2+IM7 and schedule periodic Compare updates
  if (timerHle && !fastbootHle) {
    try {
      const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
      const sr0 = cpu.cop0.read(12) >>> 0;
      cpu.cop0.write(12, (sr0 | IE | IM2 | IM7) >>> 0);
      // Install minimal ERET at physical 0x00000180 in case the game hasn't set its own yet
      bus.storeU32(0x00000180 >>> 0, 0x42000018 >>> 0);
      bus.storeU32(0x00000184 >>> 0, 0x00000000 >>> 0);
      // Program periodic timer
      const period = parseNum(opts['timer-period'], 50000);
      const cnt0 = cpu.cop0.read(9) >>> 0;
      cpu.cop0.write(11, (cnt0 + period) >>> 0);
      const repeats = Math.max(1, Math.floor(cycles / Math.max(1, period)));
      sys.scheduleEvery(period >>> 0, period >>> 0, repeats, () => {
        const cNow = cpu.cop0.read(9) >>> 0;
        cpu.cop0.write(11, (cNow + period) >>> 0);
      });
    } catch {}
  }

  // Optional minimal fastboot HLE: enable CPU interrupts, MI masks, and perform a controller handshake once.
  if (fastbootHle) {
    // Enable CPU IE and IM2 (IP2 used for MI) + IM7 (timer) and CU1 (FPU usable)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7); const CU1 = 1 << 29;
    cpu.cop0.write(12, (IE | IM2 | IM7 | CU1) >>> 0);
    // Enable MI masks for SP|SI|VI|PI|DP (bits 0,1,3,4,5)
    const MI_INTR_MASK_OFF = 0x0c >>> 0;
    const mask = ((1<<0)|(1<<1)|(1<<3)|(1<<4)|(1<<5)) >>> 0;
    bus.mi.writeU32(MI_INTR_MASK_OFF, mask);
    // Install a minimal general exception handler at 0x80000180 that immediately ERET
    // ERET = 0x42000018; followed by NOP
    try {
      // Write to physical 0x00000180; CPU fetches from virtual 0x80000180 (KSEG0)
      bus.storeU32(0x00000180 >>> 0, 0x42000018 >>> 0);
      bus.storeU32(0x00000184 >>> 0, 0x00000000 >>> 0);
    } catch {}
    // Program a periodic timer by setting CP0 Compare relative to Count and periodically updating it
    const period = parseNum(opts['fastboot-timer'], 50000);
    try {
      const cnt0 = cpu.cop0.read(9) >>> 0; // Count
      cpu.cop0.write(11, (cnt0 + period) >>> 0); // Compare
      const repeats = Math.max(1, Math.floor(cycles / Math.max(1, period)));
      sys.scheduleEvery(period >>> 0, period >>> 0, repeats, () => {
        const cNow = cpu.cop0.read(9) >>> 0;
        cpu.cop0.write(11, (cNow + period) >>> 0);
      });
    } catch {}
    // Enable fastboot reserved-instruction skip so we don't stall on unhandled opcodes early
    (cpu as any).fastbootSkipReserved = true;
    // Perform a simple controller status+state handshake at DRAM base to satisfy early input init code paths
    try {
      const ctrlBase = 0x2000 >>> 0;
      hlePifControllerStatus(bus, ctrlBase);
      hlePifReadControllerState(bus, (ctrlBase + 0x40) >>> 0);
    } catch {}
  }

  // Heuristic helpers for ROM-to-RDRAM staging discovery (before stepping)
  const basePhys = (headerInitialPC >>> 0) - 0x80000000 >>> 0;
  const looksLikeLUI = (word: number) => ((word >>> 26) & 0x3f) === 0x0f; // opcode 0x0f
  const looksLikeAddiuSp = (word: number) => (word >>> 16) === 0x27bd; // addiu sp,sp,imm
  const likelyCodeAtBase = (): boolean => {
    // Guard against OOB
    if (basePhys + 8 > bus.rdram.bytes.length) return false;
    const w0 = be32(bus.rdram.bytes, basePhys);
    const w1 = be32(bus.rdram.bytes, basePhys + 4);
    return looksLikeLUI(w0) || looksLikeAddiuSp(w0) || looksLikeLUI(w1) || looksLikeAddiuSp(w1);
  };
  const stageSlice = (cartAddr: number, dramAddr: number, length: number) => {
    const seg = { cartAddr: cartAddr >>> 0, dramAddr: dramAddr >>> 0, length: length >>> 0 };
    hlePiLoadSegments(bus as any, [seg], true);
    // Immediately acknowledge any PI interrupt pending caused by staging DMA to avoid
    // leaving MI pending latched before the program enables and acks it.
    bus.storeU32(PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY >>> 0);
  };
  // If IPL-HLE is requested, stage a probe window so the header PC points to code rather than raw header text.
  // Try the provided --ipl-cart/--ipl-len first; if it doesn't look like code at the header PC, scan candidates.

  // Heuristic pre-stage when discovering and no boot script provided:
  if (!bootPath && discover && !discoverNoPrestage) {
    const basePhys = (headerInitialPC >>> 0) - 0x80000000 >>> 0;
    const guessLen = Math.min((rom.length >>> 0), 2 * 1024 * 1024);
    if (basePhys + guessLen <= bus.rdram.bytes.length) {
      // Copy a large slice from ROM start to the entrypoint region
      hlePiLoadSegments(bus as any, [ { cartAddr: 0 >>> 0, dramAddr: basePhys >>> 0, length: guessLen >>> 0 } ], true);
    }
  }

  // Manual pre-staging when requested
  if (stageCartOpt !== null && stageLenOpt !== null && stageLenOpt > 0) {
    const basePhys2 = (headerInitialPC >>> 0) - 0x80000000 >>> 0;
    const dramTarget = (stageAtOpt ?? basePhys2) >>> 0;
    const cartSrc = stageCartOpt >>> 0;
    const len = Math.min(stageLenOpt >>> 0, Math.max(0, rom.length - cartSrc));
    if (dramTarget + len <= bus.rdram.bytes.length && len > 0) {
      hlePiLoadSegments(bus as any, [ { cartAddr: cartSrc >>> 0, dramAddr: dramTarget >>> 0, length: len >>> 0 } ], true);
      if (traceBoot > 0) {
        // eslint-disable-next-line no-console
        console.log(`[stage] cart=0x${cartSrc.toString(16)} -> dram=0x${dramTarget.toString(16)} len=0x${len.toString(16)}`);
      }
    }
  }

  // If a boot script is provided, stage its PI loads before stepping
  if (bootPath) {
    try {
      const bootText = await (await import('node:fs')).promises.readFile(bootPath, 'utf8');
      const bootCfg = JSON.parse(bootText);
      const toNum = (v: any) => (typeof v === 'number' ? v>>>0 : (typeof v === 'string' ? parseNum(v, 0) : 0)) >>> 0;
      if (Array.isArray(bootCfg.piLoads)) {
        const segs = bootCfg.piLoads.map((s: any) => ({ cartAddr: toNum(s.cartAddr), dramAddr: toNum(s.dramAddr), length: toNum(s.length) }));
        hlePiLoadSegments(bus, segs, true);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Failed to read --boot file ${bootPath}:`, e);
    }
  }

  // Instrumentation: track SP starts and PI reads, and VI changes
  let spStarts = 0;
  let piReads = 0;
  let viOrigin = bus.vi.origin >>> 0;
  let viWidth = bus.vi.width >>> 0;
  let viOriginWrites = 0;
  let viWidthWrites = 0;
  let viStatusWrites = 0;
  let lastPiDram = 0 >>> 0;
  let lastPiCart = 0 >>> 0;
  let piStatusWrites = 0;
  // PI read instrumentation
  let piStatusReads = 0;
  let piStatusReadsBusy = 0; // times any busy bit observed set
  let piStatusReadLast: number = 0;
  const piLoads: { cartAddr: number; dramAddr: number; length: number }[] = [];
  // MI summary counters
  let miInitModeWrites = 0;
  let miIntrMaskWrites = 0;
  let miIntrWrites = 0;
  // DP summary counters
  let dpStatusWrites = 0;
  let dpIntrAcks = 0;
  // SP DMA counters
  let spRdCount = 0;
  let spWrCount = 0;
  let spStatusWrites = 0;
  let spLastStatusVal = 0 >>> 0;
  // SI 64B transfer counters
  let siWr64Count = 0;
  let siRd64Count = 0;

  // Track SP DMA and OSTask-like snapshots
  let spMemAddr = 0 >>> 0;
  let spDramAddr = 0 >>> 0;
  const spDmas: { op: 'RD'|'WR'; memAddr: number; dramAddr: number; length: number }[] = [];
  const ostasks: { index: number; memAddr: number; dmas: { op: string; memAddr: string; dramAddr: string; length: string }[]; dmemFirst256Hex: string; task?: any }[] = [];
  const bridgeCRCs: string[] = [];
  let bridgeCount = 0;
  let lastBridgeSnapshotPath: string | null = null;

  // If requested, attach an SP start bridge that translates the current OSTask DL to a rendered frame immediately.
  if (bridge) {
    (bus.sp as any).onStart = () => {
      try {
        const dmemSlice = (bus.sp as any).dmem as Uint8Array;
        const be32 = (arr: Uint8Array, off: number) => (((arr[off]! << 24) | (arr[off+1]! << 16) | (arr[off+2]! << 8) | (arr[off+3]!)) >>> 0);
        const taskType = be32(dmemSlice, 0x00) >>> 0;
        const data_ptr = be32(dmemSlice, 0x30) >>> 0;
        if (!bridgeAny && taskType !== 1) {
          if (bridgeLog) console.log(`[bridge] skip task type=0x${taskType.toString(16)} data_ptr=0x${data_ptr.toString(16)}`);
          return;
        }
        if (data_ptr >>> 0) {
          // Convert physical address to KSEG0 virtual address if needed
          let dlAddr = data_ptr >>> 0;
          if (dlAddr < 0x80000000) {
            dlAddr = (0x80000000 + dlAddr) >>> 0;
          }
          const fbBytes = (width * height * 2) >>> 0;
          let fbOrigin = (viOrigin >>> 0);
          if (fbOrigin === 0) {
            // If the ROM hasn't programmed VI yet, initialize it so HLE rendering is visible.
            fbOrigin = 0xF000 >>> 0;
            (bus.vi as any).writeU32(0x14, fbOrigin >>> 0); // VI_ORIGIN_OFF
            (bus.vi as any).writeU32(0x18, width >>> 0);    // VI_WIDTH_OFF
          }
          const defaultBase = (fbOrigin + fbBytes + 0x30000) >>> 0;
          const strideWords = (bridgeStrideWordsOpt ?? (0x400 >>> 2)) >>> 0;
          const strideBytes = (strideWords * 4) >>> 0;
          const stagingBase = (bridgeStagingBaseOpt ?? (defaultBase + ((bridgeCount & 0xff) * Math.max(0x2000, strideBytes)) >>> 0)) >>> 0;
          // Optional background gradient for bridge
          const bgStart = bridgeBgStartOpt ?? undefined;
          const bgEnd = bridgeBgEndOpt ?? undefined;
          translateF3DEXAndExecNow(bus, width, height, dlAddr >>> 0, stagingBase >>> 0, strideWords >>> 0, bgStart, bgEnd);
          const img = viScanout(bus, width, height);
          const c = crc32(img);
          if (bridgeLog) {
            // eslint-disable-next-line no-console
            console.log(`[bridge] dl=0x${(data_ptr>>>0).toString(16)} staging=0x${stagingBase.toString(16)} strideWords=${strideWords} crc=${c}`);
          }
          bridgeCRCs.push(c);
          if (snapshot) {
            const extMatch = snapshot.match(/\.(png|ppm)$/i);
            const ext = extMatch ? extMatch[0] : '.png';
            const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
            const outPath = `${basePath}_bridge${bridgeCount}${ext}`;
            lastBridgeSnapshotPath = outPath;
            void maybeWriteImage(img, width, height, outPath);
          }
          bridgeCount++;
        }
      } catch {}
    };
  }

  const spWrite = bus.sp.writeU32.bind(bus.sp) as (off: number, val: number) => void;
  (bus.sp as any).writeU32 = (off: number, val: number) => {
    const o = off >>> 0; const v = val >>> 0;
    if (traceBoot>0) {
      let reg = `0x${o.toString(16)}`;
      if (o === 0x00) reg = 'MEM_ADDR';
      else if (o === 0x04) reg = 'DRAM_ADDR';
      else if (o === 0x08) reg = 'RD_LEN';
      else if (o === 0x0c) reg = 'WR_LEN';
      else if (o === 0x10) reg = 'STATUS';
      if (allowEvent('sp')) events.push({ type:'sp', reg, val:`0x${v.toString(16)}`, cyc: sys.cycle });
    }
    if (o === 0x00) {
      // SP_MEM_ADDR (also used as START when value==1 in our stub)
      if (v === 1) {
        spStarts++;
        emitTiming('sp_start', 'sp', { memAddr: spMemAddr >>> 0 });
        const dmemSlice = (bus.sp as any).dmem as Uint8Array;
        let task: any | undefined = undefined;
        try {
          const tOff = 0;
          const type = be32(dmemSlice, tOff + 0x00);
          const flags = be32(dmemSlice, tOff + 0x04);
          const ucode_boot = be32(dmemSlice, tOff + 0x08);
          const ucode_boot_size = be32(dmemSlice, tOff + 0x0C);
          const ucode = be32(dmemSlice, tOff + 0x10);
          const ucode_size = be32(dmemSlice, tOff + 0x14);
          const ucode_data = be32(dmemSlice, tOff + 0x18);
          const ucode_data_size = be32(dmemSlice, tOff + 0x1C);
          const dram_stack = be32(dmemSlice, tOff + 0x20);
          const dram_stack_size = be32(dmemSlice, tOff + 0x24);
          const output_buff = be32(dmemSlice, tOff + 0x28);
          const output_buff_size = be32(dmemSlice, tOff + 0x2C);
          const data_ptr = be32(dmemSlice, tOff + 0x30);
          const data_size = be32(dmemSlice, tOff + 0x34);
          const yield_data_ptr = be32(dmemSlice, tOff + 0x38);
          const yield_data_size = be32(dmemSlice, tOff + 0x3C);
          const fields = { type, flags, ucode_boot, ucode_boot_size, ucode, ucode_size, ucode_data, ucode_data_size, dram_stack, dram_stack_size, output_buff, output_buff_size, data_ptr, data_size, yield_data_ptr, yield_data_size } as const;
          const anyNonZero = Object.values(fields).some(v => (v >>> 0) !== 0);
          if (anyNonZero) task = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `0x${(v>>>0).toString(16)}`]));
        } catch {}
        const snap = {
          index: spStarts >>> 0,
          memAddr: spMemAddr >>> 0,
          dmas: spDmas.slice(-8).map(d => ({
            op: d.op,
            memAddr: `0x${(d.memAddr>>>0).toString(16)}`,
            dramAddr: `0x${(d.dramAddr>>>0).toString(16)}`,
            length: `0x${(d.length>>>0).toString(16)}`,
          })),
          dmemFirst256Hex: toHex(dmemSlice.slice(0, 256)),
          task,
        };
        ostasks.push(snap);
      } else {
        spMemAddr = v >>> 0;
      }
    } else if (o === 0x04) {
      // SP_DRAM_ADDR
      spDramAddr = v >>> 0;
    } else if (o === 0x08) { // SP_RD_LEN
      const len = ((v & 0x00ffffff) >>> 0) + 1;
      spDmas.push({ op: 'RD', memAddr: spMemAddr >>> 0, dramAddr: spDramAddr >>> 0, length: len >>> 0 });
      spRdCount++;
    } else if (o === 0x0C) { // SP_WR_LEN
      const len = ((v & 0x00ffffff) >>> 0) + 1;
      spDmas.push({ op: 'WR', memAddr: spMemAddr >>> 0, dramAddr: spDramAddr >>> 0, length: len >>> 0 });
      spWrCount++;
    } else if (o === 0x10) { // SP_STATUS
      spStatusWrites++;
      spLastStatusVal = v >>> 0;
      // When writing bit0=1, HALT is cleared -> start
      if ((v & 0x1) !== 0) {
        spStarts++;
        emitTiming('sp_start', 'sp', { memAddr: spMemAddr >>> 0 });
        // Snapshot a small view of DMEM at start
        const dmemSlice = (bus.sp as any).dmem as Uint8Array;
        // Try to parse a plausible OSTask struct at DMEM[0..63]
        let task: any | undefined = undefined;
        try {
          const tOff = 0;
          const type = be32(dmemSlice, tOff + 0x00);
          const flags = be32(dmemSlice, tOff + 0x04);
          const ucode_boot = be32(dmemSlice, tOff + 0x08);
          const ucode_boot_size = be32(dmemSlice, tOff + 0x0C);
          const ucode = be32(dmemSlice, tOff + 0x10);
          const ucode_size = be32(dmemSlice, tOff + 0x14);
          const ucode_data = be32(dmemSlice, tOff + 0x18);
          const ucode_data_size = be32(dmemSlice, tOff + 0x1C);
          const dram_stack = be32(dmemSlice, tOff + 0x20);
          const dram_stack_size = be32(dmemSlice, tOff + 0x24);
          const output_buff = be32(dmemSlice, tOff + 0x28);
          const output_buff_size = be32(dmemSlice, tOff + 0x2C);
          const data_ptr = be32(dmemSlice, tOff + 0x30);
          const data_size = be32(dmemSlice, tOff + 0x34);
          const yield_data_ptr = be32(dmemSlice, tOff + 0x38);
          const yield_data_size = be32(dmemSlice, tOff + 0x3C);
          const fields = { type, flags, ucode_boot, ucode_boot_size, ucode, ucode_size, ucode_data, ucode_data_size, dram_stack, dram_stack_size, output_buff, output_buff_size, data_ptr, data_size, yield_data_ptr, yield_data_size } as const;
          const anyNonZero = Object.values(fields).some(v => (v >>> 0) !== 0);
          if (anyNonZero) task = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `0x${(v>>>0).toString(16)}`]));
        } catch {}
        const snap = {
          index: spStarts >>> 0,
          memAddr: spMemAddr >>> 0,
          dmas: spDmas.slice(-8).map(d => ({
            op: d.op,
            memAddr: `0x${(d.memAddr>>>0).toString(16)}`,
            dramAddr: `0x${(d.dramAddr>>>0).toString(16)}`,
            length: `0x${(d.length>>>0).toString(16)}`,
          })),
          dmemFirst256Hex: toHex(dmemSlice.slice(0, 256)),
          task,
        };
        ostasks.push(snap);
      }
    }
    spWrite(o, v);
  };
  // Only record PI activity that happens while the CPU is executing (exclude our pre-staging)
  let monitorActive = false;
  const piWrite = bus.pi.writeU32.bind(bus.pi) as (off: number, val: number) => void;
  const piRead = bus.pi.readU32.bind(bus.pi) as (off: number) => number;
  (bus.pi as any).writeU32 = (off: number, val: number) => {
    const offU = off >>> 0;
    const valU = val >>> 0;
    if (offU === 0x00) { lastPiDram = valU >>> 0; if (traceBoot>0 && monitorActive && allowEvent('pi')) events.push({ type:'pi', reg:'DRAM_ADDR', val:`0x${valU.toString(16)}`, cyc: sys.cycle }); }
    if (offU === 0x04) { lastPiCart = valU >>> 0; if (traceBoot>0 && monitorActive && allowEvent('pi')) events.push({ type:'pi', reg:'CART_ADDR', val:`0x${valU.toString(16)}`, cyc: sys.cycle }); }
    if (offU === 0x08) { // PI_RD_LEN
      const len = (((valU & 0x00ffffff) >>> 0) + 1) >>> 0;
      if (monitorActive) {
        piReads++;
        piLoads.push({ cartAddr: lastPiCart >>> 0, dramAddr: lastPiDram >>> 0, length: len >>> 0 });
        if (traceBoot>0 && allowEvent('pi')) events.push({ type:'pi', reg:'RD_LEN', val:`0x${valU.toString(16)}`, cart:`0x${lastPiCart.toString(16)}`, dram:`0x${lastPiDram.toString(16)}`, len:`0x${len.toString(16)}`, cyc: sys.cycle });
      }
      const latency = piLatencyCycles(len >>> 0) >>> 0;
      emitTiming('pi_rd_len', 'pi', { cart: lastPiCart >>> 0, dram: lastPiDram >>> 0, len: len >>> 0, latency: latency >>> 0 });
      const when = (sys.cycle + latency) >>> 0;
      sys.scheduleAt(when, () => {
        bus.pi.completeDMA();
        emitTiming('pi_dma_complete', 'pi', { len: len >>> 0 });
        if (traceBoot>0 && monitorActive && allowEvent('pi')) events.push({ type:'pi', reg:'AUTO_COMPLETE_DMA', cart:`0x${lastPiCart.toString(16)}`, dram:`0x${lastPiDram.toString(16)}`, len:`0x${(len>>>0).toString(16)}`, cyc: sys.cycle });
      });
    }
    if (offU === 0x0C) { // PI_WR_LEN
      const len = (((valU & 0x00ffffff) >>> 0) + 1) >>> 0;
      const latency = piLatencyCycles(len >>> 0) >>> 0;
      emitTiming('pi_wr_len', 'pi', { cart: lastPiCart >>> 0, dram: lastPiDram >>> 0, len: len >>> 0, latency: latency >>> 0 });
      const when = (sys.cycle + latency) >>> 0;
      sys.scheduleAt(when, () => {
        bus.pi.completeDMA();
        emitTiming('pi_dma_complete_wr', 'pi', { len: len >>> 0 });
        if (traceBoot>0 && monitorActive && allowEvent('pi')) events.push({ type:'pi', reg:'AUTO_COMPLETE_DMA_WR', cart:`0x${lastPiCart.toString(16)}`, dram:`0x${lastPiDram.toString(16)}`, len:`0x${len.toString(16)}`, cyc: sys.cycle });
      });
      if (traceBoot>0 && monitorActive) events.push({ type:'pi', reg:'WR_LEN', val:`0x${valU.toString(16)}`, cart:`0x${lastPiCart.toString(16)}`, dram:`0x${lastPiDram.toString(16)}`, len:`0x${len.toString(16)}`, cyc: sys.cycle });
    }
    if (offU === 0x10) {
      if (monitorActive) piStatusWrites++;
      if (traceBoot>0 && monitorActive && allowEvent('pi') && tracePiStatus) {
        let regsSnap: any | undefined;
        try {
          const rr: any = (cpu as any).r || (cpu as any).regs || (cpu as any).gpr;
          if (rr && rr.length === 32) {
            const hex = (x: number) => `0x${((x>>>0)>>>0).toString(16)}`;
            regsSnap = {
              a0: hex(rr[4]), a1: hex(rr[5]), a2: hex(rr[6]), a3: hex(rr[7]),
              t0: hex(rr[8]), t1: hex(rr[9]), t2: hex(rr[10]), t3: hex(rr[11]),
              t4: hex(rr[12]), t5: hex(rr[13]), t6: hex(rr[14]), t7: hex(rr[15]),
              t8: hex(rr[24]), t9: hex(rr[25]),
              s0: hex(rr[16]), s1: hex(rr[17]), s2: hex(rr[18]), s3: hex(rr[19]),
              s4: hex(rr[20]), s5: hex(rr[21]), s6: hex(rr[22]), s7: hex(rr[23]),
              gp: hex(rr[28]), sp: hex(rr[29]), s8: hex(rr[30]), ra: hex(rr[31]),
            };
          }
        } catch {}
        const evt: any = { type:'pi', reg:'STATUS', val:`0x${valU.toString(16)}`, cyc: sys.cycle, pc: `0x${(cpu.pc>>>0).toString(16)}` };
        if (regsSnap) evt.regs = regsSnap;
        events.push(evt);
      }
    }
    piWrite(offU, valU);
  };
  (bus.pi as any).readU32 = (off: number) => {
    const o = off >>> 0;
    const v = piRead(o) >>> 0;
    if (o === 0x10) {
      piStatusReads++;
      piStatusReadLast = v >>> 0;
      if ((v & ((PI_STATUS_DMA_BUSY | PI_STATUS_IO_BUSY) >>> 0)) !== 0) piStatusReadsBusy++;
      if (traceBoot>0 && monitorActive && allowEvent('pi')) {
        events.push({ type:'pi', reg:'STATUS_RD', val:`0x${v.toString(16)}`, cyc: sys.cycle });
      }
    }
    return v >>> 0;
  };
  const viWrite = bus.vi.writeU32.bind(bus.vi) as (off: number, val: number) => void;
  (bus.vi as any).writeU32 = (off: number, val: number) => {
    viWrite(off, val >>> 0);
    // Mirror public fields for convenience and accept both legacy and real offsets
    const o = (off >>> 0);
    if (o === 0x00 || o === 0x10) { if (monitorActive) viStatusWrites++; if (traceBoot>0 && monitorActive && allowEvent('vi')) events.push({ type:'vi', reg:'STATUS', val:`0x${(val>>>0).toString(16)}`, cyc: sys.cycle }); }
    if (o === 0x14 || o === 0x04) { viOrigin = val >>> 0; if (monitorActive) viOriginWrites++; if (traceBoot>0 && monitorActive && allowEvent('vi')) events.push({ type:'vi', reg:'ORIGIN', val:`0x${(val>>>0).toString(16)}`, cyc: sys.cycle }); }
    if (o === 0x18 || o === 0x08) { viWidth = val >>> 0;  if (monitorActive) viWidthWrites++; if (traceBoot>0 && monitorActive && allowEvent('vi')) events.push({ type:'vi', reg:'WIDTH', val:`0x${(val>>>0).toString(16)}`, cyc: sys.cycle }); }
  };
  const dpWrite = bus.dp.writeU32.bind(bus.dp) as (off: number, val: number) => void;
  (bus.dp as any).writeU32 = (off: number, val: number) => {
    const o = off >>> 0, v = val >>> 0;
    if (o === 0x10) {
      if (monitorActive) dpStatusWrites++;
      if ((v & 0x1) !== 0 && monitorActive) dpIntrAcks++;
      if (traceBoot>0 && monitorActive && allowEvent('dp')) events.push({ type:'dp', reg:'STATUS', val:`0x${v.toString(16)}`, cyc: sys.cycle });
    }
    dpWrite(o, v);
  };
  // SI instrumentation
  const siWrite = bus.si.writeU32.bind(bus.si) as (off: number, val: number) => void;
  (bus.si as any).writeU32 = (off: number, val: number) => {
    const o = off >>> 0, v = val >>> 0;
    if (o === 0x10) { if (monitorActive) siWr64Count++; if (traceBoot>0 && monitorActive && allowEvent('si')) events.push({ type:'si', reg:'PIF_ADDR_WR64B', val:`0x${v.toString(16)}`, cyc: sys.cycle }); }
    if (o === 0x04) { if (monitorActive) siRd64Count++; if (traceBoot>0 && monitorActive && allowEvent('si')) events.push({ type:'si', reg:'PIF_ADDR_RD64B', val:`0x${v.toString(16)}`, cyc: sys.cycle }); }
    if (o === 0x18 && traceBoot>0 && monitorActive && allowEvent('si')) events.push({ type:'si', reg:'STATUS', val:`0x${v.toString(16)}`, cyc: sys.cycle });
    siWrite(o, v);
  };
  const miWrite = bus.mi.writeU32.bind(bus.mi) as (off: number, val: number) => void;
  (bus.mi as any).writeU32 = (off: number, val: number) => {
    const o = off >>> 0; const v = val >>> 0;
    if (monitorActive) {
      if (o === 0x00) miInitModeWrites++;
      else if (o === 0x08) miIntrWrites++;
      else if (o === 0x0c) miIntrMaskWrites++;
    }
    if (traceBoot>0 && monitorActive && allowEvent('mi')) {
      let reg = `0x${o.toString(16)}`;
      if (o === 0x00) reg = 'INIT_MODE';
      else if (o === 0x08) reg = 'INTR';
      else if (o === 0x0c) reg = 'INTR_MASK';
      events.push({ type:'mi', reg, val:`0x${v.toString(16)}`, cyc: sys.cycle });
    }
    miWrite(o, v);
  };
  const miRead = bus.mi.readU32.bind(bus.mi) as (off: number) => number;
  (bus.mi as any).readU32 = (off: number) => {
    const o = off >>> 0;
    const v = miRead(o) >>> 0;
    if (traceBoot>0 && monitorActive && allowEvent('mi') && o === 0x08) {
      events.push({ type:'mi', reg:'INTR_RD', val:`0x${v.toString(16)}`, cyc: sys.cycle });
    }
    return v >>> 0;
  };

  // RI instrumentation: auto-clear RI_MODE shortly after write to simulate RDRAM init complete
  const riWrite = bus.ri.writeU32.bind(bus.ri) as (off: number, val: number) => void;
  (bus.ri as any).writeU32 = (off: number, val: number) => {
    const o = off >>> 0; const v = val >>> 0;
    if (traceBoot>0 && allowEvent('ri')) events.push({ type:'ri', reg:`0x${o.toString(16)}`, val:`0x${v.toString(16)}`, cyc: sys.cycle });
    riWrite(o, v);
    if (o === 0x00) {
      const when = (sys.cycle + 256) >>> 0;
      sys.scheduleAt(when, () => {
        (bus.ri as any).mode = 0 >>> 0;
        if (traceBoot>0 && allowEvent('ri')) events.push({ type:'ri', reg:'MODE_AUTO_CLEAR', val:'0x0', cyc: sys.cycle });
      });
    }
  };

  // Optional IPL-HLE pre-staging with discovery before stepping
  let ipl: undefined | { cartAddr: string; dramAddr: string; length: string } = undefined;
  if (iplHle) {
    // Temporarily stage the requested window
    const probeLen = Math.min(iplLen >>> 0, 256 * 1024) >>> 0; // start with 256 KiB probe
    stageSlice(iplCart >>> 0, basePhys >>> 0, probeLen >>> 0);
    // If the header PC doesn't look like code, scan candidates on 0x1000 boundaries up to 8 MiB
    if (!likelyCodeAtBase()) {
      let found: number | null = null;
      const maxScan = Math.min(rom.length >>> 0, 8 * 1024 * 1024);
      for (let off = 0; off < maxScan; off += 0x1000) {
        stageSlice(off >>> 0, basePhys >>> 0, Math.min(0x10000, maxScan - off) >>> 0); // 64 KiB probe per candidate
        if (likelyCodeAtBase()) { found = off >>> 0; break; }
      }
      const chosen = (found ?? (iplCart >>> 0)) >>> 0;
      const bigLen = Math.min(iplLen >>> 0, Math.max(0x200000, Math.min(rom.length - chosen, 6 * 1024 * 1024))) >>> 0; // up to 6 MiB
      stageSlice(chosen >>> 0, basePhys >>> 0, bigLen >>> 0);
      ipl = { cartAddr: `0x${chosen.toString(16)}`, dramAddr: `0x${(basePhys>>>0).toString(16)}`, length: `0x${bigLen.toString(16)}` };
    } else {
      // Good first guess; stage full requested window
      const bigLen = Math.min(iplLen >>> 0, Math.max(0x200000, Math.min(rom.length - (iplCart>>>0), 6 * 1024 * 1024))) >>> 0;
      stageSlice(iplCart >>> 0, basePhys >>> 0, bigLen >>> 0);
      ipl = { cartAddr: `0x${(iplCart>>>0).toString(16)}`, dramAddr: `0x${(basePhys>>>0).toString(16)}`, length: `0x${bigLen.toString(16)}` };
    }
  }
  // Optionally jump PC directly to header entry after staging (skips IPL loops)
  let jumpedToHeader = false;
  if (jumpHeader) {
    cpu.pc = headerInitialPC >>> 0;
    jumpedToHeader = true;
  }

  // Optional bridge test injection: stage a tiny F3DEX DL and trigger SP start immediately
  if (bridgeTest) {
    // Program VI registers so HLE rendering writes land in a visible framebuffer
    const fbOrigin = 0xF000 >>> 0;
    (bus.vi as any).writeU32(0x14, fbOrigin >>> 0); // VI_ORIGIN_OFF
    (bus.vi as any).writeU32(0x18, width >>> 0);    // VI_WIDTH_OFF

    // Reserve a small region after the framebuffer for assets and DL
    const fbBytes = (width * height * 2) >>> 0;
    const base = (fbOrigin + fbBytes + 0x20000) >>> 0;
    const tlutAddr = base >>> 0;
    const pixAddr = (base + 0x1000) >>> 0;
    const dlAddr = (base + 0x2000) >>> 0;

    // TLUT: 256 entries, palette index 1 = green
    const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    for (let i = 0; i < 256; i++) bus.storeU16((tlutAddr + i * 2) >>> 0, i === 1 ? GREEN : 0);

    // CI8 texture 16x16 filled with index 1
    const TW = 16, TH = 16;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) bus.storeU8((pixAddr + (y * TW + x)) >>> 0, 1);

    // Helper to pack 12-bit fields: upper 12 (ulx) and lower 12 (uly)
    const pack12 = (hi: number, lo: number) => ((((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0);
    const fp = (v: number) => ((v * 4) >>> 0); // 10.2 fixed

    let p = dlAddr >>> 0;
    // G_LOADTLUT (0xF0): w0 low 16 bits = count, w1 = addr
    bus.storeU32(p, (0xF0 << 24) | (256 & 0xFFFF)); p = (p + 4) >>> 0; bus.storeU32(p, tlutAddr >>> 0); p = (p + 4) >>> 0;
    // G_SETTIMG (0xFD) with siz=1 (CI8): w1 = pixAddr
    bus.storeU32(p, ((0xFD << 24) | (1 << 19)) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pixAddr >>> 0); p = (p + 4) >>> 0;
    // G_SETTILESIZE (0xF2): set tile size 16x16
    bus.storeU32(p, ((0xF2 << 24) | pack12(fp(0), fp(0))) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pack12(fp(TW - 1), fp(TH - 1)) >>> 0); p = (p + 4) >>> 0;
    // G_TEXRECT (0xE4): draw at (20,20)
    const X = 20, Y = 20; const W = TW, H = TH;
    bus.storeU32(p, ((0xE4 << 24) | pack12(fp(X), fp(Y))) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pack12(fp(X + W), fp(Y + H)) >>> 0); p = (p + 4) >>> 0;
    // G_ENDDL (0xDF)
    bus.storeU32(p, (0xDF << 24) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, 0); p = (p + 4) >>> 0;

    // Write a minimal OSTask header into SP DMEM at 0x00 with data_ptr at 0x30
    const dmem = (bus.sp as any).dmem as Uint8Array;
    const wbe = (arr: Uint8Array, off: number, v: number) => { arr[off] = (v >>> 24) & 0xFF; arr[off+1] = (v >>> 16) & 0xFF; arr[off+2] = (v >>> 8) & 0xFF; arr[off+3] = v & 0xFF; };
    wbe(dmem, 0x00, 0x00000001); // type = 1 (gfx)
    wbe(dmem, 0x04, 0x00000000); // flags
    wbe(dmem, 0x08, 0x00000000); // ucode_boot
    wbe(dmem, 0x0C, 0x00000000); // ucode_boot_size
    wbe(dmem, 0x10, 0x00000000); // ucode
    wbe(dmem, 0x14, 0x00000000); // ucode_size
    wbe(dmem, 0x18, 0x00000000); // ucode_data
    wbe(dmem, 0x1C, 0x00000000); // ucode_data_size
    wbe(dmem, 0x20, 0x00000000); // dram_stack
    wbe(dmem, 0x24, 0x00000000); // dram_stack_size
    wbe(dmem, 0x28, 0x00000000); // output_buff
    wbe(dmem, 0x2C, 0x00000000); // output_buff_size
    wbe(dmem, 0x30, dlAddr >>> 0); // data_ptr -> our DL
    wbe(dmem, 0x34, 0x00000000); // data_size
    wbe(dmem, 0x38, 0x00000000); // yield_data_ptr
    wbe(dmem, 0x3C, 0x00000000); // yield_data_size

    // Trigger SP start via MEM_ADDR=1 (our stub treats this as start)
    ;(bus.sp as any).writeU32(0x00, 1 >>> 0);
  }

  // Optional VI initialization for visibility when the ROM hasn't programmed VI yet.
  if (viInit) {
    const fbOrigin = 0xF000 >>> 0;
    (bus.vi as any).writeU32(0x14, fbOrigin >>> 0); // VI_ORIGIN_OFF
    (bus.vi as any).writeU32(0x18, width >>> 0);    // VI_WIDTH_OFF
  }

  // Optional: force an SP gfx task injection at a specified cycle (diagnostic)
  if (forceSpAt > 0) {
    const at = Math.max(1, forceSpAt >>> 0);
    sys.scheduleAt(at, () => {
      try {
        // Ensure VI has a framebuffer
        let fbOriginNow = viOrigin >>> 0;
        if (fbOriginNow === 0) {
          fbOriginNow = 0xF000 >>> 0;
          (bus.vi as any).writeU32(0x14, fbOriginNow >>> 0);
          (bus.vi as any).writeU32(0x18, width >>> 0);
        }
        // Reserve a small region after the framebuffer for assets and DL
        const fbBytes = (width * height * 2) >>> 0;
        const base = (fbOriginNow + fbBytes + 0x28000) >>> 0;
        const tlutAddr = base >>> 0;
        const pixAddr = (base + 0x1000) >>> 0;
        const dlAddr = (base + 0x2000) >>> 0;
        // TLUT: 256 entries, palette index 1 = green
        const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
        for (let i = 0; i < 256; i++) bus.storeU16((tlutAddr + i * 2) >>> 0, i === 1 ? GREEN : 0);
        // CI8 texture 16x16 filled with index 1
        const TW = 16, TH = 16;
        for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) bus.storeU8((pixAddr + (y * TW + x)) >>> 0, 1);
        // Pack helpers
        const pack12 = (hi: number, lo: number) => ((((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0);
        const fp = (v: number) => ((v * 4) >>> 0);
        let p = dlAddr >>> 0;
        // G_LOADTLUT (0xF0)
        bus.storeU32(p, (0xF0 << 24) | (256 & 0xFFFF)); p = (p + 4) >>> 0; bus.storeU32(p, tlutAddr >>> 0); p = (p + 4) >>> 0;
        // G_SETTIMG (0xFD) siz=1 (CI8)
        bus.storeU32(p, ((0xFD << 24) | (1 << 19)) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pixAddr >>> 0); p = (p + 4) >>> 0;
        // G_SETTILESIZE (0xF2)
        bus.storeU32(p, ((0xF2 << 24) | pack12(fp(0), fp(0))) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pack12(fp(TW - 1), fp(TH - 1)) >>> 0); p = (p + 4) >>> 0;
        // G_TEXRECT (0xE4)
        const X = 20, Y = 20; const W = TW, H = TH;
        bus.storeU32(p, ((0xE4 << 24) | pack12(fp(X), fp(Y))) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pack12(fp(X + W), fp(Y + H)) >>> 0); p = (p + 4) >>> 0;
        // G_ENDDL (0xDF)
        bus.storeU32(p, (0xDF << 24) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, 0);
        // Write a minimal OSTask header into SP DMEM and start SP
        const dmem = (bus.sp as any).dmem as Uint8Array;
        const wbe = (arr: Uint8Array, off: number, v: number) => { arr[off] = (v >>> 24) & 0xFF; arr[off+1] = (v >>> 16) & 0xFF; arr[off+2] = (v >>> 8) & 0xFF; arr[off+3] = v & 0xFF; };
        wbe(dmem, 0x00, 0x00000001); // type = 1 (gfx)
        wbe(dmem, 0x04, 0x00000000); // flags
        wbe(dmem, 0x08, 0x00000000); // ucode_boot
        wbe(dmem, 0x0C, 0x00000000); // ucode_boot_size
        wbe(dmem, 0x10, 0x00000000); // ucode
        wbe(dmem, 0x14, 0x00000000); // ucode_size
        wbe(dmem, 0x18, 0x00000000); // ucode_data
        wbe(dmem, 0x1C, 0x00000000); // ucode_data_size
        wbe(dmem, 0x20, 0x00000000); // dram_stack
        wbe(dmem, 0x24, 0x00000000); // dram_stack_size
        wbe(dmem, 0x28, 0x00000000); // output_buff
        wbe(dmem, 0x2C, 0x00000000); // output_buff_size
        wbe(dmem, 0x30, dlAddr >>> 0); // data_ptr
        wbe(dmem, 0x34, 0x00000000); // data_size
        wbe(dmem, 0x38, 0x00000000); // yield_data_ptr
        wbe(dmem, 0x3C, 0x00000000); // yield_data_size
        // Start SP (our stub treats writing MEM_ADDR=1 as start)
        ;(bus.sp as any).writeU32(0x00, 1 >>> 0);
      } catch {}
    });
  }

  // Apply memory pokes before stepping (after staging, before any stepping)
  const appliedPokes: { va: string; pa: string; val: string }[] = [];
  if (poke32List) {
    const items = poke32List.split(',').map(s => s.trim()).filter(Boolean);
    for (const it of items) {
      const m = it.split('=');
      if (m.length === 2) {
        const va = parseNum(m[0]!, 0) >>> 0;
        const val = parseNum(m[1]!, 0) >>> 0;
        const pa = vaToPhys(va);
        if (pa !== null && (pa + 4) <= bus.rdram.bytes.length) {
          bus.storeU32(pa >>> 0, val >>> 0);
          appliedPokes.push({ va: `0x${va.toString(16)}`, pa: `0x${pa.toString(16)}`, val: `0x${val.toString(16)}` });
        }
      }
    }
  }

  // Optional one-shot controller handshake to satisfy early input init (without fastboot)
  if (pifHandshake && !fastbootHle) {
    try {
      const ctrlBase = 0x2000 >>> 0;
      hlePifControllerStatus(bus, ctrlBase);
      hlePifReadControllerState(bus, (ctrlBase + 0x40) >>> 0);
    } catch {}
  }

  // Schedule periodic VI vblank and snapshot if configured
  const frames: Uint8Array[] = [];
  // Schedule any requested timed pokes: "CYC:addr=val,addr=val;CYC2:..."
  const scheduledPokes: { cyc: number; items: { va: string; pa: string|null; val: string }[] }[] = [];
  if (poke32AtList) {
    const groups = poke32AtList.split(';').map(s => s.trim()).filter(Boolean);
    for (const g of groups) {
      const [cycStr, rest] = g.split(':');
      const cyc = parseNum(cycStr!, 0) >>> 0;
      if (!rest) continue;
      const itemsStr = rest.split(',').map(s => s.trim()).filter(Boolean);
      const groupItems: { va: string; pa: string|null; val: string }[] = [];
      sys.scheduleAt(Math.max(1, cyc), () => {
        for (const it of itemsStr) {
          const m = it.split('=');
          if (m.length === 2) {
            const va = parseNum(m[0]!, 0) >>> 0;
            const val = parseNum(m[1]!, 0) >>> 0;
            const pa = vaToPhys(va);
            if (pa !== null && (pa + 4) <= bus.rdram.bytes.length) {
              bus.storeU32(pa >>> 0, val >>> 0);
              groupItems.push({ va: `0x${va.toString(16)}`, pa: `0x${pa.toString(16)}`, val: `0x${val.toString(16)}` });
            } else {
              groupItems.push({ va: `0x${va.toString(16)}`, pa: null, val: `0x${val.toString(16)}` });
            }
          }
        }
      });
      scheduledPokes.push({ cyc, items: groupItems });
    }
  }
  if ((!fastbootHle || viVblank) && !noViVblank) {
    sys.scheduleEvery(viInterval >>> 0, viInterval >>> 0, Math.max(1, Math.floor(cycles / Math.max(1, viInterval))), () => {
      bus.vi.vblank();
      emitTiming('vi_vblank', 'vi', { origin: viOrigin >>> 0, width: viWidth >>> 0 });
      if (snapshot && viOrigin !== 0 && viWidth !== 0) {
        const img = viScanout(bus, width, height);
        frames.push(img);
      }
    });
  }
  // Optional PI kick DMA injection
  if (kickPiCart !== null && kickPiDram !== null && kickPiLen !== null && kickPiLen > 0) {
    const at = Math.max(1, kickPiAt >>> 0);
    sys.scheduleAt(at, () => {
      try {
        (bus.pi as any).writeU32(0x04, kickPiCart >>> 0); // CART_ADDR
        (bus.pi as any).writeU32(0x00, kickPiDram >>> 0); // DRAM_ADDR (KSEG0 ok; device uses low bits)
        const lenMinus1 = ((kickPiLen - 1) & 0x00ffffff) >>> 0;
        (bus.pi as any).writeU32(0x08, lenMinus1 >>> 0); // RD_LEN
        if (traceBoot>0 && allowEvent('pi')) events.push({ type:'pi', reg:'KICK_PI', cart:`0x${(kickPiCart>>>0).toString(16)}`, dram:`0x${(kickPiDram>>>0).toString(16)}`, len:`0x${(kickPiLen>>>0).toString(16)}`, cyc: sys.cycle });
      } catch {}
    });
  }

  // Optional CP0 sampling
  if (traceCp0) {
    const period = Math.max(1, traceCp0Interval) >>> 0;
    const repeats = Math.max(1, Math.floor(cycles / period));
    sys.scheduleEvery(period, period, repeats, () => {
      const status = cpu.cop0.read(12) >>> 0;
      const cause = cpu.cop0.read(13) >>> 0;
      const count = cpu.cop0.read(9) >>> 0;
      const compare = cpu.cop0.read(11) >>> 0;
      cp0Trace.push({
        cyc: sys.cycle >>> 0,
        status: `0x${status.toString(16)}`,
        cause: `0x${cause.toString(16)}`,
        count: `0x${count.toString(16)}`,
        compare: `0x${compare.toString(16)}`,
      });
    });
  }

  // Optional memory dump before stepping (after staging)
  let dump: { baseVA: string; count: number; words: { va: string; pa: string; w: string }[] } | undefined;
  let disasm: { baseVA: string; count: number; inst: { va: string; pa: string; w: string; asm: string }[] } | undefined;
  if (dumpWordsVA !== null) {
    const pa0 = vaToPhys(dumpWordsVA >>> 0);
    const words: { va: string; pa: string; w: string }[] = [];
    if (pa0 !== null) {
      for (let i = 0; i < dumpCount; i++) {
        const pa = (pa0 + i * 4) >>> 0;
        if (pa + 4 > bus.rdram.bytes.length) break;
        const w = be32(bus.rdram.bytes, pa) >>> 0;
        const va = (dumpWordsVA + i * 4) >>> 0;
        words.push({ va: `0x${va.toString(16)}`, pa: `0x${pa.toString(16)}`, w: `0x${w.toString(16)}` });
      }
    }
    dump = { baseVA: `0x${(dumpWordsVA>>>0).toString(16)}`, count: dumpCount, words };
  }

  // Optional disassembler before stepping
  if (disasmVA !== null && disasmCount > 0) {
    const pa0 = vaToPhys(disasmVA >>> 0);
    const inst: { va: string; pa: string; w: string; asm: string }[] = [];
    const regNames = [
      '$zero','$at','$v0','$v1','$a0','$a1','$a2','$a3',
      '$t0','$t1','$t2','$t3','$t4','$t5','$t6','$t7',
      '$s0','$s1','$s2','$s3','$s4','$s5','$s6','$s7',
      '$t8','$t9','$k0','$k1','$gp','$sp','$s8','$ra',
    ];
    function sign16(n: number) { return (n & 0x8000) ? (n | 0xFFFF0000) : (n & 0xFFFF); }
    function hex(n: number) { return '0x' + ((n>>>0)>>>0).toString(16); }
    function fmtTarget(pc: number, imm26: number) { const t = (((pc + 4) & 0xF0000000) | ((imm26 & 0x03FFFFFF) << 2)) >>> 0; return hex(t); }
    function fmtBranch(pc: number, imm16: number) { const off = (sign16(imm16) << 2) >>> 0; const t = ((pc + 4 + off) >>> 0); return hex(t); }
    function dis1(pc: number, w: number): string {
      const op = (w >>> 26) & 0x3F;
      const rs = (w >>> 21) & 0x1F;
      const rt = (w >>> 16) & 0x1F;
      const rd = (w >>> 11) & 0x1F;
      const sa = (w >>> 6) & 0x1F;
      const func = w & 0x3F;
      const imm16 = w & 0xFFFF;
      switch (op) {
        case 0x00: // SPECIAL
          switch (func) {
            case 0x21: return `addu ${regNames[rd]}, ${regNames[rs]}, ${regNames[rt]}`;
            case 0x23: return `subu ${regNames[rd]}, ${regNames[rs]}, ${regNames[rt]}`;
            case 0x24: return `and ${regNames[rd]}, ${regNames[rs]}, ${regNames[rt]}`;
            case 0x25: return `or ${regNames[rd]}, ${regNames[rs]}, ${regNames[rt]}`;
            case 0x27: return `nor ${regNames[rd]}, ${regNames[rs]}, ${regNames[rt]}`;
            case 0x02: return `srl ${regNames[rd]}, ${regNames[rt]}, ${sa}`;
            case 0x03: return `sra ${regNames[rd]}, ${regNames[rt]}, ${sa}`;
            case 0x08: return `jr ${regNames[rs]}`;
            default: return `.word ${hex(w)}`;
          }
        case 0x02: return `j ${fmtTarget(pc, w & 0x03FFFFFF)}`;
        case 0x03: return `jal ${fmtTarget(pc, w & 0x03FFFFFF)}`;
        case 0x04: return `beq ${regNames[rs]}, ${regNames[rt]}, ${fmtBranch(pc, imm16)}`;
        case 0x05: return `bne ${regNames[rs]}, ${regNames[rt]}, ${fmtBranch(pc, imm16)}`;
        case 0x06: return `blez ${regNames[rs]}, ${fmtBranch(pc, imm16)}`;
        case 0x07: return `bgtz ${regNames[rs]}, ${fmtBranch(pc, imm16)}`;
        case 0x08: return `addi ${regNames[rt]}, ${regNames[rs]}, ${sign16(imm16)}`;
        case 0x09: return `addiu ${regNames[rt]}, ${regNames[rs]}, ${sign16(imm16)}`;
        case 0x0C: return `andi ${regNames[rt]}, ${regNames[rs]}, ${hex(imm16)}`;
        case 0x0D: return `ori ${regNames[rt]}, ${regNames[rs]}, ${hex(imm16)}`;
        case 0x0E: return `xori ${regNames[rt]}, ${regNames[rs]}, ${hex(imm16)}`;
        case 0x0F: return `lui ${regNames[rt]}, ${hex(imm16)}`;
        case 0x20: return `lb ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x21: return `lh ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x23: return `lw ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x24: return `lbu ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x25: return `lhu ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x28: return `sb ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x29: return `sh ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x2B: return `sw ${regNames[rt]}, ${sign16(imm16)}(${regNames[rs]})`;
        case 0x10: { // COP0
          const rs_cop0 = (w >>> 21) & 0x1F;
          if (rs_cop0 === 0x00) { // mfc0
            return `mfc0 ${regNames[rt]}, $${rd}`;
          } else if (rs_cop0 === 0x04) { // mtc0
            return `mtc0 ${regNames[rt]}, $${rd}`;
          } else {
            return `.word ${hex(w)}`;
          }
        }
        default: return `.word ${hex(w)}`;
      }
    }
    if (pa0 !== null) {
      for (let i = 0; i < disasmCount; i++) {
        const pa = (pa0 + i * 4) >>> 0;
        if (pa + 4 > bus.rdram.bytes.length) break;
        const w = be32(bus.rdram.bytes, pa) >>> 0;
        const va = (disasmVA + i * 4) >>> 0;
        const asm = dis1(va >>> 0, w >>> 0);
        inst.push({ va: `0x${va.toString(16)}`, pa: `0x${pa.toString(16)}`, w: `0x${w.toString(16)}`, asm });
      }
    }
    disasm = { baseVA: `0x${(disasmVA>>>0).toString(16)}`, count: disasmCount, inst };
  }

  // Step CPU for requested cycles; trap errors to report gracefully
  let stopReason: string | null = null;
  try {
    monitorActive = true;
    sys.stepCycles(cycles);
  } catch (e: any) {
    stopReason = String(e?.message || e);
  } finally {
    monitorActive = false;
  }

  // Optional memory dump after stepping (supports comma-separated base VAs)
  let dumpAfter: { baseVA: string; count: number; words: { va: string; pa: string; w: string }[] }[] | undefined;
  if (dumpWordsAfterList) {
    const addrs = dumpWordsAfterList.split(',').map(s => s.trim()).filter(Boolean);
    const outArr: { baseVA: string; count: number; words: { va: string; pa: string; w: string }[] }[] = [];
    for (const aStr of addrs) {
      const base = parseNum(aStr, 0) >>> 0;
      const pa0 = vaToPhys(base >>> 0);
      const words: { va: string; pa: string; w: string }[] = [];
      if (pa0 !== null) {
        for (let i = 0; i < dumpCountAfter; i++) {
          const pa = (pa0 + i * 4) >>> 0;
          if (pa + 4 > bus.rdram.bytes.length) break;
          const w = be32(bus.rdram.bytes, pa) >>> 0;
          const va = (base + i * 4) >>> 0;
          words.push({ va: `0x${va.toString(16)}`, pa: `0x${pa.toString(16)}`, w: `0x${w.toString(16)}` });
        }
      }
      outArr.push({ baseVA: `0x${(base>>>0).toString(16)}`, count: dumpCountAfter, words });
    }
    dumpAfter = outArr;
  }

  // If discovering and no PI activity, try multi-window heuristic reattempts
  if (discover && piLoads.length === 0) {
    const { hlePifBoot: hleBoot2, hlePiLoadSegments: hlePi2 } = await import('@n64/core');

    // Pass 1: doubling windows (coarse)
    const coarseStarts: number[] = [];
    for (let off = 0; off < Math.min(4 * 1024 * 1024, rom.length); off = off ? (off << 1) : 0x1000) coarseStarts.push(off >>> 0);
    const runPass = async (starts: number[], perWindow: number): Promise<boolean> => {
      for (const cartStart of starts) {
        const rdram2 = new RDRAM(8 * 1024 * 1024);
        const bus2 = new Bus(rdram2);
        const cpu2 = new CPU(bus2);
        const sys2 = new System(cpu2, bus2);
        const boot2 = hleBoot2(cpu2, bus2, new Uint8Array(rom));
        const basePhys2 = (headerInitialPC >>> 0) - 0x80000000 >>> 0;
        const len2 = Math.min(2 * 1024 * 1024, Math.max(0, rom.length - cartStart));
        if (len2 <= 0 || basePhys2 + len2 > bus2.rdram.bytes.length) continue;
        hlePi2(bus2 as any, [ { cartAddr: cartStart >>> 0, dramAddr: basePhys2 >>> 0, length: len2 >>> 0 } ], true);
        let lastD = 0 >>> 0, lastC = 0 >>> 0;
        const piLoadsTemp: { cartAddr: number; dramAddr: number; length: number }[] = [];
        const piWrite2 = bus2.pi.writeU32.bind(bus2.pi) as (off: number, val: number) => void;
        (bus2.pi as any).writeU32 = (off: number, val: number) => {
          const o = off >>> 0, v = val >>> 0;
          if (o === 0x00) lastD = v; if (o === 0x04) lastC = v;
          if (o === 0x08) { const l = ((v & 0x00ffffff) >>> 0) + 1; piLoadsTemp.push({ cartAddr: lastC >>> 0, dramAddr: lastD >>> 0, length: l >>> 0 }); }
          piWrite2(o, v);
        };
        let stop2: string | null = null;
        try { sys2.stepCycles(perWindow); } catch (e: any) { stop2 = String(e?.message || e); }
        if (piLoadsTemp.length > 0) {
          for (const s of piLoadsTemp) piLoads.push(s);
          stopReason = stop2;
          console.log(`[discover] found PI loads with cartStart=0x${cartStart.toString(16)} after ${perWindow} cycles`);
          return true;
        }
      }
      return false;
    };

    const coarseCycles = Math.max(50000, Math.floor(cycles / Math.max(10, coarseStarts.length)));
    const coarseHit = await runPass(coarseStarts, coarseCycles);

    // Pass 2: linear windows (finer)
    if (!coarseHit && piLoads.length === 0) {
      const maxSpan = Math.min(8 * 1024 * 1024, rom.length);
      const fineStarts: number[] = [];
      for (let off = 0; off < maxSpan; off += 0x1000) fineStarts.push(off >>> 0);
      const fineCycles = Math.max(20000, Math.floor(cycles / Math.max(20, fineStarts.length)));
      await runPass(fineStarts, fineCycles);
    }
  }

  // Bridge CRC output aggregated from onStart handler
  const bridgeCRC32: string | null = bridgeCRCs.length ? bridgeCRCs[bridgeCRCs.length - 1]! : null;
  const bridgeSnapshotPath: string | null = lastBridgeSnapshotPath;

  // Write snapshots if requested
  if (snapshot) {
    for (let i = 0; i < frames.length; i++) {
      const extMatch = snapshot.match(/\.(png|ppm)$/i);
      const ext = extMatch ? extMatch[0] : '.png';
      const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
      const outPath = `${basePath}_f${i}${ext}`;
      await maybeWriteImage(frames[i]!, width, height, outPath);
    }
  }

  // Save SRAM if requested
  if (sramAutosave && sramFile && sramMem) {
    try {
      const pathMod = await import('node:path');
      const dir = pathMod.dirname(sramFile);
      if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
      (fs as any).writeFileSync(sramFile, Buffer.from(sramMem));
      // eslint-disable-next-line no-console
      console.log(`[sram] saved ${sramFile} (${sramMem.length} bytes)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[sram] failed to save SRAM file:', e);
    }
  }
  // Save Flash if requested
  if (flashAutosave && flashFile && flashMem) {
    try {
      const pathMod = await import('node:path');
      const dir = pathMod.dirname(flashFile);
      if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
      (fs as any).writeFileSync(flashFile, Buffer.from(flashMem));
      // eslint-disable-next-line no-console
      console.log(`[flash] saved ${flashFile} (${flashMem.length} bytes)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[flash] failed to save FlashRAM file:', e);
    }
  }

  // Optionally write discovered PI loads to file
  if (discover && bootOut) {
    try {
      const outObj = { piLoads: piLoads.map(s => ({ cartAddr: `0x${(s.cartAddr>>>0).toString(16)}`, dramAddr: `0x${(s.dramAddr>>>0).toString(16)}`, length: `0x${(s.length>>>0).toString(16)}` })) };
      await (await import('node:fs')).promises.mkdir((await import('node:path')).dirname(bootOut), { recursive: true });
      await (await import('node:fs')).promises.writeFile(bootOut, JSON.stringify(outObj, null, 2));
      // eslint-disable-next-line no-console
      console.log(`[discover] wrote boot script to ${bootOut}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to write --boot-out file:', e);
    }
  }

  // Optionally write full discovery config (PI loads + per-frame DLs) to file
  if (discover && discoverOut) {
    try {
      const pathMod = await import('node:path');
      const fsMod = await import('node:fs');
      const toHex = (n: number) => `0x${((n>>>0)>>>0).toString(16)}`;
      // Deduplicate PI loads
      const seen = new Set<string>();
      const piLoadsUniq = piLoads.filter(s => { const k = `${s.cartAddr>>>0}:${s.dramAddr>>>0}:${s.length>>>0}`; if (seen.has(k)) return false; seen.add(k); return true; });
      // Extract per-frame dlWords by reading memory at data_ptr until G_ENDDL
      const framesOut: { dlAddr?: string; dlWords?: string[] }[] = [];
      const readU32 = (pa: number) => be32(bus.rdram.bytes as any, pa >>> 0) >>> 0;
      const pushFrameFromPtr = (ptr: number) => {
        const words: string[] = [];
        let p = ptr >>> 0;
        const maxWords = 4096; // safety cap (pairs -> up to 2048 commands)
        for (let i = 0; i < maxWords; i += 2) {
          if ((p + 8) > bus.rdram.bytes.length) break;
          const w0 = readU32(p); const w1 = readU32((p + 4) >>> 0);
          words.push(toHex(w0), toHex(w1));
          p = (p + 8) >>> 0;
          if (((w0 >>> 24) & 0xFF) === 0xDF) break; // G_ENDDL
        }
        if (words.length) framesOut.push({ dlWords: words });
      };
      for (const t of ostasks) {
        const dpStr: string | undefined = (t as any)?.task?.data_ptr;
        if (dpStr && /^0x[0-9a-fA-F]+$/.test(dpStr)) {
          const ptr = parseInt(dpStr, 16) >>> 0;
          if (ptr !== 0 && ptr < (bus.rdram.bytes.length - 8)) pushFrameFromPtr(ptr);
          else framesOut.push({ dlAddr: dpStr });
        }
      }
      // Parse assets (TLUTs and CI8 textures) from DL words
      type TLUT = { addr: number; count: number };
      type Blob = { addr: number; len: number };
      const tlutMap = new Map<number, TLUT>();
      const blobMap = new Map<number, Blob>();
      for (const f of framesOut) {
        const words = (f.dlWords || []).map(w => (typeof w === 'string' ? parseNum(String(w), 0) >>> 0 : (Number(w) >>> 0))) as number[];
        let lastW = 0; let lastH = 0; let lastFormatCI8 = false;
        let lastPixAddr: number | null = null;
        const maybeRecordBlob = () => {
          if (lastFormatCI8 && lastPixAddr !== null && lastW > 0 && lastH > 0) {
            const pixAddr = lastPixAddr >>> 0;
            const len = (lastW * lastH) >>> 0;
            if (pixAddr + len <= bus.rdram.bytes.length) {
              blobMap.set(pixAddr >>> 0, { addr: pixAddr>>>0, len: len>>>0 });
            }
          }
        };
        for (let i = 0; i + 1 < words.length; i += 2) {
          const w0 = (words[i]!) >>> 0; const w1 = (words[i + 1]!) >>> 0;
          const op = (w0 >>> 24) & 0xFF;
          if (op === 0xF0) { // LOADTLUT: w0 low16=count, w1=addr
            const count = (w0 & 0xFFFF) >>> 0; const addr = w1 >>> 0;
            if (count > 0 && addr < bus.rdram.bytes.length) tlutMap.set(addr >>> 0, { addr: addr>>>0, count: count>>>0 });
          } else if (op === 0xFD) { // SETTIMG: siz in bit19, w1=pixAddr
            const sizCI8 = ((w0 >>> 19) & 0x1) === 1; lastFormatCI8 = sizCI8;
            lastPixAddr = w1 >>> 0;
            // If we already know dimensions, record now
            maybeRecordBlob();
          } else if (op === 0xF2) { // SETTILESIZE: w1 packs (w-1,h-1) in 10.2 fixed
            const xhi = ((w1 >>> 12) & 0xFFF) >>> 0; const yhi = (w1 & 0xFFF) >>> 0;
            const wPx = ((xhi >>> 2) + 1) >>> 0; const hPx = ((yhi >>> 2) + 1) >>> 0;
            lastW = wPx; lastH = hPx;
            // If we already have a SETTIMG, record now
            maybeRecordBlob();
          }
        }
      }
      const tlutsOut: { addr: string; entries: string[] }[] = [];
      for (const { addr, count } of tlutMap.values()) {
        const entries: string[] = [];
        const maxEntries = Math.min(256, count >>> 0);
        const bytes: Uint8Array = (bus.rdram.bytes as unknown as Uint8Array);
        for (let i = 0; i < maxEntries; i++) {
          const off = (addr + i * 2) >>> 0;
          if ((off + 2) > bytes.length) break;
          const lo = bytes[off + 1]! >>> 0; // BE16
          const hi = bytes[off]! >>> 0;
          const v = ((hi << 8) | lo) >>> 0;
          entries.push(`0x${v.toString(16)}`);
        }
        tlutsOut.push({ addr: toHex(addr), entries });
      }
      const blobsOut: { addr: string; dataHex: string }[] = [];
      for (const { addr, len } of blobMap.values()) {
        const arr = bus.rdram.bytes.subarray(addr, addr + len);
        const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        blobsOut.push({ addr: toHex(addr), dataHex: hex });
      }
      const cfgOut = {
        video: { width: toHex(width>>>0), height: toHex(height>>>0), origin: toHex((viOrigin !== 0 ? viOrigin : 0xF000) >>> 0) },
        timing: { start: 2, interval: 3, frames: framesOut.length, spOffset: 1 },
        f3dex: { strideWords: 256, bgStart: '0x001F', bgEnd: '0x07FF' },
        piLoads: piLoadsUniq.map(s => ({ cartAddr: toHex(s.cartAddr), dramAddr: toHex(s.dramAddr), length: toHex(s.length) })),
        tluts: tlutsOut.length ? tlutsOut : undefined,
        blobs: blobsOut.length ? blobsOut : undefined,
        frames: framesOut,
      } as any;
      await fsMod.promises.mkdir(pathMod.dirname(discoverOut), { recursive: true });
      await fsMod.promises.writeFile(discoverOut, JSON.stringify(cfgOut, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(`[discover] wrote full config to ${discoverOut} (frames=${framesOut.length}, piLoads=${piLoadsUniq.length})`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to write --discover-out file:', e);
    }
  }

  // Flush timing trace if requested
  let timingOut: any = undefined;
  if (traceTimingEnabled) {
    try {
      if (traceTimingPath) {
        const pathMod = await import('node:path');
        const dir = pathMod.dirname(traceTimingPath);
        if (!(fs as any).existsSync(dir)) (fs as any).mkdirSync(dir, { recursive: true });
        (fs as any).writeFileSync(traceTimingPath, timingLines.join('\n') + (timingLines.length ? '\n' : ''), 'utf8');
      }
    } catch {}
    timingOut = { profile: timingProfile, path: traceTimingPath || null, lines: traceTimingPath ? undefined : timingLines };
  }

  console.log(JSON.stringify({
    command: 'rom-boot-run',
    rom: file,
    entryPC: boot.entryPC >>> 0,
    headerInitialPC: headerInitialPC >>> 0,
    endPC: cpu.pc >>> 0,
    cycles,
    viInterval,
    frames: frames.length,
    vi: { origin: viOrigin >>> 0, width: viWidth >>> 0 },
    events: { spStarts, spStatusWrites, spLastStatus: `0x${(spLastStatusVal>>>0).toString(16)}`, piDmas: piReads, piStatusWrites, piStatusReads, piStatusReadsBusy, piStatusLast: `0x${(piStatusReadLast>>>0).toString(16)}`, miInitModeWrites, miIntrWrites, miIntrMaskWrites, viStatusWrites, viOriginWrites, viWidthWrites, dpStatusWrites, dpIntrAcks, spRdDmas: spRdCount, spWrDmas: spWrCount, siWr64: siWr64Count, siRd64: siRd64Count },
    ostasks: ostasks.length ? ostasks : undefined,
    stopReason: stopReason || null,
    snapshot: snapshot || null,
    discovered: discover ? piLoads : undefined,
    bridge: bridgeCRC32 ? { crc32: bridgeCRC32, snapshot: bridgeSnapshotPath } : undefined,
    ipl,
    jumpedToHeader: jumpedToHeader || undefined,
    trace: traceBoot > 0 ? trace : undefined,
    deviceEvents: traceBoot > 0 ? events : undefined,
    cpuWarnings: cpuWarnings.length ? cpuWarnings : undefined,
    cp0Trace: traceCp0 ? cp0Trace : undefined,
    dump,
    disasm,
    pokes: appliedPokes.length ? appliedPokes : undefined,
    scheduledPokes: scheduledPokes.length ? scheduledPokes : undefined,
    dumpAfter: dumpAfter && dumpAfter.length ? dumpAfter : undefined,
    timing: timingOut,
  }, null, 2));
}

async function runTraceCompare(args: string[]) {
  // Options: --trace path --rom path [--pif path] [--reset] [--max-steps N] [--skip N] [--report path.json] [--format auto]
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a.startsWith('--')) { const key = a.slice(2); const next = (i + 1 < args.length) ? args[i + 1] : undefined; const val = (next && !next.startsWith('--')) ? args[++i]! : '1'; opts[key] = val; } }
  const tracePath = String(opts['trace'] || opts['log'] || '');
  const romPath = String(opts['rom'] || '');
  const pifPath = opts['pif'] ? String(opts['pif']) : '';
  const pifShift = parseNum(opts['pif-shift'] || opts['pifShift'], 0) | 0; // shift PIF bytes by N (compat for variant dumps)
  const pifShiftFromOpt = opts['pif-shift-from'] || opts['pifShiftFrom'] || '';
  const pifShiftFrom = pifShiftFromOpt ? (parseNum(pifShiftFromOpt, 0) >>> 0) : 0 >>> 0; // apply shift starting at this byte offset
  const seedPif = Object.prototype.hasOwnProperty.call(opts, 'seed-pif') || Object.prototype.hasOwnProperty.call(opts, 'seedPif') || Object.prototype.hasOwnProperty.call(opts, 'seed_pif');
  const wantReset = Object.prototype.hasOwnProperty.call(opts, 'reset') || !!pifPath;
  const maxSteps = parseNum(opts['max-steps'] || opts['max'] || opts['limit'], 0) >>> 0;
  let skip = parseNum(opts['skip'] || '0', 0) >>> 0;
  const reportPath = opts['report'] ? String(opts['report']) : '';
  const format = String(opts['format'] || 'auto').toLowerCase();
  const compareMode = String(opts['compare'] || 'full').toLowerCase(); // 'full' or 'pc'
  const regsShift = parseNum(opts['regs-shift'] || opts['regsShift'], 1) | 0; // default 1 to match CEN64 pre-state printing lag
  const mmioRing = parseNum((opts['mmio-ring'] || (opts as any)['mmioRing'] || (opts as any)['mmio_ring']) as string | undefined, 16384) >>> 0;
  const mmioRecentCount = parseNum((opts['mmio-recent'] || (opts as any)['mmioRecent'] || (opts as any)['mmio_recent']) as string | undefined, 512) >>> 0;
  const alignPcOpt = opts['align-pc'] || opts['alignPc'] || '';
  const alignPc = alignPcOpt ? parseNum(alignPcOpt, 0) >>> 0 : 0 >>> 0;
  let cicOpt = (opts['cic'] || '').toLowerCase();
  if (!tracePath || !romPath) { console.error('trace-compare requires --trace <path> and --rom <path>'); process.exit(1); }

  const fs = await import('node:fs');
  const path = await import('node:path');
  const text = fs.readFileSync(tracePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  type TraceRec = { pc?: number; instr?: number; regs?: Map<number, number> };

  function parseHexOrDec(s: string): number { const t = s.trim(); if (/^0x[0-9a-fA-F]+$/.test(t)) { try { const b = BigInt(t); return Number(b & 0xFFFFFFFFn) >>> 0; } catch { return parseInt(t, 16) >>> 0; } } if (/^[0-9A-Fa-f]{6,16}$/.test(t)) { try { const b = BigInt('0x' + t); return Number(b & 0xFFFFFFFFn) >>> 0; } catch { return parseInt(t, 16) >>> 0; } } const n = Number(t); return Number.isFinite(n) ? (n >>> 0) : 0; }

  const recs: TraceRec[] = [];
  const pcRe = /(?:^|\b)(?:pc|PC)\s*[:=]\s*(0x[0-9a-fA-F]+|\d+)/;
  // Also support lines like "FFFFFFFF80000000: ..."
  const pcAltRe = /^\s*([0-9A-Fa-f]{8,16})\s*:/;
  const insnRe = /(?:^|\b)(?:insn|instr|opcode|op|word)\s*[:=]\s*(0x[0-9a-fA-F]+|\d+)/;
  const iwRe = /(?:^|\b)(?:iw|IW)\s*[:=]\s*(0x[0-9a-fA-F]+|[0-9A-Fa-f]+)/;
  const regGlobalRe = /(?:^|\b)(?:r|R|gpr|GPR)\s*(\d{1,2})\s*[:=]\s*(0x[0-9a-fA-F]+|[0-9A-Fa-f]+|\d+)/g;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    // Strict: only consider lines that specify a PC explicitly (prefix or pc=)
    let mpc = ln.match(pcRe); if (!mpc) mpc = ln.match(pcAltRe);
    if (!mpc) continue; // skip non-instruction lines
    const rec: TraceRec = {};
    rec.pc = parseHexOrDec(mpc[1]!);
    let mi = ln.match(insnRe); if (!mi) mi = ln.match(iwRe);
    if (mi) rec.instr = parseHexOrDec(mi[1]!);
    if (format === 'auto') {
      const regs = new Map<number, number>();
      let mm: RegExpExecArray | null;
      const re = new RegExp(regGlobalRe);
      while ((mm = re.exec(ln)) !== null) {
        const idx = parseInt(mm[1]!, 10) >>> 0; const val = parseHexOrDec(mm[2]!);
        if (idx < 32) regs.set(idx, val >>> 0);
      }
      if (regs.size > 0) rec.regs = regs;
    }
    recs.push(rec);
  }

  // If CIC is 'auto', pick the seed that matches the most steps in a short trial
  if (cicOpt === 'auto') {
    // Try canonical PIF RAM seed values for common CICs.
    // 6102 and 7102 share 0x00003F3F; 6105 uses 0x0000913F.
    const trySeeds: { name: string; seed: number }[] = [
      { name: '6102', seed: 0x00003F3F >>> 0 },
      { name: '6105', seed: 0x0000913F >>> 0 },
    ];
    const trialMax = Math.min(4096, recs.length);
    const runTrial = (seedVal: number): number => {
      // Minimal trial: create fresh emulator, seed PIF, run compare loop with limited steps
      const rdr = new RDRAM(8 * 1024 * 1024);
      const bs = new Bus(rdr);
      const cp = new CPU(bs);
      const sysT = new System(cp, bs);
      // Seed ROM
      try {
        const fsT = require('node:fs');
        const pathT = require('node:path');
        const romBuf = fsT.readFileSync(pathT.isAbsolute(romPath) ? romPath : pathT.resolve(romPath));
        const core = require('@n64/core');
        const be = core.normalizeRomToBigEndian(new Uint8Array(romBuf)).data;
        bs.setROM(be);
        // Optional PIF ROM
        if (pifPath) {
          const pifBuf = fsT.readFileSync(pathT.isAbsolute(pifPath) ? pifPath : pathT.resolve(pifPath));
          const u8 = new Uint8Array(pifBuf);
          bs.setPIFROM(u8);
          // seed PIF RAM with the candidate seed
          const pr = (bs.si as any).pifRam as Uint8Array;
          pr.fill(0);
          pr[0x24] = (seedVal>>>24)&0xff; pr[0x25] = (seedVal>>>16)&0xff; pr[0x26] = (seedVal>>>8)&0xff; pr[0x27] = seedVal&0xff;
          pr[0x3F] = 0x00;
        }
        // Pre-stage IPL
        bs.sp.dmem.fill(0); bs.sp.imem.fill(0);
        const srcOffT = 0x40 >>> 0; const endOffT = Math.min(be.length, 0x1000) >>> 0;
        if ((endOffT - srcOffT) > 0) bs.sp.dmem.set(be.subarray(srcOffT, endOffT), srcOffT);
        const imemSrcT = 0x1000 >>> 0; const imemEndT = Math.min(be.length, 0x2000) >>> 0;
        if ((imemEndT - imemSrcT) > 0) bs.sp.imem.set(be.subarray(imemSrcT, imemEndT), 0x0000);
        // Start PC
        if (wantReset) cp.pc = 0xBFC00000 >>> 0; else {
          const header = require('@n64/core').parseHeader(be);
          bs.rdram.bytes.set(be.subarray(0, Math.min(be.length, bs.rdram.bytes.length)), 0);
          cp.pc = header.initialPC >>> 0;
        }
        // Align start index to our chosen start PC
        let startI = 0; {
          const wantPC = cp.pc >>> 0;
          const idx = recs.findIndex(r => (r.pc !== undefined) && ((r.pc>>>0) === wantPC));
          startI = (idx >= 0 ? idx : 0);
        }
        // Trial loop
        let stepsT = 0; let prevPc = 0 >>> 0; let prevInstr = 0 >>> 0;
        for (let i = startI; i < recs.length && stepsT < trialMax; i++, stepsT++) {
          const r = recs[i]!;
          const curPC0 = cp.pc >>> 0;
          const curInstr0 = bs.loadU32(curPC0 >>> 0) >>> 0;
          // Simple branch commit alignment (same as main)
          let curPC = curPC0 >>> 0, curInstr = curInstr0 >>> 0;
          if (i >= 2) {
            const prevR = recs[i - 1]!; const prev2R = recs[i - 2]!;
            const prevPcR = prevR.pc ?? 0; const prev2PcR = prev2R.pc ?? 0; const prev2IwR = prev2R.instr ?? 0;
            const ourAtDelayEnd = ((curPC0 >>> 0) === (((prevPcR >>> 0) + 4) >>> 0));
            const op = (prev2IwR >>> 26) & 0x3f; const imm = prev2IwR & 0xffff; const off = (((imm << 16) >> 16) << 2) >>> 0;
            const targetBranch = ((prev2PcR + 4 + off) >>> 0);
            const targetJump = (op === 0x02 || op === 0x03) ? (((prev2PcR & 0xF0000000) | ((prev2IwR & 0x03ffffff) << 2)) >>> 0) : 0;
            const targetUse = (op === 0x02 || op === 0x03) ? targetJump : targetBranch;
            if (ourAtDelayEnd && (r.pc !== undefined) && ((r.pc>>>0) === targetUse)) {
              curPC = targetUse >>> 0; curInstr = bs.loadU32(curPC >>> 0) >>> 0;
            }
          }
          // PC/Instr check
          const pcOk = (r.pc === undefined) || ((r.pc>>>0) === curPC);
          const instrOk = (r.instr === undefined) || ((r.instr>>>0) === curInstr);
          if (!pcOk || !instrOk) return stepsT;
          // Step and continue
          prevPc = curPC; prevInstr = curInstr;
          try { cp.step(); } catch { return stepsT; }
        }
        return stepsT;
      } catch { return 0; }
    };
    let best = { name: '6102', seed: 0x80371240 >>> 0, steps: -1 };
    for (const c of trySeeds) {
      const s = runTrial(c.seed);
      if (s > best.steps) best = { name: c.name, seed: c.seed, steps: s };
    }
    cicOpt = best.name; // use the selected CIC name downstream
  }

  // Setup emulator
  const rdram = new RDRAM(8 * 1024 * 1024);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  // Hook PI/SI DMA into the system scheduler so completion events fire after realistic latency
  try { (bus.pi as any).setDMAScheduler?.((cycles: number, cb: () => void) => sys.scheduleAt(((sys.cycle >>> 0) + (cycles >>> 0)) >>> 0, cb)); } catch {}
  try { (bus.si as any).setDMAScheduler?.((cycles: number, cb: () => void) => sys.scheduleAt(((sys.cycle >>> 0) + (cycles >>> 0)) >>> 0, cb)); } catch {}
  // For trace-compare, defer PIF command processing to SI DMA completion to better mirror hardware
  try { (bus.si as any).setDeferPIF?.(true); } catch {}
  // Apply optional latency model overrides if provided
  try {
    const siLatencyOverride = parseNum(opts['si-latency'] || (opts as any)['siLatency'] || (opts as any)['si_latency'], 0);
    const siIoAutoClr = parseNum(opts['si-io-auto-clear-delay'] || (opts as any)['siIoAutoClearDelay'] || (opts as any)['si_io_auto_clear_delay'], 0);
    const piLatBaseOverride = parseNum(opts['pi-lat-base'] || (opts as any)['piLatBase'] || (opts as any)['pi_lat_base'], 0);
    const piBytesPerCycleOverride = parseNum(opts['pi-bpc'] || (opts as any)['piBPC'] || (opts as any)['pi_bytes_per_cycle'], 0);
    if (siLatencyOverride > 0) (bus.si as any).setLatency?.(siLatencyOverride >>> 0);
    if (siIoAutoClr > 0) (bus.si as any).setAutoClearIoBusyDelay?.(siIoAutoClr >>> 0);
    if ((piLatBaseOverride > 0) || (piBytesPerCycleOverride > 0)) {
      const defaultBase = 50 >>> 0;
      const defaultBpc = 2 >>> 0;
      const b = (piLatBaseOverride > 0 ? piLatBaseOverride : defaultBase) >>> 0;
      const t = (piBytesPerCycleOverride > 0 ? piBytesPerCycleOverride : defaultBpc) >>> 0;
      (bus.pi as any).setLatencyModel?.(b >>> 0, t >>> 0);
    }
  } catch {}
  // MMIO instrumentation: record recent reads/writes
  const mmioEvents: { cyc: number; dev: string; op: 'rd'|'wr'; off: number; val?: number }[] = [];
  const pushEvt = (dev: string, op: 'rd'|'wr', off: number, val?: number) => {
    mmioEvents.push({ cyc: sys.cycle>>>0, dev, op, off: off>>>0, val: val!==undefined ? (val>>>0) : undefined });
    if (mmioEvents.length > mmioRing) mmioEvents.shift();
  };
  // Wrap device read/write to capture events (non-invasive)
  const wrapDev = (dev: any, name: string) => {
    try {
      const r = dev.readU32?.bind(dev) as ((off: number)=>number)|undefined;
      const w = dev.writeU32?.bind(dev) as ((off: number, val: number)=>void)|undefined;
      if (r) (dev as any).readU32 = (off: number) => { const v = r(off)>>>0; pushEvt(name,'rd',off>>>0,v>>>0); return v; };
      if (w) (dev as any).writeU32 = (off: number, val: number) => { pushEvt(name,'wr',off>>>0,val>>>0); w(off,val>>>0); };
    } catch {}
  };
  wrapDev(bus.mi,'MI'); wrapDev(bus.sp,'SP'); wrapDev(bus.dp,'DP'); wrapDev(bus.vi,'VI'); wrapDev(bus.ai,'AI'); wrapDev(bus.pi,'PI'); wrapDev(bus.si,'SI'); wrapDev(bus.ri,'RI');
  // Instrument PI activity (cart/dram/len) for diagnostics
  const piDmas: { cart: number; dram: number; len: number }[] = [];
  let piLastCart = 0 >>> 0; let piLastDram = 0 >>> 0;
  const piWriteOrig = bus.pi.writeU32.bind(bus.pi) as (off: number, val: number) => void;
  (bus.pi as any).writeU32 = (off: number, val: number) => {
    const o = (off >>> 0); const v = (val >>> 0);
    if (o === 0x00) piLastDram = v >>> 0; // DRAM_ADDR
    else if (o === 0x04) piLastCart = v >>> 0; // CART_ADDR
    else if (o === 0x08) { // RD_LEN
      const len = (((v & 0x00ffffff) >>> 0) + 1) >>> 0;
      piDmas.push({ cart: piLastCart >>> 0, dram: piLastDram >>> 0, len });
    }
    piWriteOrig(o, v);
  };
  const rom = fs.readFileSync(path.isAbsolute(romPath) ? romPath : path.resolve(romPath));
  const { normalizeRomToBigEndian, parseHeader } = await import('@n64/core');
  const { data: beRom } = normalizeRomToBigEndian(new Uint8Array(rom));
  bus.setROM(beRom);

  // Optional PIF boot ROM: map at 0x1FC00000 and start at reset vector
  if (pifPath) {
    try {
      const pif = fs.readFileSync(path.isAbsolute(pifPath) ? pifPath : path.resolve(pifPath));
      const u8 = new Uint8Array(pif);
      // Normalize variant: if last 4 bytes are all 0xFF, zero them to match CEN64 trace variant
      if (u8.length >= 4) {
        const L = u8.length;
        if ((u8[L-1]===0xFF)&&(u8[L-2]===0xFF)&&(u8[L-3]===0xFF)&&(u8[L-4]===0xFF)) {
          u8[L-1]=0; u8[L-2]=0; u8[L-3]=0; u8[L-4]=0;
        }
      }
      // Optional shift for PIF ROM bytes to accommodate different dump alignments across emulators.
      // Positive shift moves content forward in address space (new[i] = old[i - shift]); negative shifts move backward.
      let pifBytes = u8;
      if (pifShift !== 0) {
        const shifted = new Uint8Array(u8.length);
        shifted.fill(0);
        const start = (pifShiftFrom >>> 0);
        for (let i = 0; i < shifted.length; i++) {
          if (i < start) { shifted[i] = u8[i]!; continue; }
          const src = pifShift > 0 ? (i - pifShift) : (i + ((-pifShift) >>> 0));
          if (src >= start && src < u8.length) shifted[i] = u8[src]!;
        }
        pifBytes = shifted;
      }
      bus.setPIFROM(pifBytes);
      // Optionally initialize PIF RAM seed bytes; default is to leave RAM cleared when a real PIF ROM is provided
      if (seedPif) {
        try {
          const parseCIC = (s: string): string => {
            const t = (s||'').trim().toLowerCase();
            if (!t) return '6102';
            if (t === '6102' || t === 'ntsc-u' || t === 'sm64') return '6102';
            if (t === '6105' || t === '3f3f') return '6105';
            if (t === '7102' || t === 'pal') return '7102';
            return t;
          };
          (bus as any).setCICSeed?.(parseCIC(cicOpt));
        } catch {}
      }
    } catch (e) {
      console.error(`[trace] failed to read PIF ROM at ${pifPath}:`, e);
      process.exit(1);
    }
  }

  // Pre-stage IPL3 into SP DMEM so a reset-boot finds valid code at 0xA4000040.
  // Leave IMEM to be populated by real IPL behavior (via SP DMA) to better match hardware timing.
  bus.sp.dmem.fill(0);
  bus.sp.imem.fill(0);
  const srcOff = 0x40 >>> 0;
  const endOff = Math.min(beRom.length, 0x1000) >>> 0;
  const copyLen = (endOff - srcOff) >>> 0;
  if (copyLen > 0) bus.sp.dmem.set(beRom.subarray(srcOff, endOff), srcOff);

  // Decide starting PC
  if (wantReset) cpu.pc = 0xBFC00000 >>> 0; else {
    const header = parseHeader(beRom);
    // Also copy header image to RDRAM for simple virtual fetch comparison convenience
    bus.rdram.bytes.set(beRom.subarray(0, Math.min(beRom.length, bus.rdram.bytes.length)), 0);
    cpu.pc = header.initialPC >>> 0;
  }

  // If skip not explicitly provided, auto-align to first trace record whose PC matches our chosen alignment target.
  // Priority: --align-pc if provided, else our start PC (reset or header).
  let startIdx = 0;
  if (skip > 0) startIdx = Math.min(skip >>> 0, recs.length);
  else {
    const wantPC = alignPc ? (alignPc >>> 0) : (cpu.pc >>> 0);
    const idx = recs.findIndex(r => (r.pc !== undefined) && ((r.pc>>>0) === wantPC));
    startIdx = (idx >= 0 ? idx : 0);
    // If we aligned to a PC different from our CPU start, adjust the CPU start as well when not forcing reset.
    if (!wantReset && alignPc) cpu.pc = wantPC >>> 0;
  }

  function vaToPhys(va: number): number | null {
    const a = va >>> 0; const region = a >>> 28; if (region === 0x8 || region === 0x9) return (a - 0x80000000) >>> 0; if (region === 0xA || region === 0xB) return (a - 0xA0000000) >>> 0; if (region < 0x8) return a >>> 0; return null;
  }
  function be32(buf: Uint8Array, off: number): number { const b0 = buf[off] ?? 0; const b1 = buf[off+1] ?? 0; const b2 = buf[off+2] ?? 0; const b3 = buf[off+3] ?? 0; return (((b0<<24)|(b1<<16)|(b2<<8)|b3)>>>0); }

  const max = (maxSteps && maxSteps > 0) ? Math.min(maxSteps, recs.length - startIdx) : (recs.length - startIdx);
  let divergence: any = null;
  let steps = 0;
  let prev = { trace: null as any, ours: null as any };
  // Keep a short history of our pre-step GPR snapshots to align with external trace semantics
  const oursPreHistory: Uint32Array[] = [];
  // Track last writer per GPR index for diagnostics
  const lastWrite: ({ pc: number; instr: number; value: number; effAddr?: number; mem32?: number; mem8?: number } | null)[] = new Array(32).fill(null);
  for (let i = startIdx; i < recs.length && steps < max; i++, steps++) {
    const r = recs[i]!;
    const curPC0 = cpu.pc >>> 0;
    // Use full bus mapping so PIF ROM and SP DMEM/IMEM regions are visible
    const curInstr0 = bus.loadU32(curPC0 >>> 0) >>> 0;
    // Snapshot pre-step GPRs
    const preRegs = new Uint32Array(cpu.regs);
    oursPreHistory.push(preRegs);
    // Optional: commit-fudge for branch-after-delay-slot to align with CEN64 logging
    let curPC = curPC0 >>> 0;
    let curInstr = curInstr0 >>> 0;
    let usedCommitFudge = false;
    if (i >= 2) {
      const prevR = recs[i - 1]!; const prev2R = recs[i - 2]!;
      const prevPc = prevR.pc ?? 0; const prev2Pc = prev2R.pc ?? 0; const prev2Iw = prev2R.instr ?? 0;
      const ourAtDelayEnd = ((curPC0 >>> 0) === (((prevPc >>> 0) + 4) >>> 0));
      const op = (prev2Iw >>> 26) & 0x3f; const imm = prev2Iw & 0xffff; const off = (((imm << 16) >> 16) << 2) >>> 0; const targetBranch = ((prev2Pc + 4 + off) >>> 0);
      const isBranch = (op === 0x04 || op === 0x05 || op === 0x06 || op === 0x07 || op === 0x14 || op === 0x15 || op === 0x16 || op === 0x17 || op === 0x01);
      // J/JAL target
      const targetJump = (op === 0x02 || op === 0x03) ? (((prev2Pc & 0xF0000000) | ((prev2Iw & 0x03ffffff) << 2)) >>> 0) : 0;
      const targetUse = (op === 0x02 || op === 0x03) ? targetJump : targetBranch;
      if (ourAtDelayEnd && (r.pc !== undefined) && ((r.pc >>> 0) === targetUse)) {
        // Compare using target PC to match CEN64's logging phase; CPU will commit at start of this step
        curPC = targetUse >>> 0;
        curInstr = bus.loadU32(curPC >>> 0) >>> 0;
        usedCommitFudge = true;
      } else if (ourAtDelayEnd && (r.pc !== undefined)) {
        // Fallback for JR/JALR (SPECIAL funct 0x08/0x09) dynamic targets
        const funct = prev2Iw & 0x3f;
        if (op === 0x00 && (funct === 0x08 || funct === 0x09)) {
          curPC = (r.pc >>> 0);
          curInstr = bus.loadU32(curPC >>> 0) >>> 0;
          usedCommitFudge = true;
        }
      }
    }
    // Compare if provided
    const pcOk = (r.pc === undefined) || ((r.pc >>> 0) === (curPC >>> 0));
    const instrOk = (r.instr === undefined) || ((r.instr >>> 0) === (curInstr >>> 0));

    // Special-case: CEN64 logs may include nullified delay-slot NOP after branch-likely not taken.
    // When that happens, PC in log = ours-4 and instr==0. Consume the record without stepping.
    if (!pcOk && (r.instr === 0) && ((r.pc! + 4) >>> 0) === (curPC >>> 0)) {
      prev = { trace: { pc: r.pc ?? null, instr: r.instr ?? null }, ours: { pc: curPC>>>0, instr: curInstr>>>0 } };
      continue;
    }

    let regsOk = (compareMode === 'pc');
    let compareShiftUsed = Math.max(0, regsShift|0);
    if ((compareMode !== 'pc') && r.regs && r.regs.size > 0) {
      // Build candidate reference snapshots to account for trace pre-state drift across branch/WA hazards.
      const baseShift = Math.max(0, regsShift|0);
      const fudgeRefIdx = Math.max(0, oursPreHistory.length - 2);
      const candidates: { ref: Uint32Array; usedShift: number }[] = [];
      // Primary (configured shift)
      {
        const idxHist = Math.max(0, oursPreHistory.length - 1 - baseShift);
        const ref = usedCommitFudge ? (oursPreHistory[fudgeRefIdx] ?? preRegs) : (oursPreHistory[Math.min(idxHist, oursPreHistory.length - 1)] ?? preRegs);
        candidates.push({ ref, usedShift: baseShift });
      }
      // Try baseShift+1 .. baseShift+4 as alternates (helps in deeper hazard windows)
      for (let extra = 1; extra <= 4; extra++) {
        const s = baseShift + extra;
        const idxHist = Math.max(0, oursPreHistory.length - 1 - s);
        const ref = usedCommitFudge ? (oursPreHistory[fudgeRefIdx] ?? preRegs) : (oursPreHistory[Math.min(idxHist, oursPreHistory.length - 1)] ?? preRegs);
        candidates.push({ ref, usedShift: s });
      }
      // Evaluate candidates and pick the first that matches all provided regs
      regsOk = false;
      for (const c of candidates) {
        let all = true;
        for (const [idx, val] of r.regs.entries()) {
          if ((idx|0) === 0) continue; // ignore r0 mismatches; r0 is hard-wired zero
          const got = (c.ref[idx] as number | undefined) ?? 0;
          if (((got>>>0) !== (val>>>0))) { all = false; break; }
        }
        if (all) { regsOk = true; compareShiftUsed = c.usedShift; break; }
      }
    }
    if (!pcOk || !instrOk || !regsOk) {
      divergence = {
        atLine: i, step: steps, reason: (!pcOk ? 'PC' : (!instrOk ? 'INSTR' : 'REG')),
        trace: { pc: r.pc ?? null, instr: r.instr ?? null },
        ours: { pc: curPC >>> 0, instr: curInstr >>> 0 },
        prev,
        mmioRecent: mmioEvents.slice(-(mmioRecentCount||0) || undefined as any),
        regsMismatch: r.regs && !regsOk ? Array.from(r.regs.entries()).filter(([idx]) => (idx|0)!==0).map(([idx, v]) => {
          const idxHist = Math.max(0, oursPreHistory.length - 1 - compareShiftUsed);
          const ref = usedCommitFudge ? preRegs : (oursPreHistory[Math.min(idxHist, oursPreHistory.length - 1)] ?? preRegs);
          const got = (ref[idx] as number | undefined) ?? 0;
          const lw = lastWrite[idx];
          let lwObj: any = undefined;
          if (lw) {
            lwObj = {
              pc: (lw.pc>>>0),
              instr: (lw.instr>>>0),
              value: (lw.value>>>0),
              effAddr: (lw.effAddr!==undefined ? (lw.effAddr>>>0) : undefined),
              mem32: (lw.mem32!==undefined ? (lw.mem32>>>0) : undefined),
              mem8: (lw.mem8!==undefined ? (lw.mem8>>>0) : undefined),
            };
            // If this was a load, try to annotate the source: whether it falls within a PI DMA'd region
            if (lw.effAddr !== undefined) {
              const pa = vaToPhys(lw.effAddr >>> 0);
              if (pa !== null) {
                const hit = piDmas.find(d => (pa >>> 0) >= (d.dram>>>0) && (pa >>> 0) < (((d.dram>>>0) + (d.len>>>0)) >>> 0));
                if (hit) {
                  (lwObj as any).memSrc = { kind: 'PI', cart: (hit.cart>>>0), dram: (hit.dram>>>0), len: (hit.len>>>0) };
                } else if ((pa >>> 0) < (bus.rdram.bytes.length >>> 0)) {
                  (lwObj as any).memSrc = { kind: 'RDRAM' };
                  // Provide a small hex window around the physical address to aid debugging (32 bytes centered on addr)
                  try {
                    const bytes: number[] = [];
                    for (let d = -16; d < 16; d++) {
                      const p = (pa + d) >>> 0;
                      if (p < (bus.rdram.bytes.length >>> 0)) bytes.push((bus.rdram.bytes[p] ?? 0) >>> 0);
                      else bytes.push(0);
                    }
                    (lwObj as any).memWindowHex = bytes.map(b => b.toString(16).padStart(2,'0')).join('');
                  } catch {}
                } else if ((pa >>> 0) >= (0x1FC007C0 >>> 0) && (pa >>> 0) < (0x1FC00800 >>> 0)) {
                  // PIF RAM (64 bytes) window
                  const off = ((pa >>> 0) - (0x1FC007C0 >>> 0)) >>> 0;
                  (lwObj as any).memSrc = { kind: 'PIF_RAM', off };
                  try {
                    const pr: Uint8Array = (bus.si as any).pifRam;
                    const start = Math.max(0, (off | 0) - 16);
                    const end = Math.min(64, (off | 0) + 16);
                    const bytes: number[] = [];
                    for (let i = start; i < end; i++) bytes.push((pr[i] ?? 0) >>> 0);
                    (lwObj as any).pifRamWindowHex = bytes.map(b => b.toString(16).padStart(2,'0')).join('');
                  } catch {}
                } else if ((pa >>> 0) >= (0x1FC00000 >>> 0) && (pa >>> 0) < (0x1FC10000 >>> 0)) {
                  (lwObj as any).memSrc = { kind: 'PIF_ROM' };
                } else if ((pa >>> 0) >= (0x10000000 >>> 0) && (pa >>> 0) < (((0x10000000 >>> 0) + (beRom.length >>> 0)) >>> 0)) {
                  (lwObj as any).memSrc = { kind: 'CART_ROM' };
                } else if ((pa >>> 0) >= (0x04300000 >>> 0) && (pa >>> 0) < (0x04300000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'MI', off: ((pa>>>0) - (0x04300000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04000000 >>> 0) && (pa >>> 0) < (0x04000000 + 0x2000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'SP', off: ((pa>>>0) - (0x04000000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04100000 >>> 0) && (pa >>> 0) < (0x04100000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'DP', off: ((pa>>>0) - (0x04100000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04400000 >>> 0) && (pa >>> 0) < (0x04400000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'VI', off: ((pa>>>0) - (0x04400000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04500000 >>> 0) && (pa >>> 0) < (0x04500000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'AI', off: ((pa>>>0) - (0x04500000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04600000 >>> 0) && (pa >>> 0) < (0x04600000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'PI', off: ((pa>>>0) - (0x04600000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04800000 >>> 0) && (pa >>> 0) < (0x04800000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'SI', off: ((pa>>>0) - (0x04800000>>>0))>>>0 };
                } else if ((pa >>> 0) >= (0x04700000 >>> 0) && (pa >>> 0) < (0x04700000 + 0x1000)) {
                  (lwObj as any).memSrc = { kind: 'MMIO', dev: 'RI', off: ((pa>>>0) - (0x04700000>>>0))>>>0 };
                } else {
                  (lwObj as any).memSrc = { kind: 'UNKNOWN' };
                }
              }
            }
          }
          return { idx, expected: v>>>0, got: (got>>>0), lastWriter: lwObj };
        }) : undefined,
      };
      break;
    }
    // Snapshot previous
    prev = { trace: { pc: r.pc ?? null, instr: r.instr ?? null }, ours: { pc: curPC>>>0, instr: curInstr>>>0 } };
    // Step one instruction (via system so scheduled DMA events fire)
    try { sys.stepCycles(1); } catch (e: any) {
      divergence = { atLine: i, step: steps, reason: 'EXCEPTION', error: String(e?.message || e), pc: curPC>>>0, instr: curInstr>>>0, prev };
      break;
    }
    // Record last writers to GPRs (compare post-step to pre-step snapshot)
    for (let gi = 1; gi < 32; gi++) {
      const before = ((preRegs[gi] as number | undefined) ?? 0) >>> 0;
      const after = (((cpu.regs[gi] as number | undefined) ?? 0) >>> 0);
      if (after !== before) lastWrite[gi] = { pc: curPC0 >>> 0, instr: curInstr0 >>> 0, value: after >>> 0 };
    }
    // If this instruction was a load, annotate effAddr/memory for the target rt
    {
      const iw = curInstr0 >>> 0; const op = (iw>>>26)&0x3f; const rs = (iw>>>21)&0x1f; const rt = (iw>>>16)&0x1f; const imm = iw & 0xffff;
      const se16 = (x: number) => (x<<16)>>16;
      const isLoad = (op===0x20)||(op===0x21)||(op===0x23)||(op===0x24)||(op===0x25); // lb, lh, lw, lbu, lhu
      if (isLoad && rt>0) {
        const base = ((preRegs[rs] as number | undefined) ?? 0) >>> 0;
        const ea = (base + (se16(imm) >>> 0)) >>> 0;
        if (lastWrite[rt] && lastWrite[rt]!.pc===curPC0 && lastWrite[rt]!.instr===curInstr0) {
          lastWrite[rt]!.effAddr = ea >>> 0;
          try { lastWrite[rt]!.mem32 = bus.loadU32(ea>>>0) >>> 0; } catch {}
          try { lastWrite[rt]!.mem8 = bus.loadU8(ea>>>0) >>> 0; } catch {}
        }
      }
    }
  }

  // Diagnostics: capture SI status and a hex dump of PIF RAM at end of run
  let siStatusNow: number | null = null;
  let pifRamHex: string | null = null;
  try { siStatusNow = (bus.si as any).status >>> 0; } catch { siStatusNow = null; }
  try {
    const pr: Uint8Array = (bus.si as any).pifRam;
    if (pr && pr.length === 64) {
      pifRamHex = Array.from(pr).map(b => b.toString(16).padStart(2,'0')).join('');
    }
  } catch { pifRamHex = null; }
  const siStatusReads = mmioEvents.filter(e => e.dev==='SI' && e.op==='rd' && (e.off>>>0)===0x18).length;
  const siStatusLast = (() => { const arr = mmioEvents.filter(e => e.dev==='SI' && e.op==='rd' && (e.off>>>0)===0x18); return arr.length ? (arr[arr.length-1]!.val ?? null) : null; })();

  const summary = {
    command: 'trace-compare', trace: tracePath, rom: romPath, totalLines: recs.length, skipped: startIdx, steps, divergence,
    cic: cicOpt || 'default',
    endPC: cpu.pc >>> 0,
    gpr: Array.from(cpu.regs).map(n => (n>>>0)),
    gprHi: Array.from(cpu.regsHi).map(n => (n>>>0)),
    cp0: { status: cpu.cop0.read(12)>>>0, cause: cpu.cop0.read(13)>>>0, epc: cpu.cop0.read(14)>>>0 },
    mi: { pending: (bus.mi as any).intrPending>>>0, mask: (bus.mi as any).intrMask>>>0 },
    piDmas: piDmas.map(d => ({ cart: d.cart>>>0, dram: d.dram>>>0, len: d.len>>>0 })),
    si: { status: siStatusNow, statusReads: siStatusReads, statusLast: siStatusLast },
    pifRamHex,
  };
  if (reportPath) {
    try { await (await import('node:fs')).promises.mkdir(path.dirname(reportPath), { recursive: true }); await (await import('node:fs')).promises.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf8'); console.log(`[trace] wrote report ${reportPath}`); } catch (e) { console.error('[trace] failed to write report:', e); }
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printUsage();
    return;
  }
  if (cmd === 'sm64-demo') {
    await runSm64Demo(argv.slice(1));
    return;
  }
  if (cmd === 'rspdl-ci8-ring') {
    await runRspdlCi8Ring(argv.slice(1));
    return;
  }
  if (cmd === 'uc-run') {
    await runUcRun(argv.slice(1));
    return;
  }
  if (cmd === 'f3d-run') {
    await runF3dRun(argv.slice(1));
    return;
  }
  if (cmd === 'f3d-run-table') {
    await runF3dRunTable(argv.slice(1));
    return;
  }
  if (cmd === 'f3dex-run-table') {
    await runF3dexRunTable(argv.slice(1));
    return;
  }
  if (cmd === 'f3dex-rom-run') {
    await runF3dexRomRun(argv.slice(1));
    return;
  }
  if (cmd === 'sm64-rom-title') {
    await runSm64RomTitle(argv.slice(1));
    return;
  }
  if (cmd === 'rom-boot-run') {
    await runRomBootRun(argv.slice(1));
    return;
  }
  if (cmd === 'trace-compare') {
    await runTraceCompare(argv.slice(1));
    return;
  }
  if (cmd === 'rom-scan-mio0') {
    await runRomScanMio0(argv.slice(1));
    return;
  }
  if (cmd === 'rom-probe-mio0') {
    await runRomProbeMio0(argv.slice(1));
    return;
  }
  if (cmd === 'curate-images') {
    await runCurateImages(argv.slice(1));
    return;
  }
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

