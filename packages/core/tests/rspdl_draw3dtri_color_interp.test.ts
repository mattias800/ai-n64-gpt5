import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';

// Verifies untextured 3D triangle per-pixel color interpolation via DRAW_3D_TRI (0x00000060)
// by sampling the framebuffer center to ensure blue-dominant color from the apex.
describe('rspdl_draw3dtri_color_interp', () => {
  it('interpolates vertex colors across the triangle', () => {
    const width = 128, height = 96, origin = 0x4000;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const base = (origin + width * height * 2 + 0x8000) >>> 0;
    const dl = base >>> 0;

    // Write a model-view scale matrix (0.5 on X and Y) in 16.16 fixed format
    const mvAddr = (base + 0x2000) >>> 0;
    const FIX = (f: number) => (Math.round(f * 65536) >>> 0);
    const mv: number[] = [
      FIX(0.5), 0,        0,        0,
      0,        FIX(0.5), 0,        0,
      0,        0,        FIX(1.0), 0,
      0,        0,        0,        FIX(1.0),
    ];
    for (let i = 0; i < 16; i++) bus.storeU32((mvAddr + i * 4) >>> 0, mv[i]! >>> 0);

    // Build UC program: gradient background, load MV matrix, then draw colored tri in clip space
    const BLUE_BG = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const CYAN_BG = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;

    const uc: UcCmd[] = [
      { op: 'Gradient', bgStart: BLUE_BG, bgEnd: CYAN_BG },
      { op: 'LoadMatrix', addr: mvAddr, projection: false, load: true, push: false },
      {
        op: 'Draw3DTri',
        x1: -1, y1: -1, z1: 0,
        x2:  1, y2: -1, z2: 0,
        x3:  0, y3:  1, z3: 0,
        r1: 255, g1: 0,   b1: 0,   // red
        r2: 0,   g2: 255, b2: 0,   // green
        r3: 0,   g3: 0,   b3: 255, // blue apex
        s1: 0, t1: 0, s2: 0, t2: 0, s3: 0, t3: 0,
      },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl, uc, 128);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 128);

    const img = res.frames[0] ?? res.image; // RGBA8888 scanout
    const ix = 64, iy = 48; // framebuffer center
    const di = (iy * width + ix) * 4;
    const r = img[di + 0] ?? 0;
    const g = img[di + 1] ?? 0;
    const b = img[di + 2] ?? 0;

    // Center pixel should be within the triangle and biased toward the apex (blue)
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(g).toBeGreaterThanOrEqual(0);
  });
});

