import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleF3DEXFromTableAndRun, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { buildSM64TilesSlice } from '../src/boot/title_logo_sm64_tiles.ts';
import { crc32 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function packTexCoord(ulx: number, uly: number) { return ((ulx & 0xFFF) << 12) | (uly & 0xFFF); }

// Convert a 16x16 RGBA5551 tile to a CI8 TLUT + indices, writing both to bus at given base addresses.
function writeCI8FromRGBA(bus: Bus, tlutAddr: number, pixAddr: number, rgba: Uint16Array): number /*count*/ {
  const map = new Map<number, number>();
  let nextIdx = 1; // reserve 0 for transparent 0
  // Build TLUT mapping
  for (let i=0;i<rgba.length;i++){
    const c = rgba[i] >>> 0;
    if (c === 0) continue;
    if (!map.has(c)) { map.set(c, nextIdx++); }
  }
  const count = Math.max(1, nextIdx);
  // Write TLUT
  bus.storeU16(tlutAddr + 0, 0); // index 0 = transparent
  let ti = 1;
  for (const [color, idx] of map.entries()) {
    // Ensure indices match order
    while (ti < idx) { bus.storeU16(tlutAddr + ti*2, 0); ti++; }
    bus.storeU16(tlutAddr + idx*2, color >>> 0);
    if (idx >= 255) break;
  }
  // Write indices
  for (let i=0;i<rgba.length;i++){
    const c = rgba[i] >>> 0;
    const idx = (c === 0) ? 0 : (map.get(c) ?? 0);
    bus.storeU8(pixAddr + i, idx & 0xFF);
  }
  return count;
}

describe('f3dex_sm64_slice_e2e_parity', () => {
  it('Translator path equals typed F3D for SM64-like tile slice across two frames (no gradient)', () => {
    const width=192, height=120, origin=0xF000;
    const start=2, interval=3, frames=2, spOffset=1;
    const total = start + interval*frames + 2;

    // Translator context
    const rdramA = new RDRAM(1 << 19);
    const busA = new Bus(rdramA);
    const cpuA = new CPU(busA);
    const sysA = new System(cpuA, busA);

    const fbBytes = width*height*2;
    const baseA = (origin + fbBytes + 0x9000) >>> 0;

    const tableA = baseA >>> 0;
    const dl0 = (baseA + 0x200) >>> 0;
    const dl1 = (baseA + 0x2200) >>> 0;
    // Write pointer table
    busA.storeU32(tableA + 0, dl0>>>0);
    busA.storeU32(tableA + 4, dl1>>>0);

    // Asset region
    let assetPtrA = (baseA + 0x4000) >>> 0;

    // Build two frames of SM64-like tiles
    const slice0 = buildSM64TilesSlice(width, height, { spacing: 10, offsetX: 0 });
    const slice1 = buildSM64TilesSlice(width, height, { spacing: 10, offsetX: 1 });

    // For each frame, write per-tile TLUT/PIX and emit F3DEX DL commands to draw them with CI8
    function writeFrameDL(bus: Bus, dlAddr: number, tiles: { dstX: number; dstY: number; width: number; height: number; pixels: Uint16Array }[]): number {
      let p = dlAddr >>> 0;
      for (const t of tiles) {
        const tlutAddr = assetPtrA; assetPtrA = (assetPtrA + 0x400) >>> 0; // 1KB TLUT window
        const pixAddr = assetPtrA; assetPtrA = (assetPtrA + t.width*t.height + 0x100) >>> 0;
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
      return (p - dlAddr)>>>0;
    }

    writeFrameDL(busA, dl0, slice0);
    writeFrameDL(busA, dl1, slice1);

    const strideWords = 1024 >>> 2;
    // Run frame 0 alone for clean framebuffer, then frame 1
    const resA0 = scheduleF3DEXFromTableAndRun(cpuA, busA, sysA, origin, width, height, tableA, 1, (baseA + 0x8000)>>>0, strideWords, start, interval, start + interval*1 + 2, spOffset);
    const resA1 = scheduleF3DEXFromTableAndRun(cpuA, busA, sysA, origin, width, height, (tableA + 4)>>>0, 1, (baseA + 0xA000)>>>0, strideWords, start, interval, start + interval*1 + 2, spOffset);

    // Baseline typed F3D context
    const rdramB = new RDRAM(1 << 19);
    const busB = new Bus(rdramB);
    const cpuB = new CPU(busB);
    const sysB = new System(cpuB, busB);

    let assetPtrB = (baseA + 0xC000) >>> 0;
    function writeFrameTypedDL(bus: Bus, dlAddr: number, tiles: { dstX: number; dstY: number; width: number; height: number; pixels: Uint16Array }[]): void {
      const cmds: any[] = [];
      for (const t of tiles) {
        const tlutAddr = assetPtrB; assetPtrB = (assetPtrB + 0x400) >>> 0;
        const pixAddr = assetPtrB; assetPtrB = (assetPtrB + t.width*t.height + 0x100) >>> 0;
        const count = writeCI8FromRGBA(bus, tlutAddr, pixAddr, t.pixels);
        cmds.push({ op: 'G_SETTLUT', addr: tlutAddr>>>0, count });
        cmds.push({ op: 'G_SETCIMG', format: 'CI8' as const, addr: pixAddr>>>0, w: t.width, h: t.height });
        cmds.push({ op: 'G_SPRITE', x: t.dstX, y: t.dstY, w: t.width, h: t.height });
      }
      cmds.push({ op: 'G_END' });
      const uc = f3dToUc(cmds as any);
      writeUcAsRspdl(bus, dlAddr, uc, strideWords);
    }

    const dlB = (baseA + 0xE000) >>> 0;
    writeFrameTypedDL(busB, dlB + 0*strideWords*4, slice0);
    writeFrameTypedDL(busB, dlB + 1*strideWords*4, slice1);

    const resB0 = scheduleRSPDLFramesAndRun(cpuB, busB, sysB, origin, width, height, dlB + 0*strideWords*4, 1, start, interval, start + interval*1 + 2, spOffset, strideWords);
    const resB1 = scheduleRSPDLFramesAndRun(cpuB, busB, sysB, origin, width, height, dlB + 1*strideWords*4, 1, start, interval, start + interval*1 + 2, spOffset, strideWords);

    const hashA0 = crc32((resA0.frames[0] ?? resA0.image));
    const hashA1 = crc32((resA1.frames[0] ?? resA1.image));
    const hashB0 = crc32((resB0.frames[0] ?? resB0.image));
    const hashB1 = crc32((resB1.frames[0] ?? resB1.image));

    expect(hashA0).toBe(hashB0);
    expect(hashA1).toBe(hashB1);
  });
});
