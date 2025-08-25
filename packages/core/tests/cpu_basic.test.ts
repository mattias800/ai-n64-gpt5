import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Simple assembler helpers for tests
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDIU(rt: number, rs: number, imm16: number) { return (0x09 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDU(rd: number, rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (0 << 6) | 0x21; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('CPU basic instructions', () => {
  it('executes LUI/ORI/ADDIU/ADDU and preserves $zero', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const prog = [
      LUI(1, 0x1234),           // r1 = 0x12340000
      ORI(1, 1, 0x5678),        // r1 = 0x12345678
      ADDIU(2, 1, 0x0001),      // r2 = 0x12345679
      ADDU(3, 0, 2),            // r3 = r2
      ORI(0, 0, 0xffff)         // attempt to write $zero
    ];

    loadProgram(rdram, prog, 0);

    for (let i = 0; i < prog.length; i++) cpu.step();

    expect(cpu.pc).toBe(4 * prog.length);
    expect(cpu['regs'][1] >>> 0).toBe(0x12345678 >>> 0);
    expect(cpu['regs'][2] >>> 0).toBe(0x12345679 >>> 0);
    expect(cpu['regs'][3] >>> 0).toBe(0x12345679 >>> 0);
    expect(cpu['regs'][0] >>> 0).toBe(0);
  });
});

