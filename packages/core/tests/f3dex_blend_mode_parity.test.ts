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

// Build a small F3DEX DL in RDRAM that draws two CI8 rectangles with blending enabled
function buildDexDL(bus: Bus, base: number, tlutAddr: number, pixAddr: number, x1: number, y1: number, x2: number, y2: number, w: number, h: number): number {
  let p = base >>> 0;
  // SETTIMG CI8
  const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19; bus.storeU32(p, (opSETTIMG|sizCI8)>>>0); p+=4; bus.storeU32(p, pixAddr>>>0); p+=4;
  // LOADTLUT count
  const opLOADTLUT = 0xF0 << 24; bus.storeU32(p, (opLOADTLUT | 256)>>>0); p+=4; bus.storeU32(p, tlutAddr>>>0); p+=4;
  // SETTILESIZE
  const opSETTILESIZE = 0xF2 << 24; bus.storeU32(p, (opSETTILESIZE | packTexCoord(fp(0), fp(0)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(w-1), fp(h-1))>>>0); p+=4;
  // SET_BLEND_MODE = 1 (AVERAGE_50)
  const opSETBLEND = 0xEB << 24; bus.storeU32(p, opSETBLEND>>>0); p+=4; bus.storeU32(p, 1); p+=4;
  // TEXRECT #1
  const opTEXRECT = 0xE4 << 24; bus.storeU32(p, (opTEXRECT | packTexCoord(fp(x1), fp(y1)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(x1+w), fp(y1+h))>>>0); p+=4;
  // TEXRECT #2 overlaps
  bus.storeU32(p, (opTEXRECT | packTexCoord(fp(x2), fp(y2)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(x2+w), fp(y2+h))>>>0); p+=4;
  // END
  bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
  return (p - base) >>> 0;
}

describe('f3dex_blend_mode_parity', () => {
  it('translates SET_BLEND_MODE (0xEB) and matches typed RSPDL with SetBlendMode AVERAGE_50', () => {
    const width=96, height=72, origin=0xC000;
    const start=2, interval=3, frames=1, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Assets: CI8 TLUT with blue at index 1, red at index 2; pixel field filled with 1
    const base = (origin + width*height*2 + 0x8000)>>>0;
    const tlutAddr = base>>>0; const pixAddr=(base+0x1000)>>>0; const tableBase=(base+0x3000)>>>0; const staging=(base+0x4000)>>>0;
    const BLUE=((0<<11)|(0<<6)|(31<<1)|1)>>>0; const RED=((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    bus.storeU16(tlutAddr+0, 0);
    bus.storeU16(tlutAddr+2, BLUE); // idx1
    bus.storeU16(tlutAddr+4, RED);  // idx2
    const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(pixAddr+i, 1);

    // DL: draw blue rect at (20,20), then draw red rect overlapping starting at (24,22) with blending AVERAGE_50
    const dl0=(base+0x2000)>>>0; buildDexDL(bus, dl0, tlutAddr, pixAddr, 20, 20, 24, 22, W, H);
    bus.storeU32(tableBase+0, dl0>>>0);

    const dex = scheduleF3DEXFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, staging, 128, start, interval, total, spOffset);

    // Typed RSPDL path: Set TLUT, Combine TEXEL0, SetBlendMode(AVERAGE_50), draw two CI8 sprites at same positions
    const rdram2 = new RDRAM(1<<19); const bus2=new Bus(rdram2); const cpu2=new CPU(bus2); const sys2=new System(cpu2, bus2);
    const typedBase=(base+0x6000)>>>0; const stride=128;
    // Copy assets into second context
    for (let i=0;i<256;i++) bus2.storeU16(tlutAddr + i*2, bus.loadU16(tlutAddr + i*2));
    for (let i=0;i<W*H;i++) bus2.storeU8(pixAddr + i, bus.loadU8(pixAddr + i));
    const uc: UcCmd[] = [
      { op:'SetTLUT', tlutAddr, count:256 },
      { op:'SetCombine', mode:'TEXEL0' },
      { op:'SetBlendMode', mode:'AVERAGE_50' },
      { op:'DrawCI8', w:W, h:H, addr:pixAddr, x:20, y:20 },
      { op:'DrawCI8', w:W, h:H, addr:pixAddr, x:24, y:22 },
      { op:'End' },
    ];
    writeUcAsRspdl(bus2, typedBase, uc, stride);
    const typed = scheduleRSPDLFramesAndRun(cpu2, bus2, sys2, origin, width, height, typedBase, frames, start, interval, total, spOffset, stride);

    expect(dex.frames.map(crc32)).toEqual(typed.frames.map(crc32));
  });
});

