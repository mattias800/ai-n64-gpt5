import { Tile5551 } from '../system/video_hle.js';

// RGBA5551 helpers
const RED = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

// Create an 8x8 tile representing a blocky 'M' glyph in a solid color.
// Opaque pixels (alpha=1) form the letter; background pixels are transparent (alpha=0)
// so the underlying framebuffer shows through.
export function makeTileM8x8(color5551: number = RED): Uint16Array {
  const w = 8, h = 8;
  const p = new Uint16Array(w * h);
  const O = 0; // transparent
  const C = color5551 >>> 0;
  // Initialize transparent
  for (let i = 0; i < p.length; i++) p[i] = O;
  // Left and right columns
  for (let y = 0; y < h; y++) { p[y*w + 0] = C; p[y*w + 7] = C; }
  // Diagonals toward center (forming the 'M' middle)
  p[1*w + 1] = C; p[2*w + 2] = C; p[3*w + 3] = C;
  p[1*w + 6] = C; p[2*w + 5] = C; p[3*w + 4] = C;
  return p;
}

export function buildSM64LogoSliceTiles(canvasW: number, canvasH: number): Tile5551[] {
  const tile = makeTileM8x8();
  // Center the tile roughly in the upper third
  const dstX = Math.floor((canvasW - 8) / 2);
  const dstY = Math.floor(canvasH * 0.25);
  return [{ dstX, dstY, width: 8, height: 8, pixels: tile }];
}

