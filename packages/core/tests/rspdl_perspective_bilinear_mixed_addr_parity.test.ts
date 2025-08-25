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
function to5(v: number, bits: number): number { const maxIn = (1<<bits) - 1; return Math.round((v / maxIn) * 31) & 0x1f; }

function refIA8Bilinear5551_Persp(tex: Uint8Array, W: number, H: number, sF: number, tF: number, q: number, sm: 0|1|2, tm: 0|1|2): number {
  const s = sF / q, t = tF / q; const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u); const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm); const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u-s0, bf=tf.u-t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  const b00=tex[t0i*W+s0i]??0, b10=tex[t0i*W+s1i]??0, b01=tex[t1i*W+s0i]??0, b11=tex[t1i*W+s1i]??0;
  const i00=to5((b00>>>4)&0xF,4), i10=to5((b10>>>4)&0xF,4), i01=to5((b01>>>4)&0xF,4), i11=to5((b11>>>4)&0xF,4);
  const a00=((b00&0xF)>=8)?1:0, a10=((b10&0xF)>=8)?1:0, a01=((b01&0xF)>=8)?1:0, a11=((b11&0xF)>=8)?1:0;
  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const v=Math.round(i0+(i1-i0)*b)&0x1f;
  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
  return (((v&0x1f)<<11)|((v&0x1f)<<6)|((v&0x1f)<<1)|A)>>>0;
}

function refIA16Bilinear5551_Persp(tex: Uint8Array, W: number, H: number, sF: number, tF: number, q: number, sm: 0|1|2, tm: 0|1|2): number {
  const s = sF / q, t = tF / q; const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u); const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm); const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u-s0, bf=tf.u-t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  function P(S:number,T:number){ const p=(T*W+S)*2; const I=tex[p]??0; const A=tex[p+1]??0; return {I,A}; }
  const p00=P(s0i,t0i), p10=P(s1i,t0i), p01=P(s0i,t1i), p11=P(s1i,t1i);
  const i00=to5(p00.I,8), i10=to5(p10.I,8), i01=to5(p01.I,8), i11=to5(p11.I,8);
  const a00=p00.A>=128?1:0, a10=p10.A>=128?1:0, a01=p01.A>=128?1:0, a11=p11.A>=128?1:0;
  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const v=Math.round(i0+(i1-i0)*b)&0x1f;
  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
  return (((v&0x1f)<<11)|((v&0x1f)<<6)|((v&0x1f)<<1)|A)>>>0;
}

function refRGBA16Bilinear5551_Persp(tex: Uint8Array, W: number, H: number, sF: number, tF: number, q: number, sm: 0|1|2, tm: 0|1|2): number {
  const s = sF / q, t = tF / q; const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u); const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm); const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u-s0, bf=tf.u-t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  function C(S:number,T:number){ const idx=T*W+S; const hi=tex[idx*2]??0; const lo=tex[idx*2+1]??0; return ((hi<<8)|lo)>>>0; }
  const c00=C(s0i,t0i), c10=C(s1i,t0i), c01=C(s0i,t1i), c11=C(s1i,t1i);
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

