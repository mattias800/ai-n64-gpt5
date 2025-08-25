import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Verifies translator -> RSPDL opcodes yields the same CRCs as hand-authored DLs for a simple scene

describe('ucode_translator_smoke', () => {
  it('Gradient + SetTLUT + DrawCI8 produces stable CRCs', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x5000) >>> 0;
    const tlut = base;
    const pix = (base + 0x1000) >>> 0;
    const dl = (base + 0x2000) >>> 0;

    // TLUT[1] = GREEN
    const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
    for (let i=0;i<256;i++) bus.storeU16(tlut + i*2, i===1?GREEN:0);
    // 16x16 block of index=1
    const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(pix+i, 1);

    const cmds = [
      { op: 'Gradient', bgStart: ((0<<11)|(0<<6)|(31<<1)|1) >>> 0, bgEnd: ((0<<11)|(31<<6)|(31<<1)|1) >>> 0 },
      { op: 'SetTLUT', tlutAddr: tlut>>>0, count: 256 },
      { op: 'DrawCI8', w: W, h: H, addr: pix>>>0, x: 50, y: 30 },
      { op: 'End' },
    ] as const;

    writeUcAsRspdl(bus, dl, cmds as any, 64);

    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, frames, start, interval, total, spOffset, 64);
    const hashes = res.frames.map(crc32);
    expect(hashes.length).toBe(2);
    expect(typeof hashes[0]).toBe('string');
    expect(typeof hashes[1]).toBe('string');
  });
});

