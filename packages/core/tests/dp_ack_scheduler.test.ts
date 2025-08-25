import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR } from '../src/devices/mmio.js';

// This test simulates a minimal RDP task acknowledgment loop:
// - CPU enables IE/IM2 and MI mask for DP
// - A scheduled event sets a fake display list pointer (omitted here) and raises DP interrupt
// - CPU takes interrupt at boundary; handler is simulated by clearing DP pending via STATUS write and clearing EXL
// - Repeat for a few frames

describe('RDP task acknowledgment (stub) with scheduler and CPU interrupts', () => {
  it('acknowledges DP interrupts across multiple scheduled frames', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE and IM2
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Enable MI mask for DP
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 5);

    // Schedule three DP task completions over frames 2, 4, 6
    sys.scheduleAt(2, () => bus.dp.raiseInterrupt());
    sys.scheduleAt(4, () => bus.dp.raiseInterrupt());
    sys.scheduleAt(6, () => bus.dp.raiseInterrupt());

    let taken = 0;
    for (let i = 0; i < 8; i++) {
      const savedPC = cpu.pc >>> 0;
      sys.stepCycles(1);
      // If interrupt taken (EXL set and PC at vector), simulate handler
      if (((cpu.cop0.read(12) & (1 << 1)) !== 0) && (cpu.pc >>> 0) === (0x80000180 >>> 0)) {
        taken++;
        // Ack DP pending by STATUS write
        bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
        // Clear EXL
        const st = cpu.cop0.read(12);
        cpu.cop0.write(12, st & ~(1 << 1));
        // Restore PC to continue next cycle in a simple loop
        cpu.pc = savedPC >>> 0;
      }
    }

    expect(taken).toBe(3);
  });
});

