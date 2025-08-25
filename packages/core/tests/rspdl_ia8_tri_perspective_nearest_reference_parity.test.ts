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
function nearest(u: number): number { return Math.round(u); }

function to5(v: number, bits: number): number { const maxIn=(1<<bits)-1; return Math.round((v/maxIn)*31)&0x1f; }

function refSampleIA8Nearest5551_Persp(tex: Uint8Array, W: number, H: number, sF: number, tF: number, q: number, sm: 0|1|2, tm: 0|1|2): number {
  const s = sF / q; const t = tF / q;
  const ss = idxMode(nearest(s), W, sm);
  const tt = idxMode(nearest(t), H, tm);
  const b = tex[tt*W+ss] ?? 0;
  const i5 = to5((b>>>4)&0xF, 4);
  const a1 = ((b&0xF)>=8)?1:0;
  return (((i5&0x1f)<<11)|((i5&0x1f)<<6)|((i5&0x1f)<<1)|a1)>>>0;
}

describe('rspdl_ia8_tri_perspective_nearest_reference_parity', () => {
  it('perspective-correct CLAMP/WRAP/MIRROR match software reference', () => {
    const width = 64, height = 48, origin = 0xC400;
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

    const W=16,H=16;
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const i4 = Math.round(x*15/(W-1)) & 0xF;
        const a4 = Math.round(y*15/(H-1)) & 0xF;
        bus.storeU8(texAddr + y*W + x, ((i4<<4)|a4)&0xFF);
      }
    }

    const tri = { x1: 6, y1: 6, s1: -2,  t1: -1,  q1: 0x10000,
                  x2: 54,y2: 10, s2: W+1,t2: 0,   q2: 0x20000,
                  x3: 12, y3: 40, s3: 0,  t3: H+2, q3: 0x30000 };

    const modes: Array<[0|1|2,0|1|2]> = [[0,0],[1,1],[2,2]];
    const dls: number[] = [dl0, dl1, dl2];

    for (let i=0;i<modes.length;i++) {
      const [sm, tm] = modes[i]!;
      const dl = dls[i]!;
      const uc: UcCmd[] = [
        { op: 'SetTexAddrMode', sMode: sm===0?'CLAMP': sm===1?'WRAP':'MIRROR', tMode: tm===0?'CLAMP': tm===1?'WRAP':'MIRROR' },
        { op: 'SetTexFilter', mode: 'NEAREST' },
        { op: 'DrawIA8TriPersp', addr: texAddr, texW: W, texH: H,
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

    const tex = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++) tex[i] = bus.rdram.bytes[texAddr + i] ?? 0;

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
            const sF = l0*tri.s1 + l1*tri.s2 + l2*tri.s3;
            const tF = l0*tri.t1 + l1*tri.t2 + l2*tri.t3;
            const i16 = refSampleIA8Nearest5551_Persp(tex, W, H, sF, tF, l0*tri.q1 + l1*tri.q2 + l2*tri.q3, sm, tm);
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

