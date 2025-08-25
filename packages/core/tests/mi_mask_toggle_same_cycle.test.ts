import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Test enabling mask and raising DP+VI in the same cycle in both orders

describe('MI mask toggle in same system cycle with DP+VI events', () => {
  it('order: enable mask, then raise DP+VI in same cycle -> interrupt taken next step', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // IE+IM2 on; mask initially 0
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // At cycle 2, enable mask for DP+VI and raise both in the same cycle
    sys.scheduleAt(2, () => bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3)));
    sys.scheduleAt(2, () => bus.dp.raiseInterrupt());
    sys.scheduleAt(2, () => bus.vi.vblank());

    // Step cycle 1 (no events), then cycle 2 events fire; interrupt should be seen at boundary when stepping to cycle 3
    sys.stepCycles(1);
    const expectedEPC = cpu.pc >>> 0;
    sys.stepCycles(1);
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack both and clear EXL
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });

  it('order: raise DP+VI first, then enable mask in the same cycle -> interrupt taken next step', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // IE+IM2 on; mask initially 0
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // At cycle 3, raise DP+VI and then enable mask in same cycle
    sys.scheduleAt(3, () => bus.dp.raiseInterrupt());
    sys.scheduleAt(3, () => bus.vi.vblank());
    sys.scheduleAt(3, () => bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3)));

    // Advance to cycle 3; interrupt should be seen when stepping to cycle 4
    sys.stepCycles(2);
    const expectedEPC = cpu.pc >>> 0;
    sys.stepCycles(1);
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack both and clear EXL
    bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });
});

