// Shared helpers for texture coordinate addressing and bilinear sampling
// Modes: 0=CLAMP, 1=WRAP, 2=MIRROR
export type TexAddrMode = 0 | 1 | 2;

export function texIndex(i: number, size: number, mode: TexAddrMode): number {
  if (mode === 1) { // WRAP
    const m = ((i % size) + size) % size;
    return m;
  } else if (mode === 2) { // MIRROR
    const period = size * 2;
    const k = ((i % period) + period) % period;
    return k < size ? k : (period - 1 - k);
  } else { // CLAMP
    return i < 0 ? 0 : i >= size ? size - 1 : i;
  }
}

export function nearestIndex(coord: number, size: number, mode: TexAddrMode): number {
  const i = Math.round(coord);
  return texIndex(i, size, mode);
}

export function foldFloatCoord(coord: number, size: number, mode: TexAddrMode): { u: number, dir: 1 | -1 } {
  if (mode === 1) { // WRAP
    const u = ((coord % size) + size) % size;
    return { u, dir: 1 };
  } else if (mode === 2) { // MIRROR
    const period = size * 2;
    let k = ((coord % period) + period) % period; // [0,2*size)
    if (k < size) {
      return { u: k, dir: 1 };
    } else {
      let v = (period - k); // (0,size]
      if (v === size) v = size - 1e-7; // keep inside [0,size)
      return { u: v, dir: -1 };
    }
  } else { // CLAMP
    const eps = 1e-7;
    const u = coord < 0 ? 0 : coord > (size - eps) ? (size - eps) : coord;
    return { u, dir: 1 };
  }
}

export function bilinearNeighbors(
  s: number,
  t: number,
  texW: number,
  texH: number,
  sMode: TexAddrMode,
  tMode: TexAddrMode,
): { s0i: number, s1i: number, t0i: number, t1i: number, a: number, b: number } {
  const sf = foldFloatCoord(s, texW, sMode);
  const tf = foldFloatCoord(t, texH, tMode);
  const s0 = Math.floor(sf.u);
  const t0 = Math.floor(tf.u);
  const s1raw = s0 + sf.dir;
  const t1raw = t0 + tf.dir;
  const s0i = texIndex(s0, texW, sMode);
  const s1i = texIndex(s1raw, texW, sMode);
  const t0i = texIndex(t0, texH, tMode);
  const t1i = texIndex(t1raw, texH, tMode);
  const af = sf.u - s0; const bf = tf.u - t0;
  const a = sf.dir === 1 ? af : (1 - af);
  const b = tf.dir === 1 ? bf : (1 - bf);
  return { s0i, s1i, t0i, t1i, a, b };
}

