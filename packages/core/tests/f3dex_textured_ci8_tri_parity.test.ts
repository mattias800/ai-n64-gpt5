import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { translateF3DEXToUc } from '../src/boot/f3dex_translator.ts';
import { ucToRspdlWords, writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32, COLORS_5551 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function pack12(hi: number, lo: number): number { return (((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0; }

// Build a simple CI8 textured tri via mock F3DEX ops (SETTIMG CI8 + LOADTLUT + SETTILESIZE + VTX2D_TEX + TRI2D_TEX)
// and compare result to a typed UC DrawCI8Tri baseline. CRCs must match.
describe('f3dex_textured_ci8_tri_parity', () => {
  it('translator VTX2D_TEX/TRI2D_TEX matches typed DrawCI8Tri', () => {
    const width = 192, height = 120, origin = 0x4000;
    const start = 2, interval = 3, frames = 2, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x8000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dlBytecode = (base + 0x2000) >>> 0;
    const stagingA = (base + 0x3000) >>> 0; // translated UC to RSPDL
    const stagingB = (base + 0x4000) >>> 0; // typed UC to RSPDL
    const tableBase = (base + 0x5000) >>> 0;

    // TLUT: index 1 = magenta; everything else transparent (alpha=0)
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, i === 1 ? COLORS_5551.magenta : 0x0000);

    // CI8 tex 16x16: fill with index 1
    const texW = 16, texH = 16;
    for (let i = 0; i < texW * texH; i++) bus.storeU8(texAddr + i, 1);

    // Build F3DEX bytecode DL in RDRAM
    let p = dlBytecode >>> 0;
    const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19;
    bus.storeU32(p, (opSETTIMG | sizCI8) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, texAddr >>> 0); p = (p + 4) >>> 0;
    const opLOADTLUT = 0xF0 << 24; bus.storeU32(p, (opLOADTLUT | 256) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, tlutAddr >>> 0); p = (p + 4) >>> 0;
    const opSETTILESIZE = 0xF2 << 24; bus.storeU32(p, (opSETTILESIZE | pack12(fp(0), fp(0))) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, pack12(fp(texW - 1), fp(texH - 1)) >>> 0); p = (p + 4) >>> 0;

    // VTX2D_TEX (0xB6): write 3 vertices (x,y,s,t) with s,t in texel units (integers)
    const vtxAddr = (base + 0x6000) >>> 0;
    // Tri: (x1,y1,s1,t1)=(40,30,0,0), (x2,y2,s2,t2)=(88,30,15,0), (x3,y3,s3,t3)=(40,78,0,15)
    const verts = [
      { x: 40, y: 30, s: 0,  t: 0 },
      { x: 88, y: 30, s: 15, t: 0 },
      { x: 40, y: 78, s: 0,  t: 15 },
    ];
    for (let i = 0; i < 3; i++) {
      const o = vtxAddr + i * 8;
      bus.storeU32(o + 0, ((verts[i]!.x << 16) | (verts[i]!.y & 0xFFFF)) >>> 0);
      bus.storeU32(o + 4, ((verts[i]!.s << 16) | (verts[i]!.t & 0xFFFF)) >>> 0);
    }
    const opVTX2D_TEX = 0xB6 << 24; const countM1 = 2; // 3 vertices
    bus.storeU32(p, (opVTX2D_TEX | countM1) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, vtxAddr >>> 0); p = (p + 4) >>> 0;

    const opTRI2D_TEX = 0xB7 << 24; const idxs = (0) | (1 << 4) | (2 << 8);
    bus.storeU32(p, (opTRI2D_TEX | idxs) >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, 0x00000000); p = (p + 4) >>> 0;

    bus.storeU32(p, 0xDF000000 >>> 0); p = (p + 4) >>> 0; bus.storeU32(p, 0x00000000); p = (p + 4) >>> 0;

    // Translate to UC and write RSPDL words for frame 0
    const translated: UcCmd[] = translateF3DEXToUc(bus, dlBytecode, 128);
    const wordsA = ucToRspdlWords(translated, 128);
    for (let i = 0; i < wordsA.length; i++) bus.storeU32(stagingA + i * 4, wordsA[i]!);

    // Build typed UC baseline and write RSPDL words for frame 1
    const baseline: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'DrawCI8Tri', addr: texAddr, texW, texH,
        x1: verts[0]!.x, y1: verts[0]!.y, s1: verts[0]!.s, t1: verts[0]!.t,
        x2: verts[1]!.x, y2: verts[1]!.y, s2: verts[1]!.s, t2: verts[1]!.t,
        x3: verts[2]!.x, y3: verts[2]!.y, s3: verts[2]!.s, t3: verts[2]!.t,
      },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, stagingB, baseline, 128);

    // Table with two frames: translated then baseline
    bus.storeU32(tableBase + 0, stagingA >>> 0);
    bus.storeU32(tableBase + 4, stagingB >>> 0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);

    expect(h0).toBe(h1);
    // Sanity: translator produced expected op sequence
    expect(translated.find(c => c.op === 'SetTLUT')).toBeTruthy();
    expect(translated.find(c => c.op === 'DrawCI8Tri')).toBeTruthy();
    expect(translated[translated.length - 1]!.op).toBe('End');
  });
});

