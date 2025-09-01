// CRC32 (IEEE 802.3) — hex string utility with no dependencies
const table: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i >>> 0;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) >>> 0 : (c >>> 1) >>> 0;
    t[i] = c >>> 0;
  }
  return t;
})();

export const crc32Hex = (data: Uint8Array | Uint8ClampedArray): string => {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ table[(crc ^ data[i]!) & 0xFF]!
  return (((~crc) >>> 0) >>> 0).toString(16).padStart(8, '0');
};
