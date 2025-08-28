import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) rdram.bytes.set([(words[i]>>>24)&0xff, (words[i]>>>16)&0xff, (words[i]>>>8)&0xff, words[i]&0xff], basePhys + i*4);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

describe('CP0 EntryHi is updated on TLB exceptions', () => {
  it('TLBL sets EntryHi.VPN2 from faulting VA and preserves ASID', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus, { identityMapKuseg: false });
    // BEV=0 and set ASID=0x42
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
    // Set EntryHi ASID=0x42
    const setAsid = [ LUI(1, 0), ORI(1, 1, 0x42), MTC0(1, 10) ];
    writeProgram(bus.rdram, setAsid, 0x1000);
    cpu.pc = kseg0(0x1000);
    for (let i = 0; i < setAsid.length; i++) cpu.step();

    // Access unmapped VA 0x00403000 (KUSEG)
    const prog = [ LUI(2, 0x0040), ORI(2, 2, 0x3000), LW(3, 2, 0) ];
    writeProgram(bus.rdram, prog, 0x1040);
    cpu.pc = kseg0(0x1040);
    // Execute LUI, ORI, then LW triggers TLBL
    cpu.step(); cpu.step(); cpu.step();

    const entryHi = cpu.cop0.read(10) >>> 0;
    const asid = entryHi & 0xff;
    const vpn2 = (entryHi >>> 13) >>> 0;
    expect(asid).toBe(0x42);
    expect(vpn2 >>> 0).toBe((0x00403000 >>> 13) >>> 0);
  });

  it('TLBS sets EntryHi.VPN2 from faulting VA and preserves ASID', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus, { identityMapKuseg: false });
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
    // ASID=0x7F
    const setAsid = [ LUI(1, 0), ORI(1, 1, 0x7F), MTC0(1, 10) ];
    writeProgram(bus.rdram, setAsid, 0x2000);
    cpu.pc = kseg0(0x2000);
    for (let i = 0; i < setAsid.length; i++) cpu.step();

    // Store to unmapped VA 0x00002000 -> TLBS
    const prog = [ LUI(2, 0x0000), ORI(2, 2, 0x2000), SW(0, 2, 0) ];
    writeProgram(bus.rdram, prog, 0x2040);
    cpu.pc = kseg0(0x2040);
    cpu.step(); cpu.step(); cpu.step();

    const entryHi = cpu.cop0.read(10) >>> 0;
    const asid = entryHi & 0xff;
    const vpn2 = (entryHi >>> 13) >>> 0;
    expect(asid).toBe(0x7F);
    expect(vpn2 >>> 0).toBe((0x00002000 >>> 13) >>> 0);
  });
});
