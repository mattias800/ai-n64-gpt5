import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('CP0 AddressError in a branch delay slot', () => {
  it('sets BD=1, EPC=branch PC, BadVAddr, and vectors to 0x80000180', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Ensure BEV=0
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Program: BEQ taken; delay slot is unaligned LW from address 2 (BadVAddr=2)
    loadProgram(bus.rdram, [
      BEQ(0, 0, 1),
      LW(1, 0, 2),
      0,
    ], 0);

    // Step BEQ (schedules delay slot)
    cpu.step();

    // Execute delay slot: should cause AddressErrorLoad; exception taken before branch commit
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const status = cpu.cop0.read(12) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;

    expect((cause >>> 31) !== 0).toBe(true); // BD
    expect(((cause >>> 2) & 0x1f)).toBe(4); // AddressErrorLoad
    expect(epc >>> 0).toBe(0 >>> 0); // EPC is branch instruction address
    expect(badv >>> 0).toBe(2 >>> 0);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});

