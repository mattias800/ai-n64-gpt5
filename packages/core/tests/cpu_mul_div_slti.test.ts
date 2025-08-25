import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDI(rt: number, rs: number, imm16: number) { return (0x08 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SLTI(rt: number, rs: number, imm16: number) { return (0x0a << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SLTIU(rt: number, rs: number, imm16: number) { return (0x0b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MULT(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x18; }
function MULTU(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x19; }
function DIV(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x1a; }
function DIVU(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x1b; }
function MFHI(rd: number) { return (0x00 << 26) | (0 << 21) | (0 << 16) | (rd << 11) | (0 << 6) | 0x10; }
function MFLO(rd: number) { return (0x00 << 26) | (0 << 21) | (0 << 16) | (rd << 11) | (0 << 6) | 0x12; }
function MTHI(rs: number) { return (0x00 << 26) | (rs << 21) | (0 << 16) | (0 << 11) | (0 << 6) | 0x11; }
function MTLO(rs: number) { return (0x00 << 26) | (rs << 21) | (0 << 16) | (0 << 11) | (0 << 6) | 0x13; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('SLTI/SLTIU correctness', () => {
  it('compares signed/unsigned correctly', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    const prog = [
      LUI(1, 0xffff), ORI(1, 1, 0xfffe), // r1 = 0xffff_fffe (-2)
      SLTI(2, 1, 0x0001),                 // -2 < 1 -> 1
      SLTI(3, 1, 0xffff),                 // -2 < -1 -> 1
      SLTIU(4, 1, 0x0001)                 // 0xffff_fffe < 1 (unsigned) -> 0
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    expect(cpu['regs'][2] >>> 0).toBe(1);
    expect(cpu['regs'][3] >>> 0).toBe(1);
    expect(cpu['regs'][4] >>> 0).toBe(0);
  });
});

describe('MULT/MULTU and MFHI/MFLO', () => {
  it('produces correct 64-bit products split into HI/LO', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = 0x0001_0000, r2 = 0x0002_0000; product = 0x0000_0002_0000_0000
    const prog = [
      LUI(1, 0x0001), LUI(2, 0x0002),
      MULT(1, 2), MFHI(3), MFLO(4)
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    expect(cpu['regs'][3] >>> 0).toBe(0x00000002); // HI
    expect(cpu['regs'][4] >>> 0).toBe(0x00000000); // LO

    // Unsigned multiply with large values
    const prog2 = [
      LUI(1, 0xffff), ORI(1, 1, 0xffff), // r1 = 0xffff_ffff
      LUI(2, 0x0000), ORI(2, 2, 0x0002), // r2 = 2
      MULTU(1, 2), MFHI(5), MFLO(6)
    ];
    loadProgram(rdram, prog2, 0x100);
    cpu.pc = 0x100;
    for (let i = 0; i < prog2.length; i++) cpu.step();
    expect(cpu['regs'][5] >>> 0).toBe(0x00000001);
    expect(cpu['regs'][6] >>> 0).toBe(0xfffffffe);
  });
});

describe('DIV/DIVU and MFHI/MFLO', () => {
  it('computes quotient in LO and remainder in HI', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    const prog = [
      LUI(1, 0x0001), ORI(1, 1, 0x0002), // r1 = 0x0001_0002 (65538)
      LUI(2, 0x0000), ORI(2, 2, 0x0003), // r2 = 3
      DIV(1, 2), MFLO(3), MFHI(4)        // q=21846, r=0
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    expect(cpu['regs'][3] >>> 0).toBe(Math.trunc((0x00010002|0) / 3) >>> 0);
    expect(cpu['regs'][4] >>> 0).toBe(((0x00010002|0) % 3) >>> 0);

    // DIVU with dividend < divisor
    const prog2 = [
      LUI(1, 0x0000), ORI(1, 1, 0x0001), // r1 = 1
      LUI(2, 0x0000), ORI(2, 2, 0x0005), // r2 = 5
      DIVU(1, 2), MFLO(5), MFHI(6)
    ];
    loadProgram(rdram, prog2, 0x200);
    cpu.pc = 0x200;
    for (let i = 0; i < prog2.length; i++) cpu.step();
    expect(cpu['regs'][5] >>> 0).toBe(0);
    expect(cpu['regs'][6] >>> 0).toBe(1);

    // Divide by zero behavior: LO=0xFFFF_FFFF, HI=dividend
    const prog3 = [
      LUI(1, 0x0000), ORI(1, 1, 0x0007), // r1 = 7
      LUI(2, 0x0000), ORI(2, 2, 0x0000), // r2 = 0
      DIVU(1, 2), MFLO(7), MFHI(8)
    ];
    loadProgram(rdram, prog3, 0x300);
    cpu.pc = 0x300;
    for (let i = 0; i < prog3.length; i++) cpu.step();
    expect(cpu['regs'][7] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regs'][8] >>> 0).toBe(7);
  });
});

