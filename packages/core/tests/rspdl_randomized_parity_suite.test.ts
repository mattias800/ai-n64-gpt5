import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';

// Deterministic PRNG
function lcg(seed: number) { let s = seed>>>0; return () => (s = (s * 1664525 + 1013904223) >>> 0); }
function frand(r: () => number, min: number, max: number): number { return min + (r() / 0xffffffff) * (max - min); }
function irand(r: () => number, min: number, max: number): number { return Math.floor(frand(r, min, max+1)); }

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

function refIA8Bilinear5551(tex: Uint8Array, W: number, H: number, s: number, t: number, sm: 0|1|2, tm: 0|1|2): number {
  const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u);
  const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm);
  const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
  const af=sf.u-s0, bf=tf.u-t0; const a=sf.dir===1?af:(1-af); const b=tf.dir===1?bf:(1-bf);
  const b00=tex[t0i*W+s0i]??0, b10=tex[t0i*W+s1i]??0, b01=tex[t1i*W+s0i]??0, b11=tex[t1i*W+s1i]??0;
  const i00=to5((b00>>>4)&0xF,4), i10=to5((b10>>>4)&0xF,4), i01=to5((b01>>>4)&0xF,4), i11=to5((b11>>>4)&0xF,4);
  const a00=((b00&0xF)>=8)?1:0, a10=((b10&0xF)>=8)?1:0, a01=((b01&0xF)>=8)?1:0, a11=((b11&0xF)>=8)?1:0;
  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const v=Math.round(i0+(i1-i0)*b)&0x1f;
  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
  return (((v&0x1f)<<11)|((v&0x1f)<<6)|((v&0x1f)<<1)|A)>>>0;
}

