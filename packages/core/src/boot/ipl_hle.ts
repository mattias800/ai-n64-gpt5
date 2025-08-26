import { Bus } from '../mem/bus.js';
import { hlePiLoadSegments } from './loader.js';

export type IplHleOptions = {
  initialPC: number;
  cartStart?: number; // default 0
  length?: number;    // default min(rom.length - cartStart, 2MiB)
};

export type IplHleResult = {
  dramAddr: number;
  cartAddr: number;
  length: number;
};

export function hleIplStage(bus: Bus, rom: Uint8Array, opts: IplHleOptions): IplHleResult {
  const pc = opts.initialPC >>> 0;
  const basePhys = (pc - 0x80000000) >>> 0;
  const cartAddr = (opts.cartStart ?? 0) >>> 0;
  const maxLen = Math.max(0, rom.length - cartAddr) >>> 0;
  const want = opts.length ?? (2 * 1024 * 1024);
  const length = Math.min(maxLen, want >>> 0) >>> 0;
  // Clamp within RDRAM
  const dramAddr = basePhys >>> 0;
  if (dramAddr + length > bus.rdram.bytes.length) {
    // reduce length to fit
    const fit = Math.max(0, bus.rdram.bytes.length - dramAddr) >>> 0;
    hlePiLoadSegments(bus as any, [ { cartAddr, dramAddr, length: fit } ], true);
    return { dramAddr, cartAddr, length: fit };
  }
  hlePiLoadSegments(bus as any, [ { cartAddr, dramAddr, length } ], true);
  return { dramAddr, cartAddr, length };
}
