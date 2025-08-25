import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';
import { CPUException } from '../src/cpu/exceptions.js';

function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADD(rt: number, rs: number, rt2: number) { return (0x00 << 26) | (rs << 21) | (rt2 << 16) | (rt << 11) | (0 << 6) | 0x20; }
function ADDI(rt: number, rs: number, imm16: number) { return (0x08 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LWL(rt: number, rs: number, imm16: number) { return (0x22 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LWR(rt: number, rs: number, imm16: number) { return (0x26 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SWL(rt: number, rs: number, imm16: number) { return (0x2a << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SWR(rt: number, rs: number, imm16: number) { return (0x2e << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('ADD/ADDI overflow semantics', () => {
  it('ADD overflows when adding 0x7fffffff + 1', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus);
    const prog = [
      LUI(1, 0x7fff), ORI(1, 1, 0xffff), // r1 = 0x7fffffff
      LUI(2, 0x0000), ORI(2, 2, 0x0001), // r2 = 1
      ADD(3, 1, 2)
    ];
    loadProgram(bus.rdram, prog, 0);
    for (let i = 0; i < 4; i++) cpu.step();
    const pcBefore = cpu.pc >>> 0;
    cpu.step();
    const cause = cpu.cop0.read(13);
    const exc = (cause >>> 2) & 0x1f;
    expect(exc).toBe(12);
    expect(cpu.cop0.read(14) >>> 0).toBe(pcBefore);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });

  it('ADDI does not overflow for 1 + 32767, but overflows for 0x7fffffff + 1', () => {
    // Non-overflow case
    let bus = new Bus(new RDRAM(64 * 1024));
    let cpu = new CPU(bus);
    let prog = [
      LUI(2, 0x0000), ORI(2, 2, 0x0001), // r2 = 1
      ADDI(4, 2, 0x7fff)                  // r4 = 32768
    ];
    loadProgram(bus.rdram, prog, 0);
    for (let i = 0; i < 2; i++) cpu.step();
    cpu.step();
    expect(cpu['regs'][4] | 0).toBe(32768);

    // Overflow case
    bus = new Bus(new RDRAM(64 * 1024));
    cpu = new CPU(bus);
    prog = [
      LUI(1, 0x7fff), ORI(1, 1, 0xffff), // r1 = 0x7fffffff
      ADDI(5, 1, 0x0001)
    ];
    loadProgram(bus.rdram, prog, 0);
    for (let i = 0; i < 2; i++) cpu.step();
    const pcBefore = cpu.pc >>> 0;
    cpu.step();
    const cause = cpu.cop0.read(13);
    const exc = (cause >>> 2) & 0x1f;
    expect(exc).toBe(12);
    expect(cpu.cop0.read(14) >>> 0).toBe(pcBefore);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});

describe('LWL/LWR and SWL/SWR big-endian merging semantics', () => {
  it('LWL merges upper bytes correctly for each offset with old=0', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    bit.writeU32BE(rdram.bytes, 0x100, 0x11223344);

    // For each k, reset r1=0 then run LWL
    for (let k = 0; k < 4; k++) {
      const prog = [ ORI(1, 0, 0), LWL(1, 0, 0x100 + k) ]; // reset r1=0
      loadProgram(rdram, prog, k * 8);
      cpu.pc = k * 8;
      cpu.step(); // clear r1
      cpu.step(); // LWL
      const expected = [0x11223344, 0x11223300, 0x11220000, 0x11000000][k] >>> 0;
      expect(cpu['regs'][1] >>> 0).toBe(expected);
    }
  });

  it('LWR merges lower bytes correctly for each offset with old=0', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    bit.writeU32BE(rdram.bytes, 0x100, 0x11223344);

    for (let k = 0; k < 4; k++) {
      const prog = [ ORI(1, 0, 0), LWR(1, 0, 0x100 + k) ];
      loadProgram(rdram, prog, 0x1000 + k * 8);
      cpu.pc = 0x1000 + k * 8;
      cpu.step();
      cpu.step();
      const expected = [0x00000044, 0x00003344, 0x00223344, 0x11223344][k] >>> 0;
      expect(cpu['regs'][1] >>> 0).toBe(expected);
    }
  });

  it('SWL/SWR paired with LWL/LWR round-trips a word at any unaligned address', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // r2 = 0xAABBCCDD;
    const progBase: number[] = [ LUI(2, 0xAABB), ORI(2, 2, 0xCCDD) ];
    loadProgram(rdram, progBase, 0);
    cpu.pc = 0;
    for (let i = 0; i < 2; i++) cpu.step();

    for (let k = 0; k < 4; k++) {
      // Clear region around 0x200 .. 0x207
      for (let i = 0; i < 8; i++) rdram.bytes[0x200 + i] = 0;

      // SWL at A, SWR at A+3
      const A = 0x200 + k;
      const progStore = [ SWL(2, 0, A), SWR(2, 0, A + 3) ];
      loadProgram(rdram, progStore, 0x2000 + k * 16);
      cpu.pc = 0x2000 + k * 16;
      cpu.step();
      cpu.step();

      // Now load back using LWL/LWR into r3
      const progLoad = [ ORI(3, 0, 0), LWL(3, 0, A), LWR(3, 0, A + 3) ];
      loadProgram(rdram, progLoad, 0x3000 + k * 16);
      cpu.pc = 0x3000 + k * 16;
      cpu.step(); // clear r3
      cpu.step(); // LWL
      cpu.step(); // LWR

      expect(cpu['regs'][3] >>> 0).toBe(0xAABBCCDD >>> 0);
    }
  });
});

