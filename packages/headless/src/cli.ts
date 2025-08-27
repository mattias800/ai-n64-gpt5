#!/usr/bin/env node
import { Bus, RDRAM, CPU, System, runSM64TitleDemoDP, runSM64TitleDemoSPDP, writeSM64TitleTasksToRDRAM, scheduleSPTitleTasksFromRDRAMAndRun, writeRSPTitleDLsToRDRAM, scheduleRSPDLFramesAndRun, writeUcAsRspdl, f3dToUc, scheduleRSPDLFromTableAndRun, scheduleF3DEXFromTableAndRun, translateF3DEXAndExecNow, hlePiLoadSegments, decompressMIO0, viScanout, PI_BASE, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, PI_STATUS_IO_BUSY, hlePifControllerStatus, hlePifReadControllerState } from '@n64/core';
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
     [--vi-init] [--fastboot-hle]
 
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
  const iplHle = Object.prototype.hasOwnProperty.call(opts, 'ipl-hle');
  const bridge = Object.prototype.hasOwnProperty.call(opts, 'bridge');
  const bridgeTest = Object.prototype.hasOwnProperty.call(opts, 'bridge-test');
  // Diagnostic: force an SP gfx task injection at a specific cycle
  const forceSpAt = opts['force-sp-at'] ? parseNum(opts['force-sp-at'], 0) >>> 0 : 0;
  const viInit = Object.prototype.hasOwnProperty.call(opts, 'vi-init');
  const noViVblank = Object.prototype.hasOwnProperty.call(opts, 'no-vi-vblank') || Object.prototype.hasOwnProperty.call(opts, 'noViVblank') || Object.prototype.hasOwnProperty.call(opts, 'no_vi_vblank');
  const fastbootHle = Object.prototype.hasOwnProperty.call(opts, 'fastboot-hle');
  const timerHle = Object.prototype.hasOwnProperty.call(opts, 'timer-hle') || Object.prototype.hasOwnProperty.call(opts, 'timerHle') || Object.prototype.hasOwnProperty.call(opts, 'timer_hle');
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

  // Utility to hex-encode a byte array
  const toHex = (arr: Uint8Array) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  const be32 = (arr: Uint8Array, off: number) => (((arr[off]! << 24) | (arr[off+1]! << 16) | (arr[off+2]! << 8) | (arr[off+3]!)) >>> 0);

  // HLE boot sets PC from header and makes ROM available to PI
  // Use PIF/IPL3 HLE boot so the ROM's own boot code runs from 0xA4000040
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
    // Enable CPU IE and IM2 (IP2 used for MI) + IM7 (timer)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, (IE | IM2 | IM7) >>> 0);
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
          translateF3DEXAndExecNow(bus, width, height, data_ptr >>> 0, stagingBase >>> 0, strideWords >>> 0, bgStart, bgEnd);
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
      if (monitorActive) {
        piReads++;
        const len = ((valU & 0x00ffffff) >>> 0) + 1;
        piLoads.push({ cartAddr: lastPiCart >>> 0, dramAddr: lastPiDram >>> 0, length: len >>> 0 });
        if (traceBoot>0 && allowEvent('pi')) events.push({ type:'pi', reg:'RD_LEN', val:`0x${valU.toString(16)}`, cart:`0x${lastPiCart.toString(16)}`, dram:`0x${lastPiDram.toString(16)}`, len:`0x${len.toString(16)}`, cyc: sys.cycle });
      }
      // Schedule a short-latency DMA completion so ROM doesn't stall on IO busy/interrupts.
      const when = (sys.cycle + 64) >>> 0;
      sys.scheduleAt(when, () => {
        bus.pi.completeDMA();
        if (traceBoot>0 && monitorActive && allowEvent('pi')) events.push({ type:'pi', reg:'AUTO_COMPLETE_DMA', cart:`0x${lastPiCart.toString(16)}`, dram:`0x${lastPiDram.toString(16)}`, len:`0x${(((valU & 0x00ffffff)>>>0)+1).toString(16)}`, cyc: sys.cycle });
      });
    }
    if (offU === 0x0C) { // PI_WR_LEN
      // Mirror behavior: schedule completion
      const len = ((valU & 0x00ffffff) >>> 0) + 1;
      const when = (sys.cycle + 64) >>> 0;
      sys.scheduleAt(when, () => {
        bus.pi.completeDMA();
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
  if (!fastbootHle && !noViVblank) {
    sys.scheduleEvery(viInterval >>> 0, viInterval >>> 0, Math.max(1, Math.floor(cycles / Math.max(1, viInterval))), () => {
      bus.vi.vblank();
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

