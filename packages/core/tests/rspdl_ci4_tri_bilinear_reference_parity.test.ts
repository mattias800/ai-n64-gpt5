import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';

// Software reference for CI4 bilinear sampling with address modes; palette offset applied before TLUT
function wrap(i: number, n: number): number { const m = i % n; return m < 0 ? m + n : m; }
function mirror(i: number, n: number): number { const p = n * 2; let k = i % p; if (k < 0) k += p; return k < n ? k : (p - 1 - k); }
function clamp(i: number, n: number): number { return i < 0 ? 0 : i >= n ? n - 1 : i; }
function idxMode(i: number, n: number, mode: 0|1|2): number { return mode===1?wrap(i,n): mode===2?mirror(i,n): clamp(i,n); }
function foldFloat(u: number, n: number, mode: 0|1|2): { u: number, dir: 1|-1 } {
  if (mode===1) { const r = ((u % n) + n) % n; return { u: r, dir: 1 }; }
  if (mode===2) { const p=n*2; let k=((u%p)+p)%p; if (k < n) return { u: k, dir: 1 }; let v=(p-k); if (v===n) v = n - 1e-7; return { u: v, dir: -1 }; }
  const eps = 1e-7; const r = u < 0 ? 0 : u > (n - eps) ? (n - eps) : u; return { u: r, dir: 1 };
}
function refSampleCI4Bilinear(tex: Uint8Array, W: number, H: number, s: number, t: number, sm: 0|1|2, tm: 0|1|2, palOffset: number): number {
  const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u);
  const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm);
  const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  function ci4At(s:number,t:number){ const index=t*W+s; return tex[index] ?? 0; }
  const af=sf.u - s0; const bf=tf.u - t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  const i00=(ci4At(s0i,t0i)+palOffset)&0xFF, i10=(ci4At(s1i,t0i)+palOffset)&0xFF, i01=(ci4At(s0i,t1i)+palOffset)&0xFF, i11=(ci4At(s1i,t1i)+palOffset)&0xFF;
  const i0=i00+(i10-i00)*a; const i1=i01+(i11-i01)*a; return Math.round(i0+(i1-i0)*b)&0xFF;
}

describe('rspdl_ci4_tri_bilinear_reference_parity', () => {
  it('non-perspective CLAMP/WRAP/MIRROR match software reference', () => {
    const width = 64, height = 48, origin = 0xA000;
    const start = 2, interval = 3, frames = 3, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x4000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dl0 = (base + 0x2000) >>> 0;
    const dl1 = (base + 0x3000) >>> 0;
    const dl2 = (base + 0x4000) >>> 0;
    const table = (base + 0x5000) >>> 0;

    // Build TLUT: 256 entries grayscale
    for (let i=0;i<256;i++) bus.storeU16(tlutAddr + i*2, ((i>>>3)<<11)|((i>>>3)<<6)|((i>>>3)<<1)|1);
    // 16x16 CI4 texture, but we will write packed nibbles: horizontal ramp of 0..15
    const W=16,H=16;
    const packed = new Uint8Array((W*H+1)>>1);
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const idx = (x & 0xF) >>> 0;
        const pi = (y*W + x) >>> 0;
        const bi = pi >> 1;
        if ((pi & 1) === 0) packed[bi] = (packed[bi] & 0x0F) | ((idx & 0xF) << 4);
        else packed[bi] = (packed[bi] & 0xF0) | (idx & 0xF);
      }
    }
    for (let i=0;i<packed.length;i++) bus.storeU8(texAddr + i, packed[i]!);

    const tri = { x1: 6, y1: 6, s1: -2,  t1: -1,
                  x2: 54,y2: 10, s2: W+1,t2: 0,
                  x3: 12, y3: 40, s3: 0,  t3: H+2 };

    const modes: Array<[0|1|2,0|1|2]> = [[0,0],[1,1],[2,2]]; // CLAMP, WRAP, MIRROR
    const dls: number[] = [dl0, dl1, dl2];

    for (let i=0;i<modes.length;i++) {
      const [sm, tm] = modes[i]!;
      const dl = dls[i]!;
      const uc: UcCmd[] = [
        { op: 'SetTLUT', tlutAddr, count: 256 },
        { op: 'SetCI4Palette', palette: 3 }, // offset 48
        { op: 'SetTexAddrMode', sMode: sm===0?'CLAMP': sm===1?'WRAP':'MIRROR', tMode: tm===0?'CLAMP': tm===1?'WRAP':'MIRROR' },
        { op: 'SetTexFilter', mode: 'BILINEAR' },
        { op: 'DrawCI4Tri', addr: texAddr, texW: W, texH: H,
          x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1,
          x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2,
          x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3 },
        { op: 'End' },
      ];
      writeUcAsRspdl(bus, dl, uc, 128);
    }

    bus.storeU32(table+0, dl0>>>0);
    bus.storeU32(table+4, dl1>>>0);
    bus.storeU32(table+8, dl2>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);

    // Prepare reference tex unpacked for sampling
    const tex = new Uint8Array(W*H);
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const pi=y*W+x; const byte=packed[pi>>1]??0; const hi=(byte>>>4)&0xF; const lo=byte&0xF; tex[pi]= (pi&1)===0?hi:lo;
      }
    }

    const framesOut = res.frames;
    for (let fi=0; fi<frames; fi++) {
      const [sm, tm] = modes[fi]!;
      const frame = framesOut[fi]!;
      const palOffset = (3 & 0xF) * 16;
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
            const s = l0*tri.s1 + l1*tri.s2 + l2*tri.s3;
            const t = l0*tri.t1 + l1*tri.t2 + l2*tri.t3;
            const idx = refSampleCI4Bilinear(tex, W, H, s, t, sm, tm, palOffset);
            const i16 = ((idx>>>3)<<11)|((idx>>>3)<<6)|((idx>>>3)<<1)|1;
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

