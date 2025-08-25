import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleF3DEXFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { buildSM64TilesSlice } from '../src/boot/title_logo_sm64_tiles.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

// Convert a RGBA5551 tile to CI8 TLUT+indices directly into RDRAM, returning palette count.
function writeCI8FromRGBA(bus: Bus, tlutAddr: number, pixAddr: number, rgba: Uint16Array): number {
  const map = new Map<number, number>();
  let nextIdx = 1; // 0 reserved for transparent
  for (let i = 0; i < rgba.length; i++) {
    const c = rgba[i] >>> 0;
    if (c === 0) continue;
    if (!map.has(c)) map.set(c, nextIdx++);
  }
  const count = Math.max(1, nextIdx);
  bus.storeU16(tlutAddr + 0, 0);
  let ti = 1;
  for (const [color, idx] of map.entries()) {
    while (ti < idx) { bus.storeU16(tlutAddr + ti*2, 0); ti++; }
    bus.storeU16(tlutAddr + idx*2, color >>> 0);
    if (idx >= 255) break;
  }
  for (let i = 0; i < rgba.length; i++) {
    const c = rgba[i] >>> 0;
    const idx = (c === 0) ? 0 : (map.get(c) ?? 0);
    bus.storeU8(pixAddr + i, idx & 0xFF);
  }
  return count;
}

describe('f3dex_sm64_slice_golden', () => {
  it('F3DEX translated SM64 tile slice matches known goldens per frame', () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;
    const fbBytes = width*height*2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const base = (origin + fbBytes + 0xB000) >>> 0;
    const tableBase = base >>> 0;
    const dl0 = (base + 0x200) >>> 0;
    const dl1 = (base + 0x2200) >>> 0;
    bus.storeU32(tableBase + 0, dl0>>>0);
    bus.storeU32(tableBase + 4, dl1>>>0);

    let assetPtr = (base + 0x4000) >>> 0;

    const slice0 = buildSM64TilesSlice(width, height, { spacing: 10, offsetX: 0 });
    const slice1 = buildSM64TilesSlice(width, height, { spacing: 10, offsetX: 1 });

    function writeFrameDL(dlAddr: number, tiles: { dstX: number; dstY: number; width: number; height: number; pixels: Uint16Array }[]): void {
      let p = dlAddr >>> 0;
      for (const t of tiles) {
        const tlutAddr = assetPtr; assetPtr = (assetPtr + 0x400) >>> 0;
        const pixAddr = assetPtr; assetPtr = (assetPtr + t.width*t.height + 0x100) >>> 0;
        const count = writeCI8FromRGBA(bus, tlutAddr, pixAddr, t.pixels);
        // G_SETTIMG CI8
        const opSETTIMG = 0xFD << 24; const sizCI8 = 1 << 19; bus.storeU32(p, (opSETTIMG|sizCI8)>>>0); p+=4; bus.storeU32(p, pixAddr>>>0); p+=4;
        // G_LOADTLUT count
        const opLOADTLUT = 0xF0 << 24; bus.storeU32(p, (opLOADTLUT | (count & 0xFFFF))>>>0); p+=4; bus.storeU32(p, tlutAddr>>>0); p+=4;
        // G_SETTILESIZE tile dims
        const opSETTILESIZE = 0xF2 << 24; bus.storeU32(p, (opSETTILESIZE | packTexCoord(fp(0), fp(0)))>>>0); p+=4; bus.storeU32(p, packTexCoord(fp(t.width-1), fp(t.height-1))>>>0); p+=4;
        // G_TEXRECT at dstX/Y
        const opTEXRECT = 0xE4 << 24; const ulx = fp(t.dstX), uly = fp(t.dstY), lrx = fp(t.dstX + t.width), lry = fp(t.dstY + t.height);
        bus.storeU32(p, (opTEXRECT | packTexCoord(ulx, uly))>>>0); p+=4; bus.storeU32(p, packTexCoord(lrx, lry)>>>0); p+=4;
      }
      // END
      bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
    }

    writeFrameDL(dl0, slice0);
    writeFrameDL(dl1, slice1);

    const strideWords = 128;
    const BLUE = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const CYAN = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;

    const res = scheduleF3DEXFromTableAndRun(
      cpu, bus, sys,
      origin, width, height,
      tableBase, frames,
      (base + 0x8000)>>>0, strideWords,
      start, interval, total, spOffset,
      BLUE, CYAN,
    );

    const hashes = res.frames.map(crc32);
    expect(hashes).toEqual(['6ca0bc0e','db86e0b3']);
  });
});

