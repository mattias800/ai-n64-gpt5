import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';

function wrapFloat(u: number, n: number): number { return ((u % n) + n) % n; }
function mirrorFloat(u: number, n: number): { u: number, dir: 1|-1 } {
  const p = 2*n; let k = ((u % p) + p) % p; if (k < n) return { u: k, dir: 1 }; let v = (p - k); if (v === n) v = n - 1e-7; return { u: v, dir: -1 };
}
function foldFloat(u: number, n: number, mode: 'CLAMP'|'WRAP'|'MIRROR'): { u: number, dir: 1|-1 } {
  if (mode==='WRAP') return { u: wrapFloat(u, n), dir: 1 };
  if (mode==='MIRROR') return mirrorFloat(u, n);
  const eps = 1e-7; const r = u < 0 ? 0 : u > (n - eps) ? (n - eps) : u; return { u: r, dir: 1 };
}
function idxMode(i: number, n: number, mode: 'CLAMP'|'WRAP'|'MIRROR'): number {
  if (mode==='WRAP') { const m = i % n; return m < 0 ? m + n : m; }
  if (mode==='MIRROR') { const p = n*2; let k = i % p; if (k < 0) k += p; return k < n ? k : (p - 1 - k); }
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
function refSampleCI8BilinearColor5551(tex: Uint8Array, W: number, H: number, s: number, t: number, sm: 'CLAMP'|'WRAP'|'MIRROR', tm: 'CLAMP'|'WRAP'|'MIRROR'): number {
  const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u);
  const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm);
  const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u - s0; const bf=tf.u - t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  const i00=tex[t0i*W+s0i]??0, i10=tex[t0i*W+s1i]??0, i01=tex[t1i*W+s0i]??0, i11=tex[t1i*W+s1i]??0;
  const v00=(i00>>>3)&0x1f, v10=(i10>>>3)&0x1f, v01=(i01>>>3)&0x1f, v11=(i11>>>3)&0x1f;
  const v0=v00+(v10-v00)*a; const v1=v01+(v11-v01)*a; const v=Math.round(v0+(v1-v0)*b)&0x1f;
  return (((v&0x1f)<<11)|((v&0x1f)<<6)|((v&0x1f)<<1)|1)>>>0;
}

describe('rspdl_ci8_tri_bilinear_mixed_addr_reference_parity', () => {
  it('CI8 bilinear matches software reference for mixed S/T modes', () => {
    const width = 64, height = 48, origin = 0xC800;
    const start = 2, interval = 3, frames = 4, spOffset = 1;
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
    const dl3 = (base + 0x5000) >>> 0;
    const table = (base + 0x6000) >>> 0;

    for (let i=0;i<256;i++) bus.storeU16(tlutAddr + i*2, ((i>>>3)<<11)|((i>>>3)<<6)|((i>>>3)<<1)|1);
    const W=16,H=16; for (let y=0;y<H;y++){ for (let x=0;x<W;x++){ bus.storeU8(texAddr + y*W + x, (x*255/(W-1))|0); } }

    const tri = { x1: 6, y1: 6, s1: -2,  t1: -1,
                  x2: 54,y2: 10, s2: W+1,t2: 0,
                  x3: 12, y3: 40, s3: 0,  t3: H+2 };

    const combos: Array<['CLAMP'|'WRAP'|'MIRROR','CLAMP'|'WRAP'|'MIRROR']> = [
      ['WRAP','CLAMP'], ['MIRROR','CLAMP'], ['CLAMP','WRAP'], ['CLAMP','MIRROR']
    ];
    const dls = [dl0,dl1,dl2,dl3];

    for (let i=0;i<combos.length;i++){
      const [sMode,tMode]=combos[i]!;
      const uc: UcCmd[] = [
        { op: 'SetTLUT', tlutAddr, count: 256 },
        { op: 'SetTexAddrMode', sMode, tMode },
        { op: 'SetTexFilter', mode: 'BILINEAR' },
        { op: 'DrawCI8Tri', addr: texAddr, texW: W, texH: H,
          x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1,
          x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2,
          x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3 },
        { op: 'End' },
      ];
      writeUcAsRspdl(bus, dls[i]!, uc, 128);
    }

    for (let i=0;i<frames;i++) bus.storeU32(table + i*4, dls[i]!>>>0);

    const res = scheduleRSPDLFromTableAndRun(cpu, bus, sys, origin, width, height, table, frames, start, interval, total, spOffset, 128);

    const tex = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++) tex[i] = bus.rdram.bytes[texAddr + i] ?? 0;

    function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
    const area = edge(tri.x1,tri.y1,tri.x2,tri.y2,tri.x3,tri.y3); const wsign = area>=0?1:-1; const aabs = Math.abs(area)||1;

    for (let fi=0; fi<frames; fi++) {
      const frame = res.frames[fi]!;
      const [sMode,tMode]=combos[fi]!;
      const minX = Math.min(tri.x1, tri.x2, tri.x3);
      const maxX = Math.max(tri.x1, tri.x2, tri.x3);
      const minY = Math.min(tri.y1, tri.y2, tri.y3);
      const maxY = Math.max(tri.y1, tri.y2, tri.y3);
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
            const i16 = refSampleCI8BilinearColor5551(tex, W, H, s, t, sMode, tMode);
            const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
            const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
            const di=(y*width+x)*4;
            const gr=frame[di], gg=frame[di+1], gb=frame[di+2], ga=frame[di+3];
            expect([gr,gg,gb,ga], `frame ${fi} mode S=${sMode} T=${tMode} px(${x},${y})`).toEqual([r,g,b,a]);
          }
        }
      }
    }
  });
});

