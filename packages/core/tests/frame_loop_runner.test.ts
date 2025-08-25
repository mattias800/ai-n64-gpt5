import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT, SP_BASE } from '../src/devices/mmio.js';

// This test drives a simple frame loop with VI vblank and SP task kicks (which raise DP ints)
// to ensure the loop properly acks both DP and VI interrupts over multiple frames deterministically.

describe('Frame loop runner acks DP and VI interrupts over multiple frames', () => {
  it('runs N cycles, acks interrupts, and maintains deterministic CPU flow', () => {
    const rdram = new RDRAM(8192);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE and IM2 (IP2)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Enable MI mask for DP and VI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

    // Schedule VI vblank every 3 cycles; schedule SP task kicks every 4 cycles
    sys.scheduleEvery(1, 3, 4, () => bus.vi.vblank());
    sys.scheduleEvery(2, 4, 3, () => bus.storeU32(SP_BASE + 0x00, 1)); // SP_CMD_START at SP_CMD_OFF=0x00

    const res = runFrameLoop(cpu, bus, sys, 16);
    // Expect exactly 4 VI acks (times) and 3 DP acks; SP acks equal DP acks due to stub
    expect(res.viAcks).toBe(4);
    expect(res.dpAcks).toBe(3);
    expect(res.spAcks).toBe(3);
    expect(res.steps).toBe(16);
  });
});

