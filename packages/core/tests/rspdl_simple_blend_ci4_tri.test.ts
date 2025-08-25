import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';

function pack(r5:number,g5:number,b5:number,a1:number){ return (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0; }

function makeCI4RedTex(w:number,h:number){
  // Create CI4 texture filled with index 1 in 4bpp, nibble-packed
  const pixels = w*h;
  const bytes = new Uint8Array((pixels + 1) >> 1);
  for (let i = 0; i < pixels; i += 2) {
    const hi = 1; // red index
    const lo = (i + 1 < pixels) ? 1 : 0;
    bytes[i >> 1] = ((hi & 0xF) << 4) | (lo & 0xF);
  }
  const tlut = new Uint16Array(256);
  tlut[0] = pack(0,0,0,0); // index 0 unused
  tlut[1] = pack(31,0,0,1); // red
  return { tex: bytes, tlut };
}

// Verify blending for CI4: blue background triangle then blended red CI4 tri -> overlap purple-ish
describe('rspdl_simple_blend_ci4_tri', () => {
  it('averages 5-bit channels when blending enabled (CI4)', () => {
    const width=64, height=48, origin=0xA000;
    const start=2, interval=3, frames=1, spOffset=1; const total=start+interval*frames+2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x9000) >>> 0;
    let dl = base >>> 0;

    const blue = pack(0,0,31,1);

    const texW=32, texH=32;
    const { tex, tlut } = makeCI4RedTex(texW, texH);
    const texAddr = dl + 0x3000; bus.rdram.bytes.set(tex, texAddr);
    const tlutAddr = dl + 0x5000;
    // Write TLUT in big-endian with storeU16 so alpha is read correctly
    for (let i = 0; i < tlut.length; i++) bus.storeU16(tlutAddr + i*2, tlut[i]! >>> 0);

    const uc: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetCombine', mode: 'TEXEL0' },
      { op: 'SetPrimColor', color: blue },
      { op: 'DrawPrimTri', x1: 0, y1: 0, x2: width-1, y2: 0, x3: 0, y3: height-1 },
      { op: 'SetBlend', enable: true },
      { op: 'DrawCI4Tri', addr: texAddr, texW, texH,
        x1: 10, y1: 10, s1: 0, t1: 0,
        x2: 50, y2: 12, s2: texW-1, t2: 0,
        x3: 24, y3: 40, s3: 0, t3: texH-1 },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl, uc, 256);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 256);
    const img = res.frames[0] ?? res.image;

    function getRGBA(x:number,y:number){ const i=(y*width+x)*4; return [img[i]??0,img[i+1]??0,img[i+2]??0,img[i+3]??0] as const; }

    const bg = getRGBA(2,2);
    expect(bg[2]).toBeGreaterThan(200);
    expect(bg[0]).toBeLessThan(20);

    const ov = getRGBA(24,20);
    expect(ov[0]).toBeGreaterThan(80);
    expect(ov[2]).toBeGreaterThan(80);
    expect(ov[1]).toBeLessThan(40);
  });
});

