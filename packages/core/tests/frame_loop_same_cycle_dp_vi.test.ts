import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

// Schedules DP and VI interrupts at the same cycle repeatedly and ensures
// the frame loop acks both in that cycle deterministically.

describe('Frame loop: DP and VI pending in the same cycle are both acknowledged', () => {
  it('acks both DP and VI when scheduled together', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE + IM2 and MI masks for DP+VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

    // Schedule DP and VI on cycles 2 and 4
    sys.scheduleAt(2, () => { bus.dp.raiseInterrupt(); bus.vi.vblank(); });
    sys.scheduleAt(4, () => { bus.dp.raiseInterrupt(); bus.vi.vblank(); });

    const res = runFrameLoop(cpu, bus, sys, 6);

    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);
    expect(res.steps).toBe(6);
  });
});

