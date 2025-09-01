import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';

// Opcode helpers (big-endian encoding as in existing tests)
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function OR(rd: number, rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (0 << 6) | 0x25; }
function DSLL32(rd: number, rt: number, sa: number) { return (0x00 << 26) | (0 << 21) | (rt << 16) | (rd << 11) | ((sa & 0x1f) << 6) | 0x3c; }
function MFHI(rd: number) { return (0x00 << 26) | (0 << 21) | (0 << 16) | (rd << 11) | (0 << 6) | 0x10; }
function MFLO(rd: number) { return (0x00 << 26) | (0 << 21) | (0 << 16) | (rd << 11) | (0 << 6) | 0x12; }
function DMULT(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x1c; }
function DMULTU(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x1d; }
function DDIV(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x1e; }
function DDIVU(rs: number, rt: number) { return (0x00 << 26) | (rs << 21) | (rt << 16) | (0 << 11) | (0 << 6) | 0x1f; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

// Build a 64-bit constant in rd using temp register tmp.
// Sequence:
//   rd = hi32
//   rd = rd << 32
//   tmp = lo32
//   rd = rd | tmp
function buildImm64(rd: number, tmp: number, hi32: number, lo32: number): number[] {
  return [
    LUI(rd, (hi32 >>> 16) & 0xffff), ORI(rd, rd, hi32 & 0xffff),
    DSLL32(rd, rd, 0),
    LUI(tmp, (lo32 >>> 16) & 0xffff), ORI(tmp, tmp, lo32 & 0xffff),
    OR(rd, rd, tmp),
  ];
}

function split64(x: bigint): { hi: number, lo: number } {
  const lo = Number(x & 0xffffffffn) >>> 0;
  const hi = Number((x >> 32n) & 0xffffffffn) >>> 0;
  return { hi, lo };
}

function parts128(x: bigint): { hi64: { hi:number, lo:number }, lo64: { hi:number, lo:number } } {
  const m64 = (1n << 64n) - 1n;
  const lo64 = x & m64;
  const hi64 = (x >> 64n) & m64;
  return { hi64: split64(hi64), lo64: split64(lo64) };
}

describe('DMULTU/DMULT 64-bit products into HI/LO (128-bit total)', () => {
  it('DMULTU: 0xFFFFFFFFFFFFFFFF * 2 -> HI=1, LO=0xFFFFFFFFFFFFFFFE', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = 0xFFFF_FFFF_FFFF_FFFF
    // r2 = 0x0000_0000_0000_0002
    const prog: number[] = [
      ...buildImm64(1, 7, 0xffffffff >>> 0, 0xffffffff >>> 0),
      ...buildImm64(2, 7, 0x00000000, 0x00000002),
      DMULTU(1, 2), MFHI(3), MFLO(4),
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();

    // Expect
    const P = (2n ** 64n - 1n) * 2n; // 0x1FFFFFFFFFFFFFFE
    const { hi64, lo64 } = parts128(P);

    expect(cpu['regsHi'][3] >>> 0).toBe(hi64.hi >>> 0);
    expect(cpu['regs'][3] >>> 0).toBe(hi64.lo >>> 0);
    expect(cpu['regsHi'][4] >>> 0).toBe(lo64.hi >>> 0);
    expect(cpu['regs'][4] >>> 0).toBe(lo64.lo >>> 0);
  });

  it('DMULT: (-1) * (-1) -> HI=0, LO=1', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = -1 (0xFFFF_FFFF_FFFF_FFFF)
    // r2 = -1
    const prog: number[] = [
      ...buildImm64(1, 7, 0xffffffff >>> 0, 0xffffffff >>> 0),
      ...buildImm64(2, 7, 0xffffffff >>> 0, 0xffffffff >>> 0),
      DMULT(1, 2), MFHI(3), MFLO(4),
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();

    const P = (-1n) * (-1n); // 1n
    const { hi64, lo64 } = parts128(P);

    expect(cpu['regsHi'][3] >>> 0).toBe(hi64.hi >>> 0);
    expect(cpu['regs'][3] >>> 0).toBe(hi64.lo >>> 0);
    expect(cpu['regsHi'][4] >>> 0).toBe(lo64.hi >>> 0);
    expect(cpu['regs'][4] >>> 0).toBe(lo64.lo >>> 0);
  });
});

describe('DDIVU/DDIV 64-bit division into LO/HI', () => {
  it('DDIVU: dividend < divisor -> q=0, r=dividend', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // r1 = 5, r2 = 7
    const prog: number[] = [
      ...buildImm64(1, 7, 0x00000000, 0x00000005),
      ...buildImm64(2, 7, 0x00000000, 0x00000007),
      DDIVU(1, 2), MFLO(3), MFHI(4),
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    // q=0, r=5
    expect(cpu['regsHi'][3] >>> 0).toBe(0);
    expect(cpu['regs'][3] >>> 0).toBe(0);
    expect(cpu['regsHi'][4] >>> 0).toBe(0);
    expect(cpu['regs'][4] >>> 0).toBe(5);
  });

  it('DDIV: -7 / 3 -> q=-2, r=-1 (trunc toward 0, remainder sign matches dividend)', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    const prog: number[] = [
      ...buildImm64(1, 7, 0xffffffff >>> 0, 0xfffffff9 >>> 0), // -7
      ...buildImm64(2, 7, 0x00000000, 0x00000003), // 3
      DDIV(1, 2), MFLO(3), MFHI(4),
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    // q = -2 -> 0xFFFF_FFFF_FFFF_FFFE, r = -1 -> 0xFFFF_FFFF_FFFF_FFFF
    expect(cpu['regsHi'][3] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regs'][3] >>> 0).toBe(0xfffffffe >>> 0);
    expect(cpu['regsHi'][4] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regs'][4] >>> 0).toBe(0xffffffff >>> 0);
  });

  it('DDIV/DDDVI by zero behavior: LO all-ones, HI=dividend', () => {
    const rdram = new RDRAM(64 * 1024); const bus = new Bus(rdram); const cpu = new CPU(bus);
    // Signed
    let prog: number[] = [
      ...buildImm64(1, 7, 0x00000000, 0x0000000a), // 10
      ...buildImm64(2, 7, 0x00000000, 0x00000000), // 0
      DDIV(1, 2), MFLO(3), MFHI(4),
    ];
    loadProgram(rdram, prog, 0);
    for (let i = 0; i < prog.length; i++) cpu.step();
    // LO = -1, HI = dividend
    expect(cpu['regsHi'][3] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regs'][3] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regsHi'][4] >>> 0).toBe(0x00000000);
    expect(cpu['regs'][4] >>> 0).toBe(0x0000000a);

    // Unsigned
    prog = [
      ...buildImm64(5, 7, 0xffffffff >>> 0, 0xffffffff >>> 0), // dividend = max
      ...buildImm64(6, 7, 0x00000000, 0x00000000), // divisor = 0
      DDIVU(5, 6), MFLO(7), MFHI(8),
    ];
    loadProgram(rdram, prog, 0x200);
    cpu.pc = 0x200;
    for (let i = 0; i < prog.length; i++) cpu.step();
    // LO=0xFFFF..FFFF, HI=dividend
    expect(cpu['regsHi'][7] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regs'][7] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regsHi'][8] >>> 0).toBe(0xffffffff >>> 0);
    expect(cpu['regs'][8] >>> 0).toBe(0xffffffff >>> 0);
  });
});

