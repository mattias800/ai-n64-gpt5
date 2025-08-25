import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF, SP_BASE } from '../src/devices/mmio.js';

// Stress the frame loop with many cycles and relatively prime VI/DP intervals
// to ensure stable counts and no lingering EXL states.

describe('Long-run frame loop stability', () => {
  it('acks expected number of DP/VI over 1000 cycles without lingering EXL', () => {
    const bus = new Bus(new RDRAM(1 << 18));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU interrupts and MI masks for DP/VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

    // Schedule VI every 5 cycles starting at 1, DP via SP kick every 11 cycles starting at 2
    sys.scheduleEvery(1, 5, 1000, () => bus.vi.vblank());
    sys.scheduleEvery(2, 11, 1000, () => bus.storeU32(SP_BASE + 0x00, 1));

    const total = 1000;
    const res = runFrameLoop(cpu, bus, sys, total);

    // Expected counts: floor((total - start)/interval) + 1 when within range.
    // VI: cycles at 1,6,11,... <= 1000 -> Math.floor((1000-1)/5)+1 = 200
    // DP: cycles at 2,13,24,... <= 1000 -> Math.floor((1000-2)/11)+1 = 91
    expect(res.viAcks).toBe(Math.floor((total - 1) / 5) + 1);
    expect(res.dpAcks).toBe(Math.floor((total - 2) / 11) + 1);
    expect(res.spAcks).toBe(Math.floor((total - 2) / 11) + 1);
    expect(res.steps).toBe(total);

    // Ensure EXL not set at the end
    expect((cpu.cop0.read(12) & (1 << 1)) !== 0).toBe(false);
  });
});

