import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF, SP_BASE } from '../src/devices/mmio.js';

// Verify frame loop handles combined MI (DP/VI) and CP0 timer (IP7) interrupts deterministically

describe('Frame loop with combined MI (DP/VI) and CP0 timer (IP7)', () => {
  it('acks DP, VI, SP and timer interrupts; clears EXL each time', () => {
    const bus = new Bus(new RDRAM(1 << 16));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE, IM2 (IP2) and IM7 (IP7)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM2 | IM7);
    // Enable MI mask for DP and VI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

    // Schedule VI every 5 cycles starting at 2 (cycles: 2,7)
    sys.scheduleEvery(2, 5, 2, () => bus.vi.vblank());
    // Schedule SP tasks (which raise SP and DP) every 6 cycles starting at 3 (cycles: 3,9)
    sys.scheduleEvery(3, 6, 2, () => bus.storeU32(SP_BASE + 0x00, 1));

    // Program CP0 timer: Count=0, Compare=5 -> timer interrupt at cycle 5
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 5);
    // Re-arm timer later: at cycle 9, set Compare to 13 -> interrupt at cycle 13
    sys.scheduleAt(9, () => cpu.cop0.write(11, 13));

    const total = 16;
    const res = runFrameLoop(cpu, bus, sys, total);

    expect(res.viAcks).toBe(2); // cycles 2,7
    expect(res.dpAcks).toBe(2); // cycles 3,9
    expect(res.spAcks).toBe(2); // SP acks alongside DP due to stub behavior
    expect(res.timerAcks).toBe(2); // cycles 5,13
    expect(res.steps).toBe(total);

    // Ensure EXL not set at the end
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
  });
});
