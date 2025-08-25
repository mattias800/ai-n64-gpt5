import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hlePiLoadSegments } from '../src/boot/loader.ts';
import { scheduleF3DEXFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

// Build a CI4 8x8 checker overlay (opaque) and a solid CI8 base; draw base under TEXEL0 then overlay under PRIM combine (solid color), ensure parity.
describe('f3dex_mixed_ci8_ci4_combine_parity', () => {
  it('CI8 base (TEXEL0) + CI4 overlay (PRIM fill) parity between translator and typed baseline', () => {
    const width=160, height=96, origin=0xF000;
    const start=2, interval=3, frames=1, spOffset=1;
    const total = start + interval*frames + 2;
    const fbBytes = width*height*2;

    // Translator path
    const rdramA = new RDRAM(1 << 19);
    const busA = new Bus(rdramA);
    const cpuA = new CPU(busA);
    const sysA = new System(cpuA, busA);

    const baseA = (origin + fbBytes + 0xC000) >>> 0;
    const tlutCI8 = baseA;
    const pixCI8 = (baseA + 0x1000) >>> 0;
    const tlutCI4 = (baseA + 0x2000) >>> 0;
    const pixCI4 = (baseA + 0x2800) >>> 0; // nibble-packed
    const tableA = (baseA + 0x3000) >>> 0;
    const stagingA = (baseA + 0x4000) >>> 0;

    const rom = new Uint8Array(0x50000);
    const romCI8TLUT = 0x10000 >>> 0;
    const romCI8PIX =  0x11000 >>> 0;
    const romCI4TLUT = 0x12000 >>> 0;
    const romCI4PIX =  0x13000 >>> 0;
    const romDL0 =    0x14000 >>> 0;

    // TLUTs
    const BLUE = ((0<<11)|(0<<6)|(31<<1)|1)>>>0;
    for (let i=0;i<256;i++){ const v=(i===1?BLUE:0)>>>0; rom[romCI8TLUT+i*2]=v>>>8; rom[romCI8TLUT+i*2+1]=v&0xff; }
    const WHITE = ((31<<11)|(31<<6)|(31<<1)|1)>>>0;
    for (let i=0;i<32;i++){ const v=(i===1?WHITE:0)>>>0; rom[romCI4TLUT+i*2]=v>>>8; rom[romCI4TLUT+i*2+1]=v&0xff; }

    // CI8 base 32x32 filled with index 1
    const BW=32,BH=32; for (let i=0;i<BW*BH;i++) rom[romCI8PIX+i]=1;

    // CI4 8x8 checker (index 1 for white); pack 2 pixels per byte
    const OW=8,OH=8; const packedLen=Math.ceil(OW*OH/2);
    for (let i=0;i<packedLen;i++) rom[romCI4PIX+i]=0x11;

    function W32(at:number,val:number){ rom[at]=val>>>24; rom[at+1]=(val>>>16)&0xff; rom[at+2]=(val>>>8)&0xff; rom[at+3]=val&0xff; }

    // Build DL0: draw CI8 base at (40,30), then set combine PRIM+color RED and draw CI4 overlay at (44,34)
    const RED = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    let p=romDL0;
    // Base CI8
    const opSETTIMG=0xFD<<24, sizCI8=1<<19; W32(p,(opSETTIMG|sizCI8)>>>0); p+=4; W32(p,pixCI8>>>0); p+=4;
    const opLOADTLUT=0xF0<<24; W32(p,(opLOADTLUT|256)>>>0); p+=4; W32(p,tlutCI8>>>0); p+=4;
    const opSETTILESIZE=0xF2<<24; W32(p,(opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p+=4; W32(p,packTexCoord(fp(BW-1),fp(BH-1))>>>0); p+=4;
    const opTEXRECT=0xE4<<24; const ulx=fp(40),uly=fp(30),lrx=fp(40+BW),lry=fp(30+BH); W32(p,(opTEXRECT|packTexCoord(ulx,uly))>>>0); p+=4; W32(p,packTexCoord(lrx,lry)>>>0); p+=4;
    // Overlay CI4 under PRIM combine
    const opSETCOMB=0xFC<<24; W32(p,opSETCOMB>>>0); p+=4; W32(p,1); p+=4; // PRIM
    const opSETPRIM=0xFA<<24; W32(p,opSETPRIM>>>0); p+=4; W32(p,RED>>>0); p+=4;
    const opSETTIMG_CI4=(0xFD<<24)|0; W32(p,opSETTIMG_CI4>>>0); p+=4; W32(p,pixCI4>>>0); p+=4;
    const opLOADTLUT_CI4=0xF0<<24; W32(p,(opLOADTLUT_CI4|32)>>>0); p+=4; W32(p,tlutCI4>>>0); p+=4;
    const ulx2=fp(44),uly2=fp(34),lrx2=fp(44+OW),lry2=fp(34+OH);
    W32(p,(opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p+=4; W32(p,packTexCoord(fp(OW-1),fp(OH-1))>>>0); p+=4;
    W32(p,(opTEXRECT|packTexCoord(ulx2,uly2))>>>0); p+=4; W32(p,packTexCoord(lrx2,lry2)>>>0); p+=4;
    W32(p,0xDF000000>>>0); p+=4; W32(p,0);
    const len0=(p-romDL0)>>>0;

    busA.setROM(rom);
    hlePiLoadSegments(busA,[
      { cartAddr: romCI8TLUT, dramAddr: tlutCI8, length: 256*2 },
      { cartAddr: romCI8PIX, dramAddr: pixCI8, length: BW*BH },
      { cartAddr: romCI4TLUT, dramAddr: tlutCI4, length: 32*2 },
      { cartAddr: romCI4PIX, dramAddr: pixCI4, length: packedLen },
      { cartAddr: romDL0, dramAddr: (baseA+0x6000)>>>0, length: len0 },
    ], true);
    busA.storeU32(tableA+0,(baseA+0x6000)>>>0);

    const strideWords=128;
    const BLUE_BG=((0<<11)|(0<<6)|(31<<1)|1)>>>0; const CYAN_BG=((0<<11)|(31<<6)|(31<<1)|1)>>>0;
    const resDex=scheduleF3DEXFromTableAndRun(cpuA,busA,sysA,origin,width,height,tableA,1,(stagingA)>>>0,strideWords,start,interval,total,spOffset,BLUE_BG,CYAN_BG);

    // Typed baseline
    const rdramB = new RDRAM(1 << 19);
    const busB = new Bus(rdramB);
    const cpuB = new CPU(busB);
    const sysB = new System(cpuB, busB);

    const baseB=(origin+fbBytes+0xD000)>>>0;
    const tlutB=baseB;
    const pixB=(baseB+0x1000)>>>0;
    const dlB=(baseB+0x2000)>>>0;

    // Initialize TLUT and pixels in typed context (mirror translator assets)
    for (let i=0;i<256;i++){ const v=(i===1?BLUE:0)>>>0; busB.storeU16(tlutB+i*2, v); }
    for (let i=0;i<BW*BH;i++) busB.storeU8(pixB+i, 1);

    // Build typed UC: gradient background, draw CI8 base with TEXEL0, set PRIM RED and draw CI4 overlay as solid fill
    const typedUC = f3dToUc([
      { op: 'G_GRADIENT' as const, bgStart: BLUE_BG, bgEnd: CYAN_BG },
      { op: 'G_SETTLUT' as const, addr: tlutB>>>0, count: 256 },
      { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixB>>>0, w: BW, h: BH },
      { op: 'G_SPRITE' as const, x: 40, y: 30, w: BW, h: BH },
      { op: 'G_SETPRIMCOLOR5551' as const, color: RED },
      { op: 'G_SETCOMBINE_MODE' as const, mode: 'PRIM' as const },
      // We emulate the overlay as a solid draw rectangle of OWxOH at 44,34 under PRIM
      { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixB>>>0, w: OW, h: OH },
      { op: 'G_SPRITE' as const, x: 44, y: 34, w: OW, h: OH },
      { op: 'G_END' as const },
    ] as any);

    writeUcAsRspdl(busB, dlB, typedUC, strideWords);
    const resTyped = scheduleRSPDLFramesAndRun(cpuB,busB,sysB,origin,width,height,dlB,1,start,interval,total,spOffset,strideWords);

    const d0=crc32(resDex.frames[0] ?? resDex.image);
    const t0=crc32(resTyped.frames[0] ?? resTyped.image);
    expect(d0).toBe(t0);
  });
});

