import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY, MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

function writeBlock64(bytes: Uint8Array, off: number, base: number) {
  for (let i = 0; i < 64; i++) bytes[off + i] = ((base + i) & 0xff) >>> 0;
}

describe('SI PIF integration with CPU interrupts via scheduler', () => {
  it('CPU takes interrupts for SI kickWrite and kickRead; DRAM gets PIF response', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable IE and IM2 (IP2)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    const base = 0x0800;
    rdram.bytes[base + 0] = 0x11; // read controller state command

    // Enable MI mask for SI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Schedule SI write kick at cycle 1
    sys.scheduleAt(1, () => {
      bus.storeU32(SI_BASE + 0x00, base);
      bus.si.kickWrite64B();
    });

    // Run one cycle: event runs, then CPU should see MI pending and take interrupt
    const pc0 = cpu.pc >>> 0;
    sys.stepCycles(1);
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);

    // Ack SI pending; clear EXL and restore PC for next step
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    const st = cpu.cop0.read(12);
    cpu.cop0.write(12, st & ~(1 << 1));
    cpu.pc = pc0;

    // Schedule SI read back at cycle 3
    sys.scheduleAt(3, () => {
      bus.storeU32(SI_BASE + 0x00, base);
      bus.si.kickRead64B();
    });

    // Step cycles 2 and 3: at cycle 3 CPU should take second interrupt
    sys.stepCycles(1); // cycle 2 - no event
    const pc1 = cpu.pc >>> 0;
    sys.stepCycles(1); // cycle 3 - event + interrupt
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);

    // Ack and clear again
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    const st2 = cpu.cop0.read(12);
    cpu.cop0.write(12, st2 & ~(1 << 1));
    cpu.pc = pc1;

    // Verify DRAM now contains the controller state response
    expect(rdram.bytes[base + 1]).toBe(0x00);
    expect(rdram.bytes[base + 2]).toBe(0x12);
    expect(rdram.bytes[base + 3]).toBe(0x34);
    expect(rdram.bytes[base + 4]).toBe(0x05);
    expect(rdram.bytes[base + 5]).toBe(0xFB);
  });
});
