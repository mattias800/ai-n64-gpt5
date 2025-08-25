import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('CP0 timer interrupt during branch delay sets BD and EPC to branch PC', () => {
  it('fires after delay slot before branch commit and sets BD=1, EPC=branch PC', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable IE and IM7
    const IE = 1 << 0; const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM7);

    // Program: BEQ (taken), delay slot ORI, then a NOP at target (implicit)
    loadProgram(bus.rdram, [
      BEQ(0, 0, 1), // at 0
      ORI(1, 0, 0x1234), // delay slot at 4
      0, // placeholder at target (8)
    ], 0);

    // Arrange timer to fire exactly after executing delay slot: Count=0, Compare=2 (step1: Count=1; step2: Count=2 => fire)
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 2);

    // Step BEQ: schedules delay slot
    cpu.step();
    // Step delay slot: after executing delay slot, timer asserts; interrupt is taken at the next boundary before branch commit
    cpu.step();

    // Next step should take the timer interrupt with BD set and EPC at branch PC
    cpu.step();

    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);

    expect((cause >>> 31) !== 0).toBe(true); // BD set
    expect(epc >>> 0).toBe(0 >>> 0); // EPC = branch PC
    // Delay slot should have executed and set r1
    expect(cpu.regs[1] >>> 0).toBe(0x00001234 >>> 0);
    // Branch target must not have executed yet
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});

