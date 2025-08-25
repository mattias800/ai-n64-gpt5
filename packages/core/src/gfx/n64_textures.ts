// N64 texture format decoders used for HLE tests and atlas generation
// All decoders output RGBA5551 pixels in a Uint16Array, matching the VI blitter expectations.

export function to5bit(v: number, fromBits: number): number {
  // Scale v in [0, 2^fromBits-1] to [0,31]
  if (fromBits === 5) return v & 0x1f;
  const maxIn = (1 << fromBits) - 1;
  return Math.round((v / maxIn) * 31) & 0x1f;
}

export function pack5551(r5: number, g5: number, b5: number, a1: number): number {
  return (((r5 & 0x1f) << 11) | ((g5 & 0x1f) << 6) | ((b5 & 0x1f) << 1) | (a1 & 0x01)) >>> 0;
}

// Decode CI8 indices using a 256-entry TLUT of RGBA5551 values.
export function decodeCI8ToRGBA5551(indices: Uint8Array, tlut: Uint16Array, width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = indices[i]! >>> 0;
    out[i] = (tlut[idx] ?? 0) >>> 0;
  }
  return out;
}

// Decode I4: 4-bit intensity (no alpha). We'll map intensity 0..15 -> RGB 5-bit, and set A=1 if I>0 else 0.
export function decodeI4ToRGBA5551(data: Uint8Array, width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height);
  let di = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    const hi = (byte >>> 4) & 0x0f;
    const lo = byte & 0x0f;
    const vals = [hi, lo];
    for (const v of vals) {
      if (di >= out.length) break;
      const r5 = to5bit(v, 4);
      const g5 = r5;
      const b5 = r5;
      const a1 = v > 0 ? 1 : 0;
      out[di++] = pack5551(r5, g5, b5, a1);
    }
  }
  return out;
}

// Decode IA8: 4 bits intensity (high nibble) + 4 bits alpha (low nibble).
// Map intensity 0..15 to RGB 5-bit equally, alpha 0..15 -> A=1 if >= 8 else 0.
export function decodeIA8ToRGBA5551(data: Uint8Array, width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height);
  let di = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    const i4 = (byte >>> 4) & 0x0f;
    const a4 = byte & 0x0f;
    const r5 = to5bit(i4, 4);
    const g5 = r5;
    const b5 = r5;
    const a1 = a4 >= 8 ? 1 : 0;
    if (di < out.length) out[di++] = pack5551(r5, g5, b5, a1);
  }
  return out;
}

// Decode IA16: bytes are I (8-bit) then A (8-bit), or vice versa depending on asset; we assume I then A.
// Map intensity 0..255 -> 5-bit equally; alpha 0..255 -> A=1 if >= 128.
export function decodeIA16ToRGBA5551(data: Uint8Array, width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height);
  let di = 0;
  for (let i = 0; i+1 < data.length && di < out.length; i += 2) {
    const I = data[i]!; const A = data[i+1]!;
    const r5 = to5bit(I, 8); const g5 = r5; const b5 = r5; const a1 = A >= 128 ? 1 : 0;
    out[di++] = pack5551(r5, g5, b5, a1);
  }
  return out;
}

// Decode I8: 8-bit intensity only, alpha derived from intensity > 0.
export function decodeI8ToRGBA5551(data: Uint8Array, width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height);
  const n = Math.min(out.length, data.length);
  for (let i = 0; i < n; i++) {
    const I = data[i]!;
    const r5 = to5bit(I, 8); const g5 = r5; const b5 = r5; const a1 = I > 0 ? 1 : 0;
    out[i] = pack5551(r5, g5, b5, a1);
  }
  return out;
}

// Decode CI4 using a 16-entry TLUT (RGBA5551 values). Two pixels per byte: hi nibble then lo nibble.
export function decodeCI4ToRGBA5551(data: Uint8Array, tlut16: Uint16Array, width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height);
  let di = 0;
  for (let i = 0; i < data.length && di < out.length; i++) {
    const byte = data[i]!;
    const hi = (byte >>> 4) & 0x0f; const lo = byte & 0x0f;
    out[di++] = (tlut16[hi] ?? 0) >>> 0;
    if (di < out.length) out[di++] = (tlut16[lo] ?? 0) >>> 0;
  }
  return out;
}
