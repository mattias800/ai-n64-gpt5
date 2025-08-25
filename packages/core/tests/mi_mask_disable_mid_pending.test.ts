import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR } from '../src/devices/mmio.js';

// Disabling MI mask while pending should block interrupts; re-enabling should allow immediate handling.
// Pending bits remain until device-specific ack is performed.

describe('MI mask disable/enable mid-pending gating', () => {
  it('blocks pending VI when mask cleared, then triggers immediately on re-enable; pending remains until ack', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE and IM2
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Enable MI mask for VI and raise VI pending
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);
    bus.vi.vblank();

    // Step: take interrupt
    const expectedEPC0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC0 >>> 0);

    // Without acking VI, clear EXL and disable VI mask; step — should not re-enter
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    // Disable mask via clear bits in MI_INTR_MASK (upper 16)
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << (16 + 3)) >>> 0);
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));

    // Re-enable mask; next step should re-enter (pending still set)
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);
    const expectedEPC1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC1 >>> 0);

    // Ack VI and clear EXL
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });
});

