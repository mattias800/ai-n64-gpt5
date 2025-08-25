import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';
import { MI_INTR_PI, MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

function NOP() { return 0; }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function COP0_ERET() { return (0x10 << 26) | (0x10 << 21) | 0x18; }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('COP0 ERET returns from exception', () => {
  it('clears EXL and jumps to EPC on ERET (normal boundary)', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable interrupts: IE + IM2 (PI via MI IP2)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    // Mask MI for PI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, MI_INTR_PI);

    // Program at 0: NOP, NOP, then ERET at vector 0x80000180
    loadProgram(rdram, [NOP(), NOP()], 0);
    // Place ERET at physical 0x00000180 (fetched via virtual 0x80000180)
    loadProgram(rdram, [COP0_ERET()], 0x00000180);

    // Step one instruction, then assert MI PI interrupt and step to trigger exception
    cpu.step();
    bus.mi.raise(MI_INTR_PI);
    cpu.step(); // should take interrupt now

    expect(((cpu.cop0.read(12) >>> 1) & 1) !== 0).toBe(true); // EXL set
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);

    // Clear pending so we don't re-enter after ERET
    bus.mi.clear(MI_INTR_PI);

    // Execute ERET
    cpu.step();

    // After ERET, EXL cleared, PC == EPC
    const status = cpu.cop0.read(12);
    expect(((status >>> 1) & 1) !== 0).toBe(false);
    const epc = cpu.cop0.read(14) >>> 0;
    expect(cpu.pc >>> 0).toBe(epc >>> 0);
  });

  it('ERET returns to EPC when BD=1 (after delay slot interrupt)', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, MI_INTR_PI);

    // Program at 0:
    //   BEQ r0, r0, +1
    //   ORI r1, r0, 0x1111   ; delay slot (executes)
    //   ORI r2, r0, 0x2222   ; branch target
    // Vector has ERET
    loadProgram(rdram, [BEQ(0, 0, 1), ORI(1, 0, 0x1111), ORI(2, 0, 0x2222)], 0);
    loadProgram(rdram, [COP0_ERET()], 0x00000180);

    // Step BEQ (sets branchPending)
    cpu.step();
    // Step delay slot, then raise interrupt and step to take it before branch commit
    cpu.step();
    bus.mi.raise(MI_INTR_PI);
    cpu.step();

    // At vector, EXL set and BD set, EPC==branch PC
    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);
    expect((cause >>> 31) !== 0).toBe(true);
    expect(epc >>> 0).toBe(0 >>> 0);

    // Ack pending
    bus.mi.clear(MI_INTR_PI);

    // ERET
    cpu.step();

    // After ERET, should return to EPC (branch PC), EXL cleared, and branch not auto-committed
    const status2 = cpu.cop0.read(12);
    expect(((status2 >>> 1) & 1) !== 0).toBe(false);
    expect(cpu.pc >>> 0).toBe(0 >>> 0);
    // r1 from delay slot executed, r2 not yet since branch wasn't committed pre-interrupt
    expect(cpu.regs[1] >>> 0).toBe(0x00001111 >>> 0);
    expect(cpu.regs[2] >>> 0).toBe(0);
  });
  it('ERET when EXL=0 raises ReservedInstruction', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Ensure EXL=0
    const status0 = cpu.cop0.read(12) & ~(1 << 1);
    cpu.cop0.write(12, status0);

    // Place ERET at 0 and step
    loadProgram(rdram, [COP0_ERET()], 0);

    // Step should raise ReservedInstruction exception and vector
    cpu.step();

    const cause = cpu.cop0.read(13);
    const excCode = (cause >>> 2) & 0x1f;
    expect(excCode).toBe(10);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
  });
});
