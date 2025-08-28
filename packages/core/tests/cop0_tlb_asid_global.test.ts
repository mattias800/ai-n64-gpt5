import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function TLBWI() { return (0x10 << 26) | (0x10 << 21) | 0x02; }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

function loBits(pfn: number, v: boolean, d: boolean, g: boolean) {
  return (((pfn & 0xFFFFF) << 6) | ((d ? 1 : 0) << 2) | ((v ? 1 : 0) << 1) | (g ? 1 : 0)) >>> 0;
}

// Build a TLB entry at index 0 with given asid and global flag that maps KUSEG 0x0000_0000 page
function buildTLBEntry(bus: Bus, cpu: CPU, asid: number, g: boolean): void {
  const lo0 = loBits(0x00000, /*V*/ true, /*D*/ true, g) >>> 0;
  const lo1G = loBits(0x00000, /*V*/ false, /*D*/ false, g) >>> 0;
  const prog = [
    // Index=0, PageMask=0, EntryHi= vpn2=0 | asid
    LUI(1, 0), ORI(1, 1, 0), MTC0(1, 0),
    LUI(2, 0), ORI(2, 2, 0), MTC0(2, 5),
    LUI(3, 0), ORI(3, 3, (asid & 0xff)), MTC0(3, 10),
    // EntryLo0 = lo0; EntryLo1 = lo1G (G flag set so G=1 across both halves)
    LUI(4, (lo0 >>> 16) & 0xffff), ORI(4, 4, lo0 & 0xffff), MTC0(4, 2),
    LUI(5, (lo1G >>> 16) & 0xffff), ORI(5, 5, lo1G & 0xffff), MTC0(5, 3),
    // Write indexed
    TLBWI()
  ];
  const progBase = 0x1000; // keep away from test data at low phys addresses
  writeProgram(bus.rdram, prog, progBase);
  cpu.pc = kseg0(progBase);
  for (let i = 0; i < prog.length; i++) cpu.step();
}

describe('TLB ASID and Global matching', () => {
  it('ASID mismatch causes TLBL for KUSEG load; ASID match succeeds', () => {
    // Prime physical memory at 0 with a word
    const rdram1 = new RDRAM(64 * 1024);
    const bus1 = new Bus(rdram1);
    bit.writeU32BE(bus1.rdram.bytes, 0, 0xDEADBEEF >>> 0);

    // CPU with identityMapKuseg=false
    const cpu1 = new CPU(bus1, { identityMapKuseg: false });
    // BEV=0
    cpu1.cop0.write(12, cpu1.cop0.read(12) & ~(1 << 22));

    // Build TLB entry asid=1, global=false
    buildTLBEntry(bus1, cpu1, 1, false);

    // Set current ASID=0 (EntryHi low byte)
    const setAsid0 = [ LUI(1, 0), ORI(1, 1, 0), MTC0(1, 10) ];
    writeProgram(bus1.rdram, setAsid0, 0x200);
    cpu1.pc = kseg0(0x200);
    for (let i = 0; i < setAsid0.length; i++) cpu1.step();

    // Attempt LW r2, 0(r0) from KUSEG -> TLBL due to ASID mismatch
    const doLW = [ LW(2, 0, 0) ];
    writeProgram(bus1.rdram, doLW, 0x240);
    cpu1.pc = kseg0(0x240);
    cpu1.step();

    let cause = cpu1.cop0.read(13) >>> 0;
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(2);

    // New CPU instance for ASID match case to keep a clean flow
    const rdram2 = new RDRAM(64 * 1024);
    const bus2 = new Bus(rdram2);
    bit.writeU32BE(bus2.rdram.bytes, 0, 0xDEADBEEF >>> 0);
    const cpu2 = new CPU(bus2, { identityMapKuseg: false });
    cpu2.cop0.write(12, cpu2.cop0.read(12) & ~(1 << 22));
    buildTLBEntry(bus2, cpu2, 1, false);
    // Set current ASID=1 and perform LW r2, 0(r0)
    const run = [ LUI(1, 0), ORI(1, 1, 1), MTC0(1, 10), LW(2, 0, 0) ];
    writeProgram(bus2.rdram, run, 0x100);
    cpu2.pc = kseg0(0x100);
    for (let i = 0; i < run.length; i++) cpu2.step();
    expect((cpu2 as any)['regs'][2] >>> 0).toBe(0xDEADBEEF >>> 0);
  });

  it('Global (G=1) entry matches regardless of current ASID', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    bit.writeU32BE(bus.rdram.bytes, 0, 0xCAFEBABE >>> 0);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Build global entry (asid stored but ignored by match)
    buildTLBEntry(bus, cpu, 2, true);

    // Set current ASID to 0 (mismatch), then load should still succeed
    const run = [ LUI(1, 0), ORI(1, 1, 0), MTC0(1, 10), LW(2, 0, 0) ];
    writeProgram(bus.rdram, run, 0x80);
    cpu.pc = kseg0(0x80);
    for (let i = 0; i < run.length; i++) cpu.step();

    expect((cpu as any)['regs'][2] >>> 0).toBe(0xCAFEBABE >>> 0);
  });
});
