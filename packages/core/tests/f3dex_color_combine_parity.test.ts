import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hlePiLoadSegments } from '../src/boot/loader.ts';
import { scheduleF3DEXFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

// Validates that mocked F3DEX color/combine ops translate to our UC ops and match typed baseline.
describe('f3dex_color_combine_parity', () => {
  it('PI DMA: F3DEX with PRIM/ENV combine produces same CRCs as typed baseline', () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;
    const fbBytes = width*height*2;

    // Translator context
    const rdramA = new RDRAM(1 << 19);
    const busA = new Bus(rdramA);
    const cpuA = new CPU(busA);
    const sysA = new System(cpuA, busA);

    const baseA = (origin + fbBytes + 0xE000) >>> 0;
    const tlutA = baseA;
    const pixA = (baseA + 0x1000) >>> 0;
    const tableA = (baseA + 0x2000) >>> 0;
    const stagingA = (baseA + 0x3000) >>> 0;

    const rom = new Uint8Array(0x40000);
    const romTLUT = 0x10000 >>> 0;
    const romPIX  = 0x12000 >>> 0;
    const romDL0  = 0x14000 >>> 0;
    const romDL1  = 0x15000 >>> 0;

    const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
    for (let i=0;i<256;i++){
      const v = (i===1?GREEN:0) >>> 0;
      rom[romTLUT + i*2] = (v >>> 8) & 0xff; rom[romTLUT + i*2 + 1] = v & 0xff;
    }
    const W=16, H=16; for (let i=0;i<W*H;i++) rom[romPIX + i] = 1;

    function writeU32(at: number, val: number){ rom[at]=val>>>24; rom[at+1]=(val>>>16)&0xff; rom[at+2]=(val>>>8)&0xff; rom[at+3]=val&0xff; }

    const RED5551 = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    const CYAN5551 = ((0<<11)|(31<<6)|(31<<1)|1)>>>0;

    // Build DL0: SETTIMG CI8(pixA), LOADTLUT 256, SETCOMBINE(PRIM), SETPRIMCOLOR(RED), TEXRECT
    let p = romDL0;
    const opSETTIMG = 0xFD<<24, sizCI8 = 1<<19; writeU32(p, (opSETTIMG|sizCI8)>>>0); p+=4; writeU32(p, pixA>>>0); p+=4;
    const opLOADTLUT = 0xF0<<24; writeU32(p, (opLOADTLUT|256)>>>0); p+=4; writeU32(p, tlutA>>>0); p+=4;
    const opSETCOMB = 0xFC<<24; writeU32(p, opSETCOMB>>>0); p+=4; writeU32(p, 1); p+=4; // mode=1 -> PRIM
    const opSETPRIM = 0xFA<<24; writeU32(p, opSETPRIM>>>0); p+=4; writeU32(p, RED5551>>>0); p+=4;
    const opSETTILESIZE = 0xF2<<24; writeU32(p, (opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p+=4; writeU32(p, packTexCoord(fp(W-1),fp(H-1))>>>0); p+=4;
    const opTEXRECT = 0xE4<<24; const ulx=fp(40),uly=fp(30),lrx=fp(40+W),lry=fp(30+H); writeU32(p, (opTEXRECT|packTexCoord(ulx,uly))>>>0); p+=4; writeU32(p, packTexCoord(lrx,lry)>>>0); p+=4;
    writeU32(p, 0xDF000000>>>0); p+=4; writeU32(p, 0); const len0 = (p - romDL0)>>>0;

    // Build DL1: same but SETCOMBINE(ENV) + SETENVCOLOR(CYAN)
    p = romDL1;
    writeU32(p, (opSETTIMG|sizCI8)>>>0); p+=4; writeU32(p, pixA>>>0); p+=4;
    writeU32(p, (opLOADTLUT|256)>>>0); p+=4; writeU32(p, tlutA>>>0); p+=4;
    const opSETENV = 0xFB<<24; writeU32(p, opSETCOMB>>>0); p+=4; writeU32(p, 2); p+=4; // mode=2 -> ENV
    writeU32(p, opSETENV>>>0); p+=4; writeU32(p, CYAN5551>>>0); p+=4;
    writeU32(p, (opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p+=4; writeU32(p, packTexCoord(fp(W-1),fp(H-1))>>>0); p+=4;
    writeU32(p, (opTEXRECT|packTexCoord(ulx,uly))>>>0); p+=4; writeU32(p, packTexCoord(lrx,lry)>>>0); p+=4;
    writeU32(p, 0xDF000000>>>0); p+=4; writeU32(p, 0); const len1 = (p - romDL1)>>>0;

    busA.setROM(rom);
    hlePiLoadSegments(busA, [
      { cartAddr: romTLUT, dramAddr: tlutA, length: 256*2 },
      { cartAddr: romPIX, dramAddr: pixA, length: W*H },
      { cartAddr: romDL0, dramAddr: (baseA + 0x6000)>>>0, length: len0 },
      { cartAddr: romDL1, dramAddr: (baseA + 0x7000)>>>0, length: len1 },
    ], true);
    const dl0A = (baseA + 0x6000)>>>0, dl1A=(baseA+0x7000)>>>0;
    busA.storeU32(tableA + 0, dl0A>>>0); busA.storeU32(tableA + 4, dl1A>>>0);

    const strideWords = 128;
    const resDex = scheduleF3DEXFromTableAndRun(cpuA, busA, sysA, origin, width, height, tableA, frames, stagingA, strideWords, start, interval, total, spOffset);

    // Typed baseline context
    const rdramB = new RDRAM(1 << 19);
    const busB = new Bus(rdramB);
    const cpuB = new CPU(busB);
    const sysB = new System(cpuB, busB);

    const baseB = (origin + fbBytes + 0xF000) >>> 0;
    const tlutB = baseB, pixB=(baseB+0x1000)>>>0, dlB=(baseB+0x2000)>>>0;
    for (let i=0;i<256;i++) busB.storeU16(tlutB+i*2, i===1?GREEN:0);
    for (let i=0;i<W*H;i++) busB.storeU8(pixB+i, 1);

    const f0 = [
      { op: 'G_SETTLUT' as const, addr: tlutB>>>0, count: 256 },
      { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixB>>>0, w: W, h: H },
      { op: 'G_SETPRIMCOLOR5551' as const, color: RED5551 },
      { op: 'G_SETCOMBINE_MODE' as const, mode: 'PRIM' as const },
      { op: 'G_SPRITE' as const, x: 40, y: 30, w: W, h: H },
      { op: 'G_END' as const },
    ];
    const f1 = [
      { op: 'G_SETTLUT' as const, addr: tlutB>>>0, count: 256 },
      { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixB>>>0, w: W, h: H },
      { op: 'G_SETENVCOLOR5551' as const, color: CYAN5551 },
      { op: 'G_SETCOMBINE_MODE' as const, mode: 'ENV' as const },
      { op: 'G_SPRITE' as const, x: 40, y: 30, w: W, h: H },
      { op: 'G_END' as const },
    ];
    const dlBaseB = dlB;
    writeUcAsRspdl(busB, dlBaseB + 0*strideWords*4, f3dToUc(f0 as any), strideWords);
    writeUcAsRspdl(busB, dlBaseB + 1*strideWords*4, f3dToUc(f1 as any), strideWords);

    const resTyped = scheduleRSPDLFramesAndRun(cpuB, busB, sysB, origin, width, height, dlBaseB, 2, start, interval, total, spOffset, strideWords);

    const hDex = resDex.frames.map(crc32);
    const hTy = resTyped.frames.map(crc32);

    expect(hDex).toEqual(hTy);
  });
});

