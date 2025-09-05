import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';

// Smoke test: 3D textured triangle using RGBA16 bound via SetTexImage3D/SetTexDim
// The 1x1 texture ensures sampling returns the same color everywhere.
describe('rspdl_3d_rgba16_textured_tri_smoke', () => {
  it('renders a 3D textured triangle using bound texture state', () => {
    const width = 128, height = 96, origin = 0x5000;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const base = (origin + width * height * 2 + 0x4000) >>> 0;
    const dl = base >>> 0;

    // Create a 1x1 RGBA16 texture (pure red, alpha 1)
    const texAddr = (base + 0x2000) >>> 0;
    const color = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0; // RGBA5551
    bus.rdram.bytes[texAddr] = (color >>> 8) & 0xFF;
    bus.rdram.bytes[texAddr + 1] = color & 0xFF;

    const uc: UcCmd[] = [
      { op: 'SetTexImage3D', fmt: 'RGBA16', addr: texAddr },
      { op: 'SetTexDim', width: 1, height: 1 },
      { op: 'LoadMatrix', addr: 0, projection: true, load: true, push: false }, // identity projection
      { op: 'LoadMatrix', addr: 0, projection: false, load: true, push: false }, // identity modelview
      { op: 'SetCombine', mode: 'TEXEL0' },
      { op: 'Draw3DTri',
        x1: -1, y1: -1, z1: 0,
        x2:  1, y2: -1, z2: 0,
        x3:  0, y3:  1, z3: 0,
        r1: 0, g1: 0, b1: 0,
        r2: 0, g2: 0, b2: 0,
        r3: 0, g3: 0, b3: 0,
        s1: 0, t1: 0, s2: 0, t2: 0, s3: 0, t3: 0,
      },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl, uc, 128);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 128);

    // Check that the center pixel is red
    const img = res.frames[0] ?? res.image;
    const cx = 64, cy = 48;
    const di = (cy * width + cx) * 4;
    const r = img[di + 0] ?? 0;
    const g = img[di + 1] ?? 0;
    const b = img[di + 2] ?? 0;
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(50);
    expect(b).toBeLessThan(50);
  });
});

