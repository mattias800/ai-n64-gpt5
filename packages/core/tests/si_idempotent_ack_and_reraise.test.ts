import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

// Validate SI interrupts: STATUS ack idempotency and re-raise on subsequent DMA

describe('SI idempotent ack and re-raise', () => {
  it('acknowledges SI via STATUS and can re-trigger after kick/read completion', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE/IM2 and MI mask for SI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Kick a write64B then read64B to raise SI twice
    // Prepare RDRAM region for write kick
    const base = 0x800;
    bus.storeU32(SI_BASE + 0x00, base);
    bus.si.kickWrite64B();

    // Should take interrupt (SI)
    const epc0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(epc0 >>> 0);

    // Ack SI twice (idempotent)
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

    // Clear EXL and step: no re-entry
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));

    // Re-trigger by kicking read64B
    bus.storeU32(SI_BASE + 0x00, base);
    bus.si.kickRead64B();
    const epc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(epc1 >>> 0);

    // Cleanup ack
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
  });
});

