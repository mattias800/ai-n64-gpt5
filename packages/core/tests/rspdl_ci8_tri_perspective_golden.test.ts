import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32, decode5551To8888 } from './helpers/test_utils.ts';

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

// Software reference for perspective-correct CI8 triangle with clamp addressing
function renderRefCI8Persp(width: number, height: number, tri: { x1:number,y1:number,s1:number,t1:number,q1:number,x2:number,y2:number,s2:number,t2:number,q2:number,x3:number,y3:number,s3:number,t3:number,q3:number }, tex: { w:number,h:number, data: Uint8Array }, tlut: Uint16Array): Uint8Array {
  const out = new Uint8Array(width * height * 4); // RGBA8888
  // Barycentric helpers
  const edge = (ax:number,ay:number,bx:number,by:number,px:number,py:number)=> (px-ax)*(by-ay) - (py-ay)*(bx-ax);
  const area = edge(tri.x1,tri.y1,tri.x2,tri.y2,tri.x3,tri.y3);
  const wsign = area >= 0 ? 1 : -1;
  const aabs = Math.abs(area) || 1;
  const minX = clamp(Math.min(tri.x1,tri.x2,tri.x3), 0, width-1);
  const maxX = clamp(Math.max(tri.x1,tri.x2,tri.x3), 0, width-1);
  const minY = clamp(Math.min(tri.y1,tri.y2,tri.y3), 0, height-1);
  const maxY = clamp(Math.max(tri.y1,tri.y2,tri.y3), 0, height-1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = edge(tri.x2,tri.y2,tri.x3,tri.y3,x,y) * wsign;
      const w1 = edge(tri.x3,tri.y3,tri.x1,tri.y1,x,y) * wsign;
      const w2 = edge(tri.x1,tri.y1,tri.x2,tri.y2,x,y) * wsign;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
        const l0 = w0 / aabs, l1 = w1 / aabs, l2 = w2 / aabs;
        const q = l0*tri.q1 + l1*tri.q2 + l2*tri.q3;
        const invq = q !== 0 ? 1.0 / q : 0.0;
        const s = Math.round((l0*tri.s1 + l1*tri.s2 + l2*tri.s3) * invq);
        const t = Math.round((l0*tri.t1 + l1*tri.t2 + l2*tri.t3) * invq);
        const ss = clamp(s, 0, tex.w - 1);
        const tt = clamp(t, 0, tex.h - 1);
        const idx = tex.data[tt * tex.w + ss] ?? 0;
        const c5551 = tlut[idx] ?? 0;
        if ((c5551 & 1) !== 0) {
          const [r,g,b,a] = decode5551To8888(c5551);
          const i = (y * width + x) * 4;
          out[i] = r; out[i+1] = g; out[i+2] = b; out[i+3] = a;
        }
      }
    }
  }
  return out;
}

describe('rspdl_ci8_tri_perspective_golden', () => {
  it('DrawCI8TriPersp matches software reference exactly (CRC)', () => {
    const width = 160, height = 120, origin = 0xB000;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x6000) >>> 0;
    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dl = (base + 0x2000) >>> 0;

    // TLUT: grayscale ramp in 5551
    const tlut = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      const c = ((i>>>3) & 0x1f);
      tlut[i] = ((c<<11)|(c<<6)|(c<<1)|1) >>> 0;
      bus.storeU16(tlutAddr + i*2, tlut[i]!);
    }
    // Texture 32x32 horizontal ramp
    const texW = 32, texH = 32;
    const texData = new Uint8Array(texW * texH);
    for (let y = 0; y < texH; y++) {
      for (let x = 0; x < texW; x++) {
        const v = Math.round(x * 255 / (texW - 1)) >>> 0;
        texData[y*texW + x] = v;
        bus.storeU8(texAddr + y*texW + x, v);
      }
    }

    const tri = { x1: 20, y1: 15, s1: 0, t1: 0, q1: 1,
                  x2: 140,y2: 20, s2: 31,t2: 0, q2: 1,
                  x3: 30, y3: 110,s3: 0, t3: 31,q3: 3 };

    // Build UC for perspective triangle
    const uc: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'DrawCI8TriPersp', addr: texAddr, texW, texH,
        x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1, q1: tri.q1,
        x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2, q2: tri.q2,
        x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3, q3: tri.q3 },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus, dl, uc, 128);

    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, 1, start, interval, total, spOffset, 128);
    const got = res.frames[0] ?? res.image;

    // Compute software reference
    const ref = renderRefCI8Persp(width, height, tri, { w: texW, h: texH, data: texData }, tlut);

    const hGot = crc32(got);
    const hRef = crc32(ref);
    expect(hGot).toBe(hRef);
  });
});

