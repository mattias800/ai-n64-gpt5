import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR } from '../src/devices/mmio.js';

// Verify DP STATUS ack is idempotent and a second DP raise re-triggers interrupt

describe('DP idempotent ack and re-raise', () => {
  it('STATUS ack is idempotent; re-raise causes another interrupt', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE/IM2 and MI mask for DP
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 5);

    // Raise DP and take interrupt
    bus.dp.raiseInterrupt();
    const expectedEPC0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC0 >>> 0);

    // Ack DP twice (idempotent)
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);

    // Clear EXL and step: should not re-enter (no pending now)
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));

    // Raise DP again; should cause another interrupt
    bus.dp.raiseInterrupt();
    const expectedEPC1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC1 >>> 0);

    // Cleanup ack
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
  });
});

