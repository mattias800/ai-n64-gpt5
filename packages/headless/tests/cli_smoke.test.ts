import { describe, it, expect } from 'vitest';
import { Bus, RDRAM, CPU, System, scheduleRSPDLFramesAndRun, runSM64TitleDemoDP } from '@n64/core';
import { crc32 } from '../src/lib.js';

// Deterministic CRCs validated via the headless CLI manual runs.
// These tests ensure the headless flows remain stable and verifiable end-to-end.

describe('headless CLI-like flows (deterministic CRCs)', () => {
  it('rspdl-ci8-ring produces expected per-frame CRC32', () => {
    const width = 192, height = 120, origin = 0xF000 >>> 0;
    const start = 2, interval = 3, frames = 2, spOffset = 1;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x3000) >>> 0;
    const tlutAddr = base >>> 0;
    const pixAddr = (base + 0x1000) >>> 0;
    const dlBase = (base + 0x2000) >>> 0;

    // TLUT[1] = GREEN5551
    const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, i === 1 ? GREEN : 0);

    // CI8 ring texture 32x32 at pixAddr
    const W = 32, H = 32, cx = 16, cy = 16, rO = 14, rI = 10;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x + 0.5) - cx, dy = (y + 0.5) - cy; const d2 = dx*dx + dy*dy;
      const v = (d2 <= rO*rO && d2 >= rI*rI) ? 1 : 0;
      bus.storeU8(pixAddr + (y*W + x), v);
    }

    const strideWords = 32;
    for (let i = 0; i < frames; i++) {
      let addr = (dlBase + i * strideWords * 4) >>> 0;
      // GRADIENT blue->cyan
      bus.storeU32(addr, 0x00000001); addr += 4;
      bus.storeU32(addr, ((0<<11)|(0<<6)|(31<<1)|1) >>> 0); addr += 4;
      bus.storeU32(addr, ((0<<11)|(31<<6)|(31<<1)|1) >>> 0); addr += 4;
      // SET_TLUT
      bus.storeU32(addr, 0x00000020); addr += 4;
      bus.storeU32(addr, tlutAddr >>> 0); addr += 4;
      bus.storeU32(addr, 256 >>> 0); addr += 4;
      // DRAW_CI8 32x32
      bus.storeU32(addr, 0x00000021); addr += 4;
      bus.storeU32(addr, W >>> 0); addr += 4;
      bus.storeU32(addr, H >>> 0); addr += 4;
      bus.storeU32(addr, pixAddr >>> 0); addr += 4;
      bus.storeU32(addr, (10 + i) >>> 0); addr += 4; // move X per frame
      bus.storeU32(addr, 10 >>> 0); addr += 4;
      // END
      bus.storeU32(addr, 0x00000000);
    }

    const total = start + interval * frames + 2;
    const { image, frames: imgs } = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dlBase, frames, start, interval, total, spOffset, strideWords);

    expect(imgs.length).toBe(2);
    const c0 = crc32(imgs[0]!);
    const c1 = crc32(imgs[1]!);
    expect(c0).toBe('4021e7e5');
    expect(c1).toBe('f58f7a37');
    expect(crc32(image)).toBe('f58f7a37');
  });

  it('sm64-demo dp mode CRC32 is stable', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const cfg = {
      width: 192,
      height: 120,
      origin: 0xF000 >>> 0,
      spacing: 10,
      startCycle: 2,
      interval: 3,
      frames: 1,
      bgStart5551: ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0, // blue
      bgEnd5551:   ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0, // cyan
      spOffset: 1,
    } as const;

    const { image } = runSM64TitleDemoDP(cpu, bus, sys, cfg);
    expect(crc32(image)).toBe('6ca0bc0e');
  });
});
