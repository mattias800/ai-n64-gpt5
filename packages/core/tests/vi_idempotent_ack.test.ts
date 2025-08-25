import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Verify VI STATUS ack is idempotent and pending clears correctly

describe('VI idempotent STATUS ack', () => {
  it('double STATUS write is harmless; pending stays cleared', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE/IM2 and MI mask for VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

    // Raise VI and take interrupt
    bus.vi.vblank();
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack VI twice (idempotent)
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);

    // Clear EXL and step: should not re-enter
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));
  });
});

