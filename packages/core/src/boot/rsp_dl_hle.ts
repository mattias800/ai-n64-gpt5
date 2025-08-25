import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';
import { viDrawHorizontalGradient, viComposeTiles } from '../system/video_hle.js';
import { viScanout } from '../system/video.js';
import { runFrameLoop } from '../system/frame_loop.js';
import { buildSM64TilesSlice } from './title_logo_sm64_tiles.js';
import { decodeCI8ToRGBA5551, decodeCI4ToRGBA5551 } from '../gfx/n64_textures.js';
import { bilinearNeighbors, nearestIndex } from '../gfx/texture_sampling.js';
import type { TitleLoopResult } from './title_dp_driven.js';
import { translateF3DEXToUc } from './f3dex_translator.js';
import { ucToRspdlWords } from './ucode_translator.js';

// Simple RSP-HLE DL opcodes (32-bit words):
//   0x00000000: END
//   0x00000001: GRADIENT; next 2 words: bgStart5551, bgEnd5551
//   0x00000010: SM64_SLICE; next 2 words: spacing, offsetX
// Each frame gets its own small DL at base + i*stride.

export function writeRSPTitleDLsToRDRAM(
  bus: Bus,
  baseAddr: number,
  frames: number,
  spacing: number,
  bgStart5551: number,
  bgEnd5551: number,
  strideWords: number = 16,
): number {
  const stride = (strideWords >>> 0) * 4;
  for (let i = 0; i < frames; i++) {
    let addr = (baseAddr + i * stride) >>> 0;
    // GRADIENT
    bus.storeU32(addr, 0x00000001); addr = (addr + 4) >>> 0;
    bus.storeU32(addr, bgStart5551 >>> 0); addr = (addr + 4) >>> 0;
    bus.storeU32(addr, bgEnd5551 >>> 0); addr = (addr + 4) >>> 0;
    // SM64_SLICE with spacing and per-frame offsetX
    bus.storeU32(addr, 0x00000010); addr = (addr + 4) >>> 0;
    bus.storeU32(addr, spacing >>> 0); addr = (addr + 4) >>> 0;
    bus.storeU32(addr, i | 0); addr = (addr + 4) >>> 0;
    // END
    bus.storeU32(addr, 0x00000000);
  }
  return baseAddr >>> 0;
}

