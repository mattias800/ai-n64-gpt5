import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function MFC0(rt: number, rd: number) { return (0x10 << 26) | (0x00 << 21) | (rt << 16) | (rd << 11); }
function TLBWI() { return (0x10 << 26) | (0x10 << 21) | 0x02; }
function TLBR() { return (0x10 << 26) | (0x10 << 21) | 0x01; }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}

function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

function makeEntryLo(pfn: number, c: number, d: number, v: number, g: number) {
  return (((pfn & 0xFFFFF) << 6) | ((c & 7) << 3) | ((d & 1) << 2) | ((v & 1) << 1) | (g & 1)) >>> 0;
}

describe('TLB KSEG2 semantics and EntryLo C coherency', () => {
  it('TLBL from KSEG2 vectors to base when EXL=0', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    // BEV=0, EXL=0
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // r2 = 0xC0000000; LW r3, 0(r2) -> TLBL (no mapping)
    const prog = [ LUI(2, 0xC000), LW(3, 2, 0) ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    cpu.step(); // LUI
    cpu.step(); // LW -> TLBL

    const cause = cpu.cop0.read(13) >>> 0;
    const exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(2); // TLBL
    expect(cpu.pc >>> 0).toBe(0x80000000 >>> 0); // base vector
  });

  it('TLBL from KSEG2 vectors to general when EXL=1', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    // BEV=0, EXL=1
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~(1 << 22);
    status |= (1 << 1);
    cpu.cop0.write(12, status >>> 0);

    const prog = [ LUI(2, 0xC000), LW(3, 2, 0) ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    cpu.step(); // LUI
    cpu.step(); // LW -> TLBL

    const cause = cpu.cop0.read(13) >>> 0;
    const exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(2); // TLBL
    expect(cpu.pc >>> 0).toBe((0x80000000 + 0x180) >>> 0); // general vector
  });

  it('EntryLo C field roundtrips through TLBWI/TLBR', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Build CP0 state for TLBWI at Index 0
    const entryHi = (0x00012000 << 13) >>> 0; // arbitrary VPN2
    const lo0 = makeEntryLo(0x12345, 5, 1, 1, 0);
    const lo1 = makeEntryLo(0x0ABCD, 3, 0, 1, 0);

    const prog = [
      // r1=0 -> Index=0
      ORI(1, 0, 0), MTC0(1, 0),
      // r2=entryHi
      LUI(2, (entryHi >>> 16) & 0xffff), ORI(2, 2, entryHi & 0xffff), MTC0(2, 10),
      // r3=EntryLo0, r4=EntryLo1
      LUI(3, (lo0 >>> 16) & 0xffff), ORI(3, 3, lo0 & 0xffff), MTC0(3, 2),
      LUI(4, (lo1 >>> 16) & 0xffff), ORI(4, 4, lo1 & 0xffff), MTC0(4, 3),
      // PageMask=0
      ORI(5, 0, 0), MTC0(5, 5),
      // Write indexed entry
      TLBWI(),
      // Read back into CP0 regs
      TLBR(),
    ];

    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    for (let i = 0; i < prog.length; i++) cpu.step();

    const rdLo0 = cpu.cop0.read(2) >>> 0;
    const rdLo1 = cpu.cop0.read(3) >>> 0;
    const c0 = (rdLo0 >>> 3) & 7;
    const c1 = (rdLo1 >>> 3) & 7;
    expect(c0).toBe(5);
    expect(c1).toBe(3);
  });
});

