import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32, decode5551To8888 } from './helpers/test_utils.ts';

function makeColor(r5:number,g5:number,b5:number,a1:number): number { return (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0; }

describe('rspdl_zbuffer_prim_tri', () => {
  it('near triangle occludes far where overlapping; clear affects outcome', () => {
    const width=64, height=48, origin=0xA000;
    const start=2, interval=3, frames=2, spOffset=1; // two frames: before/after clearZ
    const total = start + interval*frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x4000) >>> 0;
    const zAddr = base >>> 0;
    const dl0 = (base + 0x4000) >>> 0;
    const dl1 = (base + 0x5000) >>> 0;

    const RED = makeColor(31,0,0,1);
    const GREEN = makeColor(0,31,0,1);

    // Frame 0: enable Z, set zbuf, clear to far (0xFFFF), draw FAR green tri first then NEAR red tri overlapping
    const uc0: UcCmd[] = [
      { op: 'SetZEnable', enable: true },
      { op: 'SetZBuffer', addr: zAddr, width, height },
      { op: 'ClearZ', value: 0xFFFF },
      { op: 'SetPrimColor', color: GREEN },
      { op: 'SetCombine', mode: 'PRIM' },
      // Far triangle (bigger z)
      { op: 'DrawPrimTriZ', x1: 10, y1: 10, z1: 50000, x2: 50, y2: 12, z2: 50000, x3: 20, y3: 40, z3: 50000 },
      { op: 'SetPrimColor', color: RED },
      // Near triangle overlapping
      { op: 'DrawPrimTriZ', x1: 15, y1: 15, z1: 10000, x2: 45, y2: 18, z2: 10000, x3: 25, y3: 38, z3: 10000 },
      { op: 'End' },
    ];

    // Frame 1: clear to near (0x0000) before drawing same order -> near clear should cause both triangles to fail z (< test), image remains from frame 0
    const uc1: UcCmd[] = [
      { op: 'SetZEnable', enable: true },
      { op: 'SetZBuffer', addr: zAddr, width, height },
      { op: 'ClearZ', value: 0x0000 },
      { op: 'SetPrimColor', color: GREEN },
      { op: 'SetCombine', mode: 'PRIM' },
      { op: 'DrawPrimTriZ', x1: 10, y1: 10, z1: 50000, x2: 50, y2: 12, z2: 50000, x3: 20, y3: 40, z3: 50000 },
      { op: 'SetPrimColor', color: RED },
      { op: 'DrawPrimTriZ', x1: 15, y1: 15, z1: 10000, x2: 45, y2: 18, z2: 10000, x3: 25, y3: 38, z3: 10000 },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl0, uc0, 128);
    writeUcAsRspdl(bus, dl1, uc1, 128);

    // Run frame 0
    const res0 = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl0, 1, start, interval, total, spOffset, 128);
    const frame0 = res0.frames[0] ?? res0.image;

    // Sample a pixel in the overlap area - expect RED (near tri)
    function sampleRGBA8888(img: Uint8Array, x: number, y: number): [number,number,number,number] {
      const i=(y*width+x)*4; return [img[i]??0,img[i+1]??0,img[i+2]??0,img[i+3]??0] as any;
    }
    // Choose an overlap point roughly inside both triangles
    const px=22, py=22;
    const [r0,g0,b0,a0] = sampleRGBA8888(frame0, px, py);
    const [rR,gR,bR,aR] = decode5551To8888(RED);
    expect([r0,g0,b0,a0]).toEqual([rR,gR,bR,aR]);

    // Run frame 1 (after clear to near) -> both triangles should fail z (< test), so framebuffer should remain unchanged from previous frame
    const res1 = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl1, 1, start, interval, total, spOffset, 128);
    const frame1 = res1.frames[0] ?? res1.image;

    // CRCs should be identical since no pixels passed Z in frame 1
    expect(crc32(frame1)).toBe(crc32(frame0));
  });
});

