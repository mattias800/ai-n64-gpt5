import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function NOP() { return 0; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('CP0 timer interrupt EXL gating', () => {
  it('defers timer interrupt while EXL=1 and takes it immediately after EXL clears', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable IE and IM7 (timer), leave EXL=0
    const IE = 1 << 0; const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM7);

    loadProgram(bus.rdram, [NOP(), NOP(), NOP()], 0);

    // Set timer to fire on next step
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 1);

    // Force EXL=1 before stepping, so interrupt is deferred
    cpu.cop0.write(12, cpu.cop0.read(12) | (1 << 1));

    const pc0 = cpu.pc >>> 0;
    cpu.step(); // Count==1, IP7 pending, but EXL prevents taking interrupt
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true); // EXL still set
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0)); // normal advance

    // Clear EXL and step: should take the interrupt now
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();

    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true); // EXL set due to interrupt
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);
  });
});

