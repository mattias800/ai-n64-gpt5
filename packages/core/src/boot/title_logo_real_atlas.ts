import type { TileAtlas } from './title_dl_hle.js';

// Build a 32x32 ring (annulus) split into 4 x 16x16 RGBA5551 tiles with given color.
// Tiles keys: RING00, RING01, RING10, RING11 (row-major gy,gx)
export function buildRing32Atlas16(color5551: number): TileAtlas {
  const atlas: Record<string, { width: number; height: number; pixels: Uint16Array }> = {};
  const W = 32, H = 32, TS = 16;
  const cx = 16, cy = 16; // center in 32x32 space
  const rOuter = 14, rInner = 10;

  function genTile(gx: number, gy: number): Uint16Array {
    const px = new Uint16Array(TS * TS);
    const offX = gx * TS;
    const offY = gy * TS;
    for (let y = 0; y < TS; y++) {
      for (let x = 0; x < TS; x++) {
        const X = offX + x;
        const Y = offY + y;
        const dx = X - cx + 0.5; // sample at pixel center
        const dy = Y - cy + 0.5;
        const d2 = dx*dx + dy*dy;
        if (d2 <= rOuter*rOuter && d2 >= rInner*rInner) {
          px[y * TS + x] = color5551 >>> 0;
        } else {
          px[y * TS + x] = 0; // transparent
        }
      }
    }
    return px;
  }

  atlas['RING00'] = { width: TS, height: TS, pixels: genTile(0,0) };
  atlas['RING01'] = { width: TS, height: TS, pixels: genTile(1,0) };
  atlas['RING10'] = { width: TS, height: TS, pixels: genTile(0,1) };
  atlas['RING11'] = { width: TS, height: TS, pixels: genTile(1,1) };
  return atlas;
}

