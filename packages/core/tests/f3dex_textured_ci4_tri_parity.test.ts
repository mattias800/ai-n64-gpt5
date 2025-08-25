import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { translateF3DEXToUc } from '../src/boot/f3dex_translator.ts';
import { writeUcAsRspdl, ucToRspdlWords } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { COLORS_5551, crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function pack12(hi: number, lo: number) { return (((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0; }

describe('f3dex_textured_ci4_tri_parity', () => {
  it('translator VTX2D_TEX/TRI2D_TEX (CI4) matches typed DrawCI4Tri', () => {
    const width = 160, height = 120, origin = 0x9000;
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
    const stagingA = (base + 0x3000) >>> 0;
    const stagingB = (base + 0x4000) >>> 0;
    const table = (base + 0x5000) >>> 0;

    // TLUT: index 1 red, 2 green, 3 blue
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, 0);
    bus.storeU16(tlutAddr + 1*2, COLORS_5551.red);
    bus.storeU16(tlutAddr + 2*2, COLORS_5551.green);
    bus.storeU16(tlutAddr + 3*2, COLORS_5551.blue);

    // CI4 tex 8x8, pattern of 1,2,3,1...
    const W=8,H=8; const pixels:number[]=[];
    for (let y=0;y<H;y++){ for (let x=0;x<W;x++){ const seq=[1,2,3,1]; pixels.push(seq[(x+y)%seq.length]!); } }
    const packed = new Uint8Array(Math.ceil(W*H/2));
    for (let i=0;i<W*H;i+=2){ const hi=pixels[i]&0xF, lo=pixels[i+1]&0xF; packed[i>>1]=((hi<<4)|lo)&0xFF; }
    for (let i=0;i<packed.length;i++) bus.storeU8(texAddr+i, packed[i]!);

    // Build mock F3DEX bytecode: SETTIMG(CI4), LOADTLUT, SETTILESIZE, VTX2D_TEX, TRI2D_TEX, END
    let p = dlBytecode;
    const opSETTIMG = 0xFD<<24; const sizCI4 = 0<<19; bus.storeU32(p, (opSETTIMG|sizCI4)>>>0); p+=4; bus.storeU32(p, texAddr>>>0); p+=4;
    const opLOADTLUT=0xF0<<24; bus.storeU32(p, (opLOADTLUT|256)>>>0); p+=4; bus.storeU32(p, tlutAddr>>>0); p+=4;
    const opSETTILESIZE=0xF2<<24; bus.storeU32(p, (opSETTILESIZE | pack12(fp(0), fp(0)))>>>0); p+=4; bus.storeU32(p, pack12(fp(W-1), fp(H-1))>>>0); p+=4;

    const vtxAddr = (base + 0xA000) >>> 0;
    const verts = [ {x:40,y:30,s:0,t:0}, {x:80,y:30,s:W-1,t:0}, {x:40,y:70,s:0,t:H-1} ];
    for (let i=0;i<3;i++){ const o=vtxAddr+i*8; bus.storeU32(o+0, ((verts[i]!.x<<16)|(verts[i]!.y&0xFFFF))>>>0); bus.storeU32(o+4, ((verts[i]!.s<<16)|(verts[i]!.t&0xFFFF))>>>0); }
    const opVTX2D_TEX=0xB6<<24; const countM1=2; bus.storeU32(p,(opVTX2D_TEX|countM1)>>>0); p+=4; bus.storeU32(p, vtxAddr>>>0); p+=4;
    const opTRI2D_TEX=0xB7<<24; const idxs=(0)|(1<<4)|(2<<8); bus.storeU32(p,(opTRI2D_TEX|idxs)>>>0); p+=4; bus.storeU32(p,0); p+=4;
    bus.storeU32(p,0xDF000000>>>0); p+=4; bus.storeU32(p,0);

    const translated: UcCmd[] = translateF3DEXToUc(bus, dlBytecode, 128);
    const wordsA = ucToRspdlWords(translated, 128);
    for (let i=0;i<wordsA.length;i++) bus.storeU32(stagingA + i*4, wordsA[i]!);

    const baseline: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetCI4Palette', palette: 0 },
      { op: 'DrawCI4Tri', addr: texAddr, texW: W, texH: H,
        x1: verts[0]!.x, y1: verts[0]!.y, s1: verts[0]!.s, t1: verts[0]!.t,
        x2: verts[1]!.x, y2: verts[1]!.y, s2: verts[1]!.s, t2: verts[1]!.t,
        x3: verts[2]!.x, y3: verts[2]!.y, s3: verts[2]!.s, t3: verts[2]!.t },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, stagingB, baseline, 128);

    bus.storeU32(table+0, stagingA>>>0);
    bus.storeU32(table+4, stagingB>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);
    expect(h0).toBe(h1);
  });
});

