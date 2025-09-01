#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { Bus, RDRAM, CPU, System, hlePifBoot, hlePiLoadSegments, normalizeRomToBigEndian, parseHeader, hlePifControllerStatus, hlePifReadControllerState } from '@n64/core';

const args = process.argv.slice(2);
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!; if (!a.startsWith('--')) continue;
  const key = a.slice(2); const next = (i+1<args.length) ? args[i+1] : undefined;
  const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
  opts[key] = val;
}

const parseNum = (v: string | undefined, d: number): number => {
  if (!v) return d >>> 0; const s = v.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s,16)>>>0);
  const n = Number(s); return Number.isFinite(n) ? (n>>>0) : (d>>>0);
};

const romPath = opts['rom'];
if (!romPath) { console.error('discover-f3dex requires --rom path.z64'); process.exit(1); }
const outPath = opts['out'] || 'f3dex_discovered.json';
const framesWanted = parseNum(opts['frames'], 2);
const cyclesBudget = parseNum(opts['cycles'], 5_000_000);
const width = parseNum(opts['width'], 192);
const height = parseNum(opts['height'], 120);
const origin = parseNum(opts['origin'], 0xF000);

const toAbs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
const rom = new Uint8Array(readFileSync(toAbs(romPath)));

const rdram = new RDRAM(8*1024*1024);
const bus = new Bus(rdram);
const cpu = new CPU(bus);
const sys = new System(cpu, bus);

// Present ROM to PI and boot
bus.setROM(rom);
hlePifBoot(cpu, bus, rom);

// Pre-stage a large ROM slice at header PC physical to ensure code is present
let headerInitialPC = 0 >>> 0;
try {
  const { data: beRom } = normalizeRomToBigEndian(rom);
  headerInitialPC = parseHeader(beRom).initialPC >>> 0;
  const basePhys = (headerInitialPC - 0x80000000) >>> 0;
  const len = Math.min(2 * 1024 * 1024, rom.length) >>> 0;
  hlePiLoadSegments(bus as any, [ { cartAddr: 0 >>> 0, dramAddr: basePhys >>> 0, length: len >>> 0 } ], true);
} catch {}

// Fastboot HLE: enable CPU interrupts, MI masks, minimal exception handler, and periodic timer
try {
  const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
  cpu.cop0.write(12, (IE | IM2 | IM7) >>> 0);
  // Enable MI masks for SP|SI|VI|PI|DP (bits 0,1,3,4,5)
  try { (bus.mi as any).writeU32(0x0c >>> 0, ((1<<0)|(1<<1)|(1<<3)|(1<<4)|(1<<5)) >>> 0); } catch {}
  // Install minimal ERET at physical 0x00000180
  bus.storeU32(0x00000180 >>> 0, 0x42000018 >>> 0);
  bus.storeU32(0x00000184 >>> 0, 0x00000000 >>> 0);
  // Program periodic timer
  const period = 50000 >>> 0;
  const cnt0 = cpu.cop0.read(9) >>> 0;
  cpu.cop0.write(11, (cnt0 + period) >>> 0);
  sys.scheduleEvery(period >>> 0, period >>> 0, Math.max(1, Math.floor(cyclesBudget / Math.max(1, period))), () => {
    const cNow = cpu.cop0.read(9) >>> 0; cpu.cop0.write(11, (cNow + period) >>> 0);
  });
  // Skip reserved-instruction traps early in boot code paths
  try { (cpu as any).fastbootSkipReserved = true; } catch {}
} catch {}

// Initialize VI so any HLE rendering is visible
try { (bus.vi as any).writeU32(0x14, origin >>> 0); (bus.vi as any).writeU32(0x18, width >>> 0); } catch {}

// Program periodic VI vblank to satisfy games waiting on VI interrupts
try {
  const viInterval = 10000 >>> 0;
  sys.scheduleEvery(viInterval >>> 0, viInterval >>> 0, Math.max(1, Math.floor(cyclesBudget / Math.max(1, viInterval))), () => {
    try { (bus.vi as any).vblank(); } catch {}
  });
} catch {}

