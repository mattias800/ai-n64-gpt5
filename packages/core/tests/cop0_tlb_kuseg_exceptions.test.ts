import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDIU(rt: number, rs: number, imm16: number) { return (0x09 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

// COP0 helpers
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function TLBWI() { return (0x10 << 26) | (0x10 << 21) | 0x02; }
function TLBP() { return (0x10 << 26) | (0x10 << 21) | 0x08; }
function TLBR() { return (0x10 << 26) | (0x10 << 21) | 0x01; }

const NOP = 0 >>> 0;

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
  }
}

function kseg0(addrPhys: number) { return (0x80000000 >>> 0) + (addrPhys >>> 0); }

function loBits(pfn: number, v: boolean, d: boolean, g: boolean) {
  return (((pfn & 0xFFFFF) << 6) | ((d ? 1 : 0) << 2) | ((v ? 1 : 0) << 1) | (g ? 1 : 0)) >>> 0;
}

describe('COP0 TLB exceptions with KUSEG when identityMapKuseg=false', () => {
  it('TLBL on LW from KUSEG without a TLB entry vectors to refill base', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    // Ensure BEV=0 for base 0x8000_0000 vectoring
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    const prog = [
      // r1 = 0x00001000
      LUI(1, 0x0000), ORI(1, 1, 0x1000),
      // LW r2, 0(r1) -> TLBL (no entry for KUSEG)
      LW(2, 1, 0)
    ];

    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Execute setup
    cpu.step(); cpu.step();
    const lwPC = cpu.pc >>> 0; // PC of LW instruction (KSEG0 virtual)
    cpu.step(); // should fault

    const status = cpu.cop0.read(12) >>> 0;
    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;

    expect((status & (1 << 1)) !== 0).toBe(true); // EXL set
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(2); // TLBL code
    expect(epc >>> 0).toBe(lwPC >>> 0);
    expect(badv >>> 0).toBe(0x00001000 >>> 0);
    expect(cpu.pc >>> 0).toBe(0x80000000 >>> 0); // refill base (BEV=0)
  });

  it('TLBS on SW from KUSEG without a TLB entry vectors to refill base', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22)); // BEV=0

    const prog = [
      // r1 = 0x00001000; r2 = 1
      LUI(1, 0x0000), ORI(1, 1, 0x1000),
      ADDIU(2, 0, 1),
      // SW r2, 0(r1) -> TLBS (no entry)
      SW(2, 1, 0)
    ];
    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    cpu.step(); cpu.step(); cpu.step();
    const swPC = cpu.pc >>> 0;
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;

    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(3); // TLBS code
    expect(epc >>> 0).toBe(swPC >>> 0);
    expect(badv >>> 0).toBe(0x00001000 >>> 0);
    expect(cpu.pc >>> 0).toBe(0x80000000 >>> 0); // refill base
  });

  it('TLBS on SW to a mapped but non-dirty odd page (D=0)', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22)); // BEV=0

    // Prepare TLB entry at index 0:
    // vpn2=0 (covers 0x0000_0000..0x0000_1FFF), ASID=0, G=1
    // pfn0=0: V=1, D=1; pfn1=1: V=1, D=0 (odd page non-dirty)
    const lo0 = loBits(0x00000, true, true, true) >>> 0;
    const lo1 = loBits(0x00001, true, false, true) >>> 0;

    const prog = [
      // Index=0, PageMask=0, EntryHi=0
      MTC0(0, 0), MTC0(0, 5), MTC0(0, 10),
      // EntryLo0 = lo0 via r1
      LUI(1, (lo0 >>> 16) & 0xffff), ORI(1, 1, lo0 & 0xffff), MTC0(1, 2),
      // EntryLo1 = lo1 via r2
      LUI(2, (lo1 >>> 16) & 0xffff), ORI(2, 2, lo1 & 0xffff), MTC0(2, 3),
      // Write indexed TLB entry 0
      TLBWI(),
      // r3 = 0x00001000 (odd page), r4 = 0xABCD1234
      LUI(3, 0x0000), ORI(3, 3, 0x1000),
      LUI(4, 0xABCD), ORI(4, 4, 0x1234),
      // SW r4, 0(r3) -> should raise TLBS (D=0)
      SW(4, 3, 0),
      NOP
    ];

    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Execute until just before SW
    // Steps before SW: 3 + 3 + 3 + 1 + 2 + 2 = 14
    for (let i = 0; i < 14; i++) cpu.step();

    // Sanity check the written TLB entry state
    const tlb0 = (cpu as any)['tlb'][0];
    expect(!!tlb0.v1).toBe(true);
    expect(!!tlb0.d1).toBe(false);

    const swPC = cpu.pc >>> 0;
    cpu.step(); // TLBS

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    const badv = cpu.cop0.read(8) >>> 0;
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(3);
    expect(epc >>> 0).toBe(swPC >>> 0);
    expect(badv >>> 0).toBe(0x00001000 >>> 0);
    expect(cpu.pc >>> 0).toBe(0x80000000 >>> 0);
  });

  it('TLBP finds the entry; TLBR reads it back into CP0 regs', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22)); // BEV=0

    const lo0 = loBits(0x00000, true, true, true) >>> 0;
    const lo1 = loBits(0x00002, true, true, true) >>> 0; // use different PFN1

    const prog = [
      // Index=0, PageMask=0, EntryHi=0
      MTC0(0, 0), MTC0(0, 5), MTC0(0, 10),
      // EntryLo0/1 set
      LUI(1, (lo0 >>> 16) & 0xffff), ORI(1, 1, lo0 & 0xffff), MTC0(1, 2),
      LUI(2, (lo1 >>> 16) & 0xffff), ORI(2, 2, lo1 & 0xffff), MTC0(2, 3),
      // Write TLB[0]
      TLBWI(),
      // Probe for vpn2=0, asid=0 -> should find index 0
      MTC0(0, 10), // EntryHi=0
      TLBP(),
      // Now read back via TLBR
      TLBR(),
      NOP
    ];

    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    for (let i = 0; i < prog.length; i++) cpu.step();

    // After TLBP/TLBR, Index should be 0 (not -1); EntryLo0/1 and PageMask should match
    const index = cpu.cop0.read(0) >>> 0;
    expect((index >>> 31) === 0).toBe(true);
    expect((index & 0x3f) >>> 0).toBe(0 >>> 0);
    expect(cpu.cop0.read(2) >>> 0).toBe(lo0 >>> 0);
    expect(cpu.cop0.read(3) >>> 0).toBe(lo1 >>> 0);
    expect(cpu.cop0.read(5) >>> 0).toBe(0 >>> 0);
  });
});
