import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { translateF3DEXToUc } from '../src/boot/f3dex_translator.ts';
import { ucToRspdlWords, writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Parity test: mock F3DEX RGBA16 textured tri should match typed Uc DrawRGBA16Tri

describe('f3dex_textured_rgba16_tri_parity', () => {
  it('translator TRI2D_TEX (RGBA16) matches typed DrawRGBA16Tri', () => {
    const width = 128, height = 96, origin = 0x5000;
    const start = 2, interval = 3, frames = 2, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x6000) >>> 0;

    const texAddr = base >>> 0;
    const dlBytecode = (base + 0x2000) >>> 0;
    const stagingA = (base + 0x3000) >>> 0; // translated UC->RSPDL
    const stagingB = (base + 0x4000) >>> 0; // typed UC->RSPDL
    const tableBase = (base + 0x5000) >>> 0;

    // Build RGBA16 texture 8x8 with simple gradient, all opaque
    const W=8,H=8;
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const r5 = Math.round(x*31/(W-1)) & 0x1f;
        const g5 = Math.round(y*31/(H-1)) & 0x1f;
        const b5 = ((x+y)&1)? 31 : 0;
        const a1 = 1;
        const p = (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0;
        const off=(y*W+x)*2; bus.storeU8(texAddr+off,(p>>>8)&0xff); bus.storeU8(texAddr+off+1,p&0xff);
      }
    }

    // Build mock F3DEX bytecode: SETTIMG(RGBA16), SETTILESIZE, VTX2D_TEX, TRI2D_TEX, END
    let p = dlBytecode >>> 0;
    const opSETTIMG = 0xFD << 24; const sizRGBA16 = 2 << 19;
    bus.storeU32(p, (opSETTIMG | sizRGBA16) >>> 0); p=(p+4)>>>0; bus.storeU32(p, texAddr>>>0); p=(p+4)>>>0;
    const opSETTILESIZE = 0xF2 << 24;
    function fp(x:number){ return (x<<2)>>>0; }
    function pack12(hi:number,lo:number){ return (((hi&0xFFF)<<12)|(lo&0xFFF))>>>0; }
    bus.storeU32(p, (opSETTILESIZE | pack12(fp(0), fp(0)))>>>0); p=(p+4)>>>0; bus.storeU32(p, pack12(fp(W-1), fp(H-1))>>>0); p=(p+4)>>>0;

    // VTX2D_TEX for 3 vertices
    const vtxAddr = (base + 0x7000) >>> 0;
    const verts = [ {x:30,y:20,s:0,t:0}, {x:90,y:22,s:W-1,t:0}, {x:35,y:70,s:0,t:H-1} ];
    for (let i=0;i<3;i++){
      const o=vtxAddr+i*8; bus.storeU32(o+0, ((verts[i]!.x<<16)|(verts[i]!.y&0xFFFF))>>>0); bus.storeU32(o+4, ((verts[i]!.s<<16)|(verts[i]!.t&0xFFFF))>>>0);
    }
    const opVTX2D_TEX = 0xB6 << 24; const countM1 = 2; bus.storeU32(p,(opVTX2D_TEX|countM1)>>>0); p=(p+4)>>>0; bus.storeU32(p, vtxAddr>>>0); p=(p+4)>>>0;
    const opTRI2D_TEX = 0xB7 << 24; const idxs=(0)|(1<<4)|(2<<8); bus.storeU32(p,(opTRI2D_TEX|idxs)>>>0); p=(p+4)>>>0; bus.storeU32(p, 0)>>>0; p=(p+4)>>>0;

    bus.storeU32(p, 0xDF000000>>>0); p=(p+4)>>>0; bus.storeU32(p, 0)>>>0;

    // Translate to UC and write RSPDL words for frame 0
    const translated: UcCmd[] = translateF3DEXToUc(bus, dlBytecode, 128);
    const wordsA = ucToRspdlWords(translated, 128);
    for (let i=0;i<wordsA.length;i++) bus.storeU32(stagingA + i*4, wordsA[i]!);

    // Typed baseline
    const baseline: UcCmd[] = [
      { op: 'DrawRGBA16Tri', addr: texAddr, texW: W, texH: H,
        x1: verts[0]!.x, y1: verts[0]!.y, s1: verts[0]!.s, t1: verts[0]!.t,
        x2: verts[1]!.x, y2: verts[1]!.y, s2: verts[1]!.s, t2: verts[1]!.t,
        x3: verts[2]!.x, y3: verts[2]!.y, s3: verts[2]!.s, t3: verts[2]!.t },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, stagingB, baseline, 128);

    bus.storeU32(tableBase+0, stagingA>>>0);
    bus.storeU32(tableBase+4, stagingB>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);
    expect(h0).toBe(h1);
    expect(translated.find(c => c.op === 'DrawRGBA16Tri')).toBeTruthy();
  });
});

