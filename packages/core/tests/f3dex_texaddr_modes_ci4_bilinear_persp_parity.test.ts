import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleF3DEXFromTableAndRun, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { crc32, COLORS_5551 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function pack12(hi: number, lo: number): number { return (((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0; }
function buildSETTILE(cms: number, cmt: number): [number, number] { const op = 0xF5 << 24; const w0=op>>>0; const w1=((((cmt&3)<<18)|((cms&3)<<8))>>>0); return [w0,w1]; }

// CI4 addressing parity with perspective + bilinear sampling: G_SETTILE cms/cmt and SET_TEX_FILTER (0xEA) vs typed UC
// Requires TLUT and palette selection

describe('f3dex_texaddr_modes_ci4_bilinear_persp_parity', () => {
  it('wrap/mirror/clamp parity with bilinear + perspective (CI4)', () => {
    const width=160, height=120, origin=0xC000;
    const start=2, interval=3, frames=3, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1<<19); const bus = new Bus(rdram); const cpu=new CPU(bus); const sys=new System(cpu,bus);
    const fbBytes=width*height*2; const base=(origin+fbBytes+0xB000)>>>0;
    const tlutAddr=base>>>0; const texAddr=(base+0x1000)>>>0; const dl0=(base+0x2000)>>>0; const table=(base+0x3000)>>>0; const staging=(base+0x4000)>>>0;

    // TLUT: palette 0 -> indices 0..15 map to green; fill nibble-packed 1s
    for(let i=0;i<256;i++) bus.storeU16(tlutAddr+i*2, (i<16? COLORS_5551.green: 0));
    const W=16,H=16; for (let i=0;i<Math.ceil(W*H/2);i++) bus.storeU8(texAddr+i, 0x11);

    const modes=[0,1,2];
    for(let f=0; f<frames; f++){
      let p=(dl0+f*0x200)>>>0;
      // SETTIMG CI4
      bus.storeU32(p,(0xFD<<24 | (0<<19))>>>0); p+=4; bus.storeU32(p, texAddr>>>0); p+=4;
      // LOADTLUT (at least first palette)
      bus.storeU32(p,(0xF0<<24 | 32)>>>0); p+=4; bus.storeU32(p, tlutAddr>>>0); p+=4;
      // SETTILESIZE
      bus.storeU32(p,(0xF2<<24 | pack12(fp(0),fp(0)))>>>0); p+=4; bus.storeU32(p, pack12(fp(W-1), fp(H-1))>>>0); p+=4;
      // SET_TEX_FILTER=BILINEAR
      bus.storeU32(p,(0xEA<<24)>>>0); p+=4; bus.storeU32(p,1>>>0); p+=4;
      // G_SETTILE modes
      const [w0,w1]=buildSETTILE(modes[f]!, modes[f]!); bus.storeU32(p,w0>>>0); p+=4; bus.storeU32(p,w1>>>0); p+=4;
      // VTX2D_TEX_QZ tri
      const vtxAddr=(base+0x6000)>>>0; const verts=[
        { x:50, y:40, s:0,  t:0,  q:1, z:0 },
        { x:50, y:56, s:0,  t:15, q:1, z:0 },
        { x:66, y:40, s:15, t:0,  q:1, z:0 },
      ];
      for(let i=0;i<3;i++){
        const o=vtxAddr+i*16; bus.storeU32(o+0,((verts[i]!.x<<16)|(verts[i]!.y&0xFFFF))>>>0); bus.storeU32(o+4,((verts[i]!.s<<16)|(verts[i]!.t&0xFFFF))>>>0); bus.storeU32(o+8,verts[i]!.q>>>0); bus.storeU32(o+12,verts[i]!.z>>>0);
      }
      bus.storeU32(p,((0xBA<<24)|2)>>>0); p+=4; bus.storeU32(p, vtxAddr>>>0); p+=4;
      bus.storeU32(p, (0xBB<<24 | 0 | (1<<4) | (2<<8))>>>0); p+=4; bus.storeU32(p, 0); p+=4;
      bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
      bus.storeU32(table+f*4, (dl0+f*0x200)>>>0);
    }

    const dex=scheduleF3DEXFromTableAndRun(cpu,bus,sys,origin,width,height,table,frames,staging,256,start,interval,total,spOffset);

    // Typed UC parity
    const rdram2=new RDRAM(1<<19); const bus2=new Bus(rdram2); const cpu2=new CPU(bus2); const sys2=new System(cpu2,bus2);
    for(let i=0;i<256;i++) bus2.storeU16(tlutAddr+i*2, bus.loadU16(tlutAddr+i*2));
    for(let i=0;i<Math.ceil(W*H/2);i++) bus2.storeU8(texAddr+i, bus.loadU8(texAddr+i));
    const typedBase=(base+0xA000)>>>0; const stride=256;
    for(let f=0; f<frames; f++){
      const mode=modes[f]!; const sm=mode===0?'WRAP':mode===1?'MIRROR':'CLAMP'; const tm=sm;
      const uc: UcCmd[]=[
        { op:'SetTLUT', tlutAddr, count:32 },
        { op:'SetCombine', mode:'TEXEL0' },
        { op:'SetCI4Palette', palette:0 },
        { op:'SetTexFilter', mode:'BILINEAR' },
        { op:'SetTexAddrMode', sMode: sm as any, tMode: tm as any },
        { op:'DrawCI4TriPersp', addr:texAddr, texW:W, texH:H,
          x1:50,y1:40,s1:0,t1:0,q1:1,
          x2:50,y2:56,s2:0,t2:15,q2:1,
          x3:66,y3:40,s3:15,t3:0,q3:1,
        },
        { op:'End' },
      ];
      writeUcAsRspdl(bus2,(typedBase+f*0x200)>>>0, uc, stride);
    }
    const table2=(typedBase+0x3000)>>>0; for(let f=0; f<frames; f++) bus2.storeU32(table2+f*4, (typedBase+f*0x200)>>>0);
    const typed=scheduleRSPDLFramesAndRun(cpu2,bus2,sys2,origin,width,height,typedBase,frames,start,interval,total,spOffset,stride);

    expect(dex.frames.map(crc32)).toEqual(typed.frames.map(crc32));
  });
});

