import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

function makeCtx() {
  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  return { rdram, bus, cpu, sys };
}

function buildRingCI8(bus: Bus, tlutAddr: number, pixAddr: number, W: number, H: number, color: number) {
  for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i*2, i === 1 ? color : 0);
  const cx=W/2, cy=H/2, rO=14, rI=10;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    const dx=(x+.5)-cx, dy=(y+.5)-cy; const d2=dx*dx+dy*dy;
    const v = (d2<=rO*rO && d2>=rI*rI) ? 1 : 0;
    bus.storeU8(pixAddr + (y*W+x), v);
  }
}

function buildRingCI4(bus: Bus, tlutAddr: number, pixAddr: number, W: number, H: number, color: number) {
  for (let i = 0; i < 16; i++) bus.storeU16(tlutAddr + i*2, i === 1 ? color : 0);
  const cx=W/2, cy=H/2, rO=14, rI=10;
  const numPix = W*H; const packed = new Uint8Array(Math.ceil(numPix/2));
  for (let i=0;i<packed.length;i++) packed[i]=0;
  let idx=0;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    const dx=(x+.5)-cx, dy=(y+.5)-cy; const d2=dx*dx+dy*dy;
    const val = (d2<=rO*rO && d2>=rI*rI) ? 1 : 0;
    const b = idx>>1; if ((idx&1)===0) packed[b]|=(val&0xF)<<4; else packed[b]|=(val&0xF);
    idx++;
  }
  for (let i=0;i<packed.length;i++) bus.storeU8(pixAddr + i, packed[i]!);
}

describe('rspdl_ci4_vs_ci8_parity', () => {
  it('CI4 and CI8 rings produce the same CRCs when drawn at same coordinates', () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    const fbBytes = width*height*2;
    const base = (origin + fbBytes + 0x4000) >>> 0;

    // CI8 run in its own context
    const ctx8 = makeCtx();
    {
      const tlut8 = base;
      const pix8 = (base + 0x1000) >>> 0;
      const dl8 = (base + 0x2000) >>> 0;
      const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
      buildRingCI8(ctx8.bus, tlut8, pix8, 32, 32, GREEN);
      let addr = dl8;
      // GRADIENT
      ctx8.bus.storeU32(addr, 0x00000001); addr+=4; ctx8.bus.storeU32(addr, ((0<<11)|(0<<6)|(31<<1)|1)>>>0); addr+=4; ctx8.bus.storeU32(addr, ((0<<11)|(31<<6)|(31<<1)|1)>>>0); addr+=4;
      // SET_TLUT
      ctx8.bus.storeU32(addr, 0x00000020); addr+=4; ctx8.bus.storeU32(addr, tlut8>>>0); addr+=4; ctx8.bus.storeU32(addr, 256>>>0); addr+=4;
      // DRAW_CI8
      ctx8.bus.storeU32(addr, 0x00000021); addr+=4; ctx8.bus.storeU32(addr, 32>>>0); addr+=4; ctx8.bus.storeU32(addr, 32>>>0); addr+=4; ctx8.bus.storeU32(addr, pix8>>>0); addr+=4; ctx8.bus.storeU32(addr, 20>>>0); addr+=4; ctx8.bus.storeU32(addr, 10>>>0); addr+=4;
      // END
      ctx8.bus.storeU32(addr, 0x00000000);
    }
    const res8 = scheduleRSPDLFramesAndRun(ctx8.cpu, ctx8.bus, ctx8.sys, origin, width, height, (base + 0x2000) >>> 0, frames, start, interval, total, spOffset, 64);

    // CI4 run in its own context
    const ctx4 = makeCtx();
    {
      const base4 = (base + 0x8000) >>> 0;
      const tlut4 = base4;
      const pix4 = (base4 + 0x1000) >>> 0;
      const dl4 = (base4 + 0x2000) >>> 0;
      const GREEN = ((0<<11)|(31<<6)|(0<<1)|1) >>> 0;
      buildRingCI4(ctx4.bus, tlut4, pix4, 32, 32, GREEN);
      let addr = dl4;
      // GRADIENT
      ctx4.bus.storeU32(addr, 0x00000001); addr+=4; ctx4.bus.storeU32(addr, ((0<<11)|(0<<6)|(31<<1)|1)>>>0); addr+=4; ctx4.bus.storeU32(addr, ((0<<11)|(31<<6)|(31<<1)|1)>>>0); addr+=4;
      // SET_TLUT
      ctx4.bus.storeU32(addr, 0x00000020); addr+=4; ctx4.bus.storeU32(addr, tlut4>>>0); addr+=4; ctx4.bus.storeU32(addr, 16>>>0); addr+=4;
      // DRAW_CI4
      ctx4.bus.storeU32(addr, 0x00000022); addr+=4; ctx4.bus.storeU32(addr, 32>>>0); addr+=4; ctx4.bus.storeU32(addr, 32>>>0); addr+=4; ctx4.bus.storeU32(addr, pix4>>>0); addr+=4; ctx4.bus.storeU32(addr, 20>>>0); addr+=4; ctx4.bus.storeU32(addr, 10>>>0); addr+=4;
      // END
      ctx4.bus.storeU32(addr, 0x00000000);
    }
    const res4 = scheduleRSPDLFramesAndRun(ctx4.cpu, ctx4.bus, ctx4.sys, origin, width, height, (base + 0x2000 + 0x8000) >>> 0, frames, start, interval, total, spOffset, 64);

    const crc8 = res8.frames.map(crc32);
    const crc4 = res4.frames.map(crc32);
    expect(crc4).toEqual(crc8);
  });
});

