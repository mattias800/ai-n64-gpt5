import { Tile5551 } from '../system/video_hle.js';

const BLUE   = ((0 << 11) | (0 << 6)  | (31 << 1) | 1) >>> 0;
const RED    = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
const GREEN  = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
const YELLOW = ((31 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

function makeMask(width: number, height: number): Uint8Array { return new Uint8Array(width * height); }

// 32x32 blocky 'S' with thicker bars and connectors
function makeMaskS32(): Uint8Array {
  const w = 32, h = 32; const t = 4; const m = makeMask(w,h);
  const midY = Math.floor(h/2) - 2;
  // top/bottom bars
  for (let y = 0; y < t; y++) for (let x = 4; x < w-4; x++) m[y*w + x] = 1;
  for (let y = h-t; y < h; y++) for (let x = 4; x < w-4; x++) m[y*w + x] = 1;
  // middle bar
  for (let y = 0; y < t; y++) for (let x = 4; x < w-4; x++) m[(midY + y)*w + x] = 1;
  // left connector (top to mid)
  for (let y = t; y < midY; y++) for (let x = 4; x < 8; x++) m[y*w + x] = 1;
  // right connector (mid to bottom)
  for (let y = midY + t; y < h - t; y++) for (let x = w-8; x < w-4; x++) m[y*w + x] = 1;
  return m;
}

// 32x32 blocky 'M' with verticals and diagonals
function makeMaskM32(): Uint8Array {
  const w = 32, h = 32; const m = makeMask(w,h); const t=3;
  for (let y = 0; y < h; y++) for (let x = 0; x < t; x++) { m[y*w + x] = 1; m[y*w + (w-1-x)] = 1; }
  for (let d = 2; d < h/2; d++) {
    m[d*w + d] = 1; m[d*w + d-1] = 1;
    const rx = (w-1)-d; m[d*w + rx] = 1; m[d*w + rx+1] = 1;
  }
  return m;
}

// 32x32 blocky '6': ring + inner tail
function makeMask632(): Uint8Array {
  const w = 32, h = 32; const m = makeMask(w,h); const t=3;
  for (let x = 6; x < w-6; x++) for (let k=0;k<t;k++){ m[(0+k)*w + x] = 1; m[((h-1)-k)*w + x] = 1; }
  for (let y = t; y < h-t; y++) for (let k=0;k<t;k++){ m[y*w + (6+k)] = 1; m[y*w + ((w-1)-(6-k))] = 1; }
  for (let d=6; d<12; d++) m[d*w + d] = 1; // tail
  return m;
}

// 32x32 blocky '4': right vertical, crossbar, diagonal
function makeMask432(): Uint8Array {
  const w = 32, h = 32; const m = makeMask(w,h); const vx = w-6; const t=3;
  for (let y=0;y<h;y++) for (let k=0;k<t;k++) m[y*w + vx + k] = 1; // right vertical thick
  const cy = Math.floor(h/2);
  for (let x=4; x<vx+t; x++) for (let k=0;k<t;k++) m[(cy+k)*w + x] = 1; // crossbar
  for (let d=4; d<cy-2; d++) m[d*w + (d+2)] = 1; // diagonal
  return m;
}

function buildTilesFromMask(mask: Uint8Array, w: number, h: number, tileSize: number, color: number, originX: number, originY: number): Tile5551[] {
  const tiles: Tile5551[] = [];
  const gridW = Math.ceil(w / tileSize);
  const gridH = Math.ceil(h / tileSize);
  for (let gy=0; gy<gridH; gy++){
    for (let gx=0; gx<gridW; gx++){
      const sx = gx*tileSize, sy=gy*tileSize;
      const tw = Math.min(tileSize, w - sx), th = Math.min(tileSize, h - sy);
      const px = new Uint16Array(tw*th);
      for (let y=0;y<th;y++) for (let x=0;x<tw;x++) px[y*tw + x] = mask[(sy+y)*w + (sx+x)] ? (color>>>0) : 0;
      tiles.push({ dstX: originX + sx, dstY: originY + sy, width: tw, height: th, pixels: px });
    }
  }
  return tiles;
}

export type RefinedOptions = { tileSize?: number; spacing?: number; offsetX?: number; offsetY?: number };

export function buildRefinedSM64Tiles(canvasW: number, canvasH: number, opts: RefinedOptions = {}): Tile5551[] {
  const tile = opts.tileSize ?? 8; const spacing = opts.spacing ?? 12; const offX = opts.offsetX ?? 0; const offY = opts.offsetY ?? 0;
  const gw = 32, gh = 32; const totalW = gw*4 + spacing*3; const baseX = Math.max(0, Math.floor((canvasW-totalW)/2)) + offX; const baseY = Math.max(0, Math.floor(canvasH*0.25)) + offY;
  let x = baseX; const y = baseY; const tiles: Tile5551[] = [];
  tiles.push(...buildTilesFromMask(makeMaskS32(), gw, gh, tile, BLUE, x, y)); x += gw + spacing;
  tiles.push(...buildTilesFromMask(makeMaskM32(), gw, gh, tile, RED, x, y)); x += gw + spacing;
  tiles.push(...buildTilesFromMask(makeMask632(), gw, gh, tile, GREEN, x, y)); x += gw + spacing;
  tiles.push(...buildTilesFromMask(makeMask432(), gw, gh, tile, YELLOW, x, y));
  return tiles;
}

