// Minimal MIO0 decompressor (big-endian variant used by SM64)
// Reference: Nintendo MIO0 format
// Layout (offsets are from the start of the MIO0 block):
//  0x00: 'M','I','O','0'
//  0x04: uncompressedSize (u32 BE)
//  0x08: compOffset (u32 BE) - offset to backreference stream
//  0x0C: rawOffset  (u32 BE) - offset to literal bytes stream
//  0x10: control bits stream (32-bit words, MSB-first per word), continues until decompressedSize reached
// The decoder walks control bits: 1 = copy literal byte from raw stream; 0 = copy L bytes from a lookback
// using two bytes from comp stream: (a,b). Length L = (a >> 4) + 3 (1..18) and distance D = ((a & 0x0F) << 8 | b) + 1 (1..4096).
// The lookback is applied against the already-decompressed output buffer.

function readU32BE(buf: Uint8Array, off: number): number {
  const b0 = buf[off] ?? 0; const b1 = buf[off + 1] ?? 0; const b2 = buf[off + 2] ?? 0; const b3 = buf[off + 3] ?? 0;
  return (((b0 & 0xff) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff)) >>> 0;
}

export function decompressMIO0(src: Uint8Array, baseOffset: number = 0): Uint8Array {
  const o = baseOffset >>> 0;
  if (src[o] !== 0x4D || src[o + 1] !== 0x49 || src[o + 2] !== 0x4F || src[o + 3] !== 0x30) {
    throw new Error('MIO0: bad magic');
  }
  const outSize = readU32BE(src, o + 0x04) >>> 0;
  const compOff = (readU32BE(src, o + 0x08) >>> 0) + o;
  const rawOff0 = (readU32BE(src, o + 0x0C) >>> 0) + o;
  let ctrlPtr = o + 0x10;
  let compPtr = compOff >>> 0;
  let rawPtr = rawOff0 >>> 0;
  const out = new Uint8Array(outSize);
  let outPos = 0;
  let ctrlBits = 0; // current control word
  let bitsLeft = 0;

  while (outPos < outSize) {
    if (bitsLeft === 0) {
      ctrlBits = readU32BE(src, ctrlPtr); ctrlPtr = (ctrlPtr + 4) >>> 0; bitsLeft = 32;
    }
    const bit = (ctrlBits >>> 31) & 1; // MSB first
    ctrlBits = (ctrlBits << 1) >>> 0;
    bitsLeft--;

    if (bit === 1) {
      // literal from raw
      out[outPos++] = src[rawPtr++] ?? 0;
    } else {
      // backreference: two bytes from comp
      const a = src[compPtr++] ?? 0;
      const b = src[compPtr++] ?? 0;
      const length = ((a >>> 4) & 0x0F) + 3; // 3..18
      const distance = (((a & 0x0F) << 8) | b) + 1; // 1..4096
      for (let i = 0; i < length && outPos < outSize; i++) {
        const from = outPos - distance;
out[outPos++] = from >= 0 ? (out[from] ?? 0) : 0;
      }
    }
  }
  return out;
}
