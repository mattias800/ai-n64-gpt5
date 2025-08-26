export function crc32(data: Uint8Array): string {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < data.length; i++) {
    let c = (crc ^ data[i]!) & 0xFF;
    for (let k = 0; k < 8; k++) {
      const mask = -(c & 1);
      c = (c >>> 1) ^ (0xEDB88320 & mask);
    }
    crc = (crc >>> 8) ^ c;
  }
  crc = (~crc) >>> 0;
  return (crc >>> 0).toString(16).padStart(8, '0');
}