function execRSPDLFrame(bus: Bus, width: number, height: number, dlAddr: number, maxWords: number): void {
  let addr = dlAddr >>> 0;
  let wordsLeft = maxWords >>> 0;
  let currentTLUT: Uint16Array | null = null;
  let currentCI4Palette = 0 >>> 0;
  let primColor = 0 >>> 0;
  let envColor = 0 >>> 0;
  let combineMode: 0 | 1 | 2 = 0; // 0=TEXEL0, 1=PRIM, 2=ENV
  // Texture address modes for s/t: 0=CLAMP,1=WRAP,2=MIRROR
  let texSMode: 0 | 1 | 2 = 0;
  let texTMode: 0 | 1 | 2 = 0;
  // 0=NEAREST, 1=BILINEAR
  let texFilter: 0 | 1 = 0;
  // Blending state: 0=OFF, 1=AVERAGE_50, 2=SRC_OVER_ALPHA_1BIT
  let blendMode: 0 | 1 | 2 = 0;
  // Z-buffer state
  let zEnable: 0 | 1 = 0;
  let zAddr = 0 >>> 0;
  let zWidth = 0 >>> 0;
  let zHeight = 0 >>> 0;
  // Scissor rectangle (inclusive x0,y0 to exclusive x1,y1)
  let scX0 = 0, scY0 = 0, scX1 = width|0, scY1 = height|0;
  const bytes = bus.rdram.bytes;
  function readU16BE(p: number): number {
    const hi = bytes[p] ?? 0; const lo = bytes[p+1] ?? 0; return ((hi << 8) | lo) >>> 0;
  }
  function writeU16BE(p: number, v: number): void {
    bytes[p] = (v >>> 8) & 0xff; bytes[p + 1] = v & 0xff;
  }
  function blendOver5551(dst: number, src: number): number {
    const sr = (src >>> 11) & 0x1f, sg = (src >>> 6) & 0x1f, sb = (src >>> 1) & 0x1f, sa = src & 1;
    const dr = (dst >>> 11) & 0x1f, dg = (dst >>> 6) & 0x1f, db = (dst >>> 1) & 0x1f, da = dst & 1;
    const r = (sr + dr) >> 1; const g = (sg + dg) >> 1; const b = (sb + db) >> 1; const a = sa | da;
    return (((r & 0x1f) << 11) | ((g & 0x1f) << 6) | ((b & 0x1f) << 1) | (a & 1)) >>> 0;
  }
  function applyBlend(dst: number, src: number): number {
    if (blendMode === 1) return blendOver5551(dst, src);
    if (blendMode === 2) return (src & 1) !== 0 ? (src >>> 0) : (dst >>> 0);
    return src >>> 0;
  }
  while (wordsLeft > 0) {
    const op = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft--;
    switch (op >>> 0) {
      case 0x00000000: // END
        return;
      case 0x00000001: { // GRADIENT
        if (wordsLeft < 2) return;
        const bgStart = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const bgEnd = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 2;
        viDrawHorizontalGradient(bus, width, height, bgStart, bgEnd);
        break;
      }
      case 0x00000010: { // SM64_SLICE
        if (wordsLeft < 2) return;
        const spacing = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const offsetX = (bus.loadU32(addr) | 0); addr = (addr + 4) >>> 0;
        wordsLeft -= 2;
        const tiles = buildSM64TilesSlice(width, height, { spacing, offsetX });
        viComposeTiles(bus, width, height, tiles);
        break;
      }
      case 0x00000020: { // SET_TLUT: next 2 words: addr, count (entries)
        if (wordsLeft < 2) return;
        const tlutAddr = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const count = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 2;
        const n = Math.min(count | 0, 256);
        const out = new Uint16Array(256);
        for (let i = 0; i < n; i++) {
          out[i] = readU16BE(tlutAddr + i * 2) >>> 0;
        }
        currentTLUT = out;
        break;
      }
      case 0x00000021: { // DRAW_CI8: next 5 words: w, h, addr, x, y
        if (wordsLeft < 5) return;
        const w = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const h = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const pixAddr = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const x = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 5;
        const tlut = currentTLUT; if (!tlut) break;
        if (combineMode === 1 /*PRIM*/ || combineMode === 2 /*ENV*/) {
          // Fill solid rectangle with prim/env color
          const color = (combineMode === 1 ? primColor : envColor) >>> 0;
          const tile = { dstX: x, dstY: y, width: w, height: h, pixels: new Uint16Array(w * h) } as any;
          for (let i = 0; i < w * h; i++) tile.pixels[i] = color;
          viComposeTiles(bus as any, width, height, [tile]);
        } else {
          const idx = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) idx[i] = bytes[pixAddr + i] ?? 0;
          const rgba = decodeCI8ToRGBA5551(idx, tlut, w, h);
          const tile = { dstX: x, dstY: y, width: w, height: h, pixels: rgba } as any;
          viComposeTiles(bus as any, width, height, [tile]);
        }
        break;
      }
      case 0x00000022: { // DRAW_CI4: next 5 words: w, h, addr, x, y (nibble-packed); uses currentCI4Palette
        if (wordsLeft < 5) return;
        const w = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const h = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const pixAddr = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const x = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 5;
        const tlut = currentTLUT; if (!tlut) break;
        if (combineMode === 1 /*PRIM*/ || combineMode === 2 /*ENV*/) {
          const color = (combineMode === 1 ? primColor : envColor) >>> 0;
          const tile = { dstX: x, dstY: y, width: w, height: h, pixels: new Uint16Array(w * h) } as any;
          for (let i = 0; i < w * h; i++) tile.pixels[i] = color;
          viComposeTiles(bus as any, width, height, [tile]);
        } else {
          const numPix = w * h;
          const packed = new Uint8Array(Math.ceil(numPix / 2));
          for (let i = 0; i < packed.length; i++) packed[i] = bytes[pixAddr + i] ?? 0;
          if (currentCI4Palette >>> 0) {
            const offset = (currentCI4Palette & 0xF) * 16;
            for (let i = 0; i < packed.length; i++) {
              const byte = packed[i] >>> 0;
              const hi = (byte >>> 4) & 0xF; const lo = byte & 0xF;
              const hi2 = ((hi + offset) & 0xFF) >>> 0;
              const lo2 = ((lo + offset) & 0xFF) >>> 0;
              packed[i] = ((hi2 << 4) | lo2) & 0xFF;
            }
          }
          const rgba = decodeCI4ToRGBA5551(packed, tlut, w, h);
          const tile = { dstX: x, dstY: y, width: w, height: h, pixels: rgba } as any;
          viComposeTiles(bus as any, width, height, [tile]);
        }
        break;
      }
      case 0x00000023: { // SET_CI4_PALETTE: next 1 word: palette index 0..15
        if (wordsLeft < 1) return;
        currentCI4Palette = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        break;
      }
      case 0x00000024: { // SET_TEX_ADDR_MODE: next 1 word: bits [1:0]=S, [3:2]=T (0=CLAMP,1=WRAP,2=MIRROR)
        if (wordsLeft < 1) return;
        const mode = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        texSMode = (mode & 0x3) as 0|1|2;
        texTMode = ((mode >>> 2) & 0x3) as 0|1|2;
        break;
      }
      case 0x00000025: { // SET_TEX_FILTER: next 1 word: 0=NEAREST,1=BILINEAR
        if (wordsLeft < 1) return;
        const m = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        texFilter = (m & 1) as 0|1;
        break;
      }
      case 0x00000026: { // SET_BLEND (legacy): next 1 word: 0=disable,1=enable
        if (wordsLeft < 1) return;
        const m = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        blendMode = ((m & 1) ? 1 : 0) as 0|1|2; // map to AVERAGE_50
        break;
      }
      case 0x00000027: { // SET_BLEND_MODE: next 1 word: 0=OFF,1=AVERAGE_50,2=SRC_OVER_ALPHA_1BIT
        if (wordsLeft < 1) return;
        const m = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        blendMode = (m === 2 ? 2 : m === 1 ? 1 : 0) as 0|1|2;
        break;
      }
      case 0x00000028: { // SET_SCISSOR: next 4 words: x0,y0,x1,y1 (inclusive x0,y0; exclusive x1,y1)
        if (wordsLeft < 4) return;
        scX0 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        scY0 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        scX1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        scY1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        wordsLeft -= 4;
        // Clamp to framebuffer bounds
        scX0 = Math.max(0, Math.min(scX0, width));
        scY0 = Math.max(0, Math.min(scY0, height));
        scX1 = Math.max(scX0, Math.min(scX1, width));
        scY1 = Math.max(scY0, Math.min(scY1, height));
        break;
      }
      case 0x00000030: { // SET_PRIM_COLOR: next 1 word: RGBA5551
        if (wordsLeft < 1) return;
        primColor = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        break;
      }
      case 0x00000031: { // SET_ENV_COLOR: next 1 word: RGBA5551
        if (wordsLeft < 1) return;
        envColor = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        break;
      }
      case 0x00000032: { // SET_COMBINE: next 1 word: mode (0=TEXEL0,1=PRIM,2=ENV)
        if (wordsLeft < 1) return;
        const m = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        combineMode = (m === 1 ? 1 : m === 2 ? 2 : 0);
        break;
      }
      case 0x00000040: { // DRAW_PRIM_TRI: next 6 words: x1,y1,x2,y2,x3,y3
        if (wordsLeft < 6) return;
        const x1 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y1 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const x2 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y2 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const x3 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y3 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 6;
        const color = (combineMode === 2 /*ENV*/ ? envColor : primColor) >>> 0;
        // Simple filled triangle via bounding box scan with area test
        const minX = Math.max(0, Math.min(x1, x2, x3));
        const maxX = Math.min(width - 1, Math.max(x1, x2, x3));
        const minY = Math.max(0, Math.min(y1, y2, y3));
        const maxY = Math.min(height - 1, Math.max(y1, y2, y3));
        const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
        const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
        function edge(ax:number, ay:number, bx:number, by:number, px:number, py:number){ return (px - ax)*(by - ay) - (py - ay)*(bx - ax); }
        const area = edge(x1,y1,x2,y2,x3,y3);
        const wsign = area >= 0 ? 1 : -1;
        const ram = bus.rdram.bytes;
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const w0 = edge(x2,y2,x3,y3,x,y) * wsign;
            const w1 = edge(x3,y3,x1,y1,x,y) * wsign;
            const w2 = edge(x1,y1,x2,y2,x,y) * wsign;
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                const addrPix = origin + (y * stride + x) * 2;
                if (x < scX0 || x >= scX1 || y < scY0 || y >= scY1) { /* clipped */ }
                else if (addrPix + 1 < ram.length) {
                  let out = color >>> 0;
                  if (blendMode !== 0) { const dst = (((ram[addrPix] ?? 0) << 8) | (ram[addrPix+1] ?? 0)) >>> 0; out = applyBlend(dst, out); }
                  ram[addrPix] = (out >>> 8) & 0xff; ram[addrPix + 1] = out & 0xff;
                }
              }
          }
        }
        break;
      }
      case 0x00000041: { // DRAW_CI8_TRI
        if (wordsLeft < 16) return;
        const texAddr = bus.loadU32(addr) >>> 0; addr=(addr+4)>>>0;
        const texW = bus.loadU32(addr) >>> 0; addr=(addr+4)>>>0;
        const texH = bus.loadU32(addr) >>> 0; addr=(addr+4)>>>0;
        const x1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const y1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const s1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const t1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        const x2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const y2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const s2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const t2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        const x3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const y3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const s3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const t3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        wordsLeft -= 16;
        const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
        const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
        const ram = bus.rdram.bytes;
        function edge(ax:number, ay:number, bx:number, by:number, px:number, py:number){ return (px - ax)*(by - ay) - (py - ay)*(bx - ax); }
        const area = edge(x1,y1,x2,y2,x3,y3);
        const wsign = area >= 0 ? 1 : -1;
        const minX = Math.max(0, Math.min(x1, x2, x3));
        const maxX = Math.min(width - 1, Math.max(x1, x2, x3));
        const minY = Math.max(0, Math.min(y1, y2, y3));
        const maxY = Math.min(height - 1, Math.max(y1, y2, y3));
        if (combineMode === 1 || combineMode === 2) {
          const solid = (combineMode === 1 ? primColor : envColor) >>> 0;
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              const w0 = edge(x2,y2,x3,y3,x,y) * wsign;
              const w1 = edge(x3,y3,x1,y1,x,y) * wsign;
              const w2 = edge(x1,y1,x2,y2,x,y) * wsign;
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                const addrPix = origin + (y * stride + x) * 2;
                if (x < scX0 || x >= scX1 || y < scY0 || y >= scY1) { /* clipped */ }
                else if (addrPix + 1 < ram.length) { ram[addrPix] = (solid >>> 8) & 0xff; ram[addrPix + 1] = solid & 0xff; }
              }
            }
          }
        } else {
          const tlut = currentTLUT; if (!tlut) break;
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              const w0 = edge(x2,y2,x3,y3,x,y) * wsign;
              const w1 = edge(x3,y3,x1,y1,x,y) * wsign;
              const w2 = edge(x1,y1,x2,y2,x,y) * wsign;
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                const a = Math.abs(area) || 1;
                const l0 = w0 / a, l1 = w1 / a, l2 = w2 / a;
                const s = l0*s1 + l1*s2 + l2*s3;
                const t = l0*t1 + l1*t2 + l2*t3;
                function addrModeF(coord: number, size: number, mode: 0|1|2): number {
                  if (mode === 1) { const m = coord % size; return m < 0 ? m + size : m; }
                  else if (mode === 2) { const period = size * 2; let k = coord % period; if (k < 0) k += period; return k < size ? k : (period - 1 - k); }
                  else { return coord < 0 ? 0 : coord >= size ? size - 1 : coord; }
                }
                let outColor: number | null = null;
                let idx: number | null = null;
                if (texFilter === 1) {
                  const nb = bilinearNeighbors(s, t, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  const i00 = ram[texAddr + (t0i*texW + s0i)] ?? 0;
                  const i10 = ram[texAddr + (t0i*texW + s1i)] ?? 0;
                  const i01 = ram[texAddr + (t1i*texW + s0i)] ?? 0;
                  const i11 = ram[texAddr + (t1i*texW + s1i)] ?? 0;
                  const c00 = tlut[i00]>>>0, c10 = tlut[i10]>>>0, c01 = tlut[i01]>>>0, c11 = tlut[i11]>>>0;
                  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                  const r0=r00 + (r10 - r00) * a; const r1=r01 + (r11 - r01) * a; const r=Math.round(r0 + (r1 - r0) * b) & 0x1f;
                  const g0=g00 + (g10 - g00) * a; const g1=g01 + (g11 - g01) * a; const g=Math.round(g0 + (g1 - g0) * b) & 0x1f;
                  const b0=b00 + (b10 - b00) * a; const b1=b01 + (b11 - b01) * a; const bb=Math.round(b0 + (b1 - b0) * b) & 0x1f;
                  const a0v=a00 + (a10 - a00) * a; const a1v=a01 + (a11 - a01) * a; const av=(Math.round(a0v + (a1v - a0v) * b) & 0x1);
                  outColor = (((r & 0x1f) << 11) | ((g & 0x1f) << 6) | ((bb & 0x1f) << 1) | av) >>> 0;
                } else {
                  const ss = nearestIndex(s, texW, texSMode);
                  const tt = nearestIndex(t, texH, texTMode);
                  idx = (ram[texAddr + (tt*texW + ss)] ?? 0) >>> 0;
                }
                const color = outColor !== null ? (outColor >>> 0) : tlut[idx!] >>> 0;
                if ((color & 1) !== 0) {
                  const addrPix = origin + (y * stride + x) * 2;
                  if (x < scX0 || x >= scX1 || y < scY0 || y >= scY1) { /* clipped */ }
                  else if (addrPix + 1 < ram.length) {
                    let out = color >>> 0;
                    if (blendMode !== 0) { const dst = (((ram[addrPix] ?? 0) << 8) | (ram[addrPix+1] ?? 0)) >>> 0; out = applyBlend(dst, out); }
                    ram[addrPix] = (out >>> 8) & 0xff; ram[addrPix + 1] = out & 0xff;
                  }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000042: { // DRAW_CI4_TRI
        if (wordsLeft < 16) return;
        const texAddr = bus.loadU32(addr) >>> 0; addr=(addr+4)>>>0;
        const texW = bus.loadU32(addr) >>> 0; addr=(addr+4)>>>0;
        const texH = bus.loadU32(addr) >>> 0; addr=(addr+4)>>>0;
        const x1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const y1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const s1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const t1 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        const x2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const y2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const s2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const t2 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        const x3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const y3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const s3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0; const t3 = bus.loadU32(addr)|0; addr=(addr+4)>>>0;
        wordsLeft -= 16;
        const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
        const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
        const ram = bus.rdram.bytes;
        function edge(ax:number, ay:number, bx:number, by:number, px:number, py:number){ return (px - ax)*(by - ay) - (py - ay)*(bx - ax); }
        const area = edge(x1,y1,x2,y2,x3,y3);
        const wsign = area >= 0 ? 1 : -1;
        const minX = Math.max(0, Math.min(x1, x2, x3));
        const maxX = Math.min(width - 1, Math.max(x1, x2, x3));
        const minY = Math.max(0, Math.min(y1, y2, y3));
        const maxY = Math.min(height - 1, Math.max(y1, y2, y3));
        if (combineMode === 1 || combineMode === 2) {
          const solid = (combineMode === 1 ? primColor : envColor) >>> 0;
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              const w0 = edge(x2,y2,x3,y3,x,y) * wsign;
              const w1 = edge(x3,y3,x1,y1,x,y) * wsign;
              const w2 = edge(x1,y1,x2,y2,x,y) * wsign;
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                const addrPix = origin + (y * stride + x) * 2;
                if (x < scX0 || x >= scX1 || y < scY0 || y >= scY1) { /* clipped */ }
                else if (addrPix + 1 < ram.length) { ram[addrPix] = (solid >>> 8) & 0xff; ram[addrPix + 1] = solid & 0xff; }
              }
            }
          }
        } else {
          const tlut = currentTLUT; if (!tlut) break;
          function sampleCI4(addrBase: number, w: number, s: number, t: number): number {
            const index = t * w + s;
            const byte = ram[addrBase + (index >> 1)] ?? 0;
            const hi = (byte >>> 4) & 0xF; const lo = byte & 0xF;
            return (index & 1) === 0 ? hi : lo;
          }
          function addrMode(coord: number, size: number, mode: 0|1|2): number {
            if (mode === 1) { const m = ((coord % size) + size) % size; return m; }
            else if (mode === 2) { const period = size * 2; const k = ((coord % period) + period) % period; return k < size ? k : (period - 1 - k); }
            else { return coord < 0 ? 0 : coord >= size ? size - 1 : coord; }
          }
          const paletteOffset = ((currentCI4Palette & 0xF) * 16) >>> 0;
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              const w0 = edge(x2,y2,x3,y3,x,y) * wsign;
              const w1 = edge(x3,y3,x1,y1,x,y) * wsign;
              const w2 = edge(x1,y1,x2,y2,x,y) * wsign;
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                const a = Math.abs(area) || 1;
                const l0 = w0 / a, l1 = w1 / a, l2 = w2 / a;
                const sF = l0*s1 + l1*s2 + l2*s3;
                const tF = l0*t1 + l1*t2 + l2*t3;
                let color: number;
                if (texFilter === 1) {
                  const nb = bilinearNeighbors(sF, tF, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a: aW, b: bW } = nb;
                  const i00 = sampleCI4(texAddr, texW, s0i, t0i) + paletteOffset;
                  const i10 = sampleCI4(texAddr, texW, s1i, t0i) + paletteOffset;
                  const i01 = sampleCI4(texAddr, texW, s0i, t1i) + paletteOffset;
                  const i11 = sampleCI4(texAddr, texW, s1i, t1i) + paletteOffset;
                  const c00 = tlut[i00 & 0xFF]>>>0, c10 = tlut[i10 & 0xFF]>>>0, c01 = tlut[i01 & 0xFF]>>>0, c11 = tlut[i11 & 0xFF]>>>0;
                  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                  const r0=r00+(r10-r00)*aW; const r1=r01+(r11-r01)*aW; const r=Math.round(r0+(r1-r0)*bW)&0x1f;
                  const g0=g00+(g10-g00)*aW; const g1=g01+(g11-g01)*aW; const g=Math.round(g0+(g1-g0)*bW)&0x1f;
                  const b0=b00+(b10-b00)*aW; const b1=b01+(b11-b01)*aW; const bb=Math.round(b0+(b1-b0)*bW)&0x1f;
                  const a0v=a00+(a10-a00)*aW; const a1v=a01+(a11-a01)*aW; const av=(Math.round(a0v+(a1v-a0v)*bW)&1);
                  color = (((r & 0x1f) << 11) | ((g & 0x1f) << 6) | ((bb & 0x1f) << 1) | av) >>> 0;
                } else {
                  const ss = nearestIndex(sF, texW, texSMode);
                  const tt = nearestIndex(tF, texH, texTMode);
                  const idx4 = sampleCI4(texAddr, texW, ss, tt) + paletteOffset;
                  color = tlut[idx4 & 0xFF] >>> 0;
                }
                if ((color & 1) !== 0) {
                  const addrPix = origin + (y * stride + x) * 2;
                  if (x < scX0 || x >= scX1 || y < scY0 || y >= scY1) { /* clipped */ }
                  else if (addrPix + 1 < ram.length) {
                    let out = color >>> 0;
                    if (blendMode !== 0) { const dst = (((ram[addrPix] ?? 0) << 8) | (ram[addrPix+1] ?? 0)) >>> 0; out = applyBlend(dst, out); }
                    ram[addrPix] = (out >>> 8) & 0xff; ram[addrPix + 1] = out & 0xff;
                  }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000043: { // DRAW_CI8_TRI_PERSPECTIVE
        if (wordsLeft < 19) return;
        const texAddr = bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const q1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const q2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const q3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft -= 19;
        const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF)>>>0; const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF)>>>0; const ram = bus.rdram.bytes;
        function edge(ax:number, ay:number, bx:number, by:number, px:number, py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area = edge(x1,y1,x2,y2,x3,y3); const wsign = area>=0?1:-1; const aabs=Math.abs(area)||1;
        const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3));
        const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){
          const solid=(combineMode===1?primColor:envColor)>>>0;
          for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } }
        } else {
          const tlut=currentTLUT; if(!tlut) break;
          function addrMode(coord:number,size:number,mode:0|1|2){ if(mode===1){ const m=((coord%size)+size)%size; return m; } else if(mode===2){ const period=size*2; const k=((coord%period)+period)%period; return k<size? k:(period-1-k);} else { return coord<0?0:coord>=size?size-1:coord; } }
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs;
                const q = l0*q1 + l1*q2 + l2*q3; const invq = q!==0? (1.0/q): 0.0;
                const sf = (l0*s1 + l1*s2 + l2*s3) * invq;
                const tf = (l0*t1 + l1*t2 + l2*t3) * invq;
                let outColor: number | null = null;
                let idx: number | null = null;
                if (texFilter === 1) {
                  const nb = bilinearNeighbors(sf, tf, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  const i00 = ram[texAddr + (t0i*texW + s0i)] ?? 0; const i10 = ram[texAddr + (t0i*texW + s1i)] ?? 0; const i01 = ram[texAddr + (t1i*texW + s0i)] ?? 0; const i11 = ram[texAddr + (t1i*texW + s1i)] ?? 0;
                  const c00=tlut[i00]>>>0, c10=tlut[i10]>>>0, c01=tlut[i01]>>>0, c11=tlut[i11]>>>0;
                  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                  const r0=r00+(r10-r00)*a; const r1=r01+(r11-r01)*a; const r=Math.round(r0+(r1-r0)*b)&0x1f;
                  const g0=g00+(g10-g00)*a; const g1=g01+(g11-g01)*a; const g=Math.round(g0+(g1-g0)*b)&0x1f;
                  const b0=b00+(b10-b00)*a; const b1=b01+(b11-b01)*a; const bb=Math.round(b0+(b1-b0)*b)&0x1f;
                  const a0v=a00+(a10-a00)*a; const a1v=a01+(a11-a01)*a; const av=(Math.round(a0v+(a1v-a0v)*b)&0x1);
                  outColor = (((r & 0x1f) << 11) | ((g & 0x1f) << 6) | ((bb & 0x1f) << 1) | av) >>> 0;
                } else {
                  const ss = nearestIndex(sf, texW, texSMode);
                  const tt = nearestIndex(tf, texH, texTMode);
                  idx = (ram[texAddr + (tt*texW + ss)] ?? 0) >>> 0;
                }
                const color = outColor !== null ? (outColor >>> 0) : tlut[idx!]>>>0;
                if((color&1)!==0){ const p=origin+(y*stride+x)*2; if (x < scX0 || x >= scX1 || y < scY0 || y >= scY1) { /* clipped */ } else if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
              }
            }
          }
        }
        break;
      }
      case 0x00000044: { // DRAW_CI4_TRI_PERSPECTIVE
        if (wordsLeft < 19) return;
        const texAddr = bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const q1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const q2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const q3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft -= 19;
        const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF)>>>0; const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF)>>>0; const ram = bus.rdram.bytes;
        function edge(ax:number, ay:number, bx:number, by:number, px:number, py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area = edge(x1,y1,x2,y2,x3,y3); const wsign = area>=0?1:-1; const aabs=Math.abs(area)||1;
        const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3));
        const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){
          const solid=(combineMode===1?primColor:envColor)>>>0;
          for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } }
        } else {
          const tlut=currentTLUT; if(!tlut) break;
          function addrMode(coord:number,size:number,mode:0|1|2){ if(mode===1){ const m=((coord%size)+size)%size; return m; } else if(mode===2){ const period=size*2; const k=((coord%period)+period)%period; return k<size? k:(period-1-k);} else { return coord<0?0:coord>=size?size-1:coord; } }
          function sampleCI4(addrBase:number,w:number,s:number,t:number){ const index=t*w+s; const byte=ram[addrBase+(index>>1)]??0; const hi=(byte>>>4)&0xF; const lo=byte&0xF; return (index&1)===0?hi:lo; }
          const paletteOffset=((currentCI4Palette&0xF)*16)>>>0;
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs;
                const q = l0*q1 + l1*q2 + l2*q3; const invq = q!==0? (1.0/q): 0.0;
                const sF = (l0*s1 + l1*s2 + l2*s3) * invq;
                const tF = (l0*t1 + l1*t2 + l2*t3) * invq;
                let color: number;
                if (texFilter === 1) {
                  const nb = bilinearNeighbors(sF, tF, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  const i00 = sampleCI4(texAddr, texW, s0i, t0i) + paletteOffset;
                  const i10 = sampleCI4(texAddr, texW, s1i, t0i) + paletteOffset;
                  const i01 = sampleCI4(texAddr, texW, s0i, t1i) + paletteOffset;
                  const i11 = sampleCI4(texAddr, texW, s1i, t1i) + paletteOffset;
                  const c00=tlut[i00&0xFF]>>>0, c10=tlut[i10&0xFF]>>>0, c01=tlut[i01&0xFF]>>>0, c11=tlut[i11&0xFF]>>>0;
                  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                  const r0=r00+(r10-r00)*a; const r1=r01+(r11-r01)*a; const r=Math.round(r0+(r1-r0)*b)&0x1f;
                  const g0=g00+(g10-g00)*a; const g1=g01+(g11-g01)*a; const g=Math.round(g0+(g1-g0)*b)&0x1f;
                  const b0=b00+(b10-b00)*a; const b1=b01+(b11-b01)*a; const bb=Math.round(b0+(b1-b0)*b)&0x1f;
                  const a0v=a00+(a10-a00)*a; const a1v=a01+(a11-a01)*a; const av=(Math.round(a0v+(a1v-a0v)*b)&1);
                  color = (((r & 0x1f) << 11) | ((g & 0x1f) << 6) | ((bb & 0x1f) << 1) | av) >>> 0;
                } else {
                  const ss = nearestIndex(sF, texW, texSMode);
                  const tt = nearestIndex(tF, texH, texTMode);
                  const idx4 = sampleCI4(texAddr,texW,ss,tt)+paletteOffset; color = tlut[idx4&0xFF]>>>0;
                }
                if((color&1)!==0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
              }
            }
          }
        }
        break;
      }
      case 0x00000045: { // DRAW_IA8_TRI
        if (wordsLeft < 16) return;
        const texAddr = bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4;
        wordsLeft -= 16;
        const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3)); const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){ const solid=(combineMode===1?primColor:envColor)>>>0; for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } } }
        else {
          function to5(i:number,from:number){ const max=(1<<from)-1; return Math.round((i/max)*31)&0x1f; }
          const aabs=Math.abs(area)||1;
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const s=l0*s1+l1*s2+l2*s3; const t=l0*t1+l1*t2+l2*t3;
                if (texFilter===1){
                  const nb = bilinearNeighbors(s, t, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  const b00=ram[texAddr+(t0i*texW+s0i)]??0, b10=ram[texAddr+(t0i*texW+s1i)]??0, b01=ram[texAddr+(t1i*texW+s0i)]??0, b11=ram[texAddr+(t1i*texW+s1i)]??0;
                  const i00=to5((b00>>>4)&0xF,4), i10=to5((b10>>>4)&0xF,4), i01=to5((b01>>>4)&0xF,4), i11=to5((b11>>>4)&0xF,4);
                  const a00=((b00&0xF)>=8)?1:0, a10=((b10&0xF)>=8)?1:0, a01=((b01&0xF)>=8)?1:0, a11=((b11&0xF)>=8)?1:0;
                  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const iv=Math.round(i0+(i1-i0)*b)&0x1f;
                  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const av=(Math.round(a0v+(a1v-a0v)*b)&1);
                  const color=((iv<<11)|(iv<<6)|(iv<<1)|av)>>>0;
                  const p=origin+(y*stride+x)*2; if(p+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[p]??0)<<8)|(ram[p+1]??0))>>>0; out=applyBlend(dst,out);} ram[p]=(out>>>8)&0xff; ram[p+1]=out&0xff; }
                } else {
                  const ss = nearestIndex(s, texW, texSMode); const tt = nearestIndex(t, texH, texTMode); const bv=ram[texAddr+(tt*texW+ss)]??0;
                  const i5=to5((bv>>>4)&0xF,4); const a1=(bv&0xF)>=8?1:0;
                  const color=((i5<<11)|(i5<<6)|(i5<<1)|a1)>>>0;
                  const p=origin+(y*stride+x)*2; if(p+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[p]??0)<<8)|(ram[p+1]??0))>>>0; out=applyBlend(dst,out);} ram[p]=(out>>>8)&0xff; ram[p+1]=out&0xff; }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000046: { // DRAW_IA8_TRI_PERSPECTIVE
        if (wordsLeft < 19) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const q1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const q2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const q3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft-=19; const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1; const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3)); const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){ const solid=(combineMode===1?primColor:envColor)>>>0; for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } } }
        else {
          function addrMode(coord:number,size:number,mode:0|1|2){ if(mode===1){ const m=((coord%size)+size)%size; return m; } else if(mode===2){ const period=size*2; const k=((coord%period)+period)%period; return k<size? k:(period-1-k);} else { return coord<0?0:coord>=size?size-1:coord; } }
          function to5(i:number,from:number){ const max=(1<<from)-1; return Math.round((i/max)*31)&0x1f; }
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const q=l0*q1+l1*q2+l2*q3; const invq=q!==0?(1.0/q):0.0; const sF=(l0*s1+l1*s2+l2*s3)*invq; const tF=(l0*t1+l1*t2+l2*t3)*invq;
                if (texFilter===1){
                  const nb = bilinearNeighbors(sF, tF, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  const b00=ram[texAddr+(t0i*texW+s0i)]??0, b10=ram[texAddr+(t0i*texW+s1i)]??0, b01=ram[texAddr+(t1i*texW+s0i)]??0, b11=ram[texAddr+(t1i*texW+s1i)]??0;
                  const i00=to5((b00>>>4)&0xF,4), i10=to5((b10>>>4)&0xF,4), i01=to5((b01>>>4)&0xF,4), i11=to5((b11>>>4)&0xF,4);
                  const a00=((b00&0xF)>=8)?1:0, a10=((b10&0xF)>=8)?1:0, a01=((b01&0xF)>=8)?1:0, a11=((b11&0xF)>=8)?1:0;
                  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const iv=Math.round(i0+(i1-i0)*b)&0x1f; const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const av=(Math.round(a0v+(a1v-a0v)*b)&1);
                  const color=((iv<<11)|(iv<<6)|(iv<<1)|av)>>>0; { const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
                } else {
                  const ss = nearestIndex(sF, texW, texSMode); const tt = nearestIndex(tF, texH, texTMode); const b=ram[texAddr+(tt*texW+ss)]??0; const i5=to5((b>>>4)&0xF,4); const a1=(b&0xF)>=8?1:0; const color=((i5<<11)|(i5<<6)|(i5<<1)|a1)>>>0; { const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000047: { // DRAW_IA16_TRI
        if (wordsLeft < 16) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4;
        wordsLeft-=16; const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3)); const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){ const solid=(combineMode===1?primColor:envColor)>>>0; for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } } }
        else {
          function to5(i:number){ return Math.round((i/255)*31)&0x1f; }
          const aabs=Math.abs(area)||1;
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const s=l0*s1+l1*s2+l2*s3; const t=l0*t1+l1*t2+l2*t3;
                if (texFilter===1){
                  const nb = bilinearNeighbors(s, t, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  function IA16At(S:number,T:number){ const idx=T*texW+S; const p=(texAddr+idx*2)>>>0; const I=ram[p]??0; const A=ram[p+1]??0; return {I,A}; }
                  const p00=IA16At(s0i,t0i), p10=IA16At(s1i,t0i), p01=IA16At(s0i,t1i), p11=IA16At(s1i,t1i);
                  const i00=to5(p00.I), i10=to5(p10.I), i01=to5(p01.I), i11=to5(p11.I);
                  const a00=p00.A>=128?1:0, a10=p10.A>=128?1:0, a01=p01.A>=128?1:0, a11=p11.A>=128?1:0;
                  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const iv=Math.round(i0+(i1-i0)*b)&0x1f; const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const av=(Math.round(a0v+(a1v-a0v)*b)&1);
                  const color=((iv<<11)|(iv<<6)|(iv<<1)|av)>>>0;
                  const p=origin+(y*stride+x)*2; if(p+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[p]??0)<<8)|(ram[p+1]??0))>>>0; out=applyBlend(dst,out);} ram[p]=(out>>>8)&0xff; ram[p+1]=out&0xff; }
                } else {
                  const ss = nearestIndex(s, texW, texSMode); const tt = nearestIndex(t, texH, texTMode); const idx=tt*texW+ss; const I=ram[texAddr+idx*2]??0; const A=ram[texAddr+idx*2+1]??0; const i5=to5(I); const a1=A>=128?1:0; const color=((i5<<11)|(i5<<6)|(i5<<1)|a1)>>>0;
                  const p=origin+(y*stride+x)*2; if(p+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[p]??0)<<8)|(ram[p+1]??0))>>>0; out=applyBlend(dst,out);} ram[p]=(out>>>8)&0xff; ram[p+1]=out&0xff; }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000048: { // DRAW_IA16_TRI_PERSPECTIVE
        if (wordsLeft < 19) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const q1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const q2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const q3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft-=19; const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1; const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3)); const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){ const solid=(combineMode===1?primColor:envColor)>>>0; for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } } }
        else {
          function addrMode(coord:number,size:number,mode:0|1|2){ if(mode===1){ const m=((coord%size)+size)%size; return m; } else if(mode===2){ const period=size*2; const k=((coord%period)+period)%period; return k<size? k:(period-1-k);} else { return coord<0?0:coord>=size?size-1:coord; } }
          function to5(i:number){ return Math.round((i/255)*31)&0x1f; }
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const q=l0*q1+l1*q2+l2*q3; const invq=q!==0?(1.0/q):0.0; const sF=(l0*s1+l1*s2+l2*s3)*invq; const tF=(l0*t1+l1*t2+l2*t3)*invq;
                if (texFilter===1){
                  const nb = bilinearNeighbors(sF, tF, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  function IA16At(S:number,T:number){ const idx=T*texW+S; const p=(texAddr+idx*2)>>>0; const I=ram[p]??0; const A=ram[p+1]??0; return {I,A}; }
                  const p00=IA16At(s0i,t0i), p10=IA16At(s1i,t0i), p01=IA16At(s0i,t1i), p11=IA16At(s1i,t1i);
                  const i00=to5(p00.I), i10=to5(p10.I), i01=to5(p01.I), i11=to5(p11.I);
                  const a00=p00.A>=128?1:0, a10=p10.A>=128?1:0, a01=p01.A>=128?1:0, a11=p11.A>=128?1:0;
                  const i0=i00+(i10-i00)*a, i1=i01+(i11-i01)*a; const iv=Math.round(i0+(i1-i0)*b)&0x1f; const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const av=(Math.round(a0v+(a1v-a0v)*b)&1);
                  const color=((iv<<11)|(iv<<6)|(iv<<1)|av)>>>0; { const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
                } else {
                  const ss = nearestIndex(sF, texW, texSMode); const tt = nearestIndex(tF, texH, texTMode); const idx=tt*texW+ss; const I=ram[texAddr+idx*2]??0; const A=ram[texAddr+idx*2+1]??0; const i5=to5(I); const a1=A>=128?1:0; const color=((i5<<11)|(i5<<6)|(i5<<1)|a1)>>>0; { const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000049: { // DRAW_RGBA16_TRI
        if (wordsLeft < 16) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4;
        wordsLeft-=16; const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3)); const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){ const solid=(combineMode===1?primColor:envColor)>>>0; for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } } }
        else {
          const aabs=Math.abs(area)||1;
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const s=l0*s1+l1*s2+l2*s3; const t=l0*t1+l1*t2+l2*t3;
                if (texFilter===1){
                  const nb = bilinearNeighbors(s, t, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  function RGBA16At(S:number,T:number){ const idx=T*texW+S; const ptx=(texAddr+idx*2)>>>0; const hi=ram[ptx]??0; const lo=ram[ptx+1]??0; return ((hi<<8)|lo)>>>0; }
                  const c00=RGBA16At(s0i,t0i), c10=RGBA16At(s1i,t0i), c01=RGBA16At(s0i,t1i), c11=RGBA16At(s1i,t1i);
                  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                  const r0=r00+(r10-r00)*a, r1=r01+(r11-r01)*a; const R=Math.round(r0+(r1-r0)*b)&0x1f;
                  const g0=g00+(g10-g00)*a, g1=g01+(g11-g01)*a; const G=Math.round(g0+(g1-g0)*b)&0x1f;
                  const b0=b00+(b10-b00)*a, b1=b01+(b11-b01)*a; const B=Math.round(b0+(b1-b0)*b)&0x1f;
                  const a0v=a00+(a10-a00)*a; const a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
                  const color=((R<<11)|(G<<6)|(B<<1)|A)>>>0;
                  const p=origin+(y*stride+x)*2; if(p+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[p]??0)<<8)|(ram[p+1]??0))>>>0; out=applyBlend(dst,out);} ram[p]=(out>>>8)&0xff; ram[p+1]=out&0xff; }
                } else {
                  const ss = nearestIndex(s, texW, texSMode); const tt = nearestIndex(t, texH, texTMode); const idx=tt*texW+ss; const ptx=(texAddr+idx*2)>>>0; const hi=ram[ptx]??0; const lo=ram[ptx+1]??0; const color=((hi<<8)|lo)>>>0;
                  const d=origin+(y*stride+x)*2; if(d+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[d]??0)<<8)|(ram[d+1]??0))>>>0; out=applyBlend(dst,out);} ram[d]=(out>>>8)&0xff; ram[d+1]=out&0xff; }
                }
              }
            }
          }
        }
        break;
      }
      case 0x0000004A: { // DRAW_RGBA16_TRI_PERSPECTIVE
        if (wordsLeft < 19) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const q1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const q2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const q3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft-=19; const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1; const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3)); const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        if (combineMode===1||combineMode===2){ const solid=(combineMode===1?primColor:envColor)>>>0; for(let y=minY;y<=maxY;y++){ for(let x=minX;x<=maxX;x++){ const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){ let pass=true; if(zEnable&&zAddr>>>0){ const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const zNew=(Math.round(l0*0 + l1*0 + l2*0) & 0xFFFF)>>>0; /* no z provided here */ } const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(solid>>>8)&0xff; ram[p+1]=solid&0xff; } } } } }
        else {
          function addrMode(coord:number,size:number,mode:0|1|2){ if(mode===1){ const m=((coord%size)+size)%size; return m; } else if(mode===2){ const period=size*2; const k=((coord%period)+period)%period; return k<size? k:(period-1-k);} else { return coord<0?0:coord>=size?size-1:coord; } }
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign; if(w0>=0&&w1>=0&&w2>=0){
                const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs; const q=l0*q1+l1*q2+l2*q3; const invq=q!==0?(1.0/q):0.0; const sF=(l0*s1+l1*s2+l2*s3)*invq; const tF=(l0*t1+l1*t2+l2*t3)*invq;
                if (texFilter===1){
                  const nb = bilinearNeighbors(sF, tF, texW, texH, texSMode, texTMode);
                  const { s0i, s1i, t0i, t1i, a, b } = nb;
                  function RGBA16At(S:number,T:number){ const idx=T*texW+S; const p=(texAddr+idx*2)>>>0; const hi=ram[p]??0; const lo=ram[p+1]??0; const val=((hi<<8)|lo)>>>0; return val; }
                  const c00=RGBA16At(s0i,t0i), c10=RGBA16At(s1i,t0i), c01=RGBA16At(s0i,t1i), c11=RGBA16At(s1i,t1i);
                  const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                  const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                  const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                  const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                  const r0=r00+(r10-r00)*a, r1=r01+(r11-r01)*a; const R=Math.round(r0+(r1-r0)*b)&0x1f;
                  const g0=g00+(g10-g00)*a, g1=g01+(g11-g01)*a; const G=Math.round(g0+(g1-g0)*b)&0x1f;
                  const b0=b00+(b10-b00)*a, b1=b01+(b11-b01)*a; const B=Math.round(b0+(b1-b0)*b)&0x1f;
                  const a0v=a00+(a10-a00)*a, a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
                  const color=((R<<11)|(G<<6)|(B<<1)|A)>>>0; { const p=origin+(y*stride+x)*2; if(p+1<ram.length){ ram[p]=(color>>>8)&0xff; ram[p+1]=color&0xff; } }
                } else {
                  const ss = nearestIndex(sF, texW, texSMode); const tt = nearestIndex(tF, texH, texTMode); const idx=tt*texW+ss; const p=(texAddr+idx*2)>>>0; const hi=ram[p]??0; const lo=ram[p+1]??0; const color=((hi<<8)|lo)>>>0; { const d=origin+(y*stride+x)*2; if(d+1<ram.length){ ram[d]=(color>>>8)&0xff; ram[d+1]=color&0xff; } }
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000050: { // SET_Z_ENABLE: next 1 word: 0=disable,1=enable
        if (wordsLeft < 1) return;
        const en = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        zEnable = (en & 1) as 0 | 1;
        break;
      }
      case 0x00000051: { // SET_Z_BUFFER: next 3 words: addr, width, height
        if (wordsLeft < 3) return;
        zAddr = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        zWidth = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        zHeight = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 3;
        break;
      }
      case 0x00000052: { // CLEAR_Z: next 1 word: value (16-bit)
        if (wordsLeft < 1) return;
        const val = (bus.loadU32(addr) >>> 0) & 0xFFFF; addr = (addr + 4) >>> 0; wordsLeft -= 1;
        if (zAddr >>> 0) {
          const ram = bus.rdram.bytes;
          const w = zWidth | 0, h = zHeight | 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const p = (zAddr + ((y * w + x) << 1)) >>> 0;
              if (p + 1 < ram.length) writeU16BE(p, val);
            }
          }
        }
        break;
      }
      case 0x00000053: { // DRAW_PRIM_TRI_Z: next 9 words: x1,y1,z1,x2,y2,z2,x3,y3,z3
        if (wordsLeft < 9) return;
        const x1 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y1 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const z1 = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const x2 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y2 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const z2 = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        const x3 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const y3 = bus.loadU32(addr) | 0; addr = (addr + 4) >>> 0;
        const z3 = bus.loadU32(addr) >>> 0; addr = (addr + 4) >>> 0;
        wordsLeft -= 9;
        const color = (combineMode === 2 /*ENV*/ ? envColor : primColor) >>> 0;
        function edge(ax:number, ay:number, bx:number, by:number, px:number, py:number){ return (px - ax)*(by - ay) - (py - ay)*(bx - ax); }
        const area = edge(x1,y1,x2,y2,x3,y3);
        const wsign = area >= 0 ? 1 : -1;
        const minX = Math.max(0, Math.min(x1, x2, x3));
        const maxX = Math.min(width - 1, Math.max(x1, x2, x3));
        const minY = Math.max(0, Math.min(y1, y2, y3));
        const maxY = Math.min(height - 1, Math.max(y1, y2, y3));
        const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
        const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
        const ram = bus.rdram.bytes;
        const aabs = Math.abs(area) || 1;
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const w0 = edge(x2,y2,x3,y3,x,y) * wsign;
            const w1 = edge(x3,y3,x1,y1,x,y) * wsign;
            const w2 = edge(x1,y1,x2,y2,x,y) * wsign;
            if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
              let pass = true;
              if (zEnable && zAddr >>> 0) {
                const l0 = w0 / aabs, l1 = w1 / aabs, l2 = w2 / aabs;
                const zf = l0 * z1 + l1 * z2 + l2 * z3;
                let zNew = Math.round(zf) & 0xFFFF;
                if (x < (zWidth|0) && y < (zHeight|0)) {
                  const zp = (zAddr + ((y * (zWidth|0) + x) << 1)) >>> 0;
                  const zOld = zp + 1 < ram.length ? readU16BE(zp) : 0xFFFF;
                  if (zNew < zOld) {
                    if (zp + 1 < ram.length) writeU16BE(zp, zNew);
                  } else {
                    pass = false;
                  }
                }
              }
              if (pass) {
                const addrPix = origin + (y * stride + x) * 2;
                if (addrPix + 1 < ram.length) {
                  let out = color >>> 0;
                  if (blendMode !== 0) { const dst = (((ram[addrPix] ?? 0) << 8) | (ram[addrPix+1] ?? 0)) >>> 0; out = applyBlend(dst, out); }
                  ram[addrPix] = (out >>> 8) & 0xff; ram[addrPix + 1] = out & 0xff;
                }
              }
            }
          }
        }
        break;
      }
      case 0x00000058: { // DRAW_RGBA16_TRI_Z (affine ST + Z)
        if (wordsLeft < 19) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const z1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const z2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const z3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft -= 19;
        const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1;
        const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3));
        const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        for(let y=minY;y<=maxY;y++){
          for(let x=minX;x<=maxX;x++){
            const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign;
            if(w0>=0&&w1>=0&&w2>=0){
              const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs;
              let pass=true;
              if (zEnable && zAddr>>>0) {
                const zf = l0*z1 + l1*z2 + l2*z3; const zNew=(Math.round(zf)&0xFFFF)>>>0;
                if (x < (zWidth|0) && y < (zHeight|0)) {
                  const zp=(zAddr+((y*(zWidth|0)+x)<<1))>>>0; const zOld=zp+1<ram.length?readU16BE(zp):0xFFFF;
                  if (zNew < zOld) { if (zp+1<ram.length) writeU16BE(zp, zNew); } else { pass=false; }
                }
              }
              if (!pass) continue;
              const s = l0*s1 + l1*s2 + l2*s3; const t = l0*t1 + l1*t2 + l2*t3;
              let color: number;
              if (texFilter===1){
                const nb = bilinearNeighbors(s, t, texW, texH, texSMode, texTMode);
                const { s0i, s1i, t0i, t1i, a, b } = nb;
                function RGBA16At(S:number,T:number){ const idx=T*texW+S; const p=(texAddr+idx*2)>>>0; const hi=ram[p]??0; const lo=ram[p+1]??0; return ((hi<<8)|lo)>>>0; }
                const c00=RGBA16At(s0i,t0i), c10=RGBA16At(s1i,t0i), c01=RGBA16At(s0i,t1i), c11=RGBA16At(s1i,t1i);
                const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                const r0=r00+(r10-r00)*a, r1=r01+(r11-r01)*a; const R=Math.round(r0+(r1-r0)*b)&0x1f;
                const g0=g00+(g10-g00)*a, g1=g01+(g11-g01)*a; const G=Math.round(g0+(g1-g0)*b)&0x1f;
                const b0=b00+(b10-b00)*a, b1=b01+(b11-b01)*a; const B=Math.round(b0+(b1-b0)*b)&0x1f;
                  const a0v=a00+(a10-a00)*a; const a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
                color=((R<<11)|(G<<6)|(B<<1)|A)>>>0;
              } else {
                const ss = nearestIndex(s, texW, texSMode); const tt = nearestIndex(t, texH, texTMode); const idx=tt*texW+ss; const p=(texAddr+idx*2)>>>0; const hi=ram[p]??0; const lo=ram[p+1]??0; color=((hi<<8)|lo)>>>0;
              }
              const dp=origin+(y*stride+x)*2; if(dp+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[dp]??0)<<8)|(ram[dp+1]??0))>>>0; out=applyBlend(dst,out);} ram[dp]=(out>>>8)&0xff; ram[dp+1]=out&0xff; }
            }
          }
        }
        break;
      }
      case 0x0000005D: { // DRAW_RGBA16_TRI_PERSPECTIVE_Z (perspective ST + Z)
        if (wordsLeft < 22) return;
        const texAddr=bus.loadU32(addr)>>>0; addr+=4; const texW=bus.loadU32(addr)>>>0; addr+=4; const texH=bus.loadU32(addr)>>>0; addr+=4;
        const x1=bus.loadU32(addr)|0; addr+=4; const y1=bus.loadU32(addr)|0; addr+=4; const s1=bus.loadU32(addr)|0; addr+=4; const t1=bus.loadU32(addr)|0; addr+=4; const q1=bus.loadU32(addr)>>>0; addr+=4; const z1=bus.loadU32(addr)>>>0; addr+=4;
        const x2=bus.loadU32(addr)|0; addr+=4; const y2=bus.loadU32(addr)|0; addr+=4; const s2=bus.loadU32(addr)|0; addr+=4; const t2=bus.loadU32(addr)|0; addr+=4; const q2=bus.loadU32(addr)>>>0; addr+=4; const z2=bus.loadU32(addr)>>>0; addr+=4;
        const x3=bus.loadU32(addr)|0; addr+=4; const y3=bus.loadU32(addr)|0; addr+=4; const s3=bus.loadU32(addr)|0; addr+=4; const t3=bus.loadU32(addr)|0; addr+=4; const q3=bus.loadU32(addr)>>>0; addr+=4; const z3=bus.loadU32(addr)>>>0; addr+=4;
        wordsLeft -= 22;
        const origin=bus.loadU32(VI_BASE+VI_ORIGIN_OFF)>>>0; const stride=bus.loadU32(VI_BASE+VI_WIDTH_OFF)>>>0; const ram=bus.rdram.bytes;
        function edge(ax:number,ay:number,bx:number,by:number,px:number,py:number){ return (px-ax)*(by-ay)-(py-ay)*(bx-ax); }
        const area=edge(x1,y1,x2,y2,x3,y3); const wsign=area>=0?1:-1; const aabs=Math.abs(area)||1;
        const minX=Math.max(0,Math.min(x1,x2,x3)); const maxX=Math.min(width-1,Math.max(x1,x2,x3));
        const minY=Math.max(0,Math.min(y1,y2,y3)); const maxY=Math.min(height-1,Math.max(y1,y2,y3));
        for(let y=minY;y<=maxY;y++){
          for(let x=minX;x<=maxX;x++){
            const w0=edge(x2,y2,x3,y3,x,y)*wsign; const w1=edge(x3,y3,x1,y1,x,y)*wsign; const w2=edge(x1,y1,x2,y2,x,y)*wsign;
            if(w0>=0&&w1>=0&&w2>=0){
              const l0=w0/aabs, l1=w1/aabs, l2=w2/aabs;
              let pass=true;
              if (zEnable && zAddr>>>0) {
                const zf = l0*z1 + l1*z2 + l2*z3; const zNew=(Math.round(zf)&0xFFFF)>>>0;
                if (x < (zWidth|0) && y < (zHeight|0)) {
                  const zp=(zAddr+((y*(zWidth|0)+x)<<1))>>>0; const zOld=zp+1<ram.length?readU16BE(zp):0xFFFF;
                  if (zNew < zOld) { if (zp+1<ram.length) writeU16BE(zp, zNew); } else { pass=false; }
                }
              }
              if (!pass) continue;
              const q = l0*q1 + l1*q2 + l2*q3; const invq = q!==0? (1.0/q):0.0;
              const sF=(l0*s1 + l1*s2 + l2*s3)*invq; const tF=(l0*t1 + l1*t2 + l2*t3)*invq;
              let color: number;
              if (texFilter===1){
                const nb = bilinearNeighbors(sF, tF, texW, texH, texSMode, texTMode);
                const { s0i, s1i, t0i, t1i, a, b } = nb;
                function RGBA16At(S:number,T:number){ const idx=T*texW+S; const p=(texAddr+idx*2)>>>0; const hi=ram[p]??0; const lo=ram[p+1]??0; return ((hi<<8)|lo)>>>0; }
                const c00=RGBA16At(s0i,t0i), c10=RGBA16At(s1i,t0i), c01=RGBA16At(s0i,t1i), c11=RGBA16At(s1i,t1i);
                const r00=(c00>>>11)&0x1f, g00=(c00>>>6)&0x1f, b00=(c00>>>1)&0x1f, a00=c00&1;
                const r10=(c10>>>11)&0x1f, g10=(c10>>>6)&0x1f, b10=(c10>>>1)&0x1f, a10=c10&1;
                const r01=(c01>>>11)&0x1f, g01=(c01>>>6)&0x1f, b01=(c01>>>1)&0x1f, a01=c01&1;
                const r11=(c11>>>11)&0x1f, g11=(c11>>>6)&0x1f, b11=(c11>>>1)&0x1f, a11=c11&1;
                const r0=r00+(r10-r00)*a, r1=r01+(r11-r01)*a; const R=Math.round(r0+(r1-r0)*b)&0x1f;
                const g0=g00+(g10-g00)*a, g1=g01+(g11-g01)*a; const G=Math.round(g0+(g1-g0)*b)&0x1f;
                const b0=b00+(b10-b00)*a, b1=b01+(b11-b01)*a; const B=Math.round(b0+(b1-b0)*b)&0x1f;
                const a0v=a00+(a10-a00)*a; const a1v=a01+(a11-a01)*a; const A=(Math.round(a0v+(a1v-a0v)*b)&1);
                color=((R<<11)|(G<<6)|(B<<1)|A)>>>0;
              } else {
                const ss = nearestIndex(sF, texW, texSMode); const tt = nearestIndex(tF, texH, texTMode); const idx=tt*texW+ss; const p=(texAddr+idx*2)>>>0; const hi=ram[p]??0; const lo=ram[p+1]??0; color=((hi<<8)|lo)>>>0;
              }
              const dp=origin+(y*stride+x)*2; if(dp+1<ram.length){ let out=color>>>0; if(blendMode!==0){ const dst=(((ram[dp]??0)<<8)|(ram[dp+1]??0))>>>0; out=applyBlend(dst,out);} ram[dp]=(out>>>8)&0xff; ram[dp+1]=out&0xff; }
            }
          }
        }
        break;
      }
      default:
        // Unknown op: stop
        return;
    }
  }
}

export function scheduleRSPDLFramesAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  dlBase: number,
  frames: number,
  startCycle: number,
  interval: number,
  totalCycles: number,
  spOffset: number = 1,
  strideWords: number = 16,
): TitleLoopResult {
  // Program VI
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);

  // Enable CPU IE/IM2 and MI masks for SP+DP+VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

  const perFrameImages: Uint8Array[] = [];
  const stride = (strideWords >>> 0) * 4;
  for (let i = 0; i < frames; i++) {
    const dpAt = (startCycle + i * interval) >>> 0;
    const spAt = dpAt > (spOffset|0) ? (dpAt - (spOffset|0)) >>> 0 : 0;
    const dlAddr = (dlBase + i * stride) >>> 0;

    sys.scheduleAt(spAt, () => { bus.sp.raiseInterrupt(); });
    sys.scheduleAt(dpAt, () => {
      bus.dp.raiseInterrupt();
      execRSPDLFrame(bus, width, height, dlAddr, strideWords);
      bus.vi.vblank();
      const snap = viScanout(bus, width, height);
      perFrameImages.push(snap);
    });
  }

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, frames: perFrameImages, res };
}

// Variant that uses a table of per-frame DL addresses in RDRAM at tableBase (u32 each)
export function scheduleRSPDLFromTableAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  tableBase: number,
  frames: number,
  startCycle: number,
  interval: number,
  totalCycles: number,
  spOffset: number = 1,
  strideWords: number = 16,
): TitleLoopResult {
  // Program VI
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

  const perFrameImages: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const dpAt = (startCycle + i * interval) >>> 0;
    const spAt = dpAt > (spOffset|0) ? (dpAt - (spOffset|0)) >>> 0 : 0;
    const dlAddrAddr = (tableBase + i * 4) >>> 0;
    sys.scheduleAt(spAt, () => { bus.sp.raiseInterrupt(); });
    sys.scheduleAt(dpAt, () => {
      bus.dp.raiseInterrupt();
      const dlAddr = bus.loadU32(dlAddrAddr) >>> 0;
      execRSPDLFrame(bus, width, height, dlAddr, strideWords);
      bus.vi.vblank();
      const snap = viScanout(bus, width, height);
      perFrameImages.push(snap);
    });
  }
  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, frames: perFrameImages, res };
}

