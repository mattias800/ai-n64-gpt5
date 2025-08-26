import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { normalizeRomToBigEndian } from '../rom/byteorder.js';

export interface PifBootResult {
  order: 'z64' | 'n64' | 'v64' | 'unknown';
  entryPC: number; // 0xA4000040
}

// Minimal PIF/IPL3 HLE boot:
// - Normalize ROM to big-endian and make it available to PI
// - Copy ROM[0x40..0x1000) into SP DMEM[0x40..0x1000)
// - Set CPU PC to 0xA4000040 to execute the game's boot code
export function hlePifBoot(cpu: CPU, bus: Bus, rom: Uint8Array): PifBootResult {
  const { data: beRom, order } = normalizeRomToBigEndian(rom);
  bus.setROM(beRom);

  // Clear DMEM and stage IPL3 (boot code)
  bus.sp.dmem.fill(0);
  const srcOff = 0x40 >>> 0;
  const endOff = Math.min(beRom.length, 0x1000) >>> 0;
  const copyLen = (endOff - srcOff) >>> 0;
  if (copyLen > 0) bus.sp.dmem.set(beRom.subarray(srcOff, endOff), srcOff);

  // CPU begins executing at 0xA4000040
  cpu.pc = 0xA4000040 >>> 0;
  return { order, entryPC: cpu.pc >>> 0 };
}
