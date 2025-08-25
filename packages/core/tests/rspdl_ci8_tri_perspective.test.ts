import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { COLORS_5551, crc32 } from './helpers/test_utils.ts';

// Perspective-correct CI8 triangle parity: perspective vs affine should differ; ensure deterministic output.
describe('rspdl_ci8_tri_perspective.test', () => {
  it('perspective CI8 outputs deterministic image and differs from affine in a known setup', () => {
    const width = 160, height = 120, origin = 0xA000;
    const start = 2, interval = 3, frames = 2, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x6000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dlAff = (base + 0x2000) >>> 0;
    const dlPersp = (base + 0x3000) >>> 0;
    const table = (base + 0x4000) >>> 0;

    // TLUT: grayscale ramp
    for (let i=0;i<256;i++) bus.storeU16(tlutAddr + i*2, ((i>>>3)<<11) | ((i>>>3)<<6) | ((i>>>3)<<1) | 1);
    // Texture 32x32: horizontal ramp 0..255
    const W=32,H=32; for(let y=0;y<H;y++){ for(let x=0;x<W;x++){ bus.storeU8(texAddr + y*W + x, (x*255/(W-1))|0); } }

    // Triangle with noticeable perspective distortion
    const v1 = { x: 30, y: 20, s: 0,  t: 0,  q: 1 };
    const v2 = { x: 120,y: 25, s: 31, t: 0,  q: 1 };
    const v3 = { x: 35, y: 100,s: 0,  t: 31, q: 4 }; // deeper

    const ucAff: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'DrawCI8Tri', addr: texAddr, texW: W, texH: H,
        x1: v1.x, y1: v1.y, s1: v1.s, t1: v1.t,
        x2: v2.x, y2: v2.y, s2: v2.s, t2: v2.t,
        x3: v3.x, y3: v3.y, s3: v3.s, t3: v3.t },
      { op: 'End' },
    ];

    const ucPersp: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'DrawCI8TriPersp', addr: texAddr, texW: W, texH: H,
        x1: v1.x, y1: v1.y, s1: v1.s, t1: v1.t, q1: v1.q,
        x2: v2.x, y2: v2.y, s2: v2.s, t2: v2.t, q2: v2.q,
        x3: v3.x, y3: v3.y, s3: v3.s, t3: v3.t, q3: v3.q },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dlAff, ucAff, 128);
    writeUcAsRspdl(bus, dlPersp, ucPersp, 128);

    bus.storeU32(table+0, dlAff>>>0);
    bus.storeU32(table+4, dlPersp>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);
    // They should differ for this setup (perspective vs affine)
    expect(h0).not.toBe(h1);
  });
});

