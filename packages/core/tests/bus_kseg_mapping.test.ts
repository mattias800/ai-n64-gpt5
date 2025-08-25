import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { readU32BE, writeU32BE } from '../src/utils/bit.js';

function phys(addr: number) { return addr >>> 0; }

// Verify KSEG0/KSEG1 mapping behavior for RDRAM and MMIO

describe('Bus KSEG0/KSEG1 mapping', () => {
  it('maps KSEG0 (0x8000_0000) and KSEG1 (0xA000_0000) to physical RDRAM', () => {
    const rdram = new RDRAM(0x2000);
    const bus = new Bus(rdram);

    // Write a pattern into RDRAM at physical 0x100
    writeU32BE(rdram.bytes, 0x100, 0xDEADBEEF >>> 0);

    // Read via KSEG0 address 0x80000100
    const kseg0Addr = (0x80000000 >>> 0) + 0x100;
    const val0 = bus.loadU32(kseg0Addr);
    expect(val0 >>> 0).toBe(0xDEADBEEF >>> 0);

    // Read via KSEG1 address 0xA0000100
    const kseg1Addr = (0xA0000000 >>> 0) + 0x100;
    const val1 = bus.loadU32(kseg1Addr);
    expect(val1 >>> 0).toBe(0xDEADBEEF >>> 0);

    // Store via KSEG1 and read back physically
    const kseg1Store = (0xA0000000 >>> 0) + 0x104;
    bus.storeU32(kseg1Store, 0xCAFEBABE >>> 0);
    expect(readU32BE(rdram.bytes, 0x104) >>> 0).toBe(0xCAFEBABE >>> 0);
  });

  it('maps KSEG1 access to MMIO bases to device registers', () => {
    const rdram = new RDRAM(0x2000);
    const bus = new Bus(rdram);

    // Use MI registers as a probe
    const MI_BASE = 0x04300000 >>> 0;
    const MI_INTR_MASK_OFF = 0x0C;
    // KSEG1 address for MI_INTR_MASK
    const kseg1MiMask = (0xA0000000 >>> 0) + (MI_BASE >>> 0) + (MI_INTR_MASK_OFF >>> 0);

    // Write via KSEG1; then read via physical to confirm
    bus.storeU32(kseg1MiMask, 1 << 3);
    const physMask = (MI_BASE + MI_INTR_MASK_OFF) >>> 0;
    expect(bus.loadU32(physMask) >>> 0).toBe((1 << 3) >>> 0);
  });
});

