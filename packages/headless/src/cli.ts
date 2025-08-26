#!/usr/bin/env node
import { Bus, RDRAM, CPU, System, runSM64TitleDemoDP, runSM64TitleDemoSPDP, writeSM64TitleTasksToRDRAM, scheduleSPTitleTasksFromRDRAMAndRun, writeRSPTitleDLsToRDRAM, scheduleRSPDLFramesAndRun, writeUcAsRspdl, f3dToUc, scheduleRSPDLFromTableAndRun, scheduleF3DEXFromTableAndRun, hlePiLoadSegments, decompressMIO0, viScanout } from '@n64/core';

function parseNum(val: string | undefined, def: number): number {
  if (val === undefined) return def;
  const s = val.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16) >>> 0;
  const n = Number(s);
  return Number.isFinite(n) ? (n >>> 0) : def;
}

function crc32(data: Uint8Array): string {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < data.length; i++) {
    let c = (crc ^ data[i]!) & 0xFF;
    for (let k = 0; k < 8; k++) {
      const mask = -(c & 1);
      c = (c >>> 1) ^ (0xEDB88320 & mask);
    }
    crc = (crc >>> 8) ^ c;
  }
  crc = (~crc) >>> 0;
  return (crc >>> 0).toString(16).padStart(8, '0');
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
 
 Examples:
   n64-headless sm64-demo --frames 1
   n64-headless sm64-demo --frames 2 --snapshot tmp/sm64_2f.ppm
   n64-headless f3dex-rom-run tmp/rom_demo.json --snapshot tmp/rom.png
   n64-headless rom-boot-run mario64.z64 --cycles 5000000 --vi-interval 10000 --width 320 --height 240 --snapshot tmp/boot/boot.png
 `);
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
  console.log(JSON.stringify({ command: 'f3dex-rom-run', cfg: { width, height, origin, start, interval, frames, spOffset, tableBase, stagingBase, strideWords }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
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
  console.log(JSON.stringify({ command: 'sm64-rom-title', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res, snapshot: snapshot||null }, null, 2));
}

async function runRomBootRun(args: string[]) {
  // Arguments: <rom> [--cycles N] [--vi-interval CYC] [--width W] [--height H] [--snapshot path.png] [--discover] [--boot path.json] [--boot-out path.json]
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
  const bootPath = opts['boot'];
  const bootOut = opts['boot-out'];
  const iplHle = Object.prototype.hasOwnProperty.call(opts, 'ipl-hle');
  const iplCart = parseNum(opts['ipl-cart'], 0);
  const iplLen = parseNum(opts['ipl-len'], 2 * 1024 * 1024);

  const fs = await import('node:fs');
  const rom = fs.readFileSync(file);

  // Bigger RDRAM so KSEG0 physical addresses are in range
  const rdram = new RDRAM(8 * 1024 * 1024);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  // Utility to hex-encode a byte array
  const toHex = (arr: Uint8Array) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  const be32 = (arr: Uint8Array, off: number) => (((arr[off]! << 24) | (arr[off+1]! << 16) | (arr[off+2]! << 8) | (arr[off+3]!)) >>> 0);

  // HLE boot sets PC from header and makes ROM available to PI
  const { hleBoot, hlePiLoadSegments } = await import('@n64/core');
  const boot = hleBoot(cpu, bus, new Uint8Array(rom));

  // Heuristic pre-stage when discovering and no boot script provided:
  if (!bootPath && discover) {
    const basePhys = (boot.initialPC >>> 0) - 0x80000000 >>> 0;
    const guessLen = Math.min((rom.length >>> 0), 2 * 1024 * 1024);
    if (basePhys + guessLen <= bus.rdram.bytes.length) {
      // Copy a large slice from ROM start to the entrypoint region
      hlePiLoadSegments(bus as any, [ { cartAddr: 0 >>> 0, dramAddr: basePhys >>> 0, length: guessLen >>> 0 } ], true);
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
  let lastPiDram = 0 >>> 0;
  let lastPiCart = 0 >>> 0;
  const piLoads: { cartAddr: number; dramAddr: number; length: number }[] = [];

  // Track SP DMA and OSTask-like snapshots
  let spMemAddr = 0 >>> 0;
  let spDramAddr = 0 >>> 0;
  const spDmas: { op: 'RD'|'WR'; memAddr: number; dramAddr: number; length: number }[] = [];
  const ostasks: { index: number; memAddr: number; dmas: { op: string; memAddr: string; dramAddr: string; length: string }[]; dmemFirst256Hex: string; task?: any }[] = [];

  const spWrite = bus.sp.writeU32.bind(bus.sp) as (off: number, val: number) => void;
  (bus.sp as any).writeU32 = (off: number, val: number) => {
    const o = off >>> 0; const v = val >>> 0;
    if (o === 0x00) {
      if ((v & 0x1) !== 0 && v === 1) {
        spStarts++;
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
          // Only include if fields look non-zero reasonably
          const fields = { type, flags, ucode_boot, ucode_boot_size, ucode, ucode_size, ucode_data, ucode_data_size, dram_stack, dram_stack_size, output_buff, output_buff_size, data_ptr, data_size, yield_data_ptr, yield_data_size } as const;
          const anyNonZero = Object.values(fields).some(v => (v >>> 0) !== 0);
          if (anyNonZero) {
            task = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `0x${(v>>>0).toString(16)}`]));
          }
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
      spDramAddr = v >>> 0;
    } else if (o === 0x08) { // SP_RD_LEN
      const len = ((v & 0x00ffffff) >>> 0) + 1;
      spDmas.push({ op: 'RD', memAddr: spMemAddr >>> 0, dramAddr: spDramAddr >>> 0, length: len >>> 0 });
    } else if (o === 0x0C) { // SP_WR_LEN
      const len = ((v & 0x00ffffff) >>> 0) + 1;
      spDmas.push({ op: 'WR', memAddr: spMemAddr >>> 0, dramAddr: spDramAddr >>> 0, length: len >>> 0 });
    }
    spWrite(o, v);
  };
  const piWrite = bus.pi.writeU32.bind(bus.pi) as (off: number, val: number) => void;
  (bus.pi as any).writeU32 = (off: number, val: number) => {
    const offU = off >>> 0;
    const valU = val >>> 0;
    if (offU === 0x00) lastPiDram = valU >>> 0; // PI_DRAM_ADDR
    if (offU === 0x04) lastPiCart = valU >>> 0; // PI_CART_ADDR
    if (offU === 0x08) { // PI_RD_LEN
      piReads++;
      const len = ((valU & 0x00ffffff) >>> 0) + 1;
      piLoads.push({ cartAddr: lastPiCart >>> 0, dramAddr: lastPiDram >>> 0, length: len >>> 0 });
    }
    piWrite(offU, valU);
  };
  const viWrite = bus.vi.writeU32.bind(bus.vi) as (off: number, val: number) => void;
  (bus.vi as any).writeU32 = (off: number, val: number) => {
    viWrite(off, val >>> 0);
    // Mirror public fields for convenience
    if ((off >>> 0) === 0x14) viOrigin = val >>> 0; // VI_ORIGIN_OFF
    if ((off >>> 0) === 0x18) viWidth = val >>> 0;  // VI_WIDTH_OFF
  };

  // Optional IPL-HLE pre-staging now that PI writes are instrumented
  let ipl: undefined | { cartAddr: string; dramAddr: string; length: string } = undefined;
  if (iplHle) {
    const { hleIplStage } = await import('@n64/core');
    const res = hleIplStage(bus, new Uint8Array(rom), { initialPC: boot.initialPC >>> 0, cartStart: iplCart >>> 0, length: iplLen >>> 0 });
    ipl = { cartAddr: `0x${(res.cartAddr>>>0).toString(16)}`, dramAddr: `0x${(res.dramAddr>>>0).toString(16)}`, length: `0x${(res.length>>>0).toString(16)}` };
  }

  // Schedule periodic VI vblank and snapshot if configured
  const frames: Uint8Array[] = [];
  sys.scheduleEvery(viInterval >>> 0, viInterval >>> 0, Math.max(1, Math.floor(cycles / Math.max(1, viInterval))), () => {
    bus.vi.vblank();
    if (snapshot && viOrigin !== 0 && viWidth !== 0) {
      const img = viScanout(bus, width, height);
      frames.push(img);
    }
  });

  // Step CPU for requested cycles; trap errors to report gracefully
  let stopReason: string | null = null;
  try {
    sys.stepCycles(cycles);
  } catch (e: any) {
    stopReason = String(e?.message || e);
  }

  // If discovering and no PI activity, try multi-window heuristic reattempts
  if (discover && piLoads.length === 0) {
    const { hleBoot: hleBoot2, hlePiLoadSegments: hlePi2 } = await import('@n64/core');

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
        const basePhys2 = (boot2.initialPC >>> 0) - 0x80000000 >>> 0;
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

  // If we parsed any OSTask with a plausible data_ptr, attempt an HLE F3DEX bridge to render one frame
  let bridgeCRC32: string | null = null;
  let bridgeSnapshotPath: string | null = null;
  try {
    const last = [...ostasks].reverse().find(t => t.task && typeof t.task.data_ptr === 'string');
    if (last && last.task) {
      const ptrHex: string = last.task.data_ptr;
      const dlPtr = parseNum(ptrHex, 0) >>> 0;
      if (dlPtr >>> 0) {
        // Build a 1-entry table pointing to the DL and run scheduleF3DEXFromTableAndRun for one frame
        const fbBytes = (width * height * 2) >>> 0;
        const fbOrigin = (viOrigin >>> 0) || 0xF000;
        const tableBase = (fbOrigin + fbBytes + 0x20000) >>> 0;
        const stagingBase = (tableBase + 0x4000) >>> 0;
        const strideWords = 0x400 >>> 2;
        bus.storeU32(tableBase, dlPtr >>> 0);
        const start = 2, interval = 3;
        const total = start + interval * 1 + 2;
        const { image: bridgeImg } = scheduleF3DEXFromTableAndRun(
          cpu, bus, sys, fbOrigin, width, height,
          tableBase, 1, stagingBase, strideWords,
          start, interval, total, 1,
        );
        bridgeCRC32 = crc32(bridgeImg);
        if (snapshot) {
          const extMatch = snapshot.match(/\.(png|ppm)$/i);
          const ext = extMatch ? extMatch[0] : '.png';
          const basePath = snapshot.replace(/\.(png|ppm)$/i, '');
          bridgeSnapshotPath = `${basePath}_bridge${ext}`;
          await maybeWriteImage(bridgeImg, width, height, bridgeSnapshotPath);
        }
      }
    }
  } catch {}

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

  console.log(JSON.stringify({
    command: 'rom-boot-run',
    rom: file,
    initialPC: boot.initialPC >>> 0,
    endPC: cpu.pc >>> 0,
    cycles,
    viInterval,
    frames: frames.length,
    vi: { origin: viOrigin >>> 0, width: viWidth >>> 0 },
    events: { spStarts, piDmas: piReads },
    ostasks: ostasks.length ? ostasks : undefined,
    stopReason: stopReason || null,
    snapshot: snapshot || null,
    discovered: discover ? piLoads : undefined,
    bridge: bridgeCRC32 ? { crc32: bridgeCRC32, snapshot: bridgeSnapshotPath } : undefined,
    ipl,
  }, null, 2));
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
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

