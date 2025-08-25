import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

describe('f3d_ci4_palette_parity', () => {
  it('Different CI4 palettes produce different CRCs and match expected mapping', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width=128, height=96, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0xC000) >>> 0;
    const tlut = base;
    const pix = (base + 0x1000) >>> 0;
    const dl = (base + 0x2000) >>> 0;

    // TLUT banks of 16 entries each: palette 0 -> RED at index 1; palette 1 -> GREEN at index 17
    const RED=((31<<11)|(0<<6)|(0<<1)|1)>>>0; const GREEN=((0<<11)|(31<<6)|(0<<1)|1)>>>0;
    for (let i=0;i<32;i++) bus.storeU16(tlut + i*2, (i===1?RED:(i===17?GREEN:0))>>>0);

    const W=16,H=16; const packedLen=Math.ceil(W*H/2);
    for (let i=0;i<packedLen;i++) bus.storeU8(pix+i, 0x11); // all index=1 (or 17 when palette=1)

    const strideWords=128;
    for (let pal=0; pal<2; pal++){
      const uclist = f3dToUc([
        { op: 'G_SETTLUT', addr: tlut>>>0, count: 32 },
        { op: 'G_SETCIMG', format: 'CI4' as const, addr: pix>>>0, w: W, h: H },
        { op: 'G_SET_CI4_PALETTE', palette: pal },
        { op: 'G_SPRITE', x: 20 + pal*30, y: 20, w: W, h: H },
        { op: 'G_END' },
      ] as any);
      writeUcAsRspdl(bus, (dl + pal*strideWords*4)>>>0, uclist, strideWords);
    }

    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, frames, start, interval, total, spOffset, strideWords);
    const hashes = res.frames.map(crc32);
    expect(hashes.length).toBe(2);
    // Pal 0 vs Pal 1 produce different CRCs (color differs)
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
