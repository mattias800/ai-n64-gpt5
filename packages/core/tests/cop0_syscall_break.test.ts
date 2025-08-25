import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

function NOP() { return 0; }
function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function SYSCALL() { return (0x00 << 26) | 0x0c; }
function BREAK() { return (0x00 << 26) | 0x0d; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('SYSCALL and BREAK exceptions', () => {
  it('SYSCALL sets EXL and ExcCode=8 with correct EPC and vectors to 0x80000180', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Ensure BEV=0 so exception vector is 0x80000180
    const statusBefore = cpu.cop0.read(12) & ~(1 << 22);
    cpu.cop0.write(12, statusBefore);

    // Place SYSCALL at 0
    loadProgram(rdram, [SYSCALL()], 0);

    const pcBefore = cpu.pc >>> 0;
    cpu.step();

    const status = cpu.cop0.read(12);
    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);

    expect((status & (1 << 1)) !== 0).toBe(true); // EXL set
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(8); // Syscall
    expect(epc >>> 0).toBe(pcBefore >>> 0);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });

  it('BREAK in delay slot sets BD and EPC=branch PC', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const statusBefore = cpu.cop0.read(12) & ~(1 << 22);
    cpu.cop0.write(12, statusBefore);

    // Program: BEQ r0,r0,+1; BREAK (delay slot)
    loadProgram(rdram, [BEQ(0,0,1), BREAK()], 0);

    // Step BEQ, then BREAK in delay slot triggers exception
    cpu.step();
    cpu.step();

    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(9);
    expect((cause >>> 31) !== 0).toBe(true); // BD set
    expect(epc >>> 0).toBe(0 >>> 0); // EPC = branch PC
  });
});
