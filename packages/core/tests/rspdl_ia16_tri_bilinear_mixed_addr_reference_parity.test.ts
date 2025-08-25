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
  const eps=1e-7; const r = u < 0 ? 0 : u > (n - eps) ? (n - eps) : u; return { u: r, dir: 1 };
}
function to5(v: number, bits: number): number { const max=(1<<bits)-1; return Math.round((v/max)*31)&0x1f; }

function refSampleIA16Bilinear5551(tex: Uint8Array, W: number, H: number, s: number, t: number, sm: 0|1|2, tm: 0|1|2): number {
  const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u);
  const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm);
  const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u-s0, bf=tf.u-t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  function P(S:number,T:number){ const p=(T*W+S)*2; const I=tex[p]??0; const A=tex[p+1]??0; return {I,A}; }
  const p00=P(s0i,t0i), p10=P(s1i,t0i), p01=P(s0i,t1i), p11=P(s1i,t1i);
  const i00=to5(p00.I,8), i10=to5(p10.I,8), i01=to5(p01.I,8), i11=to5(p11.I,8);
  const a00=p00.A>=128?1:0, a10=p10.A>=128?1:0, a01=p01.A>=128?1:0, a11=p11.A>=128?1:0;
  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const v=Math.round(i0+(i1-i0)*b)&0x1f;
  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
  return (((v&0x1f)<<11)|((v&0x1f)<<6)|((v&0x1f)<<1)|A)>>>0;
}

describe('rspdl_ia16_tri_bilinear_mixed_addr_reference_parity', () => {
  it('non-perspective SM in {CLAMP,WRAP,MIRROR} x TM in {CLAMP,WRAP,MIRROR} match reference', () => {
    const width = 64, height = 48, origin = 0xD800;
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x7000) >>> 0;
    const texAddr = (base + 0x0000) >>> 0;
    const table = (base + 0x5000) >>> 0;

    const W=8,H=8;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      const I = Math.round(x*255/(W-1)) & 0xFF;
      const A = Math.round(y*255/(H-1)) & 0xFF;
      const p=(y*W+x)*2; bus.storeU8(texAddr+p, I); bus.storeU8(texAddr+p+1, A);
    }

    const dls: number[] = [];
    const tri = { x1: 6, y1: 6, s1: -2,  t1: -1, x2: 54,y2: 10, s2: W+1,t2: 0, x3: 12, y3: 40, s3: 0,  t3: H+2 };
    let dlCursor = (base + 0x2000) >>> 0;
    const combos: Array<[0|1|2,0|1|2]> = [];
    for (const sm of [0,1,2] as const) for (const tm of [0,1,2] as const) combos.push([sm,tm]);
    for (const [sm, tm] of combos) {
      const dl = dlCursor; dlCursor = (dlCursor + 0x200) >>> 0; dls.push(dl);
      const uc: UcCmd[] = [
        { op: 'SetTexAddrMode', sMode: sm===0?'CLAMP': sm===1?'WRAP':'MIRROR', tMode: tm===0?'CLAMP': tm===1?'WRAP':'MIRROR' },
        { op: 'SetTexFilter', mode: 'BILINEAR' },
        { op: 'DrawIA16Tri', addr: texAddr, texW: W, texH: H,
          x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1,
          x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2,
          x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3 },
        { op: 'End' },
      ];
      writeUcAsRspdl(bus, dl, uc, 128);
    }

    for (let i=0;i<dls.length;i++) bus.storeU32(table + i*4, dls[i]! >>> 0);

    const start = 2, interval = 3, frames = dls.length, spOffset = 1;
    const total = start + interval * frames + 2;
    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);

    const tex = new Uint8Array(W*H*2); for (let i=0;i<W*H*2;i++) tex[i] = bus.rdram.bytes[texAddr + i] ?? 0;

    for (let fi=0; fi<frames; fi++) {
      const [sm, tm] = combos[fi]!; const frame = res.frames[fi]!;
      const minX = Math.min(tri.x1, tri.x2, tri.x3);
      const maxX = Math.max(tri.x1, tri.x2, tri.x3);
      const minY = Math.min(tri.y1, tri.y2, tri.y3);
      const maxY = Math.max(tri.y1, tri.y2, tri.y3);
      function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
      const area = edge(tri.x1,tri.y1,tri.x2,tri.y2,tri.x3,tri.y3); const wsign = area >= 0 ? 1 : -1; const aabs = Math.abs(area) || 1;
      for (let y = minY; y <= maxY; y += 2) for (let x = minX; x <= maxX; x += 2) {
        if (x<0||y<0||x>=width||y>=height) continue;
        const w0 = edge(tri.x2,tri.y2,tri.x3,tri.y3,x,y) * wsign;
        const w1 = edge(tri.x3,tri.y3,tri.x1,tri.y1,x,y) * wsign;
        const w2 = edge(tri.x1,tri.y1,tri.x2,tri.y2,x,y) * wsign;
        if (w0>=0&&w1>=0&&w2>=0) {
          const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs;
          const s = l0*tri.s1 + l1*tri.s2 + l2*tri.s3;
          const t = l0*tri.t1 + l1*tri.t2 + l2*tri.t3;
          const i16 = refSampleIA16Bilinear5551(tex, W, H, s, t, sm, tm);
          const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
          const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
          const di=(y*width+x)*4; const gr=frame[di], gg=frame[di+1], gb=frame[di+2], ga=frame[di+3];
          expect([gr,gg,gb,ga], `frame ${fi} sm=${sm} tm=${tm} px(${x},${y})`).toEqual([r,g,b,a]);
        }
      }
    }
  });
});

