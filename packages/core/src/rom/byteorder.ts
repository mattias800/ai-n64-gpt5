export type RomByteOrder = 'z64' | 'n64' | 'v64' | 'unknown';

export function detectByteOrder(bytes: Uint8Array): RomByteOrder {
  if (bytes.length < 4) return 'unknown';
  const b0 = bytes[0]!, b1 = bytes[1]!, b2 = bytes[2]!, b3 = bytes[3]!;
  const magic = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  switch (magic >>> 0) {
    case 0x80371240: return 'z64'; // big-endian
    case 0x40123780: return 'n64'; // little-endian
    case 0x37804012: return 'v64'; // byteswapped (16-bit)
    default: return 'unknown';
  }
}

export function normalizeRomToBigEndian(src: Uint8Array): { data: Uint8Array; order: RomByteOrder } {
  const order = detectByteOrder(src);
  const out = new Uint8Array(src.length);
  if (order === 'z64') {
    out.set(src);
  } else if (order === 'n64') {
    // 32-bit little-endian -> big-endian per word
    for (let i = 0; i + 3 < src.length; i += 4) {
      out[i + 0] = src[i + 3]!;
      out[i + 1] = src[i + 2]!;
      out[i + 2] = src[i + 1]!;
      out[i + 3] = src[i + 0]!;
    }
  } else if (order === 'v64') {
    // 16-bit byteswapped: swap each adjacent pair
    for (let i = 0; i + 1 < src.length; i += 2) {
      out[i + 0] = src[i + 1]!;
      out[i + 1] = src[i + 0]!;
    }
  } else {
    // Unknown: pass-through
    out.set(src);
  }
  return { data: out, order };
}
