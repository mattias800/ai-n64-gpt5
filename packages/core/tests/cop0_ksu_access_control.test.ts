import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}

function kseg0(p: number) { return (0x80000000 >>> 0) + (p >>> 0); }

describe('KSU user-mode access control', () => {
  it('Instruction fetch from KSEG0 in user mode raises ADEL', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Set Status to KSU=User (10b), EXL=0
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~0x18; // clear KSU bits [4:3]
    status |= 0x10;  // set to User (10b)
    cpu.cop0.write(12, status >>> 0);

    // Set PC to KSEG0 address and attempt to fetch
    cpu.pc = kseg0(0x0);
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(4); // ADEL
  });

  it('LW from KSEG0 in user mode raises ADEL; SW raises ADES', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus); // default identityMapKuseg=true

    // Program in KUSEG: set r1=0x8000_0000, then LW r2,0(r1)
    const prog1 = [ LUI(1, 0x8000), LW(2, 1, 0) ];
    writeProgram(bus.rdram, prog1, 0x0000);

    // Set Status to User mode
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~0x18; status |= 0x10; cpu.cop0.write(12, status >>> 0);

    // Execute from KUSEG 0x0000
    cpu.pc = 0x00000000 >>> 0;
    // LUI executes, LW should fault
    cpu.step();
    cpu.step();
    let cause = cpu.cop0.read(13) >>> 0;
    let exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(4); // ADEL

    // Clear EXL before next access so user restrictions apply again
    status = cpu.cop0.read(12) >>> 0;
    status &= ~0x2; // clear EXL bit
    cpu.cop0.write(12, status >>> 0);

    // Now test SW ADES
    const prog2 = [ LUI(1, 0x8000), SW(0, 1, 0) ];
    writeProgram(bus.rdram, prog2, 0x0040);
    cpu.pc = 0x00000040 >>> 0;
    cpu.step();
    cpu.step();
    cause = cpu.cop0.read(13) >>> 0;
    exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(5); // ADES
  });

  it('LW from KUSEG in user mode succeeds', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus); // identityMapKuseg=true

    // Place a word at phys 0x0
    bit.writeU32BE(bus.rdram.bytes, 0x0, 0x11223344 >>> 0);

    // Program: LW r3,0(r0)
    const prog = [ LW(3, 0, 0) ];
    writeProgram(bus.rdram, prog, 0x0080);

    // Set User mode
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~0x18; status |= 0x10; cpu.cop0.write(12, status >>> 0);

    cpu.pc = 0x00000080 >>> 0;
    cpu.step();

    expect((cpu as any)['regs'][3] >>> 0).toBe(0x11223344 >>> 0);
  });
});
