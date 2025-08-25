import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function SH(rt: number, rs: number, imm16: number) { return (0x29 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('AddressErrorStore in a branch delay slot', () => {
  it('SH unaligned in delay slot sets BD=1, EPC=branch PC, BadVAddr, vectors to 0x80000180', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Ensure BEV=0
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Program: BEQ taken; delay slot is unaligned SH to address 1
    loadProgram(bus.rdram, [
      BEQ(0, 0, 1),
      SH(0, 0, 1),
      0,
    ], 0);

    // Step BEQ
    cpu.step();
    // Execute delay slot -> should throw AddressErrorStore
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;

    expect((cause >>> 31) !== 0).toBe(true); // BD
    expect(((cause >>> 2) & 0x1f)).toBe(5); // AddressErrorStore
    expect(epc >>> 0).toBe(0 >>> 0);
    expect(badv >>> 0).toBe(1 >>> 0);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});

