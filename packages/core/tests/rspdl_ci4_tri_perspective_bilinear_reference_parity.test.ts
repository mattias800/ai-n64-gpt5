import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';

// Perspective CI4 bilinear CLAMP reference
function clamp(i: number, n: number): number { return i < 0 ? 0 : i >= n ? n - 1 : i; }
function foldFloat(u: number, n: number): number { const eps = 1e-7; return u < 0 ? 0 : u > (n - eps) ? (n - eps) : u; }
function ci4AtPacked(tex: Uint8Array, W: number, s: number, t: number): number { const index=t*W+s; const byte=tex[index>>1]??0; const hi=(byte>>>4)&0xF; const lo=byte&0xF; return (index&1)===0?hi:lo; }
function refSampleCI4BilinearPersp(tex: Uint8Array, W: number, H: number, s: number, t: number, palOffset: number): number {
  const su=foldFloat(s,W), tu=foldFloat(t,H);
  const s0=Math.floor(su), t0=Math.floor(tu);
  const s1=s0+1, t1=t0+1;
  const s0i=clamp(s0,W), s1i=clamp(s1,W);
  const t0i=clamp(t0,H), t1i=clamp(t1,H);
  const a=su-s0, b=tu-t0;
  const i00=(ci4AtPacked(tex,W,s0i,t0i)+palOffset)&0xFF, i10=(ci4AtPacked(tex,W,s1i,t0i)+palOffset)&0xFF,
        i01=(ci4AtPacked(tex,W,s0i,t1i)+palOffset)&0xFF, i11=(ci4AtPacked(tex,W,s1i,t1i)+palOffset)&0xFF;
  const i0=i00+(i10-i00)*a; const i1=i01+(i11-i01)*a; return Math.round(i0+(i1-i0)*b)&0xFF;
}

describe('rspdl_ci4_tri_perspective_bilinear_reference_parity', () => {
  it('perspective CLAMP matches software reference', () => {
    const width = 64, height = 48, origin = 0xA800;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
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
    const table = (base + 0x3000) >>> 0;

    for (let i=0;i<256;i++) bus.storeU16(tlutAddr + i*2, ((i>>>3)<<11)|((i>>>3)<<6)|((i>>>3)<<1)|1);
    const W=16,H=16; const packed = new Uint8Array((W*H+1)>>1);
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){ const idx=(x&0xF)>>>0; const pi=y*W+x; const bi=pi>>1; if((pi&1)===0) packed[bi]=(packed[bi]&0x0F)|((idx&0xF)<<4); else packed[bi]=(packed[bi]&0xF0)|(idx&0xF); }
    for (let i=0;i<packed.length;i++) bus.storeU8(texAddr + i, packed[i]!);

    const tri = { x1: 6, y1: 6, s1: 0, t1: 0, q1: 1<<16,
                  x2: 58,y2: 10, s2: W-1, t2: 0, q2: 1<<16,
                  x3: 10, y3: 42, s3: 0, t3: H-1, q3: 1<<16 };

    const uc: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetCI4Palette', palette: 2 }, // offset 32
      { op: 'SetTexAddrMode', sMode: 'CLAMP', tMode: 'CLAMP' },
      { op: 'SetTexFilter', mode: 'BILINEAR' },
      { op: 'DrawCI4TriPersp', addr: texAddr, texW: W, texH: H,
        x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1, q1: tri.q1,
        x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2, q2: tri.q2,
        x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3, q3: tri.q3 },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl0, uc, 128);
    bus.storeU32(table+0, dl0>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);
    const frame = res.frames[0]!;

    const palOffset = (2 & 0xF) * 16;

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
          const q = l0*tri.q1 + l1*tri.q2 + l2*tri.q3; const invq = q!==0 ? (1.0/q) : 0.0;
          const s = (l0*tri.s1 + l1*tri.s2 + l2*tri.s3) * invq;
          const t = (l0*tri.t1 + l1*tri.t2 + l2*tri.t3) * invq;
          const idx = refSampleCI4BilinearPersp(packed, W, H, s, t, palOffset);
          const i16 = ((idx>>>3)<<11)|((idx>>>3)<<6)|((idx>>>3)<<1)|1;
          const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
          const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
          const di=(y*width+x)*4;
          const gr=frame[di], gg=frame[di+1], gb=frame[di+2], ga=frame[di+3];
          expect([gr,gg,gb,ga], `px(${x},${y})`).toEqual([r,g,b,a]);
        }
      }
    }
  });
});

