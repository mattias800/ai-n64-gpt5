import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';

// Helpers
function write32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function read32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('MMIO device scaffolding', () => {
  it('routes 32-bit reads/writes to MI/SP/DP/VI/AI/PI/SI regions', () => {
    const bus = new Bus(new RDRAM(1024));
    // Write unique values to each device base and read back
    write32(bus, 0x04300000, 0x11112222); // MI
    write32(bus, 0x04000000, 0xaaaaaaaa); // SP
    write32(bus, 0x04100000, 0xbbbbbbbb); // DP
    write32(bus, 0x04400000, 0x33334444); // VI
    write32(bus, 0x04500000, 0x55556666); // AI
    write32(bus, 0x04600000, 0x77778888); // PI
    write32(bus, 0x04800000, 0x9999aaaa); // SI

    expect(read32(bus, 0x04300000)).toBe(0x11112222);
    expect(read32(bus, 0x04000000)).toBe(0xaaaaaaaa >>> 0);
    expect(read32(bus, 0x04100000)).toBe(0xbbbbbbbb >>> 0);
    expect(read32(bus, 0x04400000)).toBe(0x33334444);
    expect(read32(bus, 0x04500000)).toBe(0x55556666);
    expect(read32(bus, 0x04600000)).toBe(0x77778888);
    expect(read32(bus, 0x04800000)).toBe(0x9999aaaa >>> 0);
  });

  it('leaves RDRAM accesses unaffected', () => {
    const bus = new Bus(new RDRAM(1024));
    const addr = 0x00000010;
    bus.storeU32(addr, 0xdeadbeef);
    expect(bus.loadU32(addr) >>> 0).toBe(0xdeadbeef >>> 0);
  });
});

