export function toUint32(x: number): number {
  return x >>> 0;
}

export function toInt32(x: number): number {
  return x | 0;
}

export function signExtend16(x: number): number {
  x = x & 0xffff;
  return (x & 0x8000) ? (x | 0xffff0000) : x;
}

export function zeroExtend16(x: number): number {
  return x & 0xffff;
}

export function signExtend8(x: number): number {
  x = x & 0xff;
  return (x & 0x80) ? (x | 0xffffff00) : x;
}

export function zeroExtend8(x: number): number {
  return x & 0xff;
}

export function readU16BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  return ((b0 << 8) | b1) >>> 0;
}

export function writeU16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  return (
    (b0 << 24) |
    (b1 << 16) |
    (b2 << 8) |
    (b3 << 0)
  ) >>> 0;
}

export function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

// 64-bit helpers via BigInt for deterministic HI/LO math
export function mul64Signed(a: number, b: number): { hi: number; lo: number } {
  const A = BigInt(asInt32(a));
  const B = BigInt(asInt32(b));
  const P = A * B;
  const lo = Number(P & BigInt(0xffffffff)) >>> 0;
  const hi = Number((P >> BigInt(32)) & BigInt(0xffffffff)) >>> 0;
  return { hi, lo };
}

export function mul64Unsigned(a: number, b: number): { hi: number; lo: number } {
  const A = BigInt(a >>> 0);
  const B = BigInt(b >>> 0);
  const P = A * B;
  const lo = Number(P & BigInt(0xffffffff)) >>> 0;
  const hi = Number((P >> BigInt(32)) & BigInt(0xffffffff)) >>> 0;
  return { hi, lo };
}

export function div32Signed(a: number, b: number): { q: number; r: number } {
  const A = BigInt(asInt32(a));
  const B = BigInt(asInt32(b));
  if (B === BigInt(0)) return { q: 0xffffffff >>> 0, r: a >>> 0 }; // MIPS: div by 0 -> q all ones, r = dividend
  const q = A / B;
  const r = A % B;
  return { q: Number(q) >>> 0, r: Number(r) >>> 0 };
}

export function div32Unsigned(a: number, b: number): { q: number; r: number } {
  const A = BigInt(a >>> 0);
  const B = BigInt(b >>> 0);
  if (B === BigInt(0)) return { q: 0xffffffff >>> 0, r: a >>> 0 };
  const q = A / B;
  const r = A % B;
  return { q: Number(q) >>> 0, r: Number(r) >>> 0 };
}

function asInt32(x: number): number {
  return x | 0;
}

