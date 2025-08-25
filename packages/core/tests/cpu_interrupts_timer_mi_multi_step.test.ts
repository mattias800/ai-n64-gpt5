import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

// Multi-step sequencing of MI (VI) and CP0 timer (IP7) with EXL gating

describe('CP0 timer + MI multi-step with EXL gating', () => {
  it('VI first (non-BD), then timer under EXL, then timer triggers after EXL clears', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable IE, IM2, IM7; mask VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM2 | IM7);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

    // Timer will hit at Count==2
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 2);

    // Raise VI pending now
    bus.vi.vblank();

    // Step 1: take MI (VI) interrupt at boundary (non-BD)
    const epc0 = cpu.pc >>> 0;
    cpu.step();
    let status = cpu.cop0.read(12) >>> 0;
    let cause = cpu.cop0.read(13) >>> 0;
    expect((status & (1 << 1)) !== 0).toBe(true); // EXL set
    expect(((cause >>> 10) & 1)).toBe(1); // IP2
    expect(cpu.cop0.read(14) >>> 0).toBe(epc0 >>> 0);

    // Step 2: with EXL still set, Count advances to 2 (IP7 sets) but no exception taken
    const pc1 = cpu.pc >>> 0;
    cpu.step();
    status = cpu.cop0.read(12) >>> 0;
    cause = cpu.cop0.read(13) >>> 0;
    expect(((cause >>> 15) & 1)).toBe(1); // IP7 set
    expect((status & (1 << 1)) !== 0).toBe(true); // EXL stays set
    expect(cpu.pc >>> 0).toBe(((pc1 + 4) >>> 0));

    // Ack VI, clear EXL
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, status & ~(1 << 1));

    // Step 3: should now take the timer interrupt (IP7) at boundary (non-BD)
    const epc2 = cpu.pc >>> 0;
    cpu.step();
    status = cpu.cop0.read(12) >>> 0;
    cause = cpu.cop0.read(13) >>> 0;
    expect((status & (1 << 1)) !== 0).toBe(true);
    expect(((cause >>> 15) & 1)).toBe(1);
    expect(cpu.cop0.read(14) >>> 0).toBe(epc2 >>> 0);

    // Clear IP7 by writing Compare; clear EXL and step; no further interrupts
    cpu.cop0.write(11, 100);
    cpu.cop0.write(12, status & ~(1 << 1));
    const pc3 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc3 + 4) >>> 0));
  });
});

