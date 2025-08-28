import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function TLBWI() { return (0x10 << 26) | (0x10 << 21) | 0x02; }
function TLBP() { return (0x10 << 26) | (0x10 << 21) | 0x08; }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

function loBits(pfn: number, v: boolean, d: boolean, g: boolean) {
  return (((pfn & 0xFFFFF) << 6) | ((0 /*C*/ & 0x7) << 3) | ((d ? 1 : 0) << 2) | ((v ? 1 : 0) << 1) | (g ? 1 : 0)) >>> 0;
}

describe('TLB PageMask variable page sizes', () => {
  it('16KB PageMask: even/odd selection and extended offset mapping', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    // Disable BEV to avoid boot vectors for any exception; not strictly needed here
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    const PAGE_MASK_16K = 0x00006000 >>> 0;
    const PFN_EVEN = 0x0002; // paddr base 0x00002000
    const PFN_ODD  = 0x0003; // paddr base 0x00003000

    // Prime physical memory at (pfn<<12 | 0x24)
    const off = 0x24;
    const evenPhys = ((PFN_EVEN << 12) | off) >>> 0;
    const oddPhys  = ((PFN_ODD  << 12) | off) >>> 0;
    bit.writeU32BE(bus.rdram.bytes, evenPhys, 0xAAAABBBB >>> 0);
    bit.writeU32BE(bus.rdram.bytes, oddPhys,  0xCCCCDDDD >>> 0);

    // Build TLB entry index 0: mask=16KB, vpn2=0, asid=0, global=1, V/D on both
    const lo0 = loBits(PFN_EVEN, true, true, true);
    const lo1 = loBits(PFN_ODD,  true, true, true);
    const prog = [
      // Index=0
      LUI(1, 0), ORI(1, 1, 0), MTC0(1, 0),
      // PageMask=16KB
      LUI(2, (PAGE_MASK_16K >>> 16) & 0xffff), ORI(2, 2, PAGE_MASK_16K & 0xffff), MTC0(2, 5),
      // EntryHi = vpn2=0 | asid=0
      LUI(3, 0), ORI(3, 3, 0), MTC0(3, 10),
      // EntryLo0/1
      LUI(4, (lo0 >>> 16) & 0xffff), ORI(4, 4, lo0 & 0xffff), MTC0(4, 2),
      LUI(5, (lo1 >>> 16) & 0xffff), ORI(5, 5, lo1 & 0xffff), MTC0(5, 3),
      TLBWI(),
      // Probe should hit index 0
      TLBP()
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);
    for (let i = 0; i < prog.length; i++) cpu.step();

    // Verify TLBP matched index 0
    const idx = cpu.cop0.read(0) >>> 0;
    expect((idx & (1<<31)) >>> 0).toBe(0);

    // Even half: VA = 0x00000000 + off
    const runEven = [ LW(2, 0, off) ];
    writeProgram(bus.rdram, runEven, 0x100);
    cpu.pc = kseg0(0x100);
    for (let i = 0; i < runEven.length; i++) cpu.step();
    expect((cpu as any)['regs'][2] >>> 0).toBe(0xAAAABBBB >>> 0);

    // Odd half: VA = 0x00004000 + off (bit 14 = 1 for 16KB)
    const runOdd = [ LUI(6, 0x0000), ORI(6, 6, 0x4000), LW(3, 6, off) ];
    writeProgram(bus.rdram, runOdd, 0x140);
    cpu.pc = kseg0(0x140);
    for (let i = 0; i < runOdd.length; i++) cpu.step();
    expect((cpu as any)['regs'][3] >>> 0).toBe(0xCCCCDDDD >>> 0);
  });

  it('64KB PageMask: even/odd selection and extended offset mapping', () => {
    const rdram = new RDRAM(256 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    const PAGE_MASK_64K = 0x0001E000 >>> 0;
    const PFN_EVEN = 0x0004; // paddr base 0x00004000
    const PFN_ODD  = 0x0005; // paddr base 0x00005000

    const off = 0x100; // some offset within 64KB
    const evenPhys = ((PFN_EVEN << 12) | off) >>> 0;
    const oddPhys  = ((PFN_ODD  << 12) | off) >>> 0;
    bit.writeU32BE(bus.rdram.bytes, evenPhys, 0x11112222 >>> 0);
    bit.writeU32BE(bus.rdram.bytes, oddPhys,  0x33334444 >>> 0);

    const lo0 = loBits(PFN_EVEN, true, true, true);
    const lo1 = loBits(PFN_ODD,  true, true, true);
    const prog = [
      LUI(1, 0), ORI(1, 1, 0), MTC0(1, 0),
      LUI(2, (PAGE_MASK_64K >>> 16) & 0xffff), ORI(2, 2, PAGE_MASK_64K & 0xffff), MTC0(2, 5),
      LUI(3, 0), ORI(3, 3, 0), MTC0(3, 10),
      LUI(4, (lo0 >>> 16) & 0xffff), ORI(4, 4, lo0 & 0xffff), MTC0(4, 2),
      LUI(5, (lo1 >>> 16) & 0xffff), ORI(5, 5, lo1 & 0xffff), MTC0(5, 3),
      TLBWI()
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);
    for (let i = 0; i < prog.length; i++) cpu.step();

    // Even half: VA = 0x00000000 + off
    const runEven = [ LW(8, 0, off) ];
    writeProgram(bus.rdram, runEven, 0x200);
    cpu.pc = kseg0(0x200);
    for (let i = 0; i < runEven.length; i++) cpu.step();
    expect((cpu as any)['regs'][8] >>> 0).toBe(0x11112222 >>> 0);

    // Odd half: VA = 0x00010000 + off (bit 16 = 1 for 64KB)
    const runOdd = [ LUI(9, 0x0001), ORI(9, 9, 0x0000), LW(10, 9, off) ];
    writeProgram(bus.rdram, runOdd, 0x240);
    cpu.pc = kseg0(0x240);
    for (let i = 0; i < runOdd.length; i++) cpu.step();
    expect((cpu as any)['regs'][10] >>> 0).toBe(0x33334444 >>> 0);
  });
});
