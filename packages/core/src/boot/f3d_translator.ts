import type { UcCmd } from './ucode_translator.js';

// Minimal F3D-like translator emitting our microcode commands used by the DL HLE.
// This is intentionally tiny and test-focused.
export type F3D =
  | { op: 'G_SETCIMG'; format: 'CI4' | 'CI8'; addr: number; w: number; h: number }
  | { op: 'G_SETTIMG'; format: 'CI4' | 'CI8'; addr: number }
  | { op: 'G_SETTLUT'; addr: number; count: number }
  | { op: 'G_LOADTLUT'; addr: number; count: number }
  | { op: 'G_GRADIENT'; bgStart: number; bgEnd: number }
  | { op: 'G_SETTILESIZE'; ulx: number; uly: number; lrx: number; lry: number }
  | { op: 'G_TEXRECT'; ulx: number; uly: number; lrx: number; lry: number }
  | { op: 'G_SET_CI4_PALETTE'; palette: number }
  | { op: 'G_SETPRIMCOLOR5551'; color: number }
  | { op: 'G_SETENVCOLOR5551'; color: number }
  | { op: 'G_SETCOMBINE_MODE'; mode: 'TEXEL0' | 'PRIM' | 'ENV' }
  | { op: 'G_SPRITE'; x: number; y: number; w: number; h: number }
  | { op: 'G_TRI_PRIM'; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
  | { op: 'G_SM64_SLICE'; spacing: number; offsetX: number }
  | { op: 'G_END' };

export function f3dToUc(cmds: F3D[]): UcCmd[] {
  let img: { format: 'CI4' | 'CI8'; addr: number; w: number; h: number } | null = null;
  let tlut: { addr: number; count: number } | null = null;
  let tileSize: { w: number; h: number } | null = null;
  const out: UcCmd[] = [];
  for (const c of cmds) {
    switch (c.op) {
      case 'G_GRADIENT':
        out.push({ op: 'Gradient', bgStart: c.bgStart >>> 0, bgEnd: c.bgEnd >>> 0 });
        break;
      case 'G_SETPRIMCOLOR5551':
        out.push({ op: 'SetPrimColor', color: c.color >>> 0 });
        break;
      case 'G_SETENVCOLOR5551':
        out.push({ op: 'SetEnvColor', color: c.color >>> 0 });
        break;
      case 'G_SETCOMBINE_MODE':
        out.push({ op: 'SetCombine', mode: c.mode });
        break;
      case 'G_SETTLUT':
      case 'G_LOADTLUT':
        // Record and emit TLUT load
        tlut = { addr: c.addr >>> 0, count: c.count >>> 0 } as any;
        out.push({ op: 'SetTLUT', tlutAddr: c.addr >>> 0, count: c.count >>> 0 });
        break;
      case 'G_SETCIMG':
      case 'G_SETTIMG':
        img = { format: c.format, addr: c.addr >>> 0, w: (c as any).w ?? img?.w ?? 0, h: (c as any).h ?? img?.h ?? 0 } as any;
        break;
      case 'G_SETTILESIZE': {
        // F3D encodes coordinates in 10.2 fixed-point. Convert to pixels.
        const w = Math.max(0, Math.floor((c.lrx - c.ulx) / 4 + 1));
        const h = Math.max(0, Math.floor((c.lry - c.uly) / 4 + 1));
        tileSize = { w, h };
        if (img) { (img as any).w = w; (img as any).h = h; }
        break;
      }
      case 'G_TEXRECT': {
        if (!img) break;
        // Convert UL/LR from 10.2 fixed-point to pixel coords
        const x = Math.floor(c.ulx / 4);
        const y = Math.floor(c.uly / 4);
        const w = Math.max(0, Math.floor((c.lrx - c.ulx) / 4));
        const h = Math.max(0, Math.floor((c.lry - c.uly) / 4));
        const drawW = tileSize?.w ?? (img.w || w);
        const drawH = tileSize?.h ?? (img.h || h);
        if (img.format === 'CI8') out.push({ op: 'DrawCI8', w: drawW|0, h: drawH|0, addr: img.addr>>>0, x: x|0, y: y|0 });
        else out.push({ op: 'DrawCI4', w: drawW|0, h: drawH|0, addr: img.addr>>>0, x: x|0, y: y|0 });
        break;
      }
      case 'G_SET_CI4_PALETTE': {
        out.push({ op: 'SetCI4Palette', palette: (c.palette>>>0)&0xF });
        break;
      }
      case 'G_SPRITE':
        if (!img) break;
        if (img.format === 'CI8') out.push({ op: 'DrawCI8', w: img.w|0, h: img.h|0, addr: img.addr>>>0, x: c.x|0, y: c.y|0 });
        else out.push({ op: 'DrawCI4', w: img.w|0, h: img.h|0, addr: img.addr>>>0, x: c.x|0, y: c.y|0 });
        break;
      case 'G_TRI_PRIM':
        out.push({ op: 'DrawPrimTri', x1: c.x1|0, y1: c.y1|0, x2: c.x2|0, y2: c.y2|0, x3: c.x3|0, y3: c.y3|0 });
        break;
      case 'G_SM64_SLICE':
        out.push({ op: 'Sm64Slice', spacing: c.spacing>>>0, offsetX: c.offsetX|0 });
        break;
      case 'G_END':
        out.push({ op: 'End' });
        break;
    }
  }
  if (out.length === 0 || out[out.length-1]?.op !== 'End') out.push({ op: 'End' });
  return out;
}

