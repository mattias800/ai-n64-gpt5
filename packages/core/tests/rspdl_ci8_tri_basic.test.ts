import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32, COLORS_5551, px } from './helpers/test_utils.ts';

// Verify DrawCI8Tri interpreter path by drawing a uniform-textured triangle and
// asserting a few interior pixels match the TLUT color, plus a stable CRC shape.

describe('rspdl_ci8_tri_basic', () => {
  it('draws a CI8-textured triangle with TLUT correctly', () => {
    const width = 160, height = 120, origin = 0xF000;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x8000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dlAddr = (base + 0x2000) >>> 0;

    // TLUT: index 1 = green, others transparent (alpha=0) so only index 1 draws
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, i === 1 ? COLORS_5551.green : 0x0000);

    // CI8 texture 8x8: all indices = 1 (uniform green)
    const texW = 8, texH = 8;
    for (let i = 0; i < texW * texH; i++) bus.storeU8(texAddr + i, 1);

    // Build UC commands: gradient background, set TLUT, draw triangle covering ~32x32 area
    const cmds: UcCmd[] = [
      { op: 'Gradient', bgStart: COLORS_5551.blue, bgEnd: COLORS_5551.cyan },
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'DrawCI8Tri', addr: texAddr, texW, texH,
        x1: 40, y1: 30, s1: 0, t1: 0,
        x2: 72, y2: 30, s2: texW - 1, t2: 0,
        x3: 40, y3: 62, s3: 0, t3: texH - 1,
      },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dlAddr, cmds, 128);

    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dlAddr, frames, start, interval, total, spOffset, 128);
    const out = res.frames[0] ?? res.image;

    // Sample interior pixels well inside the triangle to avoid edge rules
    const W = width;
    const A = px(out, 45, 35, W); // expect green
    const B = px(out, 55, 45, W); // expect green
    const C = px(out, 60, 33, W); // near top edge but inside: green

    // RGBA for green (255,255 alpha mapped) roughly (0,~255,0,255). Our viScanout maps 5551 -> 8888; check channel thresholds
    expect(A[3]).toBe(255);
    expect(B[3]).toBe(255);
    expect(C[3]).toBe(255);
    expect(A[1]).toBeGreaterThan(200);
    expect(B[1]).toBeGreaterThan(200);
    expect(C[1]).toBeGreaterThan(200);
    expect(A[0]).toBeLessThan(80);
    expect(A[2]).toBeLessThan(80);

    // Also assert a stable-looking CRC string shape
    const hash = crc32(out);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(8);
  });
});
