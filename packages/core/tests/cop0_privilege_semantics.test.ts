import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function MFC1(rt: number, fs: number) { return (0x11 << 26) | (0x00 << 21) | (rt << 16) | (fs << 11); }

function writeProgram(rdram: RDRAM, words: number[], basePhys = 0) {
  for (let i = 0; i < words.length; i++) bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
}

describe('CP0/KSU privilege and COP1 CU1 gating', () => {
  it('User mode executing COP0 (MTC0) raises ReservedInstruction', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // BEV=0, set KSU=User (2), clear EXL
    const statusBase = (cpu.cop0.read(12) & ~((1<<22) | (3<<3) | (1<<1))) >>> 0;
    cpu.cop0.write(12, (statusBase | (2 << 3)) >>> 0);

    // Program in KUSEG at 0x00000000 (identity-mapped)
    const prog = [
      ORI(1, 0, 0),
      MTC0(1, 12),
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = 0x00000000 >>> 0;

    cpu.step(); // ORI
    cpu.step(); // MTC0 -> ReservedInstruction

    const cause = cpu.cop0.read(13) >>> 0;
    const exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(10); // ReservedInstruction
    const pcVec = cpu.pc >>> 0;
    expect(pcVec).toBe((0x80000000 + 0x180) >>> 0);
  });

  it('COP1 instruction with CU1=0 raises Coprocessor Unusable (ExcCode=11)', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Kernel mode (KSU=0), BEV=0, ensure CU1=0
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~((1<<22) | (3<<3) | (1<<29)); // BEV=0, KSU=0, CU1=0
    cpu.cop0.write(12, status >>> 0);

    const prog = [
      MFC1(2, 0), // should raise Coprocessor Unusable since CU1=0
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = 0x00000000 >>> 0;

    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const exc = ((cause >>> 2) & 0x1f) >>> 0;
    expect(exc).toBe(11); // Coprocessor Unusable
    const pcVec = cpu.pc >>> 0;
    expect(pcVec).toBe((0x80000000 + 0x180) >>> 0);
  });

  it('Enabling CU1 via Status allows COP1 MFC1 without exception', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable CU1 and clear BEV; leave KSU=Kernel
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~((1<<22)); // BEV=0
    status |= (1<<29); // CU1=1
    cpu.cop0.write(12, status >>> 0);

    const prog = [
      MFC1(2, 0), // should not raise now
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = 0x00000000 >>> 0;

    cpu.step();

    // No exception => PC advanced to 0x4
    expect(cpu.pc >>> 0).toBe(0x00000004 >>> 0);
  });

  it('EXL=1 with KSU=User permits COP0 ops (no ReservedInstruction)', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Set KSU=User(2), set EXL=1, BEV=0
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~((1<<22) | (3<<3)); // BEV=0, clear KSU
    status |= (2 << 3); // KSU=2 (User)
    status |= (1 << 1); // EXL=1
    cpu.cop0.write(12, status >>> 0);

    const prog = [
      MTC0(0, 9), // write Count=0; should be allowed in EXL even if KSU=User
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = 0x00000000 >>> 0;

    cpu.step();

    // No exception => PC advanced to 0x4 (not vectored)
    expect(cpu.pc >>> 0).toBe(0x00000004 >>> 0);
  });

  it('Supervisor mode (KSU=1) permits COP0 ops when not in EXL', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Set KSU=Supervisor(1), clear EXL, BEV=0
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~((1<<22) | (3<<3) | (1<<1));
    status |= (1 << 3);
    cpu.cop0.write(12, status >>> 0);

    const prog = [
      MTC0(0, 9), // write Count=0; should be allowed
    ];
    writeProgram(bus.rdram, prog, 0);
    cpu.pc = 0x00000000 >>> 0;

    cpu.step();
    expect(cpu.pc >>> 0).toBe(0x00000004 >>> 0);
  });

  it('Status CU[3:0] bits can be written and read back', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const cuMask = ((1<<28) | (1<<29) | (1<<30) | (1<<31)) >>> 0;
    // Set all CU bits
    let s = cpu.cop0.read(12) >>> 0;
    cpu.cop0.write(12, (s | cuMask) >>> 0);
    const s1 = cpu.cop0.read(12) >>> 0;
    expect((s1 & cuMask) >>> 0).toBe(cuMask >>> 0);
    // Clear all CU bits
    cpu.cop0.write(12, (s1 & ~cuMask) >>> 0);
    const s2 = cpu.cop0.read(12) >>> 0;
    expect((s2 & cuMask) >>> 0).toBe(0);
  });
});
