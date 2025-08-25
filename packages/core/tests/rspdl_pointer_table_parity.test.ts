import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Ensures per-frame DL pointers table is honored and CRCs are as expected

describe('rspdl_pointer_table_parity', () => {
  it('table-driven per-frame DLs produce SM64 slice CRCs', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0xB000) >>> 0;
    const tableBase = base;
    const dl0 = (base + 0x100) >>> 0;
    const dl1 = (base + 0x1100) >>> 0;

    // table
    bus.storeU32(tableBase + 0, dl0>>>0);
    bus.storeU32(tableBase + 4, dl1>>>0);

    const strideWords = 0x1000 >>> 2;
    for (let i=0;i<frames;i++){
      const uc = f3dToUc([
        { op: 'G_GRADIENT', bgStart: ((0<<11)|(0<<6)|(31<<1)|1)>>>0, bgEnd: ((0<<11)|(31<<6)|(31<<1)|1)>>>0 },
        { op: 'G_SM64_SLICE', spacing: 10, offsetX: i },
        { op: 'G_END' },
      ] as any);
      writeUcAsRspdl(bus, (i===0?dl0:dl1), uc, strideWords);
    }

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, start, interval, total, spOffset, strideWords);
    const hashes = res.frames.map(crc32);
    expect(hashes).toEqual([ '6ca0bc0e', 'db86e0b3' ]);
  });
});

