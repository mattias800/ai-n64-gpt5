import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { translateF3DEXToUc } from '../src/boot/f3dex_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Parity test: Mock F3DEX bytecode -> UC -> RSPDL should match typed F3D -> UC -> RSPDL

function makeCtx() {
  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  return { rdram, bus, cpu, sys };
}

function packTexCoord(ulx: number, uly: number) {
  return ((ulx & 0xFFF) << 12) | (uly & 0xFFF);
}

function fp(x: number) { return (x << 2) >>> 0; }

describe('f3dex_translator_parity', () => {
  it('CI8 rect with TLUT matches typed F3D pipeline CRCs', () => {
    // Shared constants
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;
    const fbBytes = width*height*2;

    // 1) Typed F3D path in its own context
    {
      const { bus, cpu, sys } = makeCtx();
      const base = (origin + fbBytes + 0xD000) >>> 0;
      const tlut = base;
      const pix = (base + 0x1000) >>> 0;
      const dlTyped = (base + 0x2000) >>> 0;

      const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
      for (let i=0;i<256;i++) bus.storeU16(tlut + i*2, i===1?GREEN:0);
      const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(pix+i, 1);

      const typedF3d = [
        { op: 'G_SETTLUT', addr: tlut>>>0, count: 256 },
        { op: 'G_SETCIMG', format: 'CI8' as const, addr: pix>>>0, w: W, h: H },
        { op: 'G_SPRITE', x: 60, y: 40, w: W, h: H },
        { op: 'G_END' },
      ];
      const ucTyped = f3dToUc(typedF3d as any);
      writeUcAsRspdl(bus, dlTyped, ucTyped, 64);

      const resTyped = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dlTyped, frames, start, interval, total, spOffset, 64);
      var hashesTyped = resTyped.frames.map(crc32);
    }

    // 2) Mock F3DEX bytecode path in a fresh context
    {
      const { bus, cpu, sys } = makeCtx();
      const base = (origin + fbBytes + 0xD000) >>> 0;
      const tlut = base;
      const pix = (base + 0x1000) >>> 0;
      const dlBytecode = (base + 0x3000) >>> 0;

      const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
      for (let i=0;i<256;i++) bus.storeU16(tlut + i*2, i===1?GREEN:0);
      const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(pix+i, 1);

      let p = dlBytecode >>> 0;
      const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19;
      bus.storeU32(p, (opSETTIMG | sizCI8) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pix >>> 0); p = (p + 4) >>> 0;
      const opLOADTLUT = 0xF0 << 24; bus.storeU32(p, (opLOADTLUT | 256) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, tlut >>> 0); p = (p + 4) >>> 0;
      const opSETTILESIZE = 0xF2 << 24; bus.storeU32(p, (opSETTILESIZE | packTexCoord(fp(0), fp(0))) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, packTexCoord(fp(W - 1), fp(H - 1)) >>> 0); p = (p + 4) >>> 0;
      const opTEXRECT = 0xE4 << 24; const ulx = fp(60), uly = fp(40); const lrx = fp(60 + W), lry = fp(40 + H);
      bus.storeU32(p, (opTEXRECT | packTexCoord(ulx, uly)) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, packTexCoord(lrx, lry) >>> 0); p = (p + 4) >>> 0;
      bus.storeU32(p, 0xDF000000 >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, 0x00000000); p = (p + 4) >>> 0;

      const ucFromBytecode = translateF3DEXToUc(bus, dlBytecode, 64);
      const dl2 = (dlBytecode + 0x1000) >>> 0;
      writeUcAsRspdl(bus, dl2, ucFromBytecode, 64);

      const resBytecode = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl2, frames, start, interval, total, spOffset, 64);
      const hashesBytecode = resBytecode.frames.map(crc32);

      expect(hashesBytecode).toEqual(hashesTyped);
    }
  });
});
