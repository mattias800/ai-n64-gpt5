import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

// Helpers
function NOP() { return 0; }
function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('Combined MI (IP2) and CP0 timer (IP7) interrupts', () => {
  it('with both pending and masked-in, takes interrupt at boundary; Cause has both IP2 and IP7 set; EPC correct', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Program a few NOPs
    loadProgram(rdram, [NOP(), NOP(), NOP()], 0);

    // Enable IE, IM2 (IP2) and IM7 (IP7)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM2 | IM7);

    // Mask MI for SI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Arrange: set Count=0, Compare=1 -> IP7 on next tick; also assert SI pending now
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 1);
    bus.mi.raise(1 << 1);

    // Step once: at boundary, both IP2 and IP7 should be visible and interrupt taken
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();

    const status = cpu.cop0.read(12);
    const cause = cpu.cop0.read(13);
    expect((status & (1 << 1)) !== 0).toBe(true); // EXL set
    expect(((cause >>> 10) & 1)).toBe(1); // IP2
    expect(((cause >>> 15) & 1)).toBe(1); // IP7
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);
  });

  it('masking out IM7 prevents timer-only interrupts; enabling IM7 later causes immediate interrupt if Count==Compare', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    loadProgram(rdram, [NOP(), NOP(), NOP()], 0);

    // Enable IE and IM2 only (leave IM7 off)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    // Mask MI for SI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Prepare timer to hit next step; do not raise SI
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 1);

    const pc0 = cpu.pc >>> 0;
    cpu.step();
    // Without IM7, no interrupt should be taken (EXL=0), although Cause.IP7 may be pending
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(false);
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Now enable IM7; next step should take the timer interrupt immediately
    const st1 = cpu.cop0.read(12);
    cpu.cop0.write(12, st1 | (1 << (8 + 7)));
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);
  });
});

