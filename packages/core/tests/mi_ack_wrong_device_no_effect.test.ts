import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Acknowledging the wrong device should not clear other device pendings.

describe('Device-specific ack isolation', () => {
  it('acknowledging DP does not clear VI pending and vice versa', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE and IM2; enable MI mask for DP and VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

    // Raise both DP and VI
    bus.dp.raiseInterrupt();
    bus.vi.vblank();

    // Take interrupt
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);

    // Ack only DP; VI should remain pending
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);

    // Clear EXL and step again: should re-enter due to VI still pending
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Now ack VI and clear EXL
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));

    // No more interrupts pending now; next step should be normal advance
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));
  });
});

