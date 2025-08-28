import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function TLBR() { return (0x10 << 26) | (0x10 << 21) | 0x01; }
function TLBWR() { return (0x10 << 26) | (0x10 << 21) | 0x06; }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}

function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

function loBits(pfn: number, v: boolean, d: boolean, g: boolean) {
  return (((pfn & 0xFFFFF) << 6) | ((d ? 1 : 0) << 2) | ((v ? 1 : 0) << 1) | (g ? 1 : 0)) >>> 0;
}

describe('COP0 TLB misc', () => {
  it('TLBL on instruction fetch from KUSEG sets EPC to faulting PC and vectors to refill base', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    // BEV=0 so vector goes to 0x80000000 for refill
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Set PC directly to KUSEG unmapped address
    const faultPC = 0x00001000 >>> 0;
    cpu.pc = faultPC >>> 0;

    // Step -> instruction fetch TLBL
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;

    // ExcCode TLBL = 2
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(2);
    // EPC is the faulting PC
    expect(epc >>> 0).toBe(faultPC >>> 0);
    // BadVAddr = faulting virtual address
    expect(badv >>> 0).toBe(faultPC >>> 0);
    // Refill base
    expect(cpu.pc >>> 0).toBe(0x80000000 >>> 0);
  });

  it('TLBWR writes to index >= Wired (use Wired=31 to force index 31) and TLBR reads it back', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: true });

    // Set Wired=31 so Random should wrap to 31 on step
    // Also BEV=0 (not strictly needed here)
    const status = cpu.cop0.read(12);
    cpu.cop0.write(12, status & ~(1 << 22));
    cpu.cop0.write(6, 31); // Wired

    // Prepare a distinctive TLB entry and then TLBWR
    // EntryHi = vpn2=0, asid=0; Lo0 = unique PFN/V/D/G; Lo1 = zero for visibility
    const lo0 = loBits(0x01234, true, true, true) >>> 0;

    const prog = [
      // PageMask=0, EntryHi=0
      MTC0(0, 5), MTC0(0, 10),
      // EntryLo0 = lo0 via r1; EntryLo1 = g=1 via r2 to keep G bit consistent
      LUI(1, (lo0 >>> 16) & 0xffff), ORI(1, 1, lo0 & 0xffff), MTC0(1, 2),
      // lo1 with G=1 (PFN=0, V=0, D=0, G=1)
      LUI(2, 0), ORI(2, 2, 0x0001), MTC0(2, 3),
      // TLBWR should pick index 31 under Wired=31
      TLBWR(),
      // Set Index=31 and TLBR to read back
      LUI(2, 0), ORI(2, 2, 31), MTC0(2, 0),
      TLBR()
    ];

    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Execute the program
    for (let i = 0; i < prog.length; i++) cpu.step();

    // Verify that EntryLo0 now matches our value (from TLB index 31)
    const rdLo0 = cpu.cop0.read(2) >>> 0;
    const rdPM = cpu.cop0.read(5) >>> 0;
    expect(rdPM >>> 0).toBe(0 >>> 0);
    expect(rdLo0 >>> 0).toBe(lo0 >>> 0);
  });
});
