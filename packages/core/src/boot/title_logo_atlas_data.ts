import { Tile5551 } from '../system/video_hle.js';

// RGBA5551 colors
const RED    = ((31 << 11) | (0 << 6)  | (0 << 1) | 1) >>> 0;
const GREEN  = ((0 << 11)  | (31 << 6) | (0 << 1) | 1) >>> 0;
const BLUE   = ((0 << 11)  | (0 << 6)  | (31 << 1) | 1) >>> 0;
const YELLOW = ((31 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
const WHITE  = ((31 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;

const PALETTE = [RED, GREEN, BLUE, YELLOW, WHITE] as const;

// Make a 16x16 tile with horizontal stripes cycling through the provided palette indices.
// Carves a transparent cross at the center row and column so background shows through.
export function makeStripeTile16(paletteIdx: number[] = [0,1,2,3]): Uint16Array {
  const w = 16, h = 16;
  const px = new Uint16Array(w * h);
  const cy = Math.floor(h / 2), cx = Math.floor(w / 2);
  for (let y = 0; y < h; y++) {
    const color = (PALETTE[paletteIdx[y % paletteIdx.length] ?? 0] ?? RED) >>> 0;
    for (let x = 0; x < w; x++) {
      px[y * w + x] = color;
    }
  }
  // Transparent cross
  for (let x = 0; x < w; x++) px[cy * w + x] = 0;
  for (let y = 0; y < h; y++) px[y * w + cx] = 0;
  return px;
}

export type AtlasSliceOptions = { spacing?: number };

// Build two 16x16 stripe tiles placed side-by-side with spacing, roughly centered.
export function buildTitleAtlasSlice(canvasW: number, canvasH: number, opts: AtlasSliceOptions = {}): Tile5551[] {
  const spacing = opts.spacing ?? 4;
  const w = 16, h = 16;
  const totalW = w * 2 + spacing;
  const originX = Math.max(0, Math.floor((canvasW - totalW) / 2));
  const originY = Math.max(0, Math.floor(canvasH * 0.3));

  const tileA = makeStripeTile16([0,1,2,3]);      // RED, GREEN, BLUE, YELLOW
  const tileB = makeStripeTile16([3,2,1,0]);      // YELLOW, BLUE, GREEN, RED

  const tiles: Tile5551[] = [
    { dstX: originX, dstY: originY, width: w, height: h, pixels: tileA },
    { dstX: originX + w + spacing, dstY: originY, width: w, height: h, pixels: tileB },
  ];
  return tiles;
}

