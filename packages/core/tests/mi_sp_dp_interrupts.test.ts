import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, MI_INTR_SP, MI_INTR_DP } from '../src/devices/mmio.js';
import { CPU } from '../src/cpu/cpu.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('MI SP/DP interrupts', () => {
  it('SP pending respects mask and asserts CPU interrupt line', () => {
    const bus = new Bus(new RDRAM(1024));
    // Initially masked
    expect(bus.mi.cpuIntAsserted()).toBe(false);

    // Enable SP mask and raise
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_SP);
    bus.mi.raise(MI_INTR_SP);

    // Pending bit set; cpuIntAsserted should be true
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & MI_INTR_SP) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Clear pending
    bus.mi.clear(MI_INTR_SP);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & MI_INTR_SP) !== 0).toBe(false);
    expect(bus.mi.cpuIntAsserted()).toBe(false);
  });

  it('CPU takes interrupt for SP when enabled (IP2 path)', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable IE and IM2 (IP2)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Enable SP mask in MI and raise SP pending
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_SP);
    bus.mi.raise(MI_INTR_SP);

    const pcBefore = cpu.pc >>> 0;
    cpu.step();

    const status = cpu.cop0.read(12);
    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);
    expect((status & (1 << 1)) !== 0).toBe(true);
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(0);
    expect(((cause >>> 10) & 1) !== 0).toBe(true); // IP2 set
    expect(epc >>> 0).toBe(pcBefore >>> 0);
  });

  it('DP pending respects mask and cpu line', () => {
    const bus = new Bus(new RDRAM(1024));
    // Enable DP mask and raise pending
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_DP);
    bus.mi.raise(MI_INTR_DP);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & MI_INTR_DP) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Clear pending
    bus.mi.clear(MI_INTR_DP);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & MI_INTR_DP) !== 0).toBe(false);
    expect(bus.mi.cpuIntAsserted()).toBe(false);
  });
});
