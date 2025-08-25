import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function BNE(rs: number, rt: number, off: number) { return (0x05 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function BLEZ(rs: number, off: number) { return (0x06 << 26) | (rs << 21) | (0 << 16) | (off & 0xffff); }
function BGTZ(rs: number, off: number) { return (0x07 << 26) | (rs << 21) | (0 << 16) | (off & 0xffff); }
function REGIMM(rs: number, rtField: number, off: number) { return (0x01 << 26) | (rs << 21) | (rtField << 16) | (off & 0xffff); }
function NOP() { return 0; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('Extended branches and variable shifts', () => {
  it('BLEZ/BGTZ work with signed comparisons and delay slots executed', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = -1; BLEZ r1, +1 (taken). Delay: ORI r2, r0, 1 executes. Target writes ORI r3, r0, 2
    const prog = [
      LUI(1, 0xffff), ORI(1, 1, 0xffff), // r1 = 0xffff_ffff (-1)
      BLEZ(1, 1),                         // branch to index+1 after delay slot
      ORI(2, 0, 1),                        // delay slot
      ORI(3, 0, 2)                         // target
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    expect(cpu['regs'][2] >>> 0).toBe(1);
    expect(cpu['regs'][3] >>> 0).toBe(2);
  });

  it('BLTZ/BGEZ and link variants set $ra when taken', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = -5; BLTZAL r1, +1 (taken): delay ORI r4,1; target ORI r5,2; $ra must be set to pc+4 after delay
    const prog = [
      LUI(1, 0xffff), ORI(1, 1, 0xfffb), // r1 = 0xffff_fffb (-5)
      REGIMM(1, 0x10, 1),                 // BLTZAL +1
      ORI(4, 0, 1),                        // delay slot
      ORI(5, 0, 2)                         // target
    ];
    loadProgram(rdram, prog, 0);
    const startPC = 0;
    for (let i = 0; i < prog.length; i++) cpu.step();
    expect(cpu['regs'][4] >>> 0).toBe(1);
    expect(cpu['regs'][5] >>> 0).toBe(2);
    // $ra should be set to address after delay slot (startPC + 4* (branch index + 2)) i.e., 16
    expect(cpu['regs'][31] >>> 0).toBe(16 >>> 0);
  });

  it('SLLV/SRLV/SRAV variable shifts operate modulo 32', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = 0x1; r2 = 33 -> shift by 1
    const SLLV = (rd: number, rt: number, rs: number) => (0x00 << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (0 << 6) | 0x04;
    const SRLV = (rd: number, rt: number, rs: number) => (0x00 << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (0 << 6) | 0x06;
    const SRAV = (rd: number, rt: number, rs: number) => (0x00 << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (0 << 6) | 0x07;
    const prog = [
      ORI(1, 0, 1),
      ORI(2, 0, 33),
      SLLV(3, 1, 2),  // 1 << 1 = 2
      SRLV(4, 3, 2),  // 2 >>> 1 = 1
      SRAV(5, 3, 2)   // 2 >> 1 = 1
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    expect(cpu['regs'][3] >>> 0).toBe(2);
    expect(cpu['regs'][4] >>> 0).toBe(1);
    expect(cpu['regs'][5] >>> 0).toBe(1);
  });
});

