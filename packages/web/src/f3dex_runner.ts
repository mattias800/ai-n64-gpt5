import { Bus, RDRAM, CPU, System, hlePiLoadSegments, scheduleF3DEXFromTableAndRun } from '@n64/core';
import type { RunnerResult } from './types';
import { crc32Hex } from './crc32.js';

const toNum = (v: unknown, d: number = 0): number => {
  if (typeof v === 'number') return (v >>> 0);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
    const n = Number(s); return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
  }
  return (d >>> 0);
};

export const runF3dexFromConfig = async (romBytes: Uint8Array, rawCfg: unknown): Promise<RunnerResult> => {
  const cfg = (rawCfg && typeof rawCfg === 'object') ? (rawCfg as any) : {};
  const video = cfg.video || {};
  const timing = cfg.timing || {};
  const f3dex = cfg.f3dex || {};
  const width = toNum(video.width, 192);
  const height = toNum(video.height, 120);
  const origin = toNum(video.origin, 0xF000);
  const start = toNum(timing.start, 2);
  const interval = toNum(timing.interval, 3);
  const framesCount = Math.max(1, toNum(timing.frames, 1));
  const spOffset = toNum(timing.spOffset, 1);
  const strideWords = toNum(f3dex.strideWords, 256);
  const bgStart = f3dex.bgStart !== undefined ? toNum(f3dex.bgStart) : undefined;
  const bgEnd = f3dex.bgEnd !== undefined ? toNum(f3dex.bgEnd) : undefined;

  const rdram = new RDRAM(1 << 22);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  bus.setROM(romBytes);

  // Optional PI loads
  const loads: any[] = Array.isArray(cfg.piLoads) ? cfg.piLoads : [];
  if (loads.length) {
    const segs = loads.map((s) => ({ cartAddr: toNum(s.cartAddr), dramAddr: toNum(s.dramAddr), length: toNum(s.length) }));
    hlePiLoadSegments(bus, segs, true);
  }

  // Optional TLUTs and blobs placed into RDRAM
  const tluts: any[] = Array.isArray(cfg.tluts) ? cfg.tluts : [];
  for (const t of tluts) {
    const addr = toNum(t.addr, 0);
    const entries: any[] = Array.isArray(t.entries) ? t.entries : [];
    for (let i = 0; i < entries.length; i++) {
      const v = toNum(entries[i], 0);
      bus.storeU16((addr + i * 2) >>> 0, v >>> 0);
    }
  }
  const blobs: any[] = Array.isArray(cfg.blobs) ? cfg.blobs : [];
  for (const b of blobs) {
    const addr = toNum(b.addr, 0);
    const hex: string = String(b.dataHex || '');
    for (let i = 0, p = addr >>> 0; i + 1 < hex.length; i += 2, p = (p + 1) >>> 0) {
      const byte = parseInt(hex.slice(i, i + 2), 16) & 0xff;
      bus.storeU8(p >>> 0, byte >>> 0);
    }
  }

  const frames: any[] = Array.isArray(cfg.frames) ? cfg.frames : [];
  const fbBytes = width * height * 2;
  const base = (toNum(cfg.allocBase, (origin + fbBytes + 0xA000))) >>> 0;
  const tableBase = base >>> 0;
  const dl0 = (base + 0x400) >>> 0;

  for (let i = 0; i < framesCount; i++) {
    const dlAddr = (dl0 + i * strideWords * 4) >>> 0;
    // If provided, write dlWords directly
    const fr = frames[i] || {};
    const words: Array<number | string> = Array.isArray(fr.dlWords) ? fr.dlWords : [];
    let p = dlAddr >>> 0;
    for (let w = 0; w < words.length; w++) {
      const v = words[w]!;
      const num = (typeof v === 'number') ? (v >>> 0) : toNum(v, 0);
      bus.storeU32(p, num >>> 0); p = (p + 4) >>> 0;
    }
    // EndDL guard if not present
    if (words.length === 0) {
      bus.storeU32(p, 0xDF000000 >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, 0);
    }
    // Table pointer
    bus.storeU32((tableBase + i * 4) >>> 0, dlAddr >>> 0);
  }

  const total = start + interval * framesCount + 2;
  const { frames: imgs } = scheduleF3DEXFromTableAndRun(
    cpu, bus, sys, origin >>> 0, width >>> 0, height >>> 0,
    tableBase >>> 0, framesCount >>> 0, (base + 0x8000) >>> 0, strideWords >>> 0,
    start >>> 0, interval >>> 0, total >>> 0, spOffset >>> 0,
    bgStart, bgEnd,
  );

  const imageFrames: ImageData[] = imgs.map((data) => new ImageData(new Uint8ClampedArray(data), width, height));
  const crc32s: string[] = imageFrames.map((im) => crc32Hex(new Uint8Array(im.data)));
  return { frameImages: imageFrames, crc32Hex: crc32s };
};

