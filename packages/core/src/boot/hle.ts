import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { normalizeRomToBigEndian } from '../rom/byteorder.js';
import { parseHeader } from '../rom/header.js';

export interface BootResult {
  order: 'z64' | 'n64' | 'v64' | 'unknown';
  initialPC: number;
}

export function hleBoot(cpu: CPU, bus: Bus, rom: Uint8Array): BootResult {
  // Normalize ROM to big-endian and parse header
  const { data: beRom, order } = normalizeRomToBigEndian(rom);
  const header = parseHeader(beRom);

  // Stash ROM for PI to access and copy initial image into RDRAM starting at physical 0
  bus.setROM(beRom);
  const copyLen = Math.min(beRom.length, bus.rdram.bytes.length);
  bus.rdram.bytes.set(beRom.subarray(0, copyLen), 0);

  // Initialize CPU PC to initialPC from header
  cpu.pc = header.initialPC >>> 0;

  return { order, initialPC: header.initialPC >>> 0 };
}