// Translate per-frame F3DEX bytecode DLs from a table into RSPDL on-the-fly and execute via the RSPDL HLE path.
export function scheduleF3DEXFromTableAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  f3dexTableBase: number,
  frames: number,
  stagingBase: number,
  strideWords: number,
  startCycle: number,
  interval: number,
  totalCycles: number,
  spOffset: number = 1,
  bgStart5551?: number,
  bgEnd5551?: number,
): TitleLoopResult {
  // Program VI
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

  const perFrameImages: Uint8Array[] = [];
  const strideBytes = (strideWords >>> 0) * 4;

  for (let i = 0; i < frames; i++) {
    const dpAt = (startCycle + i * interval) >>> 0;
    const spAt = dpAt > (spOffset|0) ? (dpAt - (spOffset|0)) >>> 0 : 0;
    const dlAddrAddr = (f3dexTableBase + i * 4) >>> 0;
    const stagingAddr = (stagingBase + i * strideBytes) >>> 0;

    sys.scheduleAt(spAt, () => { bus.sp.raiseInterrupt(); });
    sys.scheduleAt(dpAt, () => {
      bus.dp.raiseInterrupt();
      // Optional gradient background before drawing tiles
      if (bgStart5551 !== undefined && bgEnd5551 !== undefined) {
        viDrawHorizontalGradient(bus, width, height, bgStart5551 >>> 0, bgEnd5551 >>> 0);
      }
      const dlAddr = bus.loadU32(dlAddrAddr) >>> 0;
      const uc = translateF3DEXToUc(bus as any, dlAddr, strideWords);
      const words = ucToRspdlWords(uc, strideWords);
      // write words to staging
      let p = stagingAddr;
      for (let w = 0; w < words.length; w++) { bus.storeU32(p, words[w]! >>> 0); p = (p + 4) >>> 0; }
      // Execute via RSPDL interpreter
      execRSPDLFrame(bus, width, height, stagingAddr, strideWords);
      bus.vi.vblank();
      const snap = viScanout(bus, width, height);
      perFrameImages.push(snap);
    });
  }

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, frames: perFrameImages, res };
}

