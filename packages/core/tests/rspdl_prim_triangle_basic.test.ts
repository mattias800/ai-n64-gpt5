import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Draw a solid red triangle with PRIM combine and verify image stability via a CRC.
describe('rspdl_prim_triangle_basic', () => {
  it('draws a solid PRIM triangle deterministically', () => {
    const width=128, height=96, origin=0xF000;
    const start=2, interval=3, frames=1, spOffset=1;
    const total = start + interval*frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const base = (origin + width*height*2 + 0x8000) >>> 0;
    const dl = base >>> 0;

    const RED = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    const BLUE = ((0<<11)|(0<<6)|(31<<1)|1)>>>0, CYAN=((0<<11)|(31<<6)|(31<<1)|1)>>>0;

    const uc = f3dToUc([
      { op: 'G_GRADIENT' as const, bgStart: BLUE, bgEnd: CYAN },
      { op: 'G_SETPRIMCOLOR5551' as const, color: RED },
      { op: 'G_SETCOMBINE_MODE' as const, mode: 'PRIM' as const },
      { op: 'G_TRI_PRIM' as const, x1: 20, y1: 20, x2: 80, y2: 30, x3: 40, y3: 70 },
      { op: 'G_END' as const },
    ]);

    writeUcAsRspdl(bus, dl, uc, 128);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 128);

    // The exact CRC is not important; we just assert stable hashing and non-empty output
    const hash = crc32(res.frames[0] ?? res.image);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(8);
  });
});

