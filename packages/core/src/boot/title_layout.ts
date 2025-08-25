import { Tile5551 } from '../system/video_hle.js';

function solidTile(width: number, height: number, color5551: number): Uint16Array {
  const t = new Uint16Array(width * height);
  t.fill(color5551 >>> 0);
  return t;
}

export type TitleGlyph = {
  x: number; y: number; w: number; h: number; color5551: number;
};

// Build a set of colored rectangles approximating a simple "SM64" layout.
// This is not the real asset; it's a correctness scaffold to validate composition.
export function buildSimpleSM64TitleTiles(canvasW: number, canvasH: number): Tile5551[] {
  const red   = ((31 << 11) | (0 << 6)  | (0 << 1)  | 1) >>> 0;
  const green = ((0 << 11)  | (31 << 6) | (0 << 1)  | 1) >>> 0;
  const blue  = ((0 << 11)  | (0 << 6)  | (31 << 1) | 1) >>> 0;
  const yellow= ((31 << 11) | (31 << 6) | (0 << 1)  | 1) >>> 0;

  // Define four glyph blocks roughly centered
  const glyphs: TitleGlyph[] = [
    { x: Math.floor(canvasW*0.10), y: Math.floor(canvasH*0.20), w:  Math.floor(canvasW*0.18), h: Math.floor(canvasH*0.25), color5551: blue },   // S (blue)
    { x: Math.floor(canvasW*0.30), y: Math.floor(canvasH*0.20), w:  Math.floor(canvasW*0.18), h: Math.floor(canvasH*0.25), color5551: red },    // M (red)
    { x: Math.floor(canvasW*0.50), y: Math.floor(canvasH*0.20), w:  Math.floor(canvasW*0.15), h: Math.floor(canvasH*0.25), color5551: green },  // 6 (green)
    { x: Math.floor(canvasW*0.67), y: Math.floor(canvasH*0.20), w:  Math.floor(canvasW*0.15), h: Math.floor(canvasH*0.25), color5551: yellow }, // 4 (yellow)
  ];

  const tiles: Tile5551[] = [];
  for (const g of glyphs) {
    tiles.push({ dstX: g.x, dstY: g.y, width: g.w, height: g.h, pixels: solidTile(g.w, g.h, g.color5551) });
  }
  return tiles;
}

