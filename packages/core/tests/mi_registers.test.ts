import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_OFF, MI_INTR_MASK_OFF, MI_INTR_PI } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('MI register and interrupt mask semantics', () => {
  it('sets/clears intr mask and manages pending bits; cpuIntAsserted reflects enabled pending', () => {
    const bus = new Bus(new RDRAM(1024));

    // Initial mask is 0
    expect(r32(bus, MI_BASE + MI_INTR_MASK_OFF)).toBe(0);

    // Set PI mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_PI);
    expect(r32(bus, MI_BASE + MI_INTR_MASK_OFF)).toBe(MI_INTR_PI >>> 0);

    // Clear PI mask using upper clear bits (shifted by 16)
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, (MI_INTR_PI << 16) >>> 0);
    expect(r32(bus, MI_BASE + MI_INTR_MASK_OFF)).toBe(0);

    // Pending set/clear via helper methods
    bus.mi.raise(MI_INTR_PI);
    expect(r32(bus, MI_BASE + MI_INTR_OFF)).toBe(MI_INTR_PI >>> 0);
    // With mask=0, CPU line should be deasserted
    expect(bus.mi.cpuIntAsserted()).toBe(false);

    // Enable mask; line should assert
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_PI);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Clear pending; line should deassert
    bus.mi.clear(MI_INTR_PI);
    expect(r32(bus, MI_BASE + MI_INTR_OFF)).toBe(0);
    expect(bus.mi.cpuIntAsserted()).toBe(false);
  });
});
