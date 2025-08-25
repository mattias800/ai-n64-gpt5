import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Verifies the SM64-like slice command produces the same CRCs as the hand-authored title demo DL.

describe('f3d_sm64_slice_parity', () => {
  it('SM64 slice parity: f3d->uc->rspdl equals DP-driven expected CRCs', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x9000) >>> 0;
    const dl = base;

    // Build F3D-like program: gradient + sm64 slice (offsetX per frame)
    // We'll write two DLs with changing slice offsetX via f3d->uc.
    const strideWords = 0x1000 >>> 2; // match 0x1000-byte spacing between per-frame DLs
    for (let i=0;i<frames;i++){
      const f3d = [
        { op: 'G_GRADIENT', bgStart: ((0<<11)|(0<<6)|(31<<1)|1)>>>0, bgEnd: ((0<<11)|(31<<6)|(31<<1)|1)>>>0 },
        { op: 'G_SM64_SLICE', spacing: 10, offsetX: i },
        { op: 'G_END' },
      ];
      const uc = f3dToUc(f3d as any);
      writeUcAsRspdl(bus, (dl + i*strideWords*4)>>>0, uc, strideWords);
    }

    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, frames, start, interval, total, spOffset, strideWords);
    const hashes = res.frames.map(crc32);
    // Should match the known 2-frame DP-driven SM64 title demo CRCs
    expect(hashes).toEqual([ '6ca0bc0e', 'db86e0b3' ]);
  });
});

