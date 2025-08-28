import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function BEQ(rs: number, rt: number, imm16: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

describe('COP0 TLB exceptions in delay slot', () => {
  it('sets BD and EPC=branch PC on TLBS in delay slot', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    // BEV=0 for base 0x8000_0000 vector
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Layout:
    // 0x00: LUI r1, 0x0000
    // 0x04: ORI r1, r1, 0x1000   ; r1 = 0x00001000 (KUSEG)
    // 0x08: BEQ r0, r0, +1       ; branch taken, delay slot executes
    // 0x0C: SW r0, 0(r1)         ; delay slot -> TLBS (no TLB entry for KUSEG)
    // 0x10: NOP                  ; branch target (unused)
    const prog = [
      LUI(1, 0x0000),
      ORI(1, 1, 0x1000),
      BEQ(0, 0, 1),
      SW(0, 1, 0),
      0
    ];

    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Step LUI, ORI
    cpu.step(); cpu.step();

    // Branch PC (address of BEQ)
    const branchPC = cpu.pc >>> 0;

    // Step BEQ (schedules branch), next step executes delay slot and faults
    cpu.step();
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;

    // BD bit set
    expect(((cause >>> 31) & 1) !== 0).toBe(true);
    // ExcCode = 3 (TLBS)
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(3);
    // EPC = branch PC
    expect(epc >>> 0).toBe(branchPC >>> 0);
    // BadVAddr = 0x00001000
    expect(badv >>> 0).toBe(0x00001000 >>> 0);
    // Vector to refill base
    expect(cpu.pc >>> 0).toBe(0x80000000 >>> 0);
  });
});