// One-shot controller handshake to satisfy early input init code paths
try {
  const ctrlBase = 0x2000 >>> 0;
  hlePifControllerStatus(bus as any, ctrlBase);
  hlePifReadControllerState(bus as any, (ctrlBase + 0x40) >>> 0);
} catch {}

// Optionally jump to header PC after staging
try { if (headerInitialPC >>> 0) (cpu as any).pc = headerInitialPC >>> 0; } catch {}

// Instrument PI RD_LEN to capture piLoads during execution
const piLoads: { cartAddr:number; dramAddr:number; length:number }[] = [];
let lastPiCart = 0 >>> 0; let lastPiDram = 0 >>> 0;
const piWrite = (bus.pi as any).writeU32.bind(bus.pi) as (off:number,val:number)=>void;
(bus.pi as any).writeU32 = (off:number, val:number) => {
  const o = off>>>0, v = val>>>0;
  if (o===0x04) lastPiCart = v>>>0; // CART_ADDR
  if (o===0x00) lastPiDram = v>>>0; // DRAM_ADDR
  if (o===0x08) { // RD_LEN
    const len = ((v & 0x00ffffff)>>>0) + 1;
    piLoads.push({ cartAddr: lastPiCart>>>0, dramAddr: lastPiDram>>>0, length: len>>>0 });
    // schedule quick completion so code can proceed
    const when = (sys.cycle + 64)>>>0; sys.scheduleAt(when, () => { (bus.pi as any).completeDMA(); });
  }
  piWrite(o,v);
};

// Instrument SP start to capture gfx OSTask data_ptr
const spWrite = (bus.sp as any).writeU32.bind(bus.sp) as (off:number,val:number)=>void;
const dls: number[] = [];
const be32 = (arr: Uint8Array, off: number) => (((arr[off]!<<24)|(arr[off+1]!<<16)|(arr[off+2]!<<8)|(arr[off+3]!))>>>0);
(bus.sp as any).writeU32 = (off:number, val:number) => {
  const o = off>>>0, v = val>>>0;
  // MEM_ADDR==1 convention or STATUS start bit; our stub treats MEM_ADDR=1 as start
  if ((o===0x00 && v===1) || (o===0x10 && (v&0x1)!==0)) {
    try {
      const dmem = (bus.sp as any).dmem as Uint8Array;
      const data_ptr = be32(dmem, 0x30) >>> 0;
      if (data_ptr) dls.push(data_ptr);
    } catch {}
  }
  spWrite(o,v);
};

// Step until we collect framesWanted or exhaust cyclesBudget
let steps = 0;
while (steps < cyclesBudget && dls.length < framesWanted) {
  sys.stepCycles(1);
  steps++;
}

const uniqPiLoads = (() => {
  const seen = new Set<string>();
  const out: typeof piLoads = [];
  for (const s of piLoads) {
    const k = `${s.cartAddr}:${s.dramAddr}:${s.length}`;
    if (seen.has(k)) continue; seen.add(k); out.push(s);
  }
  return out;
})();

const frames = dls.slice(0, Math.min(framesWanted, dls.length)).map(addr => ({ dlAddr: `0x${addr.toString(16)}` }));
const cfg = {
  video: { width: `0x${width.toString(16)}`, height: `0x${height.toString(16)}`, origin: `0x${origin.toString(16)}` },
  timing: { start: 2, interval: 3, frames: frames.length, spOffset: 1 },
  f3dex: { strideWords: 256, bgStart: '0x001F', bgEnd: '0x07FF' },
  piLoads: uniqPiLoads.map(s => ({ cartAddr: `0x${s.cartAddr.toString(16)}`, dramAddr: `0x${s.dramAddr.toString(16)}`, length: `0x${s.length.toString(16)}` })),
  frames,
};

writeFileSync(toAbs(outPath), JSON.stringify(cfg, null, 2));
console.log(`[discover] wrote ${outPath} (frames=${frames.length}, piLoads=${uniqPiLoads.length}, steps=${steps})`);
