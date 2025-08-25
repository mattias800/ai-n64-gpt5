import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

import * as bit from '../src/utils/bit.js';

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
}

describe('CP0 software interrupts (IP0/IP1)', () => {
  it('writing Cause IP0/IP1 and enabling IM0/IM1 triggers interrupts', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable IE and IM0 (IP0)
    const IE = 1 << 0; const IM0 = 1 << (8 + 0);
    cpu.cop0.write(12, IE | IM0);

    // Write Cause to set IP0
    cpu.cop0.write(13, 1 << 8);

    const pc0 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(pc0 >>> 0);

    // Clear EXL and set IM1, IP1
    const st = cpu.cop0.read(12);
    cpu.cop0.write(12, (st & ~(1 << 1)) | (1 << (8 + 1)) | IE);
    // Clear IP0, set IP1
    const cause = cpu.cop0.read(13);
    cpu.cop0.write(13, (cause & ~(1 << 8)) | (1 << 9));

    const pc1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(pc1 >>> 0);
  });
});
