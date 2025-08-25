import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Helpers
function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

// This suite stresses VI cadence edges with MI mask toggling in the same cycle.
// The System steps events first at a cycle boundary, then executes CPU.step().
// We validate that enabling the mask after pending is raised in the same cycle
// produces an immediate interrupt, while disabling the mask prior to raise blocks it.

describe('VI cadence edge cases with MI mask toggling', () => {
  it('mask enabled in same cycle after vblank pending => immediate CPU interrupt', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable IE and IM2 on CPU, but start with MI VI mask disabled
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Cycle 5: first raise VI vblank, then enable MI VI mask in the same cycle
    sys.scheduleAt(5, () => bus.vi.vblank());
    sys.scheduleAt(5, () => w32(bus, MI_BASE + MI_INTR_MASK_OFF, (1 << 3))); // enable VI mask

    // Step into cycle 5 and check interrupt taken
    let taken = 0;
    for (let i = 0; i < 6; i++) {
      const pcBefore = cpu.pc >>> 0;
      sys.stepCycles(1);
      if (((cpu.cop0.read(12) & (1 << 1)) !== 0) && (cpu.pc >>> 0) === (0x80000180 >>> 0)) {
        taken++;
        // Ack VI and clear EXL and restore PC
        w32(bus, VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
        const st = cpu.cop0.read(12);
        cpu.cop0.write(12, st & ~(1 << 1));
        cpu.pc = pcBefore >>> 0;
      }
    }
    expect(taken).toBe(1);
  });

  it('mask disabled in same cycle before vblank pending => no interrupt taken', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable IE and IM2 on CPU; pre-enable mask and then disable it in the critical cycle
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, (1 << 3)); // enable VI mask initially

    // Cycle 7: first disable mask via clear bits, then raise vblank in the same cycle
    // MI mask clear: write bits 16..21 set -> clear corresponding mask bits
    sys.scheduleAt(7, () => w32(bus, MI_BASE + MI_INTR_MASK_OFF, (1 << (16 + 3))));
    sys.scheduleAt(7, () => bus.vi.vblank());

    let taken = 0;
    for (let i = 0; i < 8; i++) {
      const pcBefore = cpu.pc >>> 0;
      sys.stepCycles(1);
      if (((cpu.cop0.read(12) & (1 << 1)) !== 0) && (cpu.pc >>> 0) === (0x80000180 >>> 0)) {
        taken++;
        // Ack and clear EXL to continue if any
        w32(bus, VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
        const st = cpu.cop0.read(12);
        cpu.cop0.write(12, st & ~(1 << 1));
        cpu.pc = pcBefore >>> 0;
      }
    }

    // VI pending may be set but masked; no interrupt taken
    expect(taken).toBe(0);
    // Verify MI pending has VI bit set (3rd bit) but intrMask no longer has it
    const miMask = r32(bus, MI_BASE + MI_INTR_MASK_OFF);
    const miPending = r32(bus, MI_BASE + 0x08);
    expect((miMask & (1 << 3)) === 0).toBe(true);
    expect((miPending & (1 << 3)) !== 0).toBe(true);
  });
});

