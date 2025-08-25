import type { TileAtlas } from './title_dl_hle.js';
import { decodeCI8ToRGBA5551 } from '../gfx/n64_textures.js';

// Build a 32x32 ring using CI8 indices and a TLUT, then slice to 4x 16x16 tiles.
// Atlas keys: CIR00, CIR01, CIR10, CIR11
export function buildCI8Ring32Atlas16(green5551: number): TileAtlas {
  const W=32, H=32, TS=16;
  const indices = new Uint8Array(W*H);
  const cx=16, cy=16; const rOuter=14, rInner=10;
  for (let y=0;y<H;y++){
    for (let x=0;x<W;x++){
      const dx = (x+0.5)-cx; const dy = (y+0.5)-cy; const d2 = dx*dx+dy*dy;
      const on = d2 <= rOuter*rOuter && d2 >= rInner*rInner;
      indices[y*W+x] = on ? 1 : 0;
    }
  }
  // TLUT: index 0 -> transparent (0); index 1 -> green5551
  const tlut = new Uint16Array(256);
  tlut[1] = green5551 >>> 0;
  const pixels32 = decodeCI8ToRGBA5551(indices, tlut, W, H);

  function sliceTile(gx: number, gy: number): Uint16Array {
    const px = new Uint16Array(TS*TS);
    const offX = gx*TS, offY = gy*TS;
    for (let y=0;y<TS;y++){
      for (let x=0;x<TS;x++){
        px[y*TS+x] = (pixels32[(offY+y)*W + (offX+x)] ?? 0) >>> 0;
      }
    }
    return px;
  }

  return {
    CIR00: { width: TS, height: TS, pixels: sliceTile(0,0) },
    CIR01: { width: TS, height: TS, pixels: sliceTile(1,0) },
    CIR10: { width: TS, height: TS, pixels: sliceTile(0,1) },
    CIR11: { width: TS, height: TS, pixels: sliceTile(1,1) },
  };
}
