import { readU32BE } from '../utils/bit.js';

export interface RomHeader {
  initialPC: number; // initial program counter from header
  title: string; // ASCII title if present
}

export function parseHeader(romBE: Uint8Array): RomHeader {
  // Minimal parse: initial PC at 0x8..0xB (big-endian), title at 0x20..0x33 (16 bytes)
  const initialPC = readU32BE(romBE, 0x8) >>> 0;
  const titleBytes = romBE.subarray(0x20, 0x20 + 20);
  let title = '';
  for (const b of titleBytes) {
    if (b === 0) break;
    title += String.fromCharCode(b);
  }
  return { initialPC, title };
}
