import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF, SI_BASE, AI_BASE, AI_DRAM_ADDR_OFF, AI_LEN_OFF } from '../src/devices/mmio.js';

// Verify frame loop acknowledges SI and AI interrupts

describe('Frame loop acknowledges SI and AI', () => {
  it('counts and acks SI write/read and AI DMA completion', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE/IM2 and MI masks for SI and AI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 1) | (1 << 2));

    // Prepare SI DRAM base
    const base = 0x800;

    // Schedule SI write64B at cycle 2 and SI read64B at cycle 4
    sys.scheduleAt(2, () => { bus.storeU32(SI_BASE + 0x00, base); bus.si.kickWrite64B(); });
    sys.scheduleAt(4, () => { bus.storeU32(SI_BASE + 0x00, base); bus.si.kickRead64B(); });

    // Schedule AI DMA completion at cycle 3 (start by writing DRAM addr and LEN, then complete)
    sys.scheduleAt(3, () => {
      bus.storeU32(AI_BASE + AI_DRAM_ADDR_OFF, 0x00100000);
      bus.storeU32(AI_BASE + AI_LEN_OFF, 0x100);
      bus.ai.completeDMA();
    });

    const res = runFrameLoop(cpu, bus, sys, 6);

    // Expect SI acks = 2 (write + read), AI acks = 1
    expect(res.siAcks).toBe(2);
    expect(res.aiAcks).toBe(1);
    // No DP/VI/SP planned here
    expect(res.dpAcks).toBe(0);
    expect(res.viAcks).toBe(0);
    expect(res.spAcks).toBe(0);
    expect(res.steps).toBe(6);
  });
});

