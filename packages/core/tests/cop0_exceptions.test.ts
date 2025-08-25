import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';
import { CPUException } from '../src/cpu/exceptions.js';

function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('COP0 exception entry', () => {
  it('sets EXL, Cause.ExcCode, EPC, BadVAddr for address error on LW and vectors to BEV=0 base', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Ensure BEV=0 so exception vector is 0x80000180
    const statusBefore = cpu.cop0.read(12) & ~(1 << 22);
    cpu.cop0.write(12, statusBefore);

    // Build a program that executes an unaligned LW at address 2
    // r1 = 2; LW r2, 0(r1) -> AddressErrorLoad
    const prog = [
      LUI(1, 0x0000), ORI(1, 1, 2),
      LW(2, 1, 0)
    ];
    loadProgram(rdram, prog, 0);

    // Step LUI, ORI
    cpu.step(); cpu.step();

    const pcBeforeFault = cpu.pc >>> 0; // address of LW instruction

    // Step LW -> should trigger exception
    cpu.step();

    // Check CP0 state
    const status = cpu.cop0.read(12);
    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);
    const badv = cpu.cop0.read(8);

    expect((status & (1 << 1)) !== 0).toBe(true); // EXL set
    const excCode = (cause >>> 2) & 0x1f;
    expect(excCode).toBe(4); // AddressErrorLoad
    expect(epc >>> 0).toBe(pcBeforeFault >>> 0);
    expect(badv >>> 0).toBe(2);
    // PC should be at 0x80000180 since BEV=0
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});

