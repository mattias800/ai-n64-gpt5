import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDIU(rt: number, rs: number, imm16: number) { return (0x09 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function ADDU(rd: number, rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (0 << 6) | 0x21; }
function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function J(target: number) { return (0x02 << 26) | ((target >>> 2) & 0x03ffffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('CPU branches and delay slots', () => {
  it('executes BEQ with delay slot and absolute J with delay slot', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Program layout:
    // 0: LUI r1, 0x1234
    // 1: BEQ r1, r1, +2 (branch taken)   [delay slot executes]
    // 2: ADDIU r2, r0, 1                 [delay slot]
    // 3: ORI r2, r2, 0x10                [skipped due to branch]
    // 4: J 0x20                          [delay slot executes]
    // 5: ADDIU r3, r0, 2                 [delay slot]
    // 6: ORI r3, r3, 0x20                [skipped due to jump]
    // 8: (0x20 >> 2) target: ADDU r4, r2, r3

    const target = 0x20;

    const prog = [
      LUI(1, 0x1234),        // 0
      BEQ(1, 1, 2),          // 1: branch to 4 after delay slot
      ADDIU(2, 0, 1),        // 2: delay slot -> r2 = 1
      ORI(2, 2, 0x10),       // 3: skipped
      J(target),             // 4: jump to 0x20
      ADDIU(3, 0, 2),        // 5: delay slot -> r3 = 2
      ORI(3, 3, 0x20),       // 6: skipped
      0,                     // 7: padding
    ];

    // Place jump target at 0x20
    const targetIndex = target >>> 2; // index in words
    const more = [
      ADDU(4, 2, 3)         // target: r4 = r2 + r3 = 3
    ];

    loadProgram(rdram, prog, 0);
    loadProgram(rdram, more, target);

    // Execute the minimal number of steps to reach the ADDU at the jump target
    for (let i = 0; i < 6; i++) cpu.step();

    expect(cpu['regs'][2] >>> 0).toBe(1);
    expect(cpu['regs'][3] >>> 0).toBe(2);
    expect(cpu['regs'][4] >>> 0).toBe(3);
    expect(cpu.pc >>> 0).toBe((target + 4) >>> 0);
  });
});

