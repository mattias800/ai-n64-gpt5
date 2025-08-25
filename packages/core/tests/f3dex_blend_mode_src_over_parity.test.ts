import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleF3DEXFromTableAndRun, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

function buildDexDL_SRCOVER(bus: Bus, base: number, tlutAddr: number, pixAddr: number, x1: number, y1: number, x2: number, y2: number, w: number, h: number): number {
  let p = base >>> 0;
  // SETTIMG CI8
  const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19; bus.storeU32(p, (opSETTIMG|sizCI8)>>>0); p+=4; bus.storeU32(p, pixAddr>>>0); p+=4;
  // LOADTLUT count
  const opLOADTLUT = 0xF0 << 24; bus.storeU32(p, (opLOADTLUT | 256)>>>0); p+=4; bus.storeU32(p, tlutAddr>>>0); p+=4;
  // SETTILESIZE
  const opSETTILESIZE = 0xF2 << 24; bus.storeU32(p, (opSETTILESIZE | packTexCoord(fp(0), fp(0)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(w-1), fp(h-1))>>>0); p+=4;
  // SET_BLEND_MODE = 2 (SRC_OVER_A1)
  const opSETBLEND = 0xEB << 24; bus.storeU32(p, opSETBLEND>>>0); p+=4; bus.storeU32(p, 2); p+=4;
  // TEXRECT #1 (opaque red)
  const opTEXRECT = 0xE4 << 24; bus.storeU32(p, (opTEXRECT | packTexCoord(fp(x1), fp(y1)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(x1+w), fp(y1+h))>>>0); p+=4;
  // TEXRECT #2 (transparent green) overlaps: same texture but indices map to a1=0 (we'll encode in TLUT)
  bus.storeU32(p, (opTEXRECT | packTexCoord(fp(x2), fp(y2)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(x2+w), fp(y2+h))>>>0); p+=4;
  // END
  bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
  return (p - base) >>> 0;
}

describe('f3dex_blend_mode_src_over_parity', () => {
  it('translates SET_BLEND_MODE (SRC_OVER_A1) and matches typed RSPDL', () => {
    const width=96, height=72, origin=0xC000;
    const start=2, interval=3, frames=1, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const base = (origin + width*height*2 + 0xA000)>>>0;
    const tlutAddr = base>>>0; const pixAddr=(base+0x1000)>>>0; const tableBase=(base+0x3000)>>>0; const staging=(base+0x4000)>>>0;

    const RED=((31<<11)|(0<<6)|(0<<1)|1)>>>0; const GREEN_A0=((0<<11)|(31<<6)|(0<<1)|0)>>>0;
    // TLUT: 1=red opaque, 2=green transparent (a1=0)
    bus.storeU16(tlutAddr+0, 0);
    bus.storeU16(tlutAddr+2, RED);
    bus.storeU16(tlutAddr+4, GREEN_A0);

    // Build a small pixel field mixing indices 1 and 2
    const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(pixAddr+i, (i%2===0)?1:2);

    const stride=128;
    // F3DEX path with SRC_OVER_A1 blending
    const dl0=(base+0x2000)>>>0; buildDexDL_SRCOVER(bus, dl0, tlutAddr, pixAddr, 20, 20, 24, 22, W, H);
    bus.storeU32(tableBase+0, dl0>>>0);
    const dex = scheduleF3DEXFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, staging, 128, start, interval, total, spOffset);

    // Typed RSPDL path matching operations
    const rdram2 = new RDRAM(1<<19); const bus2=new Bus(rdram2); const cpu2=new CPU(bus2); const sys2=new System(cpu2, bus2);
    const typedBase=(base+0x7000)>>>0;
    const uc: UcCmd[] = [
      { op:'SetTLUT', tlutAddr, count:256 },
      { op:'SetCombine', mode:'TEXEL0' },
      { op:'SetBlendMode', mode:'SRC_OVER_A1' },
      { op:'DrawCI8', w:W, h:H, addr:pixAddr, x:20, y:20 },
      { op:'DrawCI8', w:W, h:H, addr:pixAddr, x:24, y:22 },
      { op:'End' },
    ];
    // Copy same TLUT/pixels into second context
    for (let i=0;i<256;i++) bus2.storeU16(tlutAddr + i*2, bus.loadU16(tlutAddr + i*2));
    for (let i=0;i<W*H;i++) bus2.storeU8(pixAddr + i, bus.loadU8(pixAddr + i));

    writeUcAsRspdl(bus2, typedBase, uc, stride);
    const typed = scheduleRSPDLFramesAndRun(cpu2, bus2, sys2, origin, width, height, typedBase, frames, start, interval, total, spOffset, stride);

    expect(dex.frames.map(crc32)).toEqual(typed.frames.map(crc32));
  });
});

