import { Tile5551 } from '../system/video_hle.js';
import { makeTileS16, makeTileM16 } from './title_logo_sm_tiles.js';

const GREEN  = ((0 << 11)  | (31 << 6) | (0 << 1) | 1) >>> 0;
const YELLOW = ((31 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

function empty(w: number, h: number): Uint16Array { return new Uint16Array(w * h); }

// 16x16 blocky '6': a hollow ring plus a small interior tail at upper-left
export function makeTile616(color5551: number = GREEN): Uint16Array {
  const w = 16, h = 16, t = 2;
  const C = color5551 >>> 0;
  const px = empty(w, h);
  // Rectangle ring
  for (let x = 2; x < w - 2; x++) { px[0 * w + x] = C; px[(h - 1) * w + x] = C; }
  for (let y = 1; y < h - 1; y++) { px[y * w + 2] = C; px[y * w + (w - 3)] = C; }
  // Tail inside upper-left
  for (let d = 2; d <= 5; d++) px[(d) * w + (d)] = C;
  return px;
}

// 16x16 blocky '4': right vertical stroke, crossbar, and diagonal
export function makeTile416(color5551: number = YELLOW): Uint16Array {
  const w = 16, h = 16;
  const C = color5551 >>> 0;
  const px = empty(w, h);
  const vx = w - 3; // right vertical at x=13
  for (let y = 0; y < h; y++) { px[y * w + vx] = C; px[y * w + (vx + 1)] = C; }
  // Crossbar near mid
  const cy = Math.floor(h / 2);
  for (let x = 2; x < vx + 2; x++) px[cy * w + x] = C;
  // Diagonal from top-left toward the cross
  for (let d = 2; d <= cy - 2; d++) px[d * w + (d + 1)] = C;
  return px;
}

export type SM64SliceOptions = { spacing?: number; offsetX?: number; offsetY?: number };

export function buildSM64TilesSlice(canvasW: number, canvasH: number, opts: SM64SliceOptions = {}): Tile5551[] {
  const spacing = opts.spacing ?? 8;
  const offX = opts.offsetX ?? 0;
  const offY = opts.offsetY ?? 0;
  const w = 16, h = 16;
  const totalW = w * 4 + spacing * 3;
  const baseX = Math.max(0, Math.floor((canvasW - totalW) / 2));
  const baseY = Math.max(0, Math.floor(canvasH * 0.28));
  const originX = baseX + offX;
  const originY = baseY + offY;

  const s = makeTileS16();
  const m = makeTileM16();
  const six = makeTile616();
  const four = makeTile416();

  return [
    { dstX: originX, dstY: originY, width: w, height: h, pixels: s },
    { dstX: originX + (w + spacing) * 1, dstY: originY, width: w, height: h, pixels: m },
    { dstX: originX + (w + spacing) * 2, dstY: originY, width: w, height: h, pixels: six },
    { dstX: originX + (w + spacing) * 3, dstY: originY, width: w, height: h, pixels: four },
  ];
}

