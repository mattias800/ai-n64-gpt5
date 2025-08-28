import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function TLBWR() { return (0x10 << 26) | (0x10 << 21) | 0x06; }
function TLBR() { return (0x10 << 26) | (0x10 << 21) | 0x01; }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

function loBits(pfn: number, v: boolean, d: boolean, g: boolean) {
  return (((pfn & 0xFFFFF) << 6) | ((0 /*C*/ & 0x7) << 3) | ((d ? 1 : 0) << 2) | ((v ? 1 : 0) << 1) | (g ? 1 : 0)) >>> 0;
}

describe('CP0 Random/Wired and TLBWR semantics', () => {
  it('TLBWR writes to index 31 when Wired=31', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    // Disable BEV for simplicity
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    const PFN_EVEN = 0x0020;
    const PFN_ODD  = 0x0021;
    const lo0 = loBits(PFN_EVEN, true, true, true);
    const lo1 = loBits(PFN_ODD,  true, true, true);

    const prog = [
      // Set Wired=31
      LUI(1, 0), ORI(1, 1, 31), MTC0(1, 6),
      // PageMask=0 (4KB)
      LUI(2, 0), ORI(2, 2, 0), MTC0(2, 5),
      // EntryHi = vpn2=0 | asid=0
      LUI(3, 0), ORI(3, 3, 0), MTC0(3, 10),
      // EntryLo0/1
      LUI(4, (lo0 >>> 16) & 0xffff), ORI(4, 4, lo0 & 0xffff), MTC0(4, 2),
      LUI(5, (lo1 >>> 16) & 0xffff), ORI(5, 5, lo1 & 0xffff), MTC0(5, 3),
      // Write random entry (should target index 31 due to Wired=31)
      TLBWR(),
      // Read back entry at Index=31
      LUI(6, 0), ORI(6, 6, 31), MTC0(6, 0), TLBR(),
    ];

    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);
    for (let i = 0; i < prog.length; i++) cpu.step();

    // Verify TLBR populated CP0 regs with the entry we wrote
    const gotLo0 = cpu.cop0.read(2) >>> 0;
    const gotLo1 = cpu.cop0.read(3) >>> 0;
    const gotHi  = cpu.cop0.read(10) >>> 0; // vpn2|asid
    const gotMask = cpu.cop0.read(5) >>> 0;
    expect(gotLo0 >>> 0).toBe(lo0 >>> 0);
    expect(gotLo1 >>> 0).toBe(lo1 >>> 0);
    expect((gotHi & 0xff) >>> 0).toBe(0); // ASID 0
    expect((gotHi >>> 13) >>> 0).toBe(0); // VPN2 0
    expect(gotMask >>> 0).toBe(0 >>> 0);
  });

  it('Random decrements and wraps within [Wired..31]', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    // Disable BEV for simplicity
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Set Wired=28 -> Random range should be [28..31]
    const prog = [ LUI(1, 0), ORI(1, 1, 28), MTC0(1, 6) ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);
    for (let i = 0; i < prog.length; i++) cpu.step();

    // Execute several NOP steps and sample CP0.Random after each step
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      cpu.step();
      samples.push(cpu.cop0.read(1) >>> 0);
    }
    // All samples must be in [28..31] and sequence should not go below 28
    for (const r of samples) {
      expect(r >= 28 && r <= 31).toBe(true);
    }
    // Must observe each value in the range at least once over enough steps
    const seen = new Set(samples);
    expect(seen.has(28)).toBe(true);
    expect(seen.has(29)).toBe(true);
    expect(seen.has(30)).toBe(true);
    expect(seen.has(31)).toBe(true);
  });
});

