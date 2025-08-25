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
function buildSETTILE(cms: number, cmt: number): [number, number] { const op = 0xF5 << 24; return [op>>>0, ((((cmt & 3) << 18) | ((cms & 3) << 8))>>>0)]; }

// Parity tests for CI4 addressing modes (NEAREST) with TLUT and palette.
describe('f3dex_texaddr_modes_ci4_parity', () => {
  it('wrap/mirror/clamp addressing parity (nearest) CI4', () => {
    const width=128, height=96, origin=0xA000;
    const start=2, interval=3, frames=3, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1<<19); const bus = new Bus(rdram); const cpu = new CPU(bus); const sys = new System(cpu, bus);
    const fbBytes=width*height*2; const base=(origin+fbBytes+0x7000)>>>0;
    const tlutAddr=base>>>0; const texAddr=(base+0x1000)>>>0; const dl0=(base+0x2000)>>>0; const table=(base+0x3000)>>>0; const staging=(base+0x4000)>>>0;

    // TLUT: palette 0 -> idx 0..15 map to blue; texture nibble indices filled with 1
    for (let i=0;i<256;i++) bus.storeU16(tlutAddr + i*2, (i<16? COLORS_5551.blue: 0));
    const W=16,H=16; // CI4 nibble-packed: write bytes with hi/lo nibbles as 1
    for (let i=0;i<Math.ceil(W*H/2);i++) bus.storeU8(texAddr+i, 0x11);

    const modes=[0,1,2];
    for (let f=0; f<frames; f++){
      let p=(dl0+f*0x100)>>>0;
      // SETTIMG CI4
      const OP_SETTIMG=0xFD<<24, SIZ_CI4=0<<19; bus.storeU32(p,(OP_SETTIMG|SIZ_CI4)>>>0); p+=4; bus.storeU32(p,texAddr>>>0); p+=4;
      // LOADTLUT count=32 (at least one palette)
      const OP_LOADTLUT=0xF0<<24; bus.storeU32(p,(OP_LOADTLUT|32)>>>0); p+=4; bus.storeU32(p, tlutAddr>>>0); p+=4;
      // SETTILESIZE 16x16
      const OP_SETTILESIZE=0xF2<<24; bus.storeU32(p,(OP_SETTILESIZE|pack12(fp(0),fp(0)))>>>0); p+=4; bus.storeU32(p, pack12(fp(W-1), fp(H-1))>>>0); p+=4;
      // G_SETTILE cms/cmt
      const [w0,w1]=buildSETTILE(modes[f]!, modes[f]!); bus.storeU32(p,w0>>>0); p+=4; bus.storeU32(p,w1>>>0); p+=4;
      // TEXRECT at (40,20)
      const OP_TEXRECT=0xE4<<24; const x=40,y=20; bus.storeU32(p,(OP_TEXRECT|pack12(fp(x),fp(y)))>>>0); p+=4; bus.storeU32(p, pack12(fp(x+W), fp(y+H))>>>0); p+=4;
      // END
      bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
      bus.storeU32(table+f*4, (dl0+f*0x100)>>>0);
    }

    const dex = scheduleF3DEXFromTableAndRun(cpu,bus,sys,origin,width,height,table,frames,staging,128,start,interval,total,spOffset);

    // Typed UC
    const rdram2=new RDRAM(1<<19); const bus2=new Bus(rdram2); const cpu2=new CPU(bus2); const sys2=new System(cpu2,bus2);
    for (let i=0;i<256;i++) bus2.storeU16(tlutAddr+i*2,bus.loadU16(tlutAddr+i*2));
    for (let i=0;i<Math.ceil(W*H/2);i++) bus2.storeU8(texAddr+i,bus.loadU8(texAddr+i));
    const typedBase=(base+0x8000)>>>0; const stride=128;
    for (let f=0; f<frames; f++){
      const mode=modes[f]!; const sm=mode===0?'WRAP':mode===1?'MIRROR':'CLAMP'; const tm=sm;
      const uc: UcCmd[]=[
        { op:'SetTLUT', tlutAddr, count:32 },
        { op:'SetCombine', mode:'TEXEL0' },
        { op:'SetCI4Palette', palette:0 },
        { op:'SetTexAddrMode', sMode: sm as any, tMode: tm as any },
        { op:'DrawCI4', w:W, h:H, addr:texAddr, x:40, y:20 },
        { op:'End' },
      ];
      writeUcAsRspdl(bus2, (typedBase+f*0x100)>>>0, uc, stride);
    }
    const table2=(typedBase+0x1000)>>>0; for(let f=0; f<frames; f++) bus2.storeU32(table2+f*4, (typedBase+f*0x100)>>>0);
    const typed = scheduleRSPDLFramesAndRun(cpu2,bus2,sys2,origin,width,height,typedBase,frames,start,interval,total,spOffset,stride);

    expect(dex.frames.map(crc32)).toEqual(typed.frames.map(crc32));
  });
});

