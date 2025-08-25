import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Enabling MI mask for VI with pending already set should cause an immediate interrupt on next boundary

describe('MI mask enable with VI pending set triggers interrupt next boundary', () => {
  it('takes interrupt after enabling MI mask when VI was already pending', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE and IM2 only; leave MI mask=0
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Raise VI pending while mask is off
    bus.vi.vblank();

    // Step once: no interrupt taken (mask off)
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Enable MI mask for VI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

    // Next step: take interrupt
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack VI and clear EXL
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });
});

