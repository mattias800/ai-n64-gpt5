import { Tile5551 } from '../system/video_hle.js';

// Helpers to produce RGBA5551 colors
const BLUE   = ((0 << 11) | (0 << 6)  | (31 << 1) | 1) >>> 0;
const RED    = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
const GREEN  = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
const YELLOW = ((31 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

function makeRectWithTransparentCross(w: number, h: number, color5551: number): Uint16Array {
  const pixels = new Uint16Array(w * h);
  // Fill with color (A=1), then carve a cross (set A=0) at center row/col
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      pixels[y * w + x] = color5551 >>> 0;
    }
  }
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  // Cross thickness 1 px; ensure indices are in-bounds
  for (let x = 0; x < w; x++) pixels[cy * w + x] = 0; // transparent row
  for (let y = 0; y < h; y++) pixels[y * w + cx] = 0; // transparent column
  return pixels;
}

export type SM64LogoOptions = {
  // Scaling factors for tile size relative to canvas
  tileWidthFrac?: number; // default 0.15
  tileHeightFrac?: number; // default 0.22
  // Horizontal spacing between glyphs (as fraction of canvas width)
  spacingFrac?: number; // default 0.05
};

// Returns tiles for an SM64-like logo: S (blue), M (red), 6 (green), 4 (yellow)
export function buildSM64LogoTiles(canvasW: number, canvasH: number, opts: SM64LogoOptions = {}): Tile5551[] {
  const tileWF = opts.tileWidthFrac ?? 0.15;
  const tileHF = opts.tileHeightFrac ?? 0.22;
  const spaceF = opts.spacingFrac ?? 0.05;

  const tileW = Math.max(8, Math.floor(canvasW * tileWF));
  const tileH = Math.max(8, Math.floor(canvasH * tileHF));
  const gap = Math.floor(canvasW * spaceF);

  // Starting X such that the four tiles + gaps are roughly centered
  const totalW = tileW * 4 + gap * 3;
  const startX = Math.max(0, Math.floor((canvasW - totalW) / 2));
  const y = Math.max(0, Math.floor(canvasH * 0.25));

  const colors = [BLUE, RED, GREEN, YELLOW];
  const tiles: Tile5551[] = [];
  for (let i = 0; i < 4; i++) {
    const x = startX + i * (tileW + gap);
    const color = (colors[i] ?? BLUE) >>> 0;
    const pixels = makeRectWithTransparentCross(tileW, tileH, color);
    tiles.push({ dstX: x, dstY: y, width: tileW, height: tileH, pixels });
  }
  return tiles;
}

