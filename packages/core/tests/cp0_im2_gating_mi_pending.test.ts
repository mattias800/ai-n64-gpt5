import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

// Verify CP0 IM2 gates MI-driven interrupts; enabling IM2 later triggers pending immediately

describe('CP0 IM2 gating for MI pending', () => {
  it('with IM2=0, pending DP is not taken; enabling IM2 triggers interrupt next step', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // IE=1, IM2=0 initially
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE);

    // Enable MI mask for DP and raise DP pending
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 5);
    bus.dp.raiseInterrupt();

    // Step: no interrupt should be taken because IM2=0
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Now enable IM2 and step: interrupt should fire
    cpu.cop0.write(12, cpu.cop0.read(12) | IM2);
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);
  });
});

