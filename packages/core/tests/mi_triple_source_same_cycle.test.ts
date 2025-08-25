import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { runFrameLoop } from '../src/system/frame_loop.js';
import { MI_BASE, MI_INTR_MASK_OFF, SP_BASE, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Schedule SP start (SP+DP) and VI vblank in the same cycle; verify one ack for SP, DP, and VI

describe('Triple-source same-cycle: SP + DP + VI', () => {
  it('acks all three once when raised in the same cycle', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE/IM2 and MI masks for SP, DP, VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

    // At cycle 2, kick SP (which raises SP and DP), and also vblank VI
    sys.scheduleAt(2, () => bus.storeU32(SP_BASE + 0x00, 1));
    sys.scheduleAt(2, () => bus.vi.vblank());

    const res = runFrameLoop(cpu, bus, sys, 4);

    expect(res.spAcks).toBe(1);
    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);
    expect(res.steps).toBe(4);
  });
});

