import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

// This test uses a simple scheduler to simulate periodic VI vblank events
// and assert MI pending cadence and CPU interrupt handling.
describe('Deterministic VI tick scheduler', () => {
  it('fires vblank every N cycles; MI pending toggles; CPU takes interrupts with IE/IM', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable MI mask for VI
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, (1 << 3));
    // Enable IE and IM2 (MI aggregated external interrupt maps to CPU IP2)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    const vblankInterval = 5; // every 5 cycles
    const times = 3;

    sys.scheduleEvery(5, vblankInterval, times, () => bus.vi.vblank());

    // Step through cycles and observe interrupts taken
    let taken = 0;
    for (let i = 0; i < 30; i++) {
      const pcBefore = cpu.pc >>> 0;
      sys.stepCycles(1);
      // If interrupt taken, EXL set and PC moved to vector
      if (((cpu.cop0.read(12) & (1 << 1)) !== 0) && (cpu.pc >>> 0) === (0x80000180 >>> 0)) {
        taken++;
        // Ack VI pending via STATUS write to clear and allow subsequent interrupts
        w32(bus, VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
        // Also clear EXL by simulating an ERET at vector (we won't execute code at vector, but for test we'll directly clear EXL)
        const st = cpu.cop0.read(12);
        cpu.cop0.write(12, st & ~(1 << 1));
        // Return PC to 0 to keep the loop simple
        cpu.pc = pcBefore >>> 0;
      }
    }

    // We expect exactly `times` interrupts taken
    expect(taken).toBe(times);
  });
});
