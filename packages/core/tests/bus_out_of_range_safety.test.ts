import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';

// Loads/stores out of range should be safe: loads return 0, stores are ignored.

describe('Bus out-of-range safety', () => {
  it('returns 0 on load and ignores store for out-of-range addresses', () => {
    const rdram = new RDRAM(0x100);
    const bus = new Bus(rdram);

    // Choose an address beyond RDRAM and beyond MMIO windows
    const addr = 0x01000000 >>> 0; // 16MB, beyond our tiny RDRAM and not an MMIO base

    // Loads
    const v8 = bus.loadU8(addr);
    const v16 = bus.loadU16(addr);
    const v32 = bus.loadU32(addr);
    expect(v8 >>> 0).toBe(0);
    expect(v16 >>> 0).toBe(0);
    expect(v32 >>> 0).toBe(0);

    // Stores should not throw and should not change any in-range memory
    const before = new Uint8Array(rdram.bytes);
    bus.storeU8(addr, 0xAA);
    bus.storeU16(addr, 0xBBBB);
    bus.storeU32(addr, 0xCCCCCCCC);

    for (let i = 0; i < rdram.bytes.length; i++) expect(rdram.bytes[i]).toBe(before[i]);
  });
});

