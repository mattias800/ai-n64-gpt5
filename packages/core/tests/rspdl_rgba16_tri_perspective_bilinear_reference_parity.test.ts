import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';

function wrap(i: number, n: number): number { const m = i % n; return m < 0 ? m + n : m; }
function mirror(i: number, n: number): number { const p = n * 2; let k = i % p; if (k < 0) k += p; return k < n ? k : (p - 1 - k); }
function clamp(i: number, n: number): number { return i < 0 ? 0 : i >= n ? n - 1 : i; }
function idxMode(i: number, n: number, mode: 0|1|2): number { return mode===1?wrap(i,n): mode===2?mirror(i,n): clamp(i,n); }
function foldFloat(u: number, n: number, mode: 0|1|2): { u: number, dir: 1|-1 } {
  if (mode===1) { const r = ((u % n) + n) % n; return { u: r, dir: 1 }; }
  if (mode===2) { const p=n*2; let k=((u%p)+p)%p; if (k < n) return { u: k, dir: 1 }; let v=(p-k); if (v===n) v = n - 1e-7; return { u: v, dir: -1 }; }
  const eps = 1e-7; const r = u < 0 ? 0 : u > (n - eps) ? (n - eps) : u; return { u: r, dir: 1 };
}

function refSampleRGBA16Bilinear5551_Persp(tex: Uint16Array, W: number, H: number, sF: number, tF: number, q: number, sm: 0|1|2, tm: 0|1|2): number {
  const s = sF / q; const t = tF / q;
  const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u);
  const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm);
  const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u - s0; const bf=tf.u - t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  function RGBA16At(S: number,T: number){ return tex[T*W+S]??0; }
  const c00=RGBA16At(s0i,t0i), c10=RGBA16At(s1i,t0i), c01=RGBA16At(s0i,t1i), c11=RGBA16At(s1i,t1i);
  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
  const r0=r00+(r10-r00)*a, r1=r01+(r11-r01)*a; const R=Math.round(r0+(r1-r0)*b)&0x1f;
  const g0=g00+(g10-g00)*a, g1=g01+(g11-g01)*a; const G=Math.round(g0+(g1-g0)*b)&0x1f;
  const b0=b00+(b10-b00)*a, b1=b01+(b11-b01)*a; const B=Math.round(b0+(b1-b0)*b)&0x1f;
  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
  return (((R&0x1f)<<11)|((G&0x1f)<<6)|((B&0x1f)<<1)|A)>>>0;
}

describe('rspdl_rgba16_tri_perspective_bilinear_reference_parity', () => {
  it('perspective-correct CLAMP/WRAP/MIRROR match software reference', () => {
    const width = 64, height = 48, origin = 0xB400;
    const start = 2, interval = 3, frames = 3, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x7000) >>> 0;

    const texAddr = (base + 0x0000) >>> 0;
    const dl0 = (base + 0x2000) >>> 0;
    const dl1 = (base + 0x3000) >>> 0;
    const dl2 = (base + 0x4000) >>> 0;
    const table = (base + 0x5000) >>> 0;

    // Build a 8x8 RGBA16 texture with distinct colors and alpha pattern
    const W=8,H=8;
    const tex = new Uint16Array(W*H);
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const r5 = Math.round(x*31/(W-1)) & 0x1f;
        const g5 = Math.round(y*31/(H-1)) & 0x1f;
        const b5 = ((x+y)&1)? 31 : 0;
        const a1 = (x>=W/2)?1:0;
        const p = (((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0;
        tex[y*W+x] = p;
        const off = (y*W+x)*2; bus.storeU8(texAddr+off, (p>>>8)&0xff); bus.storeU8(texAddr+off+1, p&0xff);
      }
    }

    const tri = { x1: 6, y1: 6, s1: -2,  t1: -1,  q1: 0x10000,
                  x2: 54,y2: 10, s2: W+1,t2: 0,   q2: 0x20000,
                  x3: 12, y3: 40, s3: 0,  t3: H+2, q3: 0x30000 };

    const modes: Array<[0|1|2,0|1|2]> = [[0,0],[1,1],[2,2]]; // CLAMP, WRAP, MIRROR
    const dls: number[] = [dl0, dl1, dl2];

    for (let i=0;i<modes.length;i++) {
      const [sm, tm] = modes[i]!;
      const dl = dls[i]!;
      const uc: UcCmd[] = [
        { op: 'SetTexAddrMode', sMode: sm===0?'CLAMP': sm===1?'WRAP':'MIRROR', tMode: tm===0?'CLAMP': tm===1?'WRAP':'MIRROR' },
        { op: 'SetTexFilter', mode: 'BILINEAR' },
        { op: 'DrawRGBA16TriPersp', addr: texAddr, texW: W, texH: H,
          x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1, q1: tri.q1,
          x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2, q2: tri.q2,
          x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3, q3: tri.q3 },
        { op: 'End' },
      ];
      writeUcAsRspdl(bus, dl, uc, 128);
    }

    bus.storeU32(table+0, dl0>>>0);
    bus.storeU32(table+4, dl1>>>0);
    bus.storeU32(table+8, dl2>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);

    const framesOut = res.frames;
    for (let fi=0; fi<frames; fi++) {
      const [sm, tm] = modes[fi]!;
      const frame = framesOut[fi]!;
      const minX = Math.min(tri.x1, tri.x2, tri.x3);
      const maxX = Math.max(tri.x1, tri.x2, tri.x3);
      const minY = Math.min(tri.y1, tri.y2, tri.y3);
      const maxY = Math.max(tri.y1, tri.y2, tri.y3);
      function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
      const area = edge(tri.x1,tri.y1,tri.x2,tri.y2,tri.x3,tri.y3);
      const wsign = area >= 0 ? 1 : -1;
      const aabs = Math.abs(area) || 1;
      for (let y = minY; y <= maxY; y += 2) {
        for (let x = minX; x <= maxX; x += 2) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const w0 = edge(tri.x2,tri.y2,tri.x3,tri.y3,x,y) * wsign;
          const w1 = edge(tri.x3,tri.y3,tri.x1,tri.y1,x,y) * wsign;
          const w2 = edge(tri.x1,tri.y1,tri.x2,tri.y2,x,y) * wsign;
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
            const l0 = w0 / aabs, l1 = w1 / aabs, l2 = w2 / aabs;
            const q = l0*tri.q1 + l1*tri.q2 + l2*tri.q3;
            const sF = l0*tri.s1 + l1*tri.s2 + l2*tri.s3;
            const tF = l0*tri.t1 + l1*tri.t2 + l2*tri.t3;
            const i16 = refSampleRGBA16Bilinear5551_Persp(tex, W, H, sF, tF, q, sm, tm);
            const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
            const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
            const di=(y*width+x)*4;
            const gr=frame[di], gg=frame[di+1], gb=frame[di+2], ga=frame[di+3];
            expect([gr,gg,gb,ga], `px(${x},${y}) frame ${fi}`).toEqual([r,g,b,a]);
          }
        }
      }
    }
  });
});

