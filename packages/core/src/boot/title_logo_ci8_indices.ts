import type { TileAtlas } from './title_dl_hle.js';

// Build 32x32 CI8 indices for a ring (annulus) and a TLUT mapping 1->green5551, 0->transparent.
export function buildCI8Ring32Indices(green5551: number): { indices: Uint8Array; tlut: Uint16Array } {
  const W=32, H=32;
  const indices = new Uint8Array(W*H);
  const cx=16, cy=16; const rOuter=14, rInner=10;
  for (let y=0;y<H;y++){
    for (let x=0;x<W;x++){
      const dx = (x+0.5)-cx; const dy = (y+0.5)-cy; const d2 = dx*dx+dy*dy;
      const on = d2 <= rOuter*rOuter && d2 >= rInner*rInner;
      indices[y*W+x] = on ? 1 : 0;
    }
  }
  const tlut = new Uint16Array(256);
  tlut[1] = green5551 >>> 0;
  return { indices, tlut };
}

export function sliceCI8Indices16(indices32: Uint8Array): { CIR00: Uint8Array; CIR01: Uint8Array; CIR10: Uint8Array; CIR11: Uint8Array } {
  const W=32, H=32, TS=16;
  function slice(gx: number, gy: number): Uint8Array {
    const out = new Uint8Array(TS*TS);
    const offX = gx*TS, offY = gy*TS;
    for (let y=0;y<TS;y++){
      for (let x=0;x<TS;x++){
        out[y*TS + x] = indices32[(offY+y)*W + (offX+x)]!;
      }
    }
    return out;
  }
  return {
    CIR00: slice(0,0), CIR01: slice(1,0), CIR10: slice(0,1), CIR11: slice(1,1)
  };
}

