import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR } from '../src/devices/mmio.js';

// Verify that enabling MI mask for DP when DP is already pending triggers an interrupt at the next boundary

describe('MI mask enable for DP with pending set triggers immediate interrupt', () => {
  it('takes interrupt after enabling MI mask when DP pending was already set', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE and IM2; leave MI mask zero initially
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Raise DP pending while MI mask is off
    bus.dp.raiseInterrupt();

    // Step once: should not take interrupt (mask off)
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Enable MI mask for DP
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5));

    // Next step: should take interrupt now
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack DP and clear EXL to clean up
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });
});

