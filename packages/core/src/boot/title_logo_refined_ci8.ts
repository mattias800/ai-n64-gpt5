// CI8 variants of refined SM64 glyph masks (S, M, SIX, FOUR), sliced into 16x16 quadrants
// Each pixel is index 1 for glyph, 0 for transparent. TLUT maps 1->color5551.

export type GlyphName = 'S'|'M'|'SIX'|'FOUR';

function makeMaskS32(): Uint8Array {
  const w = 32, h = 32; const t = 4; const m = new Uint8Array(w*h);
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
function makeMaskM32(): Uint8Array {
  const w = 32, h = 32; const m = new Uint8Array(w*h); const t=3;
  for (let y = 0; y < h; y++) for (let x = 0; x < t; x++) { m[y*w + x] = 1; m[y*w + (w-1-x)] = 1; }
  for (let d = 2; d < h/2; d++) {
    m[d*w + d] = 1; m[d*w + d-1] = 1;
    const rx = (w-1)-d; m[d*w + rx] = 1; m[d*w + rx+1] = 1;
  }
  return m;
}
function makeMask632(): Uint8Array {
  const w = 32, h = 32; const m = new Uint8Array(w*h); const t=3;
  for (let x = 6; x < w-6; x++) for (let k=0;k<t;k++){ m[(0+k)*w + x] = 1; m[((h-1)-k)*w + x] = 1; }
  for (let y = t; y < h-t; y++) for (let k=0;k<t;k++){ m[y*w + (6+k)] = 1; m[y*w + ((w-1)-(6-k))] = 1; }
  for (let d=6; d<12; d++) m[d*w + d] = 1; // tail
  return m;
}
function makeMask432(): Uint8Array {
  const w = 32, h = 32; const m = new Uint8Array(w*h); const vx = w-6; const t=3;
  for (let y=0;y<h;y++) for (let k=0;k<t;k++) m[y*w + vx + k] = 1; // right vertical thick
  const cy = Math.floor(h/2);
  for (let x=4; x<vx+t; x++) for (let k=0;k<t;k++) m[(cy+k)*w + x] = 1; // crossbar
  for (let d=4; d<cy-2; d++) m[d*w + (d+2)] = 1; // diagonal
  return m;
}

function glyphMask(name: GlyphName): Uint8Array {
  switch (name) {
    case 'S': return makeMaskS32();
    case 'M': return makeMaskM32();
    case 'SIX': return makeMask632();
    case 'FOUR': return makeMask432();
  }
}

export function buildRefinedCI8GlyphQuads(name: GlyphName, color5551: number) {
  const w=32,h=32, TS=16;
  const mask = glyphMask(name);
  const indices = new Uint8Array(w*h);
  for (let i=0;i<w*h;i++) indices[i] = mask[i] ? 1 : 0;
  const tlut = new Uint16Array(256); tlut[1] = color5551>>>0;
  function slice(gx:number,gy:number): Uint8Array {
    const out = new Uint8Array(TS*TS); const offX=gx*TS, offY=gy*TS;
    for (let y=0;y<TS;y++) for (let x=0;x<TS;x++) out[y*TS+x] = indices[(offY+y)*w + (offX+x)]!;
    return out;
  }
  return {
    tlut,
    quads: {
      Q00: slice(0,0), Q01: slice(1,0), Q10: slice(0,1), Q11: slice(1,1)
    }
  } as const;
}