describe('perspective bilinear mixed addressing parity: IA8/IA16/RGBA16', () => {
  it('IA8/IA16/RGBA16 perspective bilinear parity across all S/T mode combinations', () => {
    const width = 64, height = 48, origin = 0xEC00;
    const rdram = new RDRAM(1 << 19); const bus = new Bus(rdram); const cpu = new CPU(bus); const sys = new System(cpu, bus);
    const fbBytes = width * height * 2; const base = (origin + fbBytes + 0x9000) >>> 0;

    const ia8Addr = (base + 0x0000) >>> 0;
    const ia16Addr = (base + 0x1000) >>> 0;
    const rgbaAddr = (base + 0x2000) >>> 0;
    const table = (base + 0x8000) >>> 0;

    const W8=12,H8=11; for (let y=0;y<H8;y++) for (let x=0;x<W8;x++) { const i4=Math.round(x*15/(W8-1))&0xF; const a4=Math.round(y*15/(H8-1))&0xF; bus.storeU8(ia8Addr+y*W8+x, ((i4<<4)|a4)&0xFF); }
    const W16=9,H16=10; for (let y=0;y<H16;y++) for (let x=0;x<W16;x++) { const I=Math.round(x*255/(W16-1))&0xFF; const A=Math.round(y*255/(H16-1))&0xFF; const p=(y*W16+x)*2; bus.storeU8(ia16Addr+p,I); bus.storeU8(ia16Addr+p+1,A); }
    const WR=10,HR=9; for (let y=0;y<HR;y++) for (let x=0;x<WR;x++) { const r5=Math.round(x*31/(WR-1))&0x1f; const g5=Math.round(y*31/(HR-1))&0x1f; const b5=((x+y)&1)?31:0; const a1=(x>=WR/2)?1:0; const p=(((r5&0x1f)<<11)|((g5&0x1f)<<6)|((b5&0x1f)<<1)|(a1&1))>>>0; const off=(y*WR+x)*2; bus.storeU8(rgbaAddr+off,(p>>>8)&0xff); bus.storeU8(rgbaAddr+off+1,p&0xff); }

    const dls: number[] = []; let dlCur=(base+0x3000)>>>0;
    const modes: (0|1|2)[] = [0,1,2];
    const tri = { x1: 6, y1: 6, x2: 54, y2: 10, x3: 12, y3: 40,
                  s1: -2, t1: -1, q1: 0x10000,
                  s2: 10, t2: 0,   q2: 0x20000,
                  s3: 0,  t3: 12,  q3: 0x30000 };

    type Case = { fmt: 'IA8'|'IA16'|'RGBA16', sm: 0|1|2, tm: 0|1|2 };
    const cases: Case[] = [];
    for (const fmt of ['IA8','IA16','RGBA16'] as const) for (const sm of modes) for (const tm of modes) cases.push({ fmt, sm, tm });

    for (const c of cases) {
      const dl = dlCur; dlCur=(dlCur+0x300)>>>0; dls.push(dl);
      const uc: UcCmd[] = [
        { op:'SetTexAddrMode', sMode: c.sm===0?'CLAMP': c.sm===1?'WRAP':'MIRROR', tMode: c.tm===0?'CLAMP': c.tm===1?'WRAP':'MIRROR' },
        { op:'SetTexFilter', mode:'BILINEAR' },
        ...(c.fmt==='IA8' ? [
          { op:'DrawIA8TriPersp', addr:ia8Addr, texW:W8, texH:H8,
            x1:tri.x1, y1:tri.y1, s1:tri.s1, t1:tri.t1, q1:tri.q1,
            x2:tri.x2, y2:tri.y2, s2:tri.s2, t2:tri.t2, q2:tri.q2,
            x3:tri.x3, y3:tri.y3, s3:tri.s3, t3:tri.t3, q3:tri.q3 },
        ] : c.fmt==='IA16' ? [
          { op:'DrawIA16TriPersp', addr:ia16Addr, texW:W16, texH:H16,
            x1:tri.x1, y1:tri.y1, s1:tri.s1, t1:tri.t1, q1:tri.q1,
            x2:tri.x2, y2:tri.y2, s2:tri.s2, t2:tri.t2, q2:tri.q2,
            x3:tri.x3, y3:tri.y3, s3:tri.s3, t3:tri.t3, q3:tri.q3 },
        ] : [
          { op:'DrawRGBA16TriPersp', addr:rgbaAddr, texW:WR, texH:HR,
            x1:tri.x1, y1:tri.y1, s1:tri.s1, t1:tri.t1, q1:tri.q1,
            x2:tri.x2, y2:tri.y2, s2:tri.s2, t2:tri.t2, q2:tri.q2,
            x3:tri.x3, y3:tri.y3, s3:tri.s3, t3:tri.t3, q3:tri.q3 },
        ]),
        { op:'End' },
      ];
      writeUcAsRspdl(bus, dl, uc, 128);
    }

    for (let i=0;i<dls.length;i++) bus.storeU32(table+i*4, dls[i]!>>>0);

    const start=2, interval=3, frames=dls.length, spOffset=1; const total=start+interval*frames+2;
    const res = scheduleRSPDLFromTableAndRun(cpu,bus,sys,origin,width,height,table,frames,start,interval,total,spOffset,128);

    const framesOut = res.frames;
    for (let fi=0; fi<frames; fi++) {
      const c = cases[fi]!; const frame = framesOut[fi]!;
      const minX=Math.min(tri.x1,tri.x2,tri.x3), maxX=Math.max(tri.x1,tri.x2,tri.x3);
      const minY=Math.min(tri.y1,tri.y2,tri.y3), maxY=Math.max(tri.y1,tri.y2,tri.y3);
      function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
      const area=edge(tri.x1,tri.y1,tri.x2,tri.y2,tri.x3,tri.y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1;
      for (let y=minY; y<=maxY; y+=3) for (let x=minX; x<=maxX; x+=3) {
        if (x<0||y<0||x>=width||y>=height) continue;
        const w0=edge(tri.x2,tri.y2,tri.x3,tri.y3,x,y)*wsign, w1=edge(tri.x3,tri.y3,tri.x1,tri.y1,x,y)*wsign, w2=edge(tri.x1,tri.y1,tri.x2,tri.y2,x,y)*wsign;
        if (w0>=0&&w1>=0&&w2>=0) {
          const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const q=l0*tri.q1+l1*tri.q2+l2*tri.q3; const invq=q!==0?1/q:0;
          const sF=(l0*tri.s1+l1*tri.s2+l2*tri.s3); const tF=(l0*tri.t1+l1*tri.t2+l2*tri.t3);
          let i16: number;
          if (c.fmt==='IA8') i16=refIA8Bilinear5551_Persp(new Uint8Array(bus.rdram.bytes.buffer, ia8Addr, W8*H8), W8, H8, sF, tF, q, c.sm, c.tm);
          else if (c.fmt==='IA16') i16=refIA16Bilinear5551_Persp(new Uint8Array(bus.rdram.bytes.buffer, ia16Addr, W16*H16*2), W16, H16, sF, tF, q, c.sm, c.tm);
          else i16=refRGBA16Bilinear5551_Persp(new Uint8Array(bus.rdram.bytes.buffer, rgbaAddr, WR*HR*2), WR, HR, sF, tF, q, c.sm, c.tm);
          const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
          const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
          const di=(y*width+x)*4; expect([frame[di],frame[di+1],frame[di+2],frame[di+3]]).toEqual([r,g,b,a]);
        }
      }
    }
  });
});