function refIA16Bilinear5551(tex: Uint8Array, W: number, H: number, s: number, t: number, sm: 0|1|2, tm: 0|1|2): number {
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

function refRGBA16Bilinear5551(tex: Uint8Array, W: number, H: number, s: number, t: number, sm: 0|1|2, tm: 0|1|2): number {
  const sf=foldFloat(s,W,sm), tf=foldFloat(t,H,tm);
  const s0=Math.floor(sf.u), t0=Math.floor(tf.u);
  const s1=s0+sf.dir, t1=t0+tf.dir;
  const s0i=idxMode(s0,W,sm), s1i=idxMode(s1,W,sm);
  const t0i=idxMode(t0,H,tm), t1i=idxMode(t1,H,tm);
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

describe('randomized parity: IA8/IA16/RGBA16 perspective bilinear', () => {
  it('IA8 perspective bilinear randomized parity', () => {
    const rand = lcg(0xC0FFEE);
    const width = 64, height = 48, origin = 0xE000;
    const rdram = new RDRAM(1 << 19); const bus = new Bus(rdram); const cpu = new CPU(bus); const sys = new System(cpu, bus);
    const fbBytes = width * height * 2; const base = (origin + fbBytes + 0x9000) >>> 0;
    const texAddr = (base + 0x0000) >>> 0; const table = (base + 0x8000) >>> 0;
    const W=16,H=16; for (let i=0;i<W*H;i++) bus.storeU8(texAddr+i, irand(rand,0,255));
    const frames = 6; const dls: number[] = []; let dlCur=(base+0x1000)>>>0;
    for (let f=0; f<frames; f++) {
      const sm = irand(rand,0,2) as 0|1|2; const tm = irand(rand,0,2) as 0|1|2;
      const tri = { x1: irand(rand,4,width-4), y1: irand(rand,4,height-4),
                    x2: irand(rand,4,width-4), y2: irand(rand,4,height-4),
                    x3: irand(rand,4,width-4), y3: irand(rand,4,height-4),
                    s1: frand(rand,-4,W+4), t1: frand(rand,-4,H+4), q1: irand(rand,0x10000,0x40000),
                    s2: frand(rand,-4,W+4), t2: frand(rand,-4,H+4), q2: irand(rand,0x10000,0x40000),
                    s3: frand(rand,-4,W+4), t3: frand(rand,-4,H+4), q3: irand(rand,0x10000,0x40000) };
      const dl = dlCur; dlCur=(dlCur+0x300)>>>0; dls.push(dl);
      const uc: UcCmd[] = [
        { op:'SetTexAddrMode', sMode: sm===0?'CLAMP': sm===1?'WRAP':'MIRROR', tMode: tm===0?'CLAMP': tm===1?'WRAP':'MIRROR' },
        { op:'SetTexFilter', mode:'BILINEAR' },
        { op:'DrawIA8TriPersp', addr:texAddr, texW:W, texH:H,
          x1:tri.x1, y1:tri.y1, s1:tri.s1|0, t1:tri.t1|0, q1:tri.q1>>>0,
          x2:tri.x2, y2:tri.y2, s2:tri.s2|0, t2:tri.t2|0, q2:tri.q2>>>0,
          x3:tri.x3, y3:tri.y3, s3:tri.s3|0, t3:tri.t3|0, q3:tri.q3>>>0 },
        { op:'End' },
      ];
      writeUcAsRspdl(bus, dl, uc, 128);
    }
    for (let i=0;i<dls.length;i++) bus.storeU32(table+i*4, dls[i]!>>>0);
    const start=2, interval=3, spOffset=1; const total = start + interval * frames + 2;
    const res = scheduleRSPDLFromTableAndRun(cpu,bus,sys,origin,width,height,table,frames,start,interval,total,spOffset,128);
    const tex = new Uint8Array(W*H); for (let i=0;i<W*H;i++) tex[i]=bus.rdram.bytes[texAddr+i]??0;
    for (let fi=0; fi<frames; fi++) {
      // Decode the parameters from the DL we wrote (we know the layout)
      const dl = dls[fi]!; const op = bus.loadU32(dl+0)>>>0; expect(op).toBe(0x24);
      const mode = bus.loadU32(dl+4)>>>0; const sm = (mode&3) as 0|1|2; const tm = ((mode>>>2)&3) as 0|1|2;
      const op2 = bus.loadU32(dl+8)>>>0; expect(op2).toBe(0x25);
      const op3 = bus.loadU32(dl+16)>>>0; expect(op3).toBe(0x46);
      const addr = bus.loadU32(dl+20)>>>0; const tW=bus.loadU32(dl+24)>>>0; const tH=bus.loadU32(dl+28)>>>0;
      const x1=bus.loadU32(dl+32)|0, y1=bus.loadU32(dl+36)|0, s1=bus.loadU32(dl+40)|0, t1=bus.loadU32(dl+44)|0, q1=bus.loadU32(dl+48)>>>0;
      const x2=bus.loadU32(dl+52)|0, y2=bus.loadU32(dl+56)|0, s2=bus.loadU32(dl+60)|0, t2=bus.loadU32(dl+64)|0, q2=bus.loadU32(dl+68)>>>0;
      const x3=bus.loadU32(dl+72)|0, y3=bus.loadU32(dl+76)|0, s3=bus.loadU32(dl+80)|0, t3=bus.loadU32(dl+84)|0, q3=bus.loadU32(dl+88)>>>0;
      const frame = res.frames[fi]!;
      const minX=Math.min(x1,x2,x3), maxX=Math.max(x1,x2,x3), minY=Math.min(y1,y2,y3), maxY=Math.max(y1,y2,y3);
      function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
      const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1;
      for (let y=minY; y<=maxY; y+=3) for (let x=minX; x<=maxX; x+=3) {
        if (x<0||y<0||x>=width||y>=height) continue;
        const w0=edge(x2,y2,x3,y3,x,y)*wsign, w1=edge(x3,y3,x1,y1,x,y)*wsign, w2=edge(x1,y1,x2,y2,x,y)*wsign;
        if (w0>=0&&w1>=0&&w2>=0) {
          const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const q=l0*q1+l1*q2+l2*q3; const invq = q!==0?1/q:0;
          const sF=(l0*s1+l1*s2+l2*s3)*invq; const tF=(l0*t1+l1*t2+l2*t3)*invq;
          const i16 = refIA8Bilinear5551(tex, tW, tH, sF, tF, sm, tm);
          const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
          const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
          const di=(y*width+x)*4; const gr=frame[di], gg=frame[di+1], gb=frame[di+2], ga=frame[di+3];
          expect([gr,gg,gb,ga]).toEqual([r,g,b,a]);
        }
      }
    }
  });

  it('IA16 and RGBA16 perspective bilinear randomized parity (light)', () => {
    const rand = lcg(0xBADC0DE);
    const width = 64, height = 48, origin = 0xE800;
    const rdram = new RDRAM(1 << 19); const bus = new Bus(rdram); const cpu = new CPU(bus); const sys = new System(cpu, bus);
    const fbBytes = width * height * 2; const base = (origin + fbBytes + 0x9000) >>> 0;
    const iaAddr = (base + 0x0000) >>> 0; const rgbaAddr = (base + 0x1000) >>> 0; const table = (base + 0x8000) >>> 0;
    const WI=8, HI=8, WR=8, HR=8;
    for (let i=0;i<WI*HI;i++){ const I=irand(rand,0,255), A=irand(rand,0,255); bus.storeU8(iaAddr+i*2,I); bus.storeU8(iaAddr+i*2+1,A); }
    const rgbaTex = new Uint16Array(WR*HR);
    for (let i=0;i<WR*HR;i++){ const p = irand(rand,0,0xFFFF); rgbaTex[i]=p; const off=i*2; bus.storeU8(rgbaAddr+off,(p>>>8)&0xff); bus.storeU8(rgbaAddr+off+1,p&0xff); }
    const frames = 6; const dls: number[] = []; let dlCur=(base+0x2000)>>>0;
    for (let f=0; f<frames; f++) {
      const sm = irand(rand,0,2) as 0|1|2; const tm = irand(rand,0,2) as 0|1|2;
      const tri = { x1: irand(rand,4,width-4), y1: irand(rand,4,height-4),
                    x2: irand(rand,4,width-4), y2: irand(rand,4,height-4),
                    x3: irand(rand,4,width-4), y3: irand(rand,4,height-4),
                    s1: frand(rand,-3,WI+3), t1: frand(rand,-3,HI+3), q1: irand(rand,0x10000,0x40000),
                    s2: frand(rand,-3,WI+3), t2: frand(rand,-3,HI+3), q2: irand(rand,0x10000,0x40000),
                    s3: frand(rand,-3,WI+3), t3: frand(rand,-3,HI+3), q3: irand(rand,0x10000,0x40000) };
      const useIA = (f%2)===0; const dl = dlCur; dlCur=(dlCur+0x300)>>>0; dls.push(dl);
      const uc: UcCmd[] = [
        { op:'SetTexAddrMode', sMode: sm===0?'CLAMP': sm===1?'WRAP':'MIRROR', tMode: tm===0?'CLAMP': tm===1?'WRAP':'MIRROR' },
        { op:'SetTexFilter', mode:'BILINEAR' },
        ...(useIA ? [
          { op:'DrawIA16TriPersp', addr:iaAddr, texW:WI, texH:HI,
            x1:tri.x1, y1:tri.y1, s1:tri.s1|0, t1:tri.t1|0, q1:tri.q1>>>0,
            x2:tri.x2, y2:tri.y2, s2:tri.s2|0, t2:tri.t2|0, q2:tri.q2>>>0,
            x3:tri.x3, y3:tri.y3, s3:tri.s3|0, t3:tri.t3|0, q3:tri.q3>>>0 },
        ] : [
          { op:'DrawRGBA16TriPersp', addr:rgbaAddr, texW:WR, texH:HR,
            x1:tri.x1, y1:tri.y1, s1:tri.s1|0, t1:tri.t1|0, q1:tri.q1>>>0,
            x2:tri.x2, y2:tri.y2, s2:tri.s2|0, t2:tri.t2|0, q2:tri.q2>>>0,
            x3:tri.x3, y3:tri.y3, s3:tri.s3|0, t3:tri.t3|0, q3:tri.q3>>>0 },
        ]),
        { op:'End' },
      ];
      writeUcAsRspdl(bus, dl, uc, 128);
    }
    for (let i=0;i<dls.length;i++) bus.storeU32(table+i*4, dls[i]!>>>0);
    const start=2, interval=3, spOffset=1; const total = start + interval * frames + 2;
    const res = scheduleRSPDLFromTableAndRun(cpu,bus,sys,origin,width,height,table,frames,start,interval,total,spOffset,128);
    const iaTex = new Uint8Array(WI*HI); for (let i=0;i<WI*HI;i++) { iaTex[i]=bus.rdram.bytes[iaAddr+i*2]??0; /* A not needed here */ }
    const framesOut = res.frames;
    for (let fi=0; fi<frames; fi++) {
      const dl = dls[fi]!; const mode=bus.loadU32(dl+4)>>>0; const sm=(mode&3) as 0|1|2; const tm=((mode>>>2)&3) as 0|1|2;
      const op3=bus.loadU32(dl+16)>>>0; const isIA16 = op3===0x48; const isRGBA16 = op3===0x4A;
      const addr=bus.loadU32(dl+20)>>>0; const tW=bus.loadU32(dl+24)>>>0; const tH=bus.loadU32(dl+28)>>>0;
      const x1=bus.loadU32(dl+32)|0, y1=bus.loadU32(dl+36)|0, s1=bus.loadU32(dl+40)|0, t1=bus.loadU32(dl+44)|0, q1=bus.loadU32(dl+48)>>>0;
      const x2=bus.loadU32(dl+52)|0, y2=bus.loadU32(dl+56)|0, s2=bus.loadU32(dl+60)|0, t2=bus.loadU32(dl+64)|0, q2=bus.loadU32(dl+68)>>>0;
      const x3=bus.loadU32(dl+72)|0, y3=bus.loadU32(dl+76)|0, s3=bus.loadU32(dl+80)|0, t3=bus.loadU32(dl+84)|0, q3=bus.loadU32(dl+88)>>>0;
      const frame = framesOut[fi]!;
      const minX=Math.min(x1,x2,x3), maxX=Math.max(x1,x2,x3), minY=Math.min(y1,y2,y3), maxY=Math.max(y1,y2,y3);
      function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
      const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1;
      for (let y=minY; y<=maxY; y+=4) for (let x=minX; x<=maxX; x+=4) {
        if (x<0||y<0||x>=width||y>=height) continue;
        const w0=edge(x2,y2,x3,y3,x,y)*wsign, w1=edge(x3,y3,x1,y1,x,y)*wsign, w2=edge(x1,y1,x2,y2,x,y)*wsign;
        if (w0>=0&&w1>=0&&w2>=0) {
          const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const q=l0*q1+l1*q2+l2*q3; const invq = q!==0?1/q:0;
          const sF=(l0*s1+l1*s2+l2*s3)*invq; const tF=(l0*t1+l1*t2+l2*t3)*invq;
          const i16 = isIA16 ? refIA16Bilinear5551(new Uint8Array(bus.rdram.bytes.buffer, addr, tW*tH*2), tW, tH, sF, tF, sm, tm)
                              : refRGBA16Bilinear5551(new Uint8Array(bus.rdram.bytes.buffer, addr, tW*tH*2), tW, tH, sF, tF, sm, tm);
          const r5=(i16>>>11)&0x1f, g5=(i16>>>6)&0x1f, b5=(i16>>>1)&0x1f, a1=i16&1;
          const r=(r5*255/31)|0, g=(g5*255/31)|0, b=(b5*255/31)|0, a=a1?255:0;
          const di=(y*width+x)*4; const gr=frame[di], gg=frame[di+1], gb=frame[di+2], ga=frame[di+3];
          expect([gr,gg,gb,ga]).toEqual([r,g,b,a]);
        }
      }
    }
  });
});

