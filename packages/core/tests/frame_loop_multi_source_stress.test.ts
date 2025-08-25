import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF, SP_BASE, SI_BASE, AI_BASE, AI_DRAM_ADDR_OFF, AI_LEN_OFF } from '../src/devices/mmio.js';

// Stress test: mixed SP/DP/VI/SI/AI sources over multiple cycles, verified via frame loop

describe('Frame loop multi-source stress: SP/DP/VI/SI/AI', () => {
  it('acks expected counts across 20 cycles with mixed scheduling', () => {
    const bus = new Bus(new RDRAM(1 << 16));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE/IM2 and MI masks for SP, DP, VI, SI, AI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3) | (1 << 1) | (1 << 2));

    // SP kick (also raises DP via stub) at cycles 2,7,12,17
    sys.scheduleEvery(2, 5, 4, () => bus.storeU32(SP_BASE + 0x00, 1));

    // VI vblank at cycles 3,6,9,12,15,18
    sys.scheduleEvery(3, 3, 6, () => bus.vi.vblank());

    // SI write64B at 4,10 and read64B at 8,14
    const sBase = 0x900;
    sys.scheduleAt(4, () => { bus.storeU32(SI_BASE + 0x00, sBase); bus.si.kickWrite64B(); });
    sys.scheduleAt(10, () => { bus.storeU32(SI_BASE + 0x00, sBase); bus.si.kickWrite64B(); });
    sys.scheduleAt(8, () => { bus.storeU32(SI_BASE + 0x00, sBase); bus.si.kickRead64B(); });
    sys.scheduleAt(14, () => { bus.storeU32(SI_BASE + 0x00, sBase); bus.si.kickRead64B(); });

    // AI completions at 5 and 13
    sys.scheduleAt(5, () => { bus.storeU32(AI_BASE + AI_DRAM_ADDR_OFF, 0x00100000); bus.storeU32(AI_BASE + AI_LEN_OFF, 0x100); bus.ai.completeDMA(); });
    sys.scheduleAt(13, () => { bus.storeU32(AI_BASE + AI_DRAM_ADDR_OFF, 0x00100000); bus.storeU32(AI_BASE + AI_LEN_OFF, 0x200); bus.ai.completeDMA(); });

    const total = 20;
    const res = runFrameLoop(cpu, bus, sys, total);

    // Expected counts
    // SP at 2,7,12,17 -> 4; DP also 4 due to SP stub
    // VI at 3,6,9,12,15,18 -> 6
    // SI at 4,8,10,14 -> 4
    // AI at 5,13 -> 2
    expect(res.spAcks).toBe(4);
    expect(res.dpAcks).toBe(4);
    expect(res.viAcks).toBe(6);
    expect(res.siAcks).toBe(4);
    expect(res.aiAcks).toBe(2);
    // No timer scheduled here
    expect(res.timerAcks).toBe(0);
    expect(res.steps).toBe(total);
  });
});

