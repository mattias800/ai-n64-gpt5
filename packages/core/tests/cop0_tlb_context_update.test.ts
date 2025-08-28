import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

describe('CP0.Context BadVPN2 updates on TLB exceptions', () => {
  it('TLBL updates Context.BadVPN2 while preserving PTEBase', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus, { identityMapKuseg: false });

    // Disable BEV for deterministic vectors
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));

    // Set Context PTEBase bits [22:4] to a known value (others zero)
    const PTEBASE_MASK = 0x007FFFF0 >>> 0;
    const desiredPTEBase = (0x001230F0 >>> 0) & PTEBASE_MASK; // only bits [22:4]
    const prog = [
      // r1 = desiredPTEBase; MTC0 r1, Context (reg 4)
      LUI(1, (desiredPTEBase >>> 16) & 0xffff), ORI(1, 1, desiredPTEBase & 0xffff), MTC0(1, 4),
      // r2 = 0x40001234 (KUSEG address with nonzero top VPN2 bits)
      LUI(2, 0x4000), ORI(2, 2, 0x1234),
      // LW r3, 0(r2) -> TLBL (no TLB mapping)
      LW(3, 2, 0),
    ];

    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Step through until the LW triggers TLBL
    for (let i = 0; i < prog.length; i++) cpu.step();

    const badv = cpu.cop0.read(8) >>> 0;
    const cause = cpu.cop0.read(13) >>> 0;
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(2); // TLBL
    expect(badv >>> 0).toBe(0x40001234 >>> 0);

    const context = cpu.cop0.read(4) >>> 0;
    const badVpn2High9 = ((badv >>> 23) & 0x1ff) >>> 0;
    const expectedContext = (((desiredPTEBase & PTEBASE_MASK) | (badVpn2High9 << 23)) >>> 0);

    // PTEBase preserved, BadVPN2 updated
    expect(context >>> 0).toBe(expectedContext >>> 0);
  });
});

