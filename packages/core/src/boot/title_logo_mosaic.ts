import { Tile5551 } from '../system/video_hle.js';

const RED = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

// Build a boolean mask for a blocky 'M' over a width x height grid.
// Strokes:
// - Full-height left column at x=0
// - Full-height right column at x=width-1
// - Diagonals from near top toward the center for y=1..floor(height/2)-1
function makeMaskM(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const midY = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      if (x === 0 || x === width - 1) on = true;
      if (y > 0 && y < midY) {
        if (x === y || x === (width - 1 - y)) on = true;
      }
      mask[y * width + x] = on ? 1 : 0;
    }
  }
  return mask;
}

function makeMaskA(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const midX = Math.floor(width / 2);
  const crossY = Math.floor(height * 0.6);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      // Left and right slopes of 'A'
      if (x === Math.max(0, midX - y) || x === Math.min(width - 1, midX + y)) on = true;
      // Cap the bottom to avoid huge legs beyond width
      if (y === height - 1 && (x >= 0 && x <= width - 1)) on = true;
      // Crossbar near 60% height spanning between slopes
      if (y === crossY && x >= Math.max(0, midX - crossY) && x <= Math.min(width - 1, midX + crossY)) on = true;
      mask[y * width + x] = on ? 1 : 0;
    }
  }
  return mask;
}

function makeMaskR(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const midY = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      // Left vertical
      if (x === 0) on = true;
      // Top horizontal and middle horizontal (loop of R)
      if (y === 0 && x <= width - 2) on = true;
      if (y === midY && x <= width - 2) on = true;
      // Right vertical for the loop
      if (x === width - 2 && y >= 0 && y <= midY) on = true;
      // Diagonal leg down-right from middle
      if (y >= midY && (x === (y - midY) + 1)) on = true;
      mask[y * width + x] = on ? 1 : 0;
    }
  }
  return mask;
}

function makeMaskI(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const midX = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      // Vertical center stroke; add small top/bottom horizontals to be more letter-like
      if (x === midX) on = true;
      if (y === 0 && x >= midX - Math.floor(width / 4) && x <= midX + Math.floor(width / 4)) on = true;
      if (y === height - 1 && x >= midX - Math.floor(width / 4) && x <= midX + Math.floor(width / 4)) on = true;
      mask[y * width + x] = on ? 1 : 0;
    }
  }
  return mask;
}

function makeMaskO(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) on = true; // simple rectangle ring
      // Soften corners by ensuring ring has interior hollow
      if ((x > 0 && x < width - 1) && (y > 0 && y < height - 1)) {
        // interior hollow => not on
      }
      mask[y * width + x] = on ? 1 : 0;
    }
  }
  return mask;
}

function buildTilesFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  tileSize: number,
  color5551: number,
  originX: number,
  originY: number,
): Tile5551[] {
  const tiles: Tile5551[] = [];
  const gridW = Math.ceil(width / tileSize);
  const gridH = Math.ceil(height / tileSize);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const sx = gx * tileSize;
      const sy = gy * tileSize;
      const tw = Math.min(tileSize, width - sx);
      const th = Math.min(tileSize, height - sy);
      const pixels = new Uint16Array(tw * th);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const on = mask[(sy + y) * width + (sx + x)] !== 0;
          pixels[y * tw + x] = on ? (color5551 >>> 0) : 0;
        }
      }
      tiles.push({ dstX: originX + sx, dstY: originY + sy, width: tw, height: th, pixels });
    }
  }
  return tiles;
}

export type MosaicOptions = {
  tileSize?: number; // default 8
  color5551?: number; // default RED
  offsetX?: number; // additional offset for animation
  offsetY?: number; // additional offset for animation
  placeYFrac?: number; // default 0.25 (upper third)
  spacing?: number; // pixels between glyphs (for multi-glyph builder)
};

// Build a 2x2 (16x16) mosaic for 'M' using 8x8 tiles by default.
export function buildMosaicMTiles(
  canvasW: number,
  canvasH: number,
  opts: MosaicOptions = {},
): Tile5551[] {
  const tileSize = opts.tileSize ?? 8;
  const color = opts.color5551 ?? RED;
  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const placeYFrac = opts.placeYFrac ?? 0.25;

  const width = tileSize * 2;
  const height = tileSize * 2;
  const mask = makeMaskM(width, height);

  // Center horizontally, place near upper third vertically
  const originX = Math.max(0, Math.floor((canvasW - width) / 2) + offsetX);
  const originY = Math.max(0, Math.floor(canvasH * placeYFrac) + offsetY);

  return buildTilesFromMask(mask, width, height, tileSize, color, originX, originY);
}

// Build a mosaic for M, A, R placed left-to-right with spacing; each glyph is 2*tileSize wide/high
export function buildMosaicMARGlyphs(
  canvasW: number,
  canvasH: number,
  opts: MosaicOptions = {},
): Tile5551[] {
  const tileSize = opts.tileSize ?? 8;
  const color = opts.color5551 ?? RED;
  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const placeYFrac = opts.placeYFrac ?? 0.25;
  const spacing = opts.spacing ?? Math.max(2, Math.floor(tileSize / 2));

  const gw = tileSize * 2;
  const gh = tileSize * 2;
  const totalW = gw * 3 + spacing * 2;

  let originX = Math.max(0, Math.floor((canvasW - totalW) / 2) + offsetX);
  const originY = Math.max(0, Math.floor(canvasH * placeYFrac) + offsetY);

  const masks = [makeMaskM(gw, gh), makeMaskA(gw, gh), makeMaskR(gw, gh)];
  const tiles: Tile5551[] = [];
  for (let i = 0; i < masks.length; i++) {
    tiles.push(...buildTilesFromMask(masks[i]!, gw, gh, tileSize, color, originX, originY));
    originX += gw + spacing;
  }
  return tiles;
}

// Build a mosaic for M, A, R, I, O placed left-to-right with spacing
export function buildMosaicMARIOGlyphs(
  canvasW: number,
  canvasH: number,
  opts: MosaicOptions = {},
): Tile5551[] {
  const tileSize = opts.tileSize ?? 8;
  const color = opts.color5551 ?? RED;
  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const placeYFrac = opts.placeYFrac ?? 0.25;
  const spacing = opts.spacing ?? Math.max(2, Math.floor(tileSize / 2));

  const gw = tileSize * 2;
  const gh = tileSize * 2;
  const totalW = gw * 5 + spacing * 4;

  let originX = Math.max(0, Math.floor((canvasW - totalW) / 2) + offsetX);
  const originY = Math.max(0, Math.floor(canvasH * placeYFrac) + offsetY);

  const masks = [makeMaskM(gw, gh), makeMaskA(gw, gh), makeMaskR(gw, gh), makeMaskI(gw, gh), makeMaskO(gw, gh)];
  const tiles: Tile5551[] = [];
  for (let i = 0; i < masks.length; i++) {
    tiles.push(...buildTilesFromMask(masks[i]!, gw, gh, tileSize, color, originX, originY));
    originX += gw + spacing;
  }
  return tiles;
}

