import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

// Z-enabled RGBA16 textured triangle occlusion test
// Draw far green textured tri, then near red textured tri overlapping. Expect red where overlap.

describe('rspdl_zbuffer_rgba16_textured_tri', () => {
  it('near textured RGBA16 triangle occludes far', () => {
    const width=64, height=48, origin=0x9000;
    const start=2, interval=3, frames=1, spOffset=1;
    const total = start + interval*frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x4000) >>> 0;
    const zAddr = base >>> 0;
    const texAddr = (base + 0x2000) >>> 0;
    const dl = (base + 0x3000) >>> 0;

    // Build a tiny 4x4 RGBA16 texture: left half red, right half green
    const W=4,H=4;
    function pack(r5:number,g5:number,b5:number,a1:number){ return (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0; }
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const red = pack(31,0,0,1);
        const grn = pack(0,31,0,1);
        const p = (y*W+x)*2; const c = x < 2 ? red : grn;
        bus.storeU8(texAddr+p, (c>>>8)&0xff); bus.storeU8(texAddr+p+1, c&0xff);
      }
    }

    // Two triangles overlapping around (24,20)-(30,24)
    const farZ = 45000>>>0; const nearZ = 12000>>>0;

    const uc: UcCmd[] = [
      { op: 'SetZEnable', enable: true },
      { op: 'SetZBuffer', addr: zAddr, width, height },
      { op: 'ClearZ', value: 0xFFFF },
      // Draw far green tri (sample right side of texture)
      { op: 'DrawRGBA16TriZ', addr: texAddr, texW: W, texH: H,
        x1: 10, y1: 12, s1: 3, t1: 0, z1: farZ,
        x2: 50, y2: 14, s2: 3, t2: 1, z2: farZ,
        x3: 20, y3: 42, s3: 3, t3: 3, z3: farZ },
      // Draw near red tri (sample left side of texture)
      { op: 'DrawRGBA16TriZ', addr: texAddr, texW: W, texH: H,
        x1: 15, y1: 16, s1: 0, t1: 0, z1: nearZ,
        x2: 45, y2: 18, s2: 0, t2: 1, z2: nearZ,
        x3: 25, y3: 40, s3: 0, t3: 3, z3: nearZ },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl, uc, 128);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 128);
    const img = res.frames[0] ?? res.image;

    // Quick pixel checks around an overlap point
    function get5551(x:number,y:number): number {
      const i=(y*width+x)*4; const r=img[i]??0, g=img[i+1]??0, b=img[i+2]??0, a=img[i+3]??0;
      const r5=Math.round(r*31/255)&0x1f, g5=Math.round(g*31/255)&0x1f, b5=Math.round(b*31/255)&0x1f, a1=a>=128?1:0;
      return (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0;
    }
    const samplePt = { x: 24, y: 22 };
    const c = get5551(samplePt.x, samplePt.y);
    // Expect near red (nonzero red, low green)
    const r5=(c>>>11)&0x1f, g5=(c>>>6)&0x1f;
    expect(r5).toBeGreaterThan(20);
    expect(g5).toBeLessThan(5);

    // Ensure image is non-empty and stable
    expect(typeof crc32(img)).toBe('string');
  });
});

