import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

function BEQL(rs: number, rt: number, off: number) { return (0x14 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function BNEL(rs: number, rt: number, off: number) { return (0x15 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function BLEZL(rs: number, off: number) { return (0x16 << 26) | (rs << 21) | (0 << 16) | (off & 0xffff); }
function BGTZL(rs: number, off: number) { return (0x17 << 26) | (rs << 21) | (0 << 16) | (off & 0xffff); }
function REGIMM(rs: number, rtField: number, off: number) { return (0x01 << 26) | (rs << 21) | (rtField << 16) | (off & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDIU(rt: number, rs: number, imm16: number) { return (0x09 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function NOP() { return 0; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
}

describe('Branch-likely instructions', () => {
  it('BEQL skips delay slot when not taken, executes when taken', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // r1 = 5, r2 = 6
    loadProgram(rdram, [
      ORI(1, 0, 5), ORI(2, 0, 6),
      // BEQL r1,r2,+1 -> not taken -> skip delay slot ORI(3,0,1)
      BEQL(1, 2, 1), ORI(3, 0, 1),
      // Now set r2 = 5
      ORI(2, 0, 5),
      // BEQL r1,r2,+1 -> taken -> execute delay slot ORI(4,0,2)
      BEQL(1, 2, 1), ORI(4, 0, 2),
      NOP()
    ], 0);

    // ORIs
    cpu.step(); cpu.step();
    // BEQL not taken -> skip delay slot
    cpu.step();
    // After skipping delay slot, next executed is ORI(2,0,5)
    cpu.step();
    // BEQL taken -> delay slot executes and branch
    cpu.step(); // executes delay slot ORI(4,0,2)
    cpu.step(); // performs branch to NOP

    expect(cpu.regs[3] >>> 0).toBe(0); // was skipped
    expect(cpu.regs[4] >>> 0).toBe(2); // executed in delay slot
  });

  it('REGIMM BLTZL/BLTZALL skip/execute patterns', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    loadProgram(rdram, [
      ADDIU(1, 0, 0xffff), // r1 = -1 via sign-extended imm
      // BLTZL r1,+1 -> taken -> execute delay slot setting r5=3
      REGIMM(1, 0x02, 1), ORI(5, 0, 3),
      // BGEZALL r1,+1 -> not taken -> skip delay slot ORI(6,0,4)
      REGIMM(1, 0x13, 1), ORI(6, 0, 4),
      NOP()
    ], 0);

    // Set r1
    cpu.step();
    // BLTZL taken -> delay slot executed
    cpu.step();
    // Next instruction
    cpu.step();
    // BGEZALL not taken -> skip delay slot
    cpu.step();
    // Branch target NOP
    cpu.step();

    expect(cpu.regs[5] >>> 0).toBe(3);
    expect(cpu.regs[6] >>> 0).toBe(0);
  });
});
