import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

// CP0 IE gating: with IE=0 and IM2=1, pending MI interrupts should not be taken. Enabling IE triggers on next step.

describe('CP0 IE gating for MI pending', () => {
  it('with IE=0, pending SI is not taken; enabling IE triggers next step', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // IM2=1, IE=0
    const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IM2);

    // Enable SI mask and raise SI pending
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);
    bus.si.kickWrite64B();

    // Step: IE=0 -> no interrupt
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Enable IE and step: now take the interrupt
    cpu.cop0.write(12, cpu.cop0.read(12) | 1);
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack SI and clear EXL
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });
});

