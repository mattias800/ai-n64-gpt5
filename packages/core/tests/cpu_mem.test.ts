import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';
import { CPUException } from '../src/cpu/exceptions.js';

function SW(rt: number, rs: number, imm16: number) { return (0x2b << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LW(rt: number, rs: number, imm16: number) { return (0x23 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SH(rt: number, rs: number, imm16: number) { return (0x29 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LH(rt: number, rs: number, imm16: number) { return (0x21 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function SB(rt: number, rs: number, imm16: number) { return (0x28 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LB(rt: number, rs: number, imm16: number) { return (0x20 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LBU(rt: number, rs: number, imm16: number) { return (0x24 << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function LUI(rt: number, imm16: number) { return (0x0f << 26) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('CPU memory loads/stores with alignment', () => {
  it('performs aligned SW/LW and unaligned throws', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // r1 = 0x00001000; store word into [0x1000], then load back to r2
    const prog = [
      LUI(1, 0x0001),
      SW(1, 0, 0x0000), // SW r1, 0(r0) -> to address 0
      LW(2, 0, 0x0000)  // LW r2, 0(r0)
    ];

    loadProgram(rdram, prog, 0);

    // Set r1 to 0x00010000 via LUI, then execute SW and LW
    for (let i = 0; i < prog.length; i++) cpu.step();

    expect(cpu['regs'][1] >>> 0).toBe(0x00010000 >>> 0);
    const loaded = cpu['regs'][2] >>> 0;
    expect(loaded).toBe(0x00010000 >>> 0);

    // Now try unaligned LW at 0x0002 -> AddressErrorLoad exception flow
    const unaligned = [ LW(3, 0, 0x0002) ];
    loadProgram(rdram, unaligned, 0x40);
    cpu.pc = 0x40;
    const lwPC = cpu.pc >>> 0;
    cpu.step();
    let cause = cpu.cop0.read(13); let exc = (cause >>> 2) & 0x1f;
    expect(exc).toBe(4);
    expect(cpu.cop0.read(14) >>> 0).toBe(lwPC);

    // Unaligned SH at 0x0001 -> AddressErrorStore exception
    const unalignedSH = [ SH(1, 0, 0x0001) ];
    loadProgram(rdram, unalignedSH, 0x80);
    cpu.pc = 0x80;
    const shPC = cpu.pc >>> 0;
    cpu.step();
    cause = cpu.cop0.read(13); exc = (cause >>> 2) & 0x1f;
    expect(exc).toBe(5);
    expect(cpu.cop0.read(14) >>> 0).toBe(shPC);
  });

  it('byte loads/stores work and sign/zero extend correctly', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Write a byte 0xF0 to address 3, then LB and LBU into r1/r2
    const prog = [
      SB(0, 0, 0x0003), // store r0 (0) initially
      LB(1, 0, 0x0003),
      LBU(2, 0, 0x0003)
    ];
    loadProgram(rdram, prog, 0);

    // Manually write byte into memory
    bus.storeU8(3, 0xF0);

    for (let i = 0; i < prog.length; i++) cpu.step();

    // LB sign extends: 0xF0 -> 0xFFFFFFF0; LBU zero extends: 0x000000F0
    expect(cpu['regs'][1] | 0).toBe(-16);
    expect(cpu['regs'][2] >>> 0).toBe(0xF0);
  });
});

