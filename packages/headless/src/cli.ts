#!/usr/bin/env node
import { Bus, RDRAM, CPU, System, runSM64TitleDemoDP, runSM64TitleDemoSPDP, writeSM64TitleTasksToRDRAM, scheduleSPTitleTasksFromRDRAMAndRun, writeRSPTitleDLsToRDRAM, scheduleRSPDLFramesAndRun, writeUcAsRspdl, f3dToUc, scheduleRSPDLFromTableAndRun, scheduleF3DEXFromTableAndRun } from '@n64/core';

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

Examples:
  n64-headless sm64-demo --frames 1
  n64-headless sm64-demo --frames 2 --snapshot tmp/sm64_2f.ppm
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
  const perFrame = frames.map(crc32);
  console.log(JSON.stringify({ command: 'rspdl-ci8-ring', cfg: { width, height, origin, start, interval, frameCount, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res }, null, 2));
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
  const perFrame = imgs.map(crc32);
  console.log(JSON.stringify({ command: 'uc-run', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res }, null, 2));
}

async function runF3dRun(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3d-run requires a JSON file path');
    process.exit(1);
  }
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
  const perFrame = imgs.map(crc32);
  console.log(JSON.stringify({ command: 'f3d-run', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res }, null, 2));
}

async function runF3dRunTable(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3d-run-table requires a JSON file path');
    process.exit(1);
  }
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
  const perFrame = imgs.map(crc32);
  console.log(JSON.stringify({ command: 'f3d-run-table', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res }, null, 2));
}

async function runF3dexRunTable(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('f3dex-run-table requires a JSON file path');
    process.exit(1);
  }
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
  const perFrame = imgs.map(crc32);
  console.log(JSON.stringify({ command: 'f3dex-run-table', cfg: { width, height, origin, start, interval, frames, spOffset }, perFrameCRC32: perFrame, crc32: crc32(image), acks: res }, null, 2));
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
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

