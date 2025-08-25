import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { MI_BASE, MI_INTR_MASK_OFF, AI_BASE, AI_LEN_OFF, AI_DRAM_ADDR_OFF, AI_STATUS_OFF, AI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

// Validate AI interrupts ack and can be re-raised; STATUS ack is idempotent

describe('AI idempotent ack and re-raise', () => {
  it('acknowledges AI interrupt via STATUS and can re-trigger after completion', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable CPU IE/IM2 and MI mask for AI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 2);

    // Start an AI DMA by writing DRAM address and LEN; then complete to raise MI
    bus.storeU32(AI_BASE + AI_DRAM_ADDR_OFF, 0x00100000);
    bus.storeU32(AI_BASE + AI_LEN_OFF, 0x100);
    bus.ai.completeDMA();

    // Should take interrupt now
    const expectedEPC0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC0 >>> 0);

    // Ack AI via STATUS write; idempotent double ack
    bus.storeU32(AI_BASE + AI_STATUS_OFF, AI_STATUS_DMA_BUSY);
    bus.storeU32(AI_BASE + AI_STATUS_OFF, AI_STATUS_DMA_BUSY);

    // Clear EXL and step: no re-entry
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));

    // Re-trigger another AI completion -> should take another interrupt
    bus.ai.completeDMA();
    const expectedEPC1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC1 >>> 0);

    // Cleanup ack
    bus.storeU32(AI_BASE + AI_STATUS_OFF, AI_STATUS_DMA_BUSY);
  });
});

