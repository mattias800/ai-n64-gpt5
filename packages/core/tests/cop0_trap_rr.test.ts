import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function BEQ(rs: number, rt: number, off16: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off16 & 0xffff); }
// Trap RR encodings (code field = 0)
function TGE(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | 0x30; }
function TGEU(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | 0x31; }
function TLT(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | 0x32; }
function TLTU(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | 0x33; }
function TEQ(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | 0x34; }
function TNE(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | 0x36; }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

// Basic trap behavior
describe('Trap RR instructions', () => {
  it('TGE (signed) triggers trap when rs >= rt; TEQ and TLTU behave as expected', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Disable BEV for deterministic vectors
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // r1 = 5, r2 = 5 -> TGE should trap; then TEQ should trap; TLTU with r3=1,r4=2 should trap
    const prog = [
      ORI(1, 0, 5), ORI(2, 0, 5),
      TGE(1, 2),
      ORI(3, 0, 1), ORI(4, 0, 2),
      TEQ(1, 2),
      TLTU(3, 4),
    ];

    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Step first TGE and take trap
    cpu.step(); // ORI
    cpu.step(); // ORI
    cpu.step(); // TGE -> trap

    const cause1 = cpu.cop0.read(13) >>> 0;
    expect(((cause1 >>> 2) & 0x1f) >>> 0).toBe(13); // Trap
    const base = 0x80000000 >>> 0;
    expect(cpu.pc >>> 0).toBe((base + 0x180) >>> 0);

    // Clear EXL to continue test (simulate return)
    cpu.cop0.write(12, cpu.cop0.read(12) & ~1); // clear EXL

    // Set PC to continue after trap site for TEQ
    cpu.pc = kseg0(3 * 4); // next instruction after TGE
    cpu.step(); // ORI r3
    cpu.step(); // ORI r4
    cpu.step(); // TEQ -> trap

    const cause2 = cpu.cop0.read(13) >>> 0;
    expect(((cause2 >>> 2) & 0x1f) >>> 0).toBe(13);
    expect(cpu.pc >>> 0).toBe((base + 0x180) >>> 0);

    // Clear EXL again
    cpu.cop0.write(12, cpu.cop0.read(12) & ~1);
    cpu.pc = kseg0(6 * 4); // TLTU
    cpu.step(); // TLTU -> trap
    const cause3 = cpu.cop0.read(13) >>> 0;
    expect(((cause3 >>> 2) & 0x1f) >>> 0).toBe(13);
    expect(cpu.pc >>> 0).toBe((base + 0x180) >>> 0);
  });

  it('Trap in delay slot sets BD and EPC to branch PC', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22)); // BEV=0

    // r5 = 1, r6 = 1; BEQ $zero,$zero, +1; TEQ r5, r6 (in delay slot)
    const prog = [
      ORI(5, 0, 1), ORI(6, 0, 1),
      BEQ(0, 0, 1),
      TEQ(5, 6),
      ORI(7, 0, 0xdead), // should not execute due to trap
    ];

    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Execute up to delay slot
    cpu.step(); // ORI
    cpu.step(); // ORI
    const branchPC = cpu.pc; // address of BEQ when fetched
    cpu.step(); // BEQ (schedules branch), will execute delay slot next
    cpu.step(); // TEQ in delay slot -> trap with BD

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(13);
    expect((cause >>> 31) & 1).toBe(1); // BD set
    expect(epc >>> 0).toBe(branchPC >>> 0); // EPC is branch instruction address
  });
});

