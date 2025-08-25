import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { translateF3DEXToUc } from '../src/boot/f3dex_translator.ts';
import { crc32 } from './helpers/test_utils.ts';

function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }
function fp(x: number) { return (x << 2) >>> 0; }

describe('f3dex_ci4_translator_parity', () => {
  it('CI4 rect with TLUT matches typed F3D pipeline CRCs', () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const fbBytes = width*height*2;

    // 1) Typed F3D path in its own context
    const rdramT = new RDRAM(1 << 19);
    const busT = new Bus(rdramT);
    const cpuT = new CPU(busT);
    const sysT = new System(cpuT, busT);

    const baseT = (origin + fbBytes + 0xE000) >>> 0;
    const tlutT = baseT;
    const pixT = (baseT + 0x1000) >>> 0;
    const dlTyped = (baseT + 0x2000) >>> 0;

    // TLUT[1] = GREEN
    const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
    for (let i=0;i<16;i++) busT.storeU16(tlutT + i*2, i===1?GREEN:0);

    // 16x16 pixels of index 1, nibble-packed: two pixels per byte
    const W=16,H=16; const numPix=W*H; const packedLen = Math.ceil(numPix/2);
    for (let i=0;i<packedLen;i++) busT.storeU8(pixT+i, 0x11);

    // 1) Typed F3D path
    const typedF3d = [
      { op: 'G_SETTLUT', addr: tlutT>>>0, count: 16 },
      { op: 'G_SETCIMG', format: 'CI4' as const, addr: pixT>>>0, w: W, h: H },
      { op: 'G_SPRITE', x: 40, y: 30, w: W, h: H },
      { op: 'G_END' },
    ];
    const ucTyped = f3dToUc(typedF3d as any);
    writeUcAsRspdl(busT, dlTyped, ucTyped, 64);

    const resTyped = scheduleRSPDLFramesAndRun(cpuT, busT, sysT, origin, width, height, dlTyped, frames, start, interval, total, spOffset, 64);
    const hashesTyped = resTyped.frames.map(crc32);

    // 2) F3DEX bytecode path in a fresh context
    const rdramB = new RDRAM(1 << 19);
    const busB = new Bus(rdramB);
    const cpuB = new CPU(busB);
    const sysB = new System(cpuB, busB);

    const baseB = (origin + fbBytes + 0xE000) >>> 0;
    const tlutB = baseB;
    const pixB = (baseB + 0x1000) >>> 0;
    const dlBytecode = (baseB + 0x3000) >>> 0;

    for (let i=0;i<16;i++) busB.storeU16(tlutB + i*2, i===1?GREEN:0);
    for (let i=0;i<packedLen;i++) busB.storeU8(pixB+i, 0x11);

    let p = dlBytecode >>> 0;
    // G_SETTIMG (0xFD): siz=0 (CI4), word1 = pix
    const opSETTIMG = 0xFD << 24;
    const sizCI4 = 0 << 19;
    busB.storeU32(p, (opSETTIMG | sizCI4) >>> 0); p = (p + 4) >>> 0;
    busB.storeU32(p, pixB >>> 0); p = (p + 4) >>> 0;
    // G_LOADTLUT (0xF0): count in low16, word1 = tlut
    const opLOADTLUT = 0xF0 << 24;
    busB.storeU32(p, (opLOADTLUT | 16) >>> 0); p = (p + 4) >>> 0;
    busB.storeU32(p, tlutB >>> 0); p = (p + 4) >>> 0;
    // G_SETTILESIZE (0xF2) 16x16 at (0,0)
    const opSETTILESIZE = 0xF2 << 24;
    busB.storeU32(p, (opSETTILESIZE | packTexCoord(fp(0), fp(0))) >>> 0); p = (p + 4) >>> 0;
    busB.storeU32(p, packTexCoord(fp(W - 1), fp(H - 1)) >>> 0); p = (p + 4) >>> 0;
    // Optional: set palette via G_SETTILE (0xF5) palette=0
    const opSETTILE = 0xF5 << 24;
    // Palette=0 in bits 20..23 => w1 remains 0 for palette=0; no-op but exercises decode path
    busB.storeU32(p, (opSETTILE | 0) >>> 0); p = (p + 4) >>> 0;
    busB.storeU32(p, 0 >>> 0); p = (p + 4) >>> 0;
    // G_TEXRECT (0xE4) at x=40,y=30
    const opTEXRECT = 0xE4 << 24;
    const ulx = fp(40), uly = fp(30);
    const lrx = fp(40 + W), lry = fp(30 + H);
    busB.storeU32(p, (opTEXRECT | packTexCoord(ulx, uly)) >>> 0); p = (p + 4) >>> 0;
    busB.storeU32(p, packTexCoord(lrx, lry) >>> 0); p = (p + 4) >>> 0;
    // G_ENDDL (0xDF)
    busB.storeU32(p, 0xDF000000 >>> 0); p = (p + 4) >>> 0;
    busB.storeU32(p, 0x00000000); p = (p + 4) >>> 0;

    // Translate and emit as RSPDL in a separate area
    const dl2 = (dlBytecode + 0x1000) >>> 0;
    const ucFromBytecode = translateF3DEXToUc(busB as any, dlBytecode, 64);
    writeUcAsRspdl(busB, dl2, ucFromBytecode, 64);

    const resBytecode = scheduleRSPDLFramesAndRun(cpuB, busB, sysB, origin, width, height, dl2, frames, start, interval, total, spOffset, 64);
    const hashesBytecode = resBytecode.frames.map(crc32);

    expect(hashesBytecode).toEqual(hashesTyped);
  });
});
