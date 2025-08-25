import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleRSPDLFramesAndRun, scheduleF3DEXFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { crc32 } from './helpers/test_utils.ts';

// Build a tiny F3DEX program with segmented addressing and a DL call. The sublist draws a CI8 rect.

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

describe('f3dex_segment_dl_parity', () => {
  it('Segment base + DL call produces same CRCs as typed F3D', async () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    // 1) Build a context for F3DEX segmented program
    const rdram1 = new RDRAM(1 << 19);
    const bus1 = new Bus(rdram1);
    const cpu1 = new CPU(bus1);
    const sys1 = new System(cpu1, bus1);

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x8800) >>> 0;
    const tlut = base >>> 0;
    const pix = (base + 0x1000) >>> 0;
    const sublist = (base + 0x2000) >>> 0;
    const mainlist = (base + 0x3000) >>> 0;
    const tableBase = (base + 0x4000) >>> 0;
    const stagingBase = (base + 0x5000) >>> 0;

    // assets: TLUT[1]=GREEN, PIX=16x16 index=1
    const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
    for (let i=0;i<256;i++) bus1.storeU16(tlut + i*2, i===1?GREEN:0);
    const W=16,H=16; for (let i=0;i<W*H;i++) bus1.storeU8(pix+i, 1);

    // sublist: SETTIMG CI8(pix), LOADTLUT(tlut,256), SETTILESIZE 16x16, TEXRECT at (60,40), END
    let p = sublist >>> 0;
    const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19;
    bus1.storeU32(p, (opSETTIMG|sizCI8)>>>0); p+=4; bus1.storeU32(p, pix>>>0); p+=4;
    const opLOADTLUT = 0xF0 << 24; bus1.storeU32(p, (opLOADTLUT|256)>>>0); p+=4; bus1.storeU32(p, tlut>>>0); p+=4;
    const opSETTILESIZE = 0xF2 << 24; bus1.storeU32(p, (opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p+=4; bus1.storeU32(p, packTexCoord(fp(W-1),fp(H-1))>>>0); p+=4;
    const opTEXRECT = 0xE4 << 24; const ulx=fp(60),uly=fp(40),lrx=fp(60+W),lry=fp(40+H);
    bus1.storeU32(p, (opTEXRECT|packTexCoord(ulx,uly))>>>0); p+=4; bus1.storeU32(p, packTexCoord(lrx,lry)>>>0); p+=4;
    bus1.storeU32(p, 0xDF000000>>>0); p+=4; bus1.storeU32(p, 0); // END

    // mainlist: G_SEGMENT 0x06 -> base, then G_DL push to sublist via segmented pointer 06:offset
    // We'll set segment 6 to base so 0x06xxxxxx resolves to base + xxxxxx
    let m = mainlist >>> 0;
    const opSEGMENT = 0xD7 << 24; const seg6 = (opSEGMENT | (6<<16))>>>0; bus1.storeU32(m, seg6); m+=4; bus1.storeU32(m, base>>>0); m+=4;
    const opDL = 0xDE << 24; const push=1; const segAddr = (0x06<<24) | (sublist - base); bus1.storeU32(m, (opDL|push)>>>0); m+=4; bus1.storeU32(m, segAddr>>>0); m+=4;
    bus1.storeU32(m, 0xDF000000>>>0); m+=4; bus1.storeU32(m, 0);

    // table of per-frame DLs (call the same mainlist twice for simplicity)
    bus1.storeU32(tableBase + 0, mainlist>>>0);
    bus1.storeU32(tableBase + 4, mainlist>>>0);

    const strideWords = 128;
    const resDex = scheduleF3DEXFromTableAndRun(cpu1, bus1, sys1, origin, width, height, tableBase, frames, stagingBase, strideWords, start, interval, total, spOffset);
    const hashesDex = resDex.frames.map(crc32);

    // 2) Translator self-consistency: translate the same mainlist upfront and run via plain RSPDL path
    const rdram2 = new RDRAM(1 << 19);
    const bus2 = new Bus(rdram2);
    const cpu2 = new CPU(bus2);
    const sys2 = new System(cpu2, bus2);

    const base2 = (origin + fbBytes + 0xA800) >>> 0;
    const tlut2 = base2, pix2 = (base2 + 0x1000) >>> 0, dl2Base = (base2 + 0x3000) >>> 0;
    for (let i=0;i<256;i++) bus2.storeU16(tlut2 + i*2, i===1?GREEN:0);
    for (let i=0;i<W*H;i++) bus2.storeU8(pix2+i, 1);

    // Rebuild sublist/mainlist identically in this fresh context
    let p2 = (base2 + 0x2000) >>> 0;
    bus2.storeU32(p2, (opSETTIMG|sizCI8)>>>0); p2+=4; bus2.storeU32(p2, pix2>>>0); p2+=4;
    bus2.storeU32(p2, (opLOADTLUT|256)>>>0); p2+=4; bus2.storeU32(p2, tlut2>>>0); p2+=4;
    bus2.storeU32(p2, (opSETTILESIZE|packTexCoord(fp(0),fp(0)))>>>0); p2+=4; bus2.storeU32(p2, packTexCoord(fp(W-1),fp(H-1))>>>0); p2+=4;
    bus2.storeU32(p2, (opTEXRECT|packTexCoord(ulx,uly))>>>0); p2+=4; bus2.storeU32(p2, packTexCoord(lrx,lry)>>>0); p2+=4;
    bus2.storeU32(p2, 0xDF000000>>>0); p2+=4; bus2.storeU32(p2, 0);

    let m2 = (base2 + 0x3000) >>> 0;
    bus2.storeU32(m2, (opSEGMENT | (6<<16))>>>0); m2+=4; bus2.storeU32(m2, base2>>>0); m2+=4;
    const sub2 = (base2 + 0x2000) >>> 0; const segAddr2 = (0x06<<24) | (sub2 - base2);
    bus2.storeU32(m2, (opDL|push)>>>0); m2+=4; bus2.storeU32(m2, segAddr2>>>0); m2+=4;
    bus2.storeU32(m2, 0xDF000000>>>0); m2+=4; bus2.storeU32(m2, 0);

    // Translate mainlist upfront and write as RSPDL
    const { translateF3DEXToUc } = await import('../src/boot/f3dex_translator.ts');
    const uc = translateF3DEXToUc(bus2 as any, (base2 + 0x3000)>>>0, 256);
    writeUcAsRspdl(bus2, dl2Base, uc, strideWords);

    const res2 = scheduleRSPDLFramesAndRun(cpu2, bus2, sys2, origin, width, height, dl2Base, frames, start, interval, total, spOffset, strideWords);
    const hashes2 = res2.frames.map(crc32);

    expect(hashesDex).toEqual(hashes2);
  });
});
