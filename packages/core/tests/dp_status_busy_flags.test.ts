import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, DP_STATUS_BUSY, DP_STATUS_PIPE_BUSY } from '../src/devices/mmio.js';

// Verify DP BUSY/PIPE_BUSY flags set on raise and cleared on STATUS ack

describe('DP status BUSY/PIPE_BUSY flags', () => {
  it('sets BUSY and PIPE_BUSY on raiseInterrupt; clears them on STATUS ack; idempotent', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE/IM2 and MI mask for DP
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 5);

    // Raise DP -> should set busy flags and trigger interrupt
    bus.dp.raiseInterrupt();
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Read DP status: BUSY and PIPE_BUSY should be set
    const stBefore = bus.loadU32(DP_BASE + DP_STATUS_OFF) >>> 0;
    expect((stBefore & DP_STATUS_BUSY) !== 0).toBe(true);
    expect((stBefore & DP_STATUS_PIPE_BUSY) !== 0).toBe(true);

    // Ack DP: flags should clear; ack twice to verify idempotency
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);

    const stAfter = bus.loadU32(DP_BASE + DP_STATUS_OFF) >>> 0;
    expect((stAfter & (DP_STATUS_BUSY | DP_STATUS_PIPE_BUSY)) === 0).toBe(true);

    // Clear EXL and step: should not re-enter
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));
  });
});

