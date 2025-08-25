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

// Draw a quad as two PRIM triangles: translator (mocked VTX/TRI) vs typed DrawPrimTri pairs

describe('f3dex_two_tri_quad_prim_parity', () => {
  it('two-triangle quad PRIM parity between translator VTX/TRI and typed UC', () => {
    const width=128, height=96, origin=0xF000;
    const start=2, interval=3, frames=1, spOffset=1;
    const total = start + interval*frames + 2;

    // Translator context
    const rdramA = new RDRAM(1 << 19);
    const busA = new Bus(rdramA);
    const cpuA = new CPU(busA);
    const sysA = new System(cpuA, busA);

    const baseA = (origin + width*height*2 + 0xA000) >>> 0;
    const tableA = baseA >>> 0;
    const vtxRAM = (baseA + 0x1000) >>> 0;
    const dlROM = 0x20000 >>> 0;
    const rom = new Uint8Array(0x30000);

    // Quad corners: (40,30),(80,30),(80,60),(40,60) -> triangles (0,1,2) and (0,2,3)
    function storeU32BE(addr:number, val:number){ busA.storeU32(addr, val>>>0); }
    storeU32BE(vtxRAM + 0*4, ((40<<16)|30)>>>0);
    storeU32BE(vtxRAM + 1*4, ((80<<16)|30)>>>0);
    storeU32BE(vtxRAM + 2*4, ((80<<16)|60)>>>0);
    storeU32BE(vtxRAM + 3*4, ((40<<16)|60)>>>0);

    function W32(arr:Uint8Array, at:number, val:number){ arr[at]=val>>>24; arr[at+1]=(val>>>16)&0xff; arr[at+2]=(val>>>8)&0xff; arr[at+3]=val&0xff; }
    let p = dlROM;
    const opSETCOMB = 0xFC<<24; W32(rom, p, opSETCOMB>>>0); p+=4; W32(rom, p, 1); p+=4; // PRIM
    const RED = ((31<<11)|(0<<6)|(0<<1)|1)>>>0; const opSETPRIM = 0xFA<<24; W32(rom, p, opSETPRIM>>>0); p+=4; W32(rom, p, RED>>>0); p+=4;
    const opVTX = 0xB4<<24; const countminus1 = 3; W32(rom, p, (opVTX | countminus1)>>>0); p+=4; W32(rom, p, vtxRAM>>>0); p+=4;
    const opTRI = 0xB5<<24; const tri0 = (0)|(1<<4)|(2<<8); const tri1 = (0)|(2<<4)|(3<<8);
    W32(rom, p, (opTRI|tri0)>>>0); p+=4; W32(rom, p, 0); p+=4;
    W32(rom, p, (opTRI|tri1)>>>0); p+=4; W32(rom, p, 0); p+=4;
    W32(rom, p, 0xDF000000>>>0); p+=4; W32(rom, p, 0); const len = (p - dlROM)>>>0;

    const dlRDRAM = (baseA + 0x4000) >>> 0;
    busA.setROM(rom);
    hlePiLoadSegments(busA, [ { cartAddr: dlROM, dramAddr: dlRDRAM, length: len } ], true);
    busA.storeU32(tableA+0, dlRDRAM>>>0);

    const resDex = scheduleF3DEXFromTableAndRun(cpuA, busA, sysA, origin, width, height, tableA, 1, (baseA+0x8000)>>>0, 128, start, interval, total, spOffset);

    // Typed baseline
    const rdramB = new RDRAM(1 << 19);
    const busB = new Bus(rdramB);
    const cpuB = new CPU(busB);
    const sysB = new System(cpuB, busB);

    const baseB = (origin + width*height*2 + 0xC000) >>> 0;
    const dlB = baseB >>> 0;

    const uc = f3dToUc([
      { op: 'G_SETPRIMCOLOR5551' as const, color: RED },
      { op: 'G_SETCOMBINE_MODE' as const, mode: 'PRIM' as const },
      { op: 'G_TRI_PRIM' as const, x1: 40, y1: 30, x2: 80, y2: 30, x3: 80, y3: 60 },
      { op: 'G_TRI_PRIM' as const, x1: 40, y1: 30, x2: 80, y2: 60, x3: 40, y3: 60 },
      { op: 'G_END' as const },
    ]);
    writeUcAsRspdl(busB, dlB, uc, 128);
    const resTyped = scheduleRSPDLFramesAndRun(cpuB, busB, sysB, origin, width, height, dlB, 1, start, interval, total, spOffset, 128);

    const d0 = crc32(resDex.frames[0] ?? resDex.image);
    const t0 = crc32(resTyped.frames[0] ?? resTyped.image);
    expect(d0).toBe(t0);
  });
});

