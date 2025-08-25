import { Tile5551 } from '../system/video_hle.js';

// RGBA5551 colors
const BLUE = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
const RED  = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

function makeEmptyTile(w: number, h: number): Uint16Array {
  return new Uint16Array(w * h); // all zero (transparent)
}

// 16x16 blocky 'S':
// - Top bar (thickness 2)
// - Middle bar (thickness 2) centered
// - Bottom bar (thickness 2)
// - Left vertical connector near top, right vertical connector near bottom
export function makeTileS16(color5551: number = BLUE): Uint16Array {
  const w = 16, h = 16, t = 2;
  const px = makeEmptyTile(w, h);
  const C = color5551 >>> 0;
  const midY = Math.floor(h / 2) - 1;
  // Top bar
  for (let y = 0; y < t; y++) for (let x = 2; x < w - 2; x++) px[y * w + x] = C;
  // Middle bar
  for (let y = 0; y < t; y++) for (let x = 2; x < w - 2; x++) px[(midY + y) * w + x] = C;
  // Bottom bar
  for (let y = h - t; y < h; y++) for (let x = 2; x < w - 2; x++) px[y * w + x] = C;
  // Left connector (between top and mid)
  for (let y = t; y < midY; y++) for (let x = 2; x < 4; x++) px[y * w + x] = C;
  // Right connector (between mid and bottom)
  for (let y = midY + t; y < h - t; y++) for (let x = w - 4; x < w - 2; x++) px[y * w + x] = C;
  return px;
}

// 16x16 blocky 'M':
// - Left and right vertical strokes
// - Two diagonals from near top toward center
export function makeTileM16(color5551: number = RED): Uint16Array {
  const w = 16, h = 16;
  const px = makeEmptyTile(w, h);
  const C = color5551 >>> 0;
  // Left/right verticals (thickness 2)
  for (let y = 0; y < h; y++) {
    px[y * w + 0] = C; px[y * w + 1] = C;
    px[y * w + (w - 1)] = C; px[y * w + (w - 2)] = C;
  }
  // Diagonals: (1,1)->(7,7) and (14-1,1)->(8,7)
  for (let d = 1; d <= 7; d++) {
    px[d * w + d] = C;
    px[d * w + (d - 1)] = C; // thicken
    const rx = (w - 1) - d;
    px[d * w + rx] = C;
    px[d * w + (rx + 1)] = C; // thicken
  }
  return px;
}

export type SMSliceOptions = { spacing?: number };

export function buildSMTilesSlice(canvasW: number, canvasH: number, opts: SMSliceOptions = {}): Tile5551[] {
  const spacing = opts.spacing ?? 6;
  const w = 16, h = 16;
  const totalW = w * 2 + spacing;
  const originX = Math.max(0, Math.floor((canvasW - totalW) / 2));
  const originY = Math.max(0, Math.floor(canvasH * 0.28));

  const s = makeTileS16();
  const m = makeTileM16();

  return [
    { dstX: originX, dstY: originY, width: w, height: h, pixels: s },
    { dstX: originX + w + spacing, dstY: originY, width: w, height: h, pixels: m },
  ];
}

