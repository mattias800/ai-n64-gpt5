import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleBoot } from '../src/boot/hle.ts';
import { hlePiLoadSegments } from '../src/boot/loader.ts';
import { scheduleF3DEXFromTableAndRun, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

// Build a tiny synthetic ROM containing TLUT, pixels, and two DLs referencing RDRAM addresses
function buildSyntheticROM(width: number, height: number, origin: number) {
  const fbBytes = width * height * 2;
  const base = (origin + fbBytes + 0xE000) >>> 0;
  const tlutRdram = base >>> 0;
  const pixRdram = (base + 0x1000) >>> 0;
  const dl0Rdram = (base + 0x2000) >>> 0;
  const dl1Rdram = (base + 0x2400) >>> 0;
  const tableRdram = (base + 0x2800) >>> 0;

  // Carve out ROM regions and write header (big-endian z64 signature and initialPC)
  const rom = new Uint8Array(0x30000);
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40; // z64 magic
  // initialPC at 0x8..0xB: point it somewhere nonzero
  rom[0x8] = 0x80; rom[0x9] = 0x00; rom[0xA] = 0x00; rom[0xB] = 0x00;

  const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
  for (let i=0;i<256;i++){
    const v = (i===1?GREEN:0) >>> 0;
    rom[0x10000 + i*2] = (v >>> 8) & 0xff; rom[0x10000 + i*2 + 1] = v & 0xff;
  }
  const W=16, H=16; for (let i=0;i<W*H;i++) rom[0x12000 + i] = 1;

  function writeDl(at: number, x: number, y: number): number {
    let p = at >>> 0;
    const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19;
    rom[p++] = (opSETTIMG|sizCI8)>>>24; rom[p++] = (opSETTIMG|sizCI8)>>>16; rom[p++] = (opSETTIMG|sizCI8)>>>8; rom[p++] = (opSETTIMG|sizCI8)>>>0;
    // DRAM address of pixels
    rom[p++] = (pixRdram>>>24)&0xff; rom[p++] = (pixRdram>>>16)&0xff; rom[p++] = (pixRdram>>>8)&0xff; rom[p++] = (pixRdram>>>0)&0xff;
    // LOADTLUT count and DRAM TLUT addr
    const opLOADTLUT = 0xF0 << 24; const count = 256; const w0lt = (opLOADTLUT | (count & 0xffff)) >>> 0;
    rom[p++] = w0lt>>>24; rom[p++] = w0lt>>>16; rom[p++] = w0lt>>>8; rom[p++] = w0lt>>>0;
    rom[p++] = (tlutRdram>>>24)&0xff; rom[p++] = (tlutRdram>>>16)&0xff; rom[p++] = (tlutRdram>>>8)&0xff; rom[p++] = (tlutRdram>>>0)&0xff;
    // SETTILESIZE
    const opSETTILESIZE = 0xF2 << 24; const w0s = (opSETTILESIZE | packTexCoord(fp(0), fp(0)))>>>0; const w1s = packTexCoord(fp(W-1), fp(H-1))>>>0;
    rom[p++] = w0s>>>24; rom[p++] = w0s>>>16; rom[p++] = w0s>>>8; rom[p++] = w0s>>>0;
    rom[p++] = w1s>>>24; rom[p++] = w1s>>>16; rom[p++] = w1s>>>8; rom[p++] = w1s>>>0;
    // TEXRECT
    const opTEXRECT = 0xE4 << 24; const ulx = fp(x), uly = fp(y); const lrx = fp(x+W), lry = fp(y+H);
    const w0tr = (opTEXRECT | packTexCoord(ulx, uly))>>>0; const w1tr = packTexCoord(lrx, lry)>>>0;
    rom[p++] = w0tr>>>24; rom[p++] = w0tr>>>16; rom[p++] = w0tr>>>8; rom[p++] = w0tr>>>0;
    rom[p++] = w1tr>>>24; rom[p++] = w1tr>>>16; rom[p++] = w1tr>>>8; rom[p++] = w1tr>>>0;
    // END
    const w0end = 0xDF000000>>>0; rom[p++] = w0end>>>24; rom[p++] = w0end>>>16; rom[p++] = w0end>>>8; rom[p++] = w0end>>>0;
    rom[p++] = 0; rom[p++] = 0; rom[p++] = 0; rom[p++] = 0;
    return (p - at) >>> 0;
  }
  const len0 = writeDl(0x14000, 60, 40);
  const len1 = writeDl(0x15000, 61, 40);

  return {
    rom,
    tlutRom: 0x10000 >>> 0,
    pixRom:  0x12000 >>> 0,
    dl0Rom:  0x14000 >>> 0,
    dl1Rom:  0x15000 >>> 0,
    tlutRdram, pixRdram, dl0Rdram, dl1Rdram, tableRdram,
    base,
  } as const;
}

describe('rom_sm64_title_hle_smoke', () => {
  it('HLE boots a ROM, loads assets via PI DMA, and renders two frames with F3DEX translator', () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const synth = buildSyntheticROM(width, height, origin);
    const boot = hleBoot(cpu, bus, synth.rom);
    expect(boot.order).toBe('z64');

    // Use HLE PI DMA loader to copy TLUT, pixels, and two Dls from ROM to RDRAM; write DL table
    hlePiLoadSegments(bus, [
      { cartAddr: synth.tlutRom, dramAddr: synth.tlutRdram, length: 256*2 },
      { cartAddr: synth.pixRom,  dramAddr: synth.pixRdram,  length: 16*16 },
      { cartAddr: synth.dl0Rom,  dramAddr: synth.dl0Rdram,  length: 0x400 },
      { cartAddr: synth.dl1Rom,  dramAddr: synth.dl1Rdram,  length: 0x400 },
    ], true);
    bus.storeU32(synth.tableRdram + 0, synth.dl0Rdram>>>0);
    bus.storeU32(synth.tableRdram + 4, synth.dl1Rdram>>>0);

    const strideWords = 128;
    const resDex = scheduleF3DEXFromTableAndRun(
      cpu, bus, sys,
      origin, width, height,
      synth.tableRdram, frames,
      synth.base + 0x6000, strideWords,
      start, interval, total, spOffset,
    );

    // Build a typed RSPDL path that draws the same CI8 sprite at (60,40) then (61,40)
    const rdram2 = new RDRAM(1 << 19);
    const bus2 = new Bus(rdram2);
    const cpu2 = new CPU(bus2);
    const sys2 = new System(cpu2, bus2);
    // HLE boot second context so RDRAM initial contents match (ROM copied into RDRAM)
    hleBoot(cpu2, bus2, synth.rom);
    // Load assets via HLE PI as well
    hlePiLoadSegments(bus2, [
      { cartAddr: synth.tlutRom, dramAddr: synth.tlutRdram, length: 256*2 },
      { cartAddr: synth.pixRom,  dramAddr: synth.pixRdram,  length: 16*16 },
    ], true);

    const typedBase = (synth.base + 0x7000) >>> 0;
    for (let i = 0; i < frames; i++) {
      const uc: UcCmd[] = [
        { op: 'SetTLUT', tlutAddr: synth.tlutRdram, count: 256 },
        { op: 'SetCombine', mode: 'TEXEL0' },
        { op: 'DrawCI8', w: 16, h: 16, addr: synth.pixRdram, x: 60 + i, y: 40 },
        { op: 'End' },
      ];
      writeUcAsRspdl(bus2, (typedBase + i*strideWords*4)>>>0, uc, strideWords);
    }
    const resTyped = scheduleRSPDLFramesAndRun(cpu2, bus2, sys2, origin, width, height, typedBase, frames, start, interval, total, spOffset, strideWords);

    const hashesDex = resDex.frames.map(crc32);
    const hashesTyped = resTyped.frames.map(crc32);
    expect(hashesDex).toEqual(hashesTyped);
  });
});

