import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hlePiLoadSegments } from '../src/boot/loader.ts';
import { scheduleF3DEXFromTableAndRun, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

// Combined test: PI DMA loads TLUT/PIX and two main DLs (segmented) that call a shared sublist. Each main sets a different CI4 palette via G_SETTILE.
// Translator path frames must match typed F3D path frames (using G_SET_CI4_PALETTE) per-frame CRCs.

describe('f3dex_pi_dma_segment_ci4_parity', () => {
  it('PI DMA + segmented G_DL + CI4 palette via G_SETTILE matches typed F3D per-frame CRCs', () => {
    const width=176, height=96, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    // Context A: translator path
    const rdramA = new RDRAM(1 << 19);
    const busA = new Bus(rdramA);
    const cpuA = new CPU(busA);
    const sysA = new System(cpuA, busA);

    const fbBytes = width*height*2;
    const baseA = (origin + fbBytes + 0x8800) >>> 0;
    const tlutA = baseA;
    const pixA = (baseA + 0x1000) >>> 0;
    const subA = (baseA + 0x2000) >>> 0; // sublist (segmented)
    const main0A = (baseA + 0x3000) >>> 0;
    const main1A = (baseA + 0x3800) >>> 0;
    const tableA = (baseA + 0x4000) >>> 0;
    const stagingA = (baseA + 0x5000) >>> 0;

    // Fake ROM: TLUT (32 entries), PIX (CI4 packed), DLs
    const rom = new Uint8Array(0x60000);
    const romTLUT = 0x20000 >>> 0, romPIX = 0x22000 >>> 0, romSub = 0x24000 >>> 0, romMain0 = 0x25000 >>> 0, romMain1 = 0x26000 >>> 0;

    // TLUT: palette 0 index 1 = RED, palette 1 index (16+1)=17 = GREEN
    const RED = ((31<<11)|(0<<6)|(0<<1)|1)>>>0; const GREEN=((0<<11)|(31<<6)|(0<<1)|1)>>>0;
    for (let i=0;i<32;i++) { const v = (i===1?RED:(i===17?GREEN:0))>>>0; rom[romTLUT+i*2]=(v>>>8)&0xff; rom[romTLUT+i*2+1]=v&0xff; }

    // PIX: 16x16 indices of 1 (nibble-packed)
    const W=16,H=16; const packedLen = Math.ceil(W*H/2);
    for (let i=0;i<packedLen;i++) rom[romPIX+i] = 0x11;

    // Shared sublist: SETTIMG CI4(pixA), LOADTLUT 32, SETTILESIZE 16x16, TEXRECT at (40,30), END
    function writeU32(at: number, val: number){ rom[at]=val>>>24; rom[at+1]=(val>>>16)&0xff; rom[at+2]=(val>>>8)&0xff; rom[at+3]=val&0xff; }
    let p = romSub;
    const opSETTIMG = 0xFD<<24, sizCI4 = 0<<19; writeU32(p, (opSETTIMG|sizCI4)>>>0); p+=4; writeU32(p, pixA>>>0); p+=4;
    const opLOADTLUT = 0xF0<<24; writeU32(p, (opLOADTLUT|32)>>>0); p+=4; writeU32(p, tlutA>>>0); p+=4;
    const opSETTILESIZE = 0xF2<<24; writeU32(p, (opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p+=4; writeU32(p, packTexCoord(fp(W-1),fp(H-1))>>>0); p+=4;
    const opTEXRECT = 0xE4<<24; const ulx=fp(40),uly=fp(30),lrx=fp(40+W),lry=fp(30+H); writeU32(p, (opTEXRECT|packTexCoord(ulx,uly))>>>0); p+=4; writeU32(p, packTexCoord(lrx,lry)>>>0); p+=4;
    writeU32(p, 0xDF000000>>>0); p+=4; writeU32(p, 0); // END
    const lenSub = (p - romSub)>>>0;

    // Write main DL helper: sets segment 6 to baseA, sets tile palette, calls sublist (push), end
    function writeMain(at: number, palette: number): number {
      let q = at>>>0;
      const opSEGMENT = 0xD7<<24; writeU32(q, (opSEGMENT | (6<<16))>>>0); q+=4; writeU32(q, baseA>>>0); q+=4;
      const opSETTILE = 0xF5<<24; // encode palette in bits 20..23 of w1
      writeU32(q, (opSETTILE|0)>>>0); q+=4; writeU32(q, (palette & 0xF) << 20); q+=4;
      const opDL = 0xDE<<24; const subSeg = (0x06<<24)|((subA-baseA)>>>0); writeU32(q, (opDL|1)>>>0); q+=4; writeU32(q, subSeg>>>0); q+=4;
      writeU32(q, 0xDF000000>>>0); q+=4; writeU32(q, 0);
      return (q - at)>>>0;
    }

    const lenMain0 = writeMain(romMain0, 0);
    const lenMain1 = writeMain(romMain1, 1);

    // Install ROM
    busA.setROM(rom);
    // PI DMA copy TLUT/PIX and DLs to RDRAM
    hlePiLoadSegments(busA, [
      { cartAddr: romTLUT, dramAddr: tlutA, length: 32*2 },
      { cartAddr: romPIX, dramAddr: pixA, length: packedLen },
      { cartAddr: romSub, dramAddr: subA, length: lenSub },
      { cartAddr: romMain0, dramAddr: main0A, length: lenMain0 },
      { cartAddr: romMain1, dramAddr: main1A, length: lenMain1 },
    ], true);

    // Pointer table: per-frame DLs (main0A, main1A)
    busA.storeU32(tableA + 0, main0A>>>0);
    busA.storeU32(tableA + 4, main1A>>>0);

    const strideWords = 128;
    const resA = scheduleF3DEXFromTableAndRun(cpuA, busA, sysA, origin, width, height, tableA, frames, stagingA, strideWords, start, interval, total, spOffset);
    const hashesA = resA.frames.map(crc32);

    // Context B: typed F3D baseline
    const rdramB = new RDRAM(1 << 19);
    const busB = new Bus(rdramB);
    const cpuB = new CPU(busB);
    const sysB = new System(cpuB, busB);

    const baseB = (origin + fbBytes + 0xA800) >>> 0;
    const tlutB = baseB, pixB2 = (baseB + 0x1000) >>> 0, dlB = (baseB + 0x2000) >>> 0;
    for (let i=0;i<32;i++) busB.storeU16(tlutB + i*2, (i===1?RED:(i===17?GREEN:0))>>>0);
    for (let i=0;i<packedLen;i++) busB.storeU8(pixB2+i, 0x11);

    for (let f=0; f<frames; f++){
      const pal = f; // 0 then 1
      const uc = f3dToUc([
        { op: 'G_SETTLUT', addr: tlutB>>>0, count: 32 },
        { op: 'G_SETCIMG', format: 'CI4' as const, addr: pixB2>>>0, w: W, h: H },
        { op: 'G_SET_CI4_PALETTE', palette: pal },
        { op: 'G_SPRITE', x: 40, y: 30, w: W, h: H },
        { op: 'G_END' },
      ] as any);
      writeUcAsRspdl(busB, (dlB + f*strideWords*4)>>>0, uc, strideWords);
    }

    const resB = scheduleRSPDLFramesAndRun(cpuB, busB, sysB, origin, width, height, dlB, frames, start, interval, total, spOffset, strideWords);
    const hashesB = resB.frames.map(crc32);

    expect(hashesA).toEqual(hashesB);
  });
});
