import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';

function pack(r5:number,g5:number,b5:number,a1:number){ return (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0; }

// Verify simple blending: draw opaque blue background, then enable blend and draw opaque red tri
// Overlap region should be purple-ish (averaged), non-overlap stays blue.
describe('rspdl_simple_blend_rgba16_tri', () => {
  it('averages 5-bit channels when blending enabled', () => {
    const width=64, height=48, origin=0xA000;
    const start=2, interval=3, frames=1, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x4000) >>> 0;
    const dl = base >>> 0;

    const blue = pack(0,0,31,1);
    const red = pack(31,0,0,1);

    // We use DrawPrimTri to fill large blue tri as background, then enable blend and draw red tri overlapping
    const uc: UcCmd[] = [
      { op: 'SetPrimColor', color: blue },
      { op: 'DrawPrimTri', x1: 0, y1: 0, x2: width-1, y2: 0, x3: 0, y3: height-1 },
      { op: 'SetBlend', enable: true },
      { op: 'SetPrimColor', color: red },
      { op: 'DrawPrimTri', x1: 10, y1: 10, x2: 50, y2: 12, x3: 24, y3: 40 },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl, uc, 128);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 128);
    const img = res.frames[0] ?? res.image;

    function getRGBA(x:number,y:number){ const i=(y*width+x)*4; return [img[i]??0,img[i+1]??0,img[i+2]??0,img[i+3]??0] as const; }

    // Background pixel not covered by red tri should be pure blue (~0,0,255)
    const bg = getRGBA(2,2);
    expect(bg[2]).toBeGreaterThan(200);
    expect(bg[0]).toBeLessThan(20);

    // Overlap pixel should be purple-ish: both red and blue significant, green near zero
    const ov = getRGBA(24,20);
    expect(ov[0]).toBeGreaterThan(80); // some red
    expect(ov[2]).toBeGreaterThan(80); // some blue
    expect(ov[1]).toBeLessThan(40);    // little green
  });
});

