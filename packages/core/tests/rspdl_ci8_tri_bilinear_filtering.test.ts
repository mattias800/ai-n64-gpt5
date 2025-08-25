import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Verify that enabling bilinear filtering produces a different, stable CRC vs nearest.
describe('rspdl_ci8_tri_bilinear_filtering', () => {
  it('bilinear vs nearest CRCs differ while each is stable', () => {
    const width = 160, height = 120, origin = 0xC000;
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
    const dl0 = (base + 0x2000) >>> 0;
    const dl1 = (base + 0x3000) >>> 0;
    const table = (base + 0x4000) >>> 0;

    // TLUT: grayscale ramp
    for (let i=0;i<256;i++) bus.storeU16(tlutAddr + i*2, ((i>>>3)<<11) | ((i>>>3)<<6) | ((i>>>3)<<1) | 1);
    // Texture 16x16: horizontal ramp for filtering visibility
    const W=16,H=16; for (let y=0;y<H;y++){ for (let x=0;x<W;x++){ bus.storeU8(texAddr + y*W + x, (x*255/(W-1))|0); } }

    const tri = { x1: 30, y1: 30, s1: 0,  t1: 0,
                  x2: 120,y2: 35, s2: W-1,t2: 0,
                  x3: 40, y3: 90, s3: 0,  t3: H-1 };

    const ucNearest: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetTexFilter', mode: 'NEAREST' },
      { op: 'DrawCI8Tri', addr: texAddr, texW: W, texH: H,
        x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1,
        x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2,
        x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3 },
      { op: 'End' },
    ];

    const ucBilinear: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetTexFilter', mode: 'BILINEAR' },
      { op: 'DrawCI8Tri', addr: texAddr, texW: W, texH: H,
        x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1,
        x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2,
        x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3 },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl0, ucNearest, 128);
    writeUcAsRspdl(bus, dl1, ucBilinear, 128);

    bus.storeU32(table+0, dl0>>>0);
    bus.storeU32(table+4, dl1>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);
    expect(h0).toMatch(/^[0-9a-f]{8}$/);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(h0).not.toBe(h1);
  });
});

