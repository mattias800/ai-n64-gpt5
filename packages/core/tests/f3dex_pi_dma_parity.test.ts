import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hlePiLoadSegments } from '../src/boot/loader.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { scheduleRSPDLFramesAndRun, scheduleF3DEXFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

describe('f3dex_pi_dma_parity', () => {
  it('F3DEX DL + assets loaded via PI DMA match typed F3D pipeline CRCs', () => {
    // Shared constants
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;
    const fbBytes = width*height*2;

    // 1) F3DEX path in its own context, assets loaded by PI DMA
    const dexHashes = (() => {
      const rdram = new RDRAM(1 << 19);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const base = (origin + fbBytes + 0xF000) >>> 0;
      const tlutRdram = base;
      const pixRdram = (base + 0x1000) >>> 0;
      const tableBase = (base + 0x2000) >>> 0;
      const stagingBase = (base + 0x3000) >>> 0;

      const rom = new Uint8Array(0x30000);
      const romTlut = 0x10000 >>> 0;
      const romPix =  0x12000 >>> 0;
      const romDl0 =  0x14000 >>> 0;
      const romDl1 =  0x15000 >>> 0;

      const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
      for (let i=0;i<256;i++){
        const v = (i===1?GREEN:0) >>> 0;
        rom[romTlut + i*2] = (v >>> 8) & 0xff; rom[romTlut + i*2 + 1] = v & 0xff;
      }
      const W=16, H=16; for (let i=0;i<W*H;i++) rom[romPix + i] = 1;

      function writeDl(at: number, x: number, y: number): number {
        let p = at >>> 0;
        const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19;
        rom[p++] = (opSETTIMG|sizCI8)>>>24; rom[p++] = (opSETTIMG|sizCI8)>>>16; rom[p++] = (opSETTIMG|sizCI8)>>>8; rom[p++] = (opSETTIMG|sizCI8)>>>0;
        rom[p++] = (pixRdram>>>24)&0xff; rom[p++] = (pixRdram>>>16)&0xff; rom[p++] = (pixRdram>>>8)&0xff; rom[p++] = (pixRdram>>>0)&0xff;
        const opLOADTLUT = 0xF0 << 24; const count = 256; const w0lt = (opLOADTLUT | (count & 0xffff)) >>> 0;
        rom[p++] = w0lt>>>24; rom[p++] = w0lt>>>16; rom[p++] = w0lt>>>8; rom[p++] = w0lt>>>0;
        rom[p++] = (tlutRdram>>>24)&0xff; rom[p++] = (tlutRdram>>>16)&0xff; rom[p++] = (tlutRdram>>>8)&0xff; rom[p++] = (tlutRdram>>>0)&0xff;
        const opSETTILESIZE = 0xF2 << 24; const w0s = (opSETTILESIZE | packTexCoord(fp(0), fp(0)))>>>0; const w1s = packTexCoord(fp(W-1), fp(H-1))>>>0;
        rom[p++] = w0s>>>24; rom[p++] = w0s>>>16; rom[p++] = w0s>>>8; rom[p++] = w0s>>>0;
        rom[p++] = w1s>>>24; rom[p++] = w1s>>>16; rom[p++] = w1s>>>8; rom[p++] = w1s>>>0;
        const opTEXRECT = 0xE4 << 24; const ulx = fp(x), uly = fp(y); const lrx = fp(x+W), lry = fp(y+H);
        const w0tr = (opTEXRECT | packTexCoord(ulx, uly))>>>0; const w1tr = packTexCoord(lrx, lry)>>>0;
        rom[p++] = w0tr>>>24; rom[p++] = w0tr>>>16; rom[p++] = w0tr>>>8; rom[p++] = w0tr>>>0;
        rom[p++] = w1tr>>>24; rom[p++] = w1tr>>>16; rom[p++] = w1tr>>>8; rom[p++] = w1tr>>>0;
        const w0end = 0xDF000000>>>0; rom[p++] = w0end>>>24; rom[p++] = w0end>>>16; rom[p++] = w0end>>>8; rom[p++] = w0end>>>0;
        rom[p++] = 0; rom[p++] = 0; rom[p++] = 0; rom[p++] = 0;
        return (p - at) >>> 0;
      }
      const len0 = writeDl(romDl0, 60, 40); const len1 = writeDl(romDl1, 61, 40);

      bus.setROM(rom);
      hlePiLoadSegments(bus, [
        { cartAddr: romTlut, dramAddr: tlutRdram, length: 256*2 },
        { cartAddr: romPix,  dramAddr: pixRdram,  length: W*H },
        { cartAddr: romDl0,  dramAddr: (base + 0x4000)>>>0, length: len0 },
        { cartAddr: romDl1,  dramAddr: (base + 0x5000)>>>0, length: len1 },
      ], true);
      const dl0Rdram = (base + 0x4000) >>> 0; const dl1Rdram = (base + 0x5000) >>> 0;
      bus.storeU32(tableBase + 0, dl0Rdram>>>0); bus.storeU32(tableBase + 4, dl1Rdram>>>0);

      const strideWords = 128;
      const res = scheduleF3DEXFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, stagingBase, strideWords, start, interval, total, spOffset);
      return res.frames.map(crc32);
    })();

    // 2) Typed F3D path in a fresh context
    const typedHashes = (() => {
      const rdram = new RDRAM(1 << 19);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const base = (origin + fbBytes + 0xF000) >>> 0;
      const tlutRdram = base;
      const pixRdram = (base + 0x1000) >>> 0;
      const typedBase = (base + 0x7000) >>> 0;

      const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
      for (let i=0;i<256;i++) bus.storeU16(tlutRdram + i*2, i===1?GREEN:0);
      const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(pixRdram+i, 1);

      const strideWords = 128;
      for (let i=0;i<frames;i++){
        const f3d = [
          { op: 'G_SETTLUT' as const, addr: tlutRdram>>>0, count: 256 },
          { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixRdram>>>0, w: W, h: H },
          { op: 'G_SPRITE' as const, x: (60+i), y: 40, w: W, h: H },
          { op: 'G_END' as const },
        ];
        const uc = f3dToUc(f3d as any);
        writeUcAsRspdl(bus, (typedBase + i*strideWords*4)>>>0, uc, strideWords);
      }
      const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, typedBase, frames, start, interval, total, spOffset, strideWords);
      return res.frames.map(crc32);
    })();

    expect(dexHashes).toEqual(typedHashes);
  });
});
