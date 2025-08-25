import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32, COLORS_5551 } from './helpers/test_utils.ts';

describe('rspdl_ci8_tri_combine_prim_parity', () => {
  it('DrawCI8Tri under PRIM combine matches DrawPrimTri', () => {
    const width = 160, height = 120, origin = 0x5000;
    const start = 2, interval = 3, frames = 2, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x7000) >>> 0;
    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dlA = (base + 0x2000) >>> 0;
    const dlB = (base + 0x3000) >>> 0;
    const table = (base + 0x4000) >>> 0;

    // PRIM color = cyan
    const PRIM = COLORS_5551.cyan;

    // TLUT can be empty since under PRIM we don't sample; but keep something valid
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, 0x0000);
    // Texture is irrelevant under PRIM, but allocate
    for (let i = 0; i < 8 * 8; i++) bus.storeU8(texAddr + i, 0);

    // Frame 0: DrawCI8Tri with PRIM combine
    const ucA: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetPrimColor', color: PRIM },
      { op: 'SetCombine', mode: 'PRIM' },
      { op: 'DrawCI8Tri', addr: texAddr, texW: 8, texH: 8,
        x1: 40, y1: 30, s1: 0, t1: 0,
        x2: 80, y2: 30, s2: 7, t2: 0,
        x3: 40, y3: 70, s3: 0, t3: 7 },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, dlA, ucA, 128);

    // Frame 1: equivalent DrawPrimTri (PRIM combine is implicit for prim triangle)
    const ucB: UcCmd[] = [
      { op: 'SetPrimColor', color: PRIM },
      { op: 'SetCombine', mode: 'PRIM' },
      { op: 'DrawPrimTri', x1: 40, y1: 30, x2: 80, y2: 30, x3: 40, y3: 70 },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, dlB, ucB, 128);

    bus.storeU32(table + 0, dlA >>> 0);
    bus.storeU32(table + 4, dlB >>> 0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);
    expect(h0).toBe(h1);
  });
});

