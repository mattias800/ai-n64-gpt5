import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}
function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

// R-type encoder
function R(op: number, rs: number, rt: number, rd: number, shamt: number, funct: number) {
  return ((op & 0x3f) << 26) | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | ((rd & 0x1f) << 11) | ((shamt & 0x1f) << 6) | (funct & 0x3f);
}
function SUB(rd: number, rs: number, rt: number) { return R(0, rs, rt, rd, 0, 0x22); }
function DADD(rd: number, rs: number, rt: number) { return R(0, rs, rt, rd, 0, 0x2c); }
function DADDU(rd: number, rs: number, rt: number) { return R(0, rs, rt, rd, 0, 0x2d); }
function DSUB(rd: number, rs: number, rt: number) { return R(0, rs, rt, rd, 0, 0x2e); }
function DSUBU(rd: number, rs: number, rt: number) { return R(0, rs, rt, rd, 0, 0x2f); }

// I-type encoder
function I(op: number, rs: number, rt: number, imm16: number) {
  return ((op & 0x3f) << 26) | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (imm16 & 0xffff);
}
function LLD(rt: number, rs: number, off: number) { return I(0x34, rs, rt, off); }
function SCD(rt: number, rs: number, off: number) { return I(0x3c, rs, rt, off); }
function SD(rt: number, rs: number, off: number) { return I(0x3f, rs, rt, off); }
function LD(rt: number, rs: number, off: number) { return I(0x37, rs, rt, off); }
function LUI(rt: number, imm16: number) { return I(0x0f, 0, rt, imm16); }
function ORI(rt: number, rs: number, imm16: number) { return I(0x0d, rs, rt, imm16); }

describe('CPU 64-bit add/sub and 64-bit LL/SC', () => {
  it('SUB traps on overflow and SUBU does not', () => {
    const rdram = new RDRAM(0x100);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Program: SUB r3, r1, r2; NOP
    const prog = [ SUB(3,1,2), 0x00000000 ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = kseg0(0);

    // r1 = 0x7fffffff, r2 = 0xffffffff (-1) => overflow expected on SUB
    cpu.regs[1] = 0x7fffffff >>> 0; cpu.regsHi[1] = 0x00000000;
    cpu.regs[2] = 0xffffffff >>> 0; cpu.regsHi[2] = 0xffffffff >>> 0;

    // Step SUB -> exception taken
    cpu.step();
    const cause = bus.loadU32(0x04300000 + 0x0); // just to touch MI (no-op)
    const cop0Cause = cpu.cop0.read(13) >>> 0;
    const excCode = (cop0Cause >>> 2) & 0x1f;
    expect(excCode).toBe(12); // Overflow

    // Now try SUBU (no trap)
    writeProgram(bus.rdram, [R(0,1,2,3,0,0x23)], 0);
    // Reset PC and status to normal flow
    cpu.pc = kseg0(0);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~ (1 << 1)); // clear EXL
    cpu.step();
    // r3 should be 0x80000000 with sign-extension in regsHi
    expect(cpu.regs[3] >>> 0).toBe(0x80000000 >>> 0);
    expect(cpu.regsHi[3] >>> 0).toBe(0xffffffff >>> 0);
  });

  it('DADD/DSUB trap on overflow; DADDU/DSUBU do not', () => {
    const rdram = new RDRAM(0x100);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Place a single instruction at 0 and step it repeatedly with different register presets
    cpu.pc = kseg0(0);

    // DADD overflow: (0x7fff...ffff) + 1 -> sign flips
    writeProgram(bus.rdram, [ DADD(3,1,2) ], 0);
    cpu.regsHi[1] = 0x7fffffff >>> 0; cpu.regs[1] = 0xffffffff >>> 0;
    cpu.regsHi[2] = 0x00000000 >>> 0; cpu.regs[2] = 0x00000001 >>> 0;
    cpu.step();
    let exc = (cpu.cop0.read(13) >>> 0);
    expect(((exc >>> 2) & 0x1f)).toBe(12);

    // DADDU: same operands, no trap
    writeProgram(bus.rdram, [ DADDU(3,1,2) ], 0);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~ (1 << 1));
    cpu.pc = kseg0(0);
    cpu.step();
    expect(cpu.regsHi[3] >>> 0).toBe(0x80000000 >>> 0);
    expect(cpu.regs[3] >>> 0).toBe(0x00000000 >>> 0);

    // DSUB overflow: (0x8000...0000) - 1 -> wraps to 0x7fff...ffff -> trap
    writeProgram(bus.rdram, [ DSUB(3,1,2) ], 0);
    cpu.pc = kseg0(0);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~ (1 << 1));
    cpu.regsHi[1] = 0x80000000 >>> 0; cpu.regs[1] = 0x00000000 >>> 0;
    cpu.regsHi[2] = 0x00000000 >>> 0; cpu.regs[2] = 0x00000001 >>> 0;
    cpu.step();
    exc = (cpu.cop0.read(13) >>> 0);
    expect(((exc >>> 2) & 0x1f)).toBe(12);

    // DSUBU: same operands, no trap and correct result
    writeProgram(bus.rdram, [ DSUBU(3,1,2) ], 0);
    cpu.pc = kseg0(0);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~ (1 << 1));
    cpu.step();
    expect(cpu.regsHi[3] >>> 0).toBe(0x7fffffff >>> 0);
    expect(cpu.regs[3] >>> 0).toBe(0xffffffff >>> 0);
  });

  it('LLD/SCD succeed (basic path)', () => {
    const rdram = new RDRAM(0x200);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Memory location for test: phys 0x80 (8-aligned)
    const basePhys = 0x80 >>> 0;
    // Seed 64-bit value at 0x80: hi=0x11223344, lo=0x55667788
    const b = rdram.bytes;
    b[basePhys + 0] = 0x11; b[basePhys + 1] = 0x22; b[basePhys + 2] = 0x33; b[basePhys + 3] = 0x44;
    b[basePhys + 4] = 0x55; b[basePhys + 5] = 0x66; b[basePhys + 6] = 0x77; b[basePhys + 7] = 0x88;

    // Program: load base into r1; LLD r2, 0(r1); SCD r2, 0(r1)
    const baseVirt = kseg0(basePhys);
    const prog = [
      LUI(1, (baseVirt >>> 16) & 0xffff), ORI(1, 1, baseVirt & 0xffff),
      LLD(2, 1, 0),
      SCD(2, 1, 0),
    ];
    writeProgram(rdram, prog, 0);
    cpu.pc = kseg0(0);

    // Step all
    for (let i = 0; i < prog.length; i++) cpu.step();

    // SCD success => r2 (rt) becomes 1
    expect(cpu.regs[2] >>> 0).toBe(1);
    // Memory should equal the loaded value (unchanged)
    const hi = bit.readU32BE(b, basePhys) >>> 0;
    const lo = bit.readU32BE(b, basePhys + 4) >>> 0;
    expect(hi >>> 0).toBe(0x11223344 >>> 0);
    expect(lo >>> 0).toBe(0x55667788 >>> 0);
  });
});

