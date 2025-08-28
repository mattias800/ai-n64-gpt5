import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function TLBWI() { return (0x10 << 26) | (0x10 << 21) | 0x02; }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

function loBits(pfn: number, v: boolean, d: boolean, g: boolean) {
  return (((pfn & 0xFFFFF) << 6) | ((0 /*C*/ & 0x7) << 3) | ((d ? 1 : 0) << 2) | ((v ? 1 : 0) << 1) | (g ? 1 : 0)) >>> 0;
}

describe('TLB Modified (Mod) exception', () => {
  it('SW to a valid but clean (D=0) page raises TLB Modified and updates EntryHi/BadVAddr', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });
    // Disable BEV for deterministic vector
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Build a TLB entry with V=1, D=0 for both halves, global=1, mapping vpn2=0
    const PFN_EVEN = 0x0100;
    const PFN_ODD  = 0x0101;
    const lo0 = loBits(PFN_EVEN, true, false, true); // D=0
    const lo1 = loBits(PFN_ODD,  true, false, true); // D=0

    const prog = [
      // Index = 0
      LUI(1, 0), ORI(1, 1, 0), MTC0(1, 0),
      // PageMask = 0 (4KB)
      LUI(2, 0), ORI(2, 2, 0), MTC0(2, 5),
      // EntryHi = vpn2=0 | asid=0
      LUI(3, 0), ORI(3, 3, 0), MTC0(3, 10),
      // EntryLo0/1 with D=0
      LUI(4, (lo0 >>> 16) & 0xffff), ORI(4, 4, lo0 & 0xffff), MTC0(4, 2),
      LUI(5, (lo1 >>> 16) & 0xffff), ORI(5, 5, lo1 & 0xffff), MTC0(5, 3),
      TLBWI(),
      // Attempt SW to VA=0x00000000 (mapped by vpn2=0 even half) -> should raise Mod
      // $zero is base, so address = 0; rt can be $0 as value isn't used when exception occurs
      SW(0, 0, 0),
    ];

    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Step through program; the final SW should trigger the exception
    for (let i = 0; i < prog.length; i++) cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const excCode = (cause >>> 2) & 0x1f;
    expect(excCode).toBe(1); // TLB Modified

    const badV = cpu.cop0.read(8) >>> 0;
    expect(badV >>> 0).toBe(0x00000000 >>> 0);

    const entryHi = cpu.cop0.read(10) >>> 0;
    expect((entryHi & 0xff) >>> 0).toBe(0); // ASID preserved
    expect((entryHi >>> 13) >>> 0).toBe(0); // VPN2 of faulting VA

    // Should vector to general exception vector (not refill): base+0x180
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});

