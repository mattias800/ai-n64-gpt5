import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { translateF3DEXToUc } from '../src/boot/f3dex_translator.ts';
import { ucToRspdlWords, writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Parity test: mock F3DEX RGBA16 textured tris with Z should match typed Uc path

function pack5551(r5:number,g5:number,b5:number,a1:number){ return (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0; }

describe('f3dex_zbuffer_rgba16_textured_tri_parity', () => {
  it('translator TRI2D_TEX_Z matches typed DrawRGBA16TriZ for occlusion', () => {
    const width=96, height=72, origin=0x7000;
    const start=2, interval=3, frames=2, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x6000) >>> 0;

    const zAddr = base >>> 0;
    const texAddr = (base + 0x2000) >>> 0;
    const dlBytecode = (base + 0x3000) >>> 0;
    const stagingA = (base + 0x3800) >>> 0; // translated UC -> RSPDL
    const stagingB = (base + 0x4000) >>> 0; // typed UC -> RSPDL
    const table = (base + 0x5000) >>> 0;

    // Build small 4x4 RGBA16: left red, right green
    const W=4,H=4;
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const c = x<2 ? pack5551(31,0,0,1) : pack5551(0,31,0,1);
        const o=(y*W+x)*2; bus.storeU8(texAddr+o,(c>>>8)&0xff); bus.storeU8(texAddr+o+1,c&0xff);
      }
    }

    // Build translator bytecode for frame 0 using mock Z ops
    let p = dlBytecode >>> 0;
    const opSETTIMG=0xFD<<24, sizRGBA16=2<<19; bus.storeU32(p,(opSETTIMG|sizRGBA16)>>>0); p+=4; bus.storeU32(p, texAddr>>>0); p+=4;
    const opSETTILESIZE=0xF2<<24; function fp(x:number){ return (x<<2)>>>0; } function pack12(hi:number,lo:number){ return (((hi&0xFFF)<<12)|(lo&0xFFF))>>>0; }
    bus.storeU32(p,(opSETTILESIZE|pack12(fp(0),fp(0)))>>>0); p+=4; bus.storeU32(p, pack12(fp(W-1), fp(H-1))>>>0); p+=4;
    // Set Z state: enable, set buffer, clear to far
    const opSET_Z_ENABLE=0xEC<<24; bus.storeU32(p, opSET_Z_ENABLE>>>0); p+=4; bus.storeU32(p, 1>>>0); p+=4;
    const opSET_Z_BUFFER=0xED<<24; bus.storeU32(p, (opSET_Z_BUFFER | ((width&0xFFFF)<<16) | (height&0xFFFF))>>>0); p+=4; bus.storeU32(p, zAddr>>>0); p+=4;
    const opCLEAR_Z=0xEE<<24; bus.storeU32(p, opCLEAR_Z>>>0); p+=4; bus.storeU32(p, 0x0000FFFF>>>0); p+=4;
    // Provide VTX2D_TEX_Z (0xB8)
    const vtxAddr = (base + 0x8000) >>> 0;
    type V={x:number;y:number;s:number;t:number;z:number};
    const farZ=45000>>>0, nearZ=12000>>>0;
    const A:V={x:15,y:16,s:3,t:0,z:farZ}; const B:V={x:70,y:18,s:3,t:1,z:farZ}; const C:V={x:25,y:60,s:3,t:3,z:farZ};
    const D:V={x:20,y:20,s:0,t:0,z:nearZ}; const E:V={x:65,y:22,s:0,t:1,z:nearZ}; const F:V={x:30,y:58,s:0,t:3,z:nearZ};
    // Store 6 vertices sequentially (x,y)(s,t)(z)
    function putV(o:number,v:V){ bus.storeU32(o+0, ((v.x<<16)|(v.y&0xFFFF))>>>0); bus.storeU32(o+4, ((v.s<<16)|(v.t&0xFFFF))>>>0); bus.storeU32(o+8, v.z>>>0); }
    putV(vtxAddr+0*12,A); putV(vtxAddr+1*12,B); putV(vtxAddr+2*12,C); putV(vtxAddr+3*12,D); putV(vtxAddr+4*12,E); putV(vtxAddr+5*12,F);
    const opVTX2D_TEX_Z=0xB8<<24; const countM1=5; bus.storeU32(p,(opVTX2D_TEX_Z|countM1)>>>0); p+=4; bus.storeU32(p, vtxAddr>>>0); p+=4;
    // Draw far tri (A,B,C) then near tri (D,E,F)
    const opTRI2D_TEX_Z=0xB9<<24; const idxABC=(0)|(1<<4)|(2<<8); const idxDEF=(3)|(4<<4)|(5<<8);
    bus.storeU32(p,(opTRI2D_TEX_Z|idxABC)>>>0); p+=4; bus.storeU32(p,0); p+=4;
    bus.storeU32(p,(opTRI2D_TEX_Z|idxDEF)>>>0); p+=4; bus.storeU32(p,0); p+=4;
    // END
    bus.storeU32(p,0xDF000000>>>0); p+=4; bus.storeU32(p,0); p+=4;

    // Translate frame 0 bytecode to UC then to RSPDL words and stage
    const translated: UcCmd[] = translateF3DEXToUc(bus, dlBytecode, 128);
    const wordsA = ucToRspdlWords(translated, 128);
    for (let i=0; i<wordsA.length; i++) bus.storeU32(stagingA + i*4, wordsA[i]!);

    // Typed baseline UC for frame 1
    const uc: UcCmd[] = [
      { op: 'SetZEnable', enable: true },
      { op: 'SetZBuffer', addr: zAddr, width, height },
      { op: 'ClearZ', value: 0xFFFF },
      { op: 'DrawRGBA16TriZ', addr: texAddr, texW: W, texH: H,
        x1: A.x, y1: A.y, s1: A.s, t1: A.t, z1: A.z,
        x2: B.x, y2: B.y, s2: B.s, t2: B.t, z2: B.z,
        x3: C.x, y3: C.y, s3: C.s, t3: C.t, z3: C.z },
      { op: 'DrawRGBA16TriZ', addr: texAddr, texW: W, texH: H,
        x1: D.x, y1: D.y, s1: D.s, t1: D.t, z1: D.z,
        x2: E.x, y2: E.y, s2: E.s, t2: E.t, z2: E.z,
        x3: F.x, y3: F.y, s3: F.s, t3: F.t, z3: F.z },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, stagingB, uc, 128);

    // Build tables: frame0 translated, frame1 typed
    bus.storeU32(table+0, stagingA>>>0);
    bus.storeU32(table+4, stagingB>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);
    const h0 = crc32(res.frames[0]!);
    const h1 = crc32(res.frames[1]!);
    expect(h0).toBe(h1);

    expect(translated.find(c => c.op === 'SetZEnable')).toBeTruthy();
    expect(translated.find(c => c.op === 'SetZBuffer')).toBeTruthy();
    expect(translated.find(c => c.op === 'ClearZ')).toBeTruthy();
    expect(translated.find(c => c.op === 'DrawRGBA16TriZ')).toBeTruthy();
  });
});

