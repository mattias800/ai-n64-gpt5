import type { UcCmd } from './ucode_translator.js';
import type { Bus } from '../mem/bus.js';

// Minimal, mock-friendly F3DEX bytecode translator.
// Parses a tiny subset sufficient for parity tests:
//  - 0xFD: G_SETTIMG (uses siz to pick CI4/CI8/RGBA16; word1 = DRAM addr)
//  - 0xF0: G_LOADTLUT (mocked: low 16 bits of word0 = count; word1 = DRAM addr)
//  - 0xF2: G_SETTILESIZE (ulx/uly/lrx/lry in 10.2 fixed packed as 12-bit fields)
//  - 0xE4: G_TEXRECT (ulx/uly/lrx/lry in 10.2 fixed packed as 12-bit fields)
//  - 0xB6: VTX2D_TEX (mock)
//  - 0xB7: TRI2D_TEX (mock)
//  - 0xB8: VTX2D_TEX_Z (mock; adds Z)
//  - 0xB9: TRI2D_TEX_Z (mock; emits Z-enabled draw)
//  - 0xBA: VTX2D_TEX_QZ (mock; adds Q and Z)
//  - 0xBB: TRI2D_TEX_QZ (mock; emits perspective+Z draw)
//  - 0xEC: SET_Z_ENABLE (mock)
//  - 0xED: SET_Z_BUFFER (mock; w0: width<<16|height, w1: addr)
//  - 0xEE: CLEAR_Z (mock; w1: 16-bit value)
//  - 0xDF: G_ENDDL
// Unknown ops are ignored.
// NOTE: This is not a full/accurate F3DEX implementation; it is a deliberately small
// stub to drive our RSP-DL HLE with verifiable tests. We'll extend it incrementally.

function fp10_2_to_px(v12: number): number { return Math.floor(v12 / 4); }
function sizeFromSizBits(siz: number): 'CI4' | 'CI8' | 'RGBA16' | null {
  switch (siz & 3) {
    case 0: return 'CI4';  // 4bpp
    case 1: return 'CI8';  // 8bpp
    case 2: return 'RGBA16'; // 16bpp color
    default: return null;
  }
}

