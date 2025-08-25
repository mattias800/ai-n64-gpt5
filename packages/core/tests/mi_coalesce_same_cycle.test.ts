import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

// Ensure MI coalesces multiple same-cycle raises into a single pending per device

describe('MI coalescing: multiple device raises in same cycle -> single ack per device', () => {
  it('coalesces VI and DP raises when scheduled together', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE, IM2 and MI masks for DP and VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

    // Schedule two VI vblanks and two DP raises in the same cycle (cycle 3)
    sys.scheduleAt(3, () => bus.vi.vblank());
    sys.scheduleAt(3, () => bus.vi.vblank());
    sys.scheduleAt(3, () => bus.dp.raiseInterrupt());
    sys.scheduleAt(3, () => bus.dp.raiseInterrupt());

    const res = runFrameLoop(cpu, bus, sys, 5);

    expect(res.viAcks).toBe(1);
    expect(res.dpAcks).toBe(1);
    expect(res.spAcks).toBe(0);
    expect(res.timerAcks).toBe(0);
    expect(res.steps).toBe(5);
  });
});

