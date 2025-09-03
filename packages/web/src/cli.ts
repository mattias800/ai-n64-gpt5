#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { runSm64TitleFramesCore } from './sm64_title_runner.js';
import { normalizeConfig } from './ui.js';
import type { Sm64TitleConfig } from './types.js';

const parseNum = (v: string | undefined, d: number): number => {
  if (!v) return d >>> 0; const s = v.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
  const n = Number(s); return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
};

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  // eslint-disable-next-line no-console
  console.log(`Usage:\n  n64-web sm64-title [--rom path.z64] [--config cfg.json] [--frames N] [--width W] [--height H] [--origin 0xADDR] [--expect a,b]\n  n64-web f3d-run-table <config.json> [--expect a,b]\n  n64-web f3dex-run-table <config.json> [--expect a,b]\n`);
  process.exit(0);
}

const cmd = args[0]!;
const opts: Record<string, string> = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i]!; if (!a.startsWith('--')) continue;
  const key = a.slice(2); const next = (i + 1 < args.length) ? args[i + 1] : undefined;
  const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
  opts[key] = val;
}

if (cmd === 'sm64-title') {
  const frames = parseNum(opts['frames'], 2);
  const width = parseNum(opts['width'], 192);
  const height = parseNum(opts['height'], 120);
  const origin = parseNum(opts['origin'], 0xF000);
  const romPath = opts['rom'];
  const cfgPath = opts['config'];
  const expectStr = opts['expect'];

  let romBytes: Uint8Array;
  if (romPath) {
    const abs = isAbsolute(romPath) ? romPath : resolve(process.cwd(), romPath);
    romBytes = new Uint8Array(readFileSync(abs));
  } else {
    romBytes = new Uint8Array(8 * 1024 * 1024); // zero-filled placeholder
  }

  let cfg: Sm64TitleConfig;
  if (cfgPath) {
    const abs = isAbsolute(cfgPath) ? cfgPath : resolve(process.cwd(), cfgPath);
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
    cfg = normalizeConfig(raw);
  } else {
    cfg = {
      video: { width, height, origin },
      timing: { start: 2, interval: 3, frames, spOffset: 1 },
      bg: { start5551: 0x001F, end5551: 0x07FF },
      assets: {},
    } as Sm64TitleConfig;
  }

  const { width: w, height: h, crc32Hex } = await runSm64TitleFramesCore(romBytes, cfg, frames);

  const normalizeHex = (s: string) => s.toLowerCase().replace(/^0x/, '');
  const expected = expectStr ? expectStr.split(',').map(s => normalizeHex(s.trim())).filter(Boolean)
                             : (Array.isArray(cfg.expectedCrc32) ? cfg.expectedCrc32.map(s => normalizeHex(String(s))) : null);
  let match: boolean | null = null;
  if (expected) {
    match = (expected.length === crc32Hex.length) && expected.every((e, i) => e === normalizeHex(crc32Hex[i]!));
  }
  const out = { command: 'sm64-title', width: w, height: h, frames, crc32: crc32Hex, match } as any;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
  if (match === false) process.exit(1);
  process.exit(0);
} else if (cmd === 'f3d-run-table') {
  const file = args.slice(1).find(a => !a.startsWith('--'));
  if (!file) { console.error('f3d-run-table requires a JSON file'); process.exit(1); }
  const expectStr = opts['expect'];
  const { runF3dTableFramesCore } = await import('./f3d_runner.js');
  const { crc32Hex } = await import('./crc32.js');
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(file, 'utf8');
  const cfgRaw = JSON.parse(text);
  const res = runF3dTableFramesCore(cfgRaw);
  const crcs = res.frames.map((f: Uint8Array) => crc32Hex(f));
  const normalizeHex = (s: string) => s.toLowerCase().replace(/^0x/, '');
  const expected = expectStr ? expectStr.split(',').map(s => normalizeHex(s.trim())).filter(Boolean) : null;
  let match: boolean | null = null;
  if (expected) match = (expected.length === crcs.length) && expected.every((e, i) => e === normalizeHex(crcs[i]!));
  const out = { command: 'f3d-run-table', width: res.width, height: res.height, frames: crcs.length, crc32: crcs, match } as any;
  console.log(JSON.stringify(out, null, 2));
  if (match === false) process.exit(1);
  process.exit(0);
} else if (cmd === 'f3dex-run-table') {
  const file = args.slice(1).find(a => !a.startsWith('--'));
  if (!file) { console.error('f3dex-run-table requires a JSON file'); process.exit(1); }
  const expectStr = opts['expect'];
// Backward-compat: use f3dex runner's table core if exported; otherwise no-op
const { runF3dexFromTableCore } = await import('./f3dex_table_core.js');
  const { crc32Hex } = await import('./crc32.js');
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(file, 'utf8');
  const cfgRaw = JSON.parse(text);
  const res = runF3dexFromTableCore(cfgRaw);
  const crcs = res.frames.map((f: Uint8Array) => crc32Hex(f));
  const normalizeHex = (s: string) => s.toLowerCase().replace(/^0x/, '');
  const expected = expectStr ? expectStr.split(',').map(s => normalizeHex(s.trim())).filter(Boolean) : null;
  let match: boolean | null = null;
  if (expected) match = (expected.length === crcs.length) && expected.every((e, i) => e === normalizeHex(crcs[i]!));
  const out = { command: 'f3dex-run-table', width: (res as any).width, height: (res as any).height, frames: crcs.length, crc32: crcs, match } as any;
  console.log(JSON.stringify(out, null, 2));
  if (match === false) process.exit(1);
  process.exit(0);
} else if (cmd === 'f3dex-rom-run') {
  const file = args.slice(1).find(a => !a.startsWith('--'));
  if (!file) { console.error('f3dex-rom-run requires a JSON file'); process.exit(1); }
  const romPath = opts['rom'];
  if (!romPath) { console.error('f3dex-rom-run requires --rom path.z64'); process.exit(1); }
  const expectStr = opts['expect'];
  const { readFileSync } = await import('node:fs');
  const { resolve, isAbsolute } = await import('node:path');
  const toAbs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
  const cfgRaw = JSON.parse(readFileSync(toAbs(file), 'utf8')) as any;

  const toU32 = (v: unknown, d: number = 0) => {
    if (typeof v === 'number') return v >>> 0; if (typeof v === 'string') { const s = v.trim(); if (s.startsWith('0x')||s.startsWith('0X')) return (parseInt(s,16)>>>0); const n=Number(s); return Number.isFinite(n)?(n>>>0):(d>>>0);} return d>>>0;
  };
  const video = { width: toU32(cfgRaw.video?.width,192), height: toU32(cfgRaw.video?.height,120), origin: toU32(cfgRaw.video?.origin,0xF000) };
  const timing = { start: toU32(cfgRaw.timing?.start,2), interval: toU32(cfgRaw.timing?.interval,3), frames: toU32(cfgRaw.timing?.frames,2), spOffset: toU32(cfgRaw.timing?.spOffset,1) };
  const f3dex = {
    tableBase: cfgRaw.f3dex?.tableBase !== undefined ? toU32(cfgRaw.f3dex.tableBase) : ((video.origin + video.width*video.height*2 + 0x9000)>>>0),
    stagingBase: cfgRaw.f3dex?.stagingBase !== undefined ? toU32(cfgRaw.f3dex.stagingBase) : undefined,
    strideWords: cfgRaw.f3dex?.strideWords !== undefined ? toU32(cfgRaw.f3dex.strideWords) : (0x400>>>2),
    bgStart: cfgRaw.f3dex?.bgStart !== undefined ? toU32(cfgRaw.f3dex.bgStart) : undefined,
    bgEnd: cfgRaw.f3dex?.bgEnd !== undefined ? toU32(cfgRaw.f3dex.bgEnd) : undefined,
  };
  const loads: { cartAddr:number; dramAddr:number; length:number }[] = Array.isArray(cfgRaw.piLoads) ? cfgRaw.piLoads.map((s:any)=>({ cartAddr: toU32(s.cartAddr), dramAddr: toU32(s.dramAddr), length: toU32(s.length) })) : [];

  const { Bus, RDRAM, CPU, System, hlePiLoadSegments, scheduleF3DEXFromTableAndRun } = await import('@n64/core');
  const romBytes = new Uint8Array(readFileSync(toAbs(romPath)));
  const rdram = new RDRAM(1<<22);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu,bus);
  bus.setROM(romBytes);
  if (loads.length) hlePiLoadSegments(bus, loads, true);

  const framesIn: any[] = Array.isArray(cfgRaw.frames) ? cfgRaw.frames : [];
  const dl0 = (f3dex.tableBase + 0x100)>>>0;
  for (let i=0;i<timing.frames;i++) {
    const explicitAddr = framesIn[i]?.dlAddr !== undefined ? toU32(framesIn[i].dlAddr, 0) >>> 0 : 0 >>> 0;
    let dlAddr: number;
    if (explicitAddr !== 0) {
      dlAddr = explicitAddr >>> 0;
    } else {
      dlAddr = (dl0 + i * (f3dex.strideWords*4))>>>0;
      const words = Array.isArray(framesIn[i]?.dlWords) ? framesIn[i].dlWords : [];
      for (let w=0,p=dlAddr; w<words.length; w++, p=(p+4)>>>0) bus.storeU32(p>>>0, toU32(words[w],0)>>>0);
    }
    bus.storeU32((f3dex.tableBase + i*4)>>>0, dlAddr>>>0);
  }

  const total = (timing.start + timing.interval*timing.frames + 2)>>>0;
  const { frames } = scheduleF3DEXFromTableAndRun(
    cpu,bus,sys, video.origin>>>0, video.width>>>0, video.height>>>0,
    f3dex.tableBase>>>0, timing.frames>>>0, (f3dex.stagingBase ?? ((f3dex.tableBase+0x8000)>>>0))>>>0, f3dex.strideWords>>>0,
    timing.start>>>0, timing.interval>>>0, total>>>0, timing.spOffset>>>0,
    f3dex.bgStart, f3dex.bgEnd,
  );
  const { crc32Hex } = await import('./crc32.js');
  const crcs = frames.map((f: Uint8Array)=>crc32Hex(f));
  const normalizeHex2 = (s: string) => s.toLowerCase().replace(/^0x/,'');
  const expected = expectStr ? expectStr.split(',').map(s=>normalizeHex2(s.trim())).filter(Boolean) : null;
  let match: boolean | null = null;
  if (expected) match = (expected.length===crcs.length) && expected.every((e,i)=> e===normalizeHex2(crcs[i]!));
  const out2 = { command:'f3dex-rom-run', width: video.width, height: video.height, frames: timing.frames, crc32: crcs, match } as any;
  console.log(JSON.stringify(out2,null,2));
  if (match===false) process.exit(1);
  process.exit(0);
} else {
  // eslint-disable-next-line no-console
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