export function translateF3DEXToUc(bus: Pick<Bus, 'loadU32'>, dlAddr: number, maxCmds: number = 256): UcCmd[] {
  let p = dlAddr >>> 0;
  const out: UcCmd[] = [];
  let imgAddr: number | null = null;
  let imgFmt: 'CI4' | 'CI8' | 'RGBA16' | null = null;
  let tileW = 0, tileH = 0;
  let ci4Palette = 0 >>> 0;
  const segBase = new Uint32Array(16);
  const retStack: number[] = [];
  const vtx: { x: number; y: number; s?: number; t?: number; z?: number; q?: number }[] = [];
  function resolve(addr: number): number {
    addr >>>= 0;
    const seg = (addr >>> 24) & 0x0F;
    const off = addr & 0x00FFFFFF;
    const base = (segBase[seg] ?? 0) >>> 0;
    if (base) return ((base & 0x00FFFFFF) + off) >>> 0;
    return addr >>> 0;
  }

  let cmds = 0;
  // Track a simple scissor rectangle; translate to SetScissor UC when changed.
  let scissor: { x0: number, y0: number, x1: number, y1: number } | null = null;
  while (cmds < maxCmds) {
    const w0 = bus.loadU32(p) >>> 0; p = (p + 4) >>> 0;
    const w1 = bus.loadU32(p) >>> 0; p = (p + 4) >>> 0;
    const op = (w0 >>> 24) & 0xFF;
    cmds++;
    switch (op) {
      case 0xDF: { // G_ENDDL
        if (retStack.length > 0) { p = retStack.pop()! >>> 0; break; }
        out.push({ op: 'End' });
        return out;
      }
      case 0xFD: { // G_SETTIMG
        const siz = (w0 >>> 19) & 0x3;
        const fmt = sizeFromSizBits(siz);
        imgFmt = fmt;
        imgAddr = resolve(w1 >>> 0);
        break;
      }
      case 0xF0: { // G_LOADTLUT (mocked)
        const count = (w0 & 0xFFFF) || 256;
        const tlutAddr = resolve(w1 >>> 0);
        out.push({ op: 'SetTLUT', tlutAddr, count });
        break;
      }
      case 0xF2: { // G_SETTILESIZE
        const ulx = (w0 >>> 12) & 0xFFF;
        const uly = (w0 >>> 0) & 0xFFF;
        const lrx = (w1 >>> 12) & 0xFFF;
        const lry = (w1 >>> 0) & 0xFFF;
        // Convert 10.2 fixed: pixel size is lr-ul+[+1] per HW; we follow our typed translator heuristic
        tileW = Math.max(0, Math.floor((lrx - ulx) / 4 + 1));
        tileH = Math.max(0, Math.floor((lry - uly) / 4 + 1));
        break;
      }
      case 0xE3: { // Mock: G_SCISSOR - parse ulx/uly and lrx/lry in 10.2 fixed like TEXRECT
        const ulx = (w0 >>> 12) & 0xFFF;
        const uly = (w0 >>> 0) & 0xFFF;
        const lrx = (w1 >>> 12) & 0xFFF;
        const lry = (w1 >>> 0) & 0xFFF;
        const x0 = fp10_2_to_px(ulx);
        const y0 = fp10_2_to_px(uly);
        const x1 = fp10_2_to_px(lrx);
        const y1 = fp10_2_to_px(lry);
        scissor = { x0, y0, x1, y1 };
        out.push({ op: 'SetScissor', x0, y0, x1, y1 });
        break;
      }
      case 0xE4: { // G_TEXRECT
        if (imgAddr == null || imgFmt == null) break;
        if (imgFmt === 'CI4') out.push({ op: 'SetCI4Palette', palette: ci4Palette & 0xF });
        const ulx = (w0 >>> 12) & 0xFFF;
        const uly = (w0 >>> 0) & 0xFFF;
        const lrx = (w1 >>> 12) & 0xFFF;
        const lry = (w1 >>> 0) & 0xFFF;
        const x = fp10_2_to_px(ulx);
        const y = fp10_2_to_px(uly);
        const w = tileW || Math.max(0, fp10_2_to_px(lrx - ulx));
        const h = tileH || Math.max(0, fp10_2_to_px(lry - uly));
        if (imgFmt === 'CI8') out.push({ op: 'DrawCI8', w, h, addr: imgAddr >>> 0, x, y });
        else if (imgFmt === 'CI4') out.push({ op: 'DrawCI4', w, h, addr: imgAddr >>> 0, x, y });
        else if (imgFmt === 'RGBA16') out.push({ op: 'DrawRGBA16Tri', addr: imgAddr>>>0, texW: w|0, texH: h|0, x1: x|0, y1: y|0, s1: 0, t1: 0, x2: x|0, y2: y|0, s2: 0, t2: 0, x3: x|0, y3: y|0, s3: 0, t3: 0 } as any);
        break;
      }
      case 0xD7: { // G_SEGMENT
        const seg = ((w0 >>> 16) & 0xFF) & 0x0F;
        segBase[seg] = w1 >>> 0;
        break;
      }
      case 0xDE: { // G_DL
        const push = (w0 & 1) !== 0;
        const target = resolve(w1 >>> 0);
        if (push) retStack.push(p >>> 0);
        p = target >>> 0;
        break;
      }
      case 0xF3: { // G_LOADBLOCK (mock): ignore, assume SETTIMG points to DRAM source
        break;
      }
      case 0xB4: { // Mock: VTX2D - load N vertices as pairs of 16-bit x,y from DRAM
        // w0 low 12 bits carry count-1, w1 is DRAM addr; coords are pixels already
        const count = ((w0 & 0x0FFF) + 1) >>> 0;
        const addr = resolve(w1 >>> 0);
        for (let i = 0; i < count; i++) {
          const lo = bus.loadU32((addr + i * 4) >>> 0) >>> 0; // pack two 16-bit: x in hi, y in lo (BE vs LE isn't critical in mock)
          const x = (lo >>> 16) & 0xFFFF; const y = lo & 0xFFFF;
          vtx.push({ x: x | 0, y: y | 0 });
        }
        break;
      }
      case 0xB6: { // Mock: VTX2D_TEX - load N vertices as (x,y,s,t) pairs; 2 words per vertex
        const count = ((w0 & 0x0FFF) + 1) >>> 0;
        const addr = resolve(w1 >>> 0);
        for (let i = 0; i < count; i++) {
          const xy = bus.loadU32((addr + i * 8) >>> 0) >>> 0;
          const st = bus.loadU32((addr + i * 8 + 4) >>> 0) >>> 0;
          const x = (xy >>> 16) & 0xFFFF; const y = xy & 0xFFFF;
          const s = (st >>> 16) & 0xFFFF; const t = st & 0xFFFF;
          vtx.push({ x: x | 0, y: y | 0, s: s | 0, t: t | 0 });
        }
        break;
      }
      case 0xB8: { // Mock: VTX2D_TEX_Z - load N vertices as (x,y,s,t,z); 3 words per vertex
        const count = ((w0 & 0x0FFF) + 1) >>> 0;
        const addr = resolve(w1 >>> 0);
        for (let i = 0; i < count; i++) {
          const xy = bus.loadU32((addr + i * 12) >>> 0) >>> 0;
          const st = bus.loadU32((addr + i * 12 + 4) >>> 0) >>> 0;
          const zv = bus.loadU32((addr + i * 12 + 8) >>> 0) >>> 0;
          const x = (xy >>> 16) & 0xFFFF; const y = xy & 0xFFFF;
          const s = (st >>> 16) & 0xFFFF; const t = st & 0xFFFF;
          vtx.push({ x: x|0, y: y|0, s: s|0, t: t|0, z: zv>>>0 });
        }
        break;
      }
      case 0xBA: { // Mock: VTX2D_TEX_QZ - load N vertices as (x,y,s,t,q,z); 4 words per vertex
        const count = ((w0 & 0x0FFF) + 1) >>> 0;
        const addr = resolve(w1 >>> 0);
        for (let i = 0; i < count; i++) {
          const xy = bus.loadU32((addr + i * 16) >>> 0) >>> 0;
          const st = bus.loadU32((addr + i * 16 + 4) >>> 0) >>> 0;
          const qv = bus.loadU32((addr + i * 16 + 8) >>> 0) >>> 0;
          const zv = bus.loadU32((addr + i * 16 + 12) >>> 0) >>> 0;
          const x = (xy >>> 16) & 0xFFFF; const y = xy & 0xFFFF;
          const s = (st >>> 16) & 0xFFFF; const t = st & 0xFFFF;
          vtx.push({ x: x|0, y: y|0, s: s|0, t: t|0, q: qv>>>0, z: zv>>>0 });
        }
        break;
      }
      case 0xB7: { // Mock: TRI2D_TEX - draw textured triangle using last loaded textured vertices
        const i0 = (w0 >>> 0) & 0xF; const i1 = (w0 >>> 4) & 0xF; const i2 = (w0 >>> 8) & 0xF;
        const a = vtx[i0], b = vtx[i1], c = vtx[i2];
        if (a && b && c && imgAddr != null && imgFmt != null) {
          const tw = tileW || 0; const th = tileH || 0;
          if (imgFmt === 'CI8') {
            out.push({ op: 'DrawCI8Tri', addr: imgAddr >>> 0, texW: tw|0, texH: th|0,
              x1: a.x|0, y1: a.y|0, s1: (a.s ?? 0)|0, t1: (a.t ?? 0)|0,
              x2: b.x|0, y2: b.y|0, s2: (b.s ?? 0)|0, t2: (b.t ?? 0)|0,
              x3: c.x|0, y3: c.y|0, s3: (c.s ?? 0)|0, t3: (c.t ?? 0)|0,
            } as any);
          } else if (imgFmt === 'CI4') {
            out.push({ op: 'DrawCI4Tri', addr: imgAddr >>> 0, texW: tw|0, texH: th|0,
              x1: a.x|0, y1: a.y|0, s1: (a.s ?? 0)|0, t1: (a.t ?? 0)|0,
              x2: b.x|0, y2: b.y|0, s2: (b.s ?? 0)|0, t2: (b.t ?? 0)|0,
              x3: c.x|0, y3: c.y|0, s3: (c.s ?? 0)|0, t3: (c.t ?? 0)|0,
            } as any);
          } else if (imgFmt === 'RGBA16') {
            out.push({ op: 'DrawRGBA16Tri', addr: imgAddr>>>0, texW: tw|0, texH: th|0,
              x1: a.x|0, y1: a.y|0, s1: (a.s??0)|0, t1: (a.t??0)|0,
              x2: b.x|0, y2: b.y|0, s2: (b.s??0)|0, t2: (b.t??0)|0,
              x3: c.x|0, y3: c.y|0, s3: (c.s??0)|0, t3: (c.t??0)|0,
            } as any);
          }
        }
        break;
      }
      case 0xB9: { // Mock: TRI2D_TEX_Z - draw RGBA16 textured triangle with Z
        const i0 = (w0 >>> 0) & 0xF; const i1 = (w0 >>> 4) & 0xF; const i2 = (w0 >>> 8) & 0xF;
        const a = vtx[i0], b = vtx[i1], c = vtx[i2];
        if (a && b && c && imgAddr != null && imgFmt === 'RGBA16') {
          const tw = tileW || 0; const th = tileH || 0;
          out.push({ op: 'DrawRGBA16TriZ', addr: imgAddr>>>0, texW: tw|0, texH: th|0,
            x1: a.x|0, y1: a.y|0, s1: (a.s??0)|0, t1: (a.t??0)|0, z1: (a.z??0)>>>0,
            x2: b.x|0, y2: b.y|0, s2: (b.s??0)|0, t2: (b.t??0)|0, z2: (b.z??0)>>>0,
            x3: c.x|0, y3: c.y|0, s3: (c.s??0)|0, t3: (c.t??0)|0, z3: (c.z??0)>>>0,
          } as any);
        }
        break;
      }
      case 0xBB: { // Mock: TRI2D_TEX_QZ - draw textured triangle with perspective-correct ST (and optional Z)
        const i0 = (w0 >>> 0) & 0xF; const i1 = (w0 >>> 4) & 0xF; const i2 = (w0 >>> 8) & 0xF;
        const a = vtx[i0], b = vtx[i1], c = vtx[i2];
        if (a && b && c && imgAddr != null) {
          const tw = tileW || 0; const th = tileH || 0;
          if (imgFmt === 'RGBA16') {
            out.push({ op: 'DrawRGBA16TriPerspZ', addr: imgAddr>>>0, texW: tw|0, texH: th|0,
              x1: a.x|0, y1: a.y|0, s1: (a.s??0)|0, t1: (a.t??0)|0, q1: (a.q??1)>>>0, z1: (a.z??0)>>>0,
              x2: b.x|0, y2: b.y|0, s2: (b.s??0)|0, t2: (b.t??0)|0, q2: (b.q??1)>>>0, z2: (b.z??0)>>>0,
              x3: c.x|0, y3: c.y|0, s3: (c.s??0)|0, t3: (c.t??0)|0, q3: (c.q??1)>>>0, z3: (c.z??0)>>>0,
            } as any);
          } else if (imgFmt === 'CI8') {
            out.push({ op: 'DrawCI8TriPersp', addr: imgAddr>>>0, texW: tw|0, texH: th|0,
              x1: a.x|0, y1: a.y|0, s1: (a.s??0)|0, t1: (a.t??0)|0, q1: (a.q??1)>>>0,
              x2: b.x|0, y2: b.y|0, s2: (b.s??0)|0, t2: (b.t??0)|0, q2: (b.q??1)>>>0,
              x3: c.x|0, y3: c.y|0, s3: (c.s??0)|0, t3: (c.t??0)|0, q3: (c.q??1)>>>0,
            } as any);
          }
        }
        break;
      }
      case 0xB5: { // Mock: TRI2D - indices in w0/w1 lower nibbles: i0,i1,i2
        const i0 = (w0 >>> 0) & 0xF; const i1 = (w0 >>> 4) & 0xF; const i2 = (w0 >>> 8) & 0xF;
        const a = vtx[i0], b = vtx[i1], c = vtx[i2];
        if (a && b && c) out.push({ op: 'DrawPrimTri', x1: a.x|0, y1: a.y|0, x2: b.x|0, y2: b.y|0, x3: c.x|0, y3: c.y|0 });
        break;
      }
      case 0xFA: { // G_SETPRIMCOLOR (mocked): use w1 as RGBA5551 directly
        out.push({ op: 'SetPrimColor', color: (w1 & 0xFFFF) >>> 0 });
        break;
      }
      case 0xFB: { // G_SETENVCOLOR (mocked): use w1 as RGBA5551 directly
        out.push({ op: 'SetEnvColor', color: (w1 & 0xFFFF) >>> 0 });
        break;
      }
      case 0xFC: { // G_SETCOMBINE (mocked): low 2 bits of w1 encode 0=TEXEL0,1=PRIM,2=ENV
        const m = (w1 & 0x3) >>> 0;
        const mode = m === 1 ? 'PRIM' as const : m === 2 ? 'ENV' as const : 'TEXEL0' as const;
        out.push({ op: 'SetCombine', mode });
        break;
      }
      case 0xEC: { // Mock: SET_Z_ENABLE
        const enable = (w1 & 1) !== 0;
        out.push({ op: 'SetZEnable', enable });
        break;
      }
      case 0xEA: { // Mock: SET_TEX_FILTER (w1: 0=NEAREST,1=BILINEAR)
        const bil = (w1 & 1) !== 0;
        out.push({ op: 'SetTexFilter', mode: bil ? 'BILINEAR' : 'NEAREST' });
        break;
      }
      case 0xED: { // Mock: SET_Z_BUFFER (w0: width<<16 | height, w1: addr)
        const width = (w0 >>> 16) & 0xFFFF; const height = (w0 >>> 0) & 0xFFFF;
        const addr = resolve(w1 >>> 0);
        out.push({ op: 'SetZBuffer', addr, width, height });
        break;
      }
      case 0xEE: { // Mock: CLEAR_Z (w1: value)
        const value = (w1 & 0xFFFF) >>> 0;
        out.push({ op: 'ClearZ', value });
        break;
      }
      case 0xEB: { // Mock: SET_BLEND_MODE (w1: 0=OFF,1=AVERAGE_50,2=SRC_OVER_A1)
        const m = (w1 & 0x3) >>> 0;
        const mode = m === 2 ? 'SRC_OVER_A1' as const : m === 1 ? 'AVERAGE_50' as const : 'OFF' as const;
        out.push({ op: 'SetBlendMode', mode });
        break;
      }
      default:
        // Parse G_SETTILE (0xF5): CI4 palette is in bits 20..23 of w1 for many F3D variants
        if (op === 0xF5) {
          ci4Palette = ((w1 >>> 20) & 0xF) >>> 0;
          // Mock: decode CLAMP/WRAP/MIRROR from cms/cmt fields
          const cms = (w1 >>> 8) & 0x3;
          const cmt = (w1 >>> 18) & 0x3;
          const modeFrom = (v: number): 'CLAMP' | 'WRAP' | 'MIRROR' => (v === 2 ? 'CLAMP' : v === 1 ? 'MIRROR' : 'WRAP');
          out.push({ op: 'SetTexAddrMode', sMode: modeFrom(cms), tMode: modeFrom(cmt) });
          break;
        }
        // ignore unknowns
        break;
    }
  }
  // Ensure termination
  if (out.length === 0 || out[out.length - 1]?.op !== 'End') out.push({ op: 'End' });
  return out;
}
