import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import * as bit from '../src/utils/bit.js';
import { MI_INTR_PI, MI_BASE, MI_INTR_MASK_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function NOP() { return 0; }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function J(target: number) { return (0x02 << 26) | ((target >>> 2) & 0x03ffffff); }
function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, base + i * 4, words[i] >>> 0);
  }
}

describe('CPU interrupts via MI', () => {
  it('takes interrupt at instruction boundary with correct EPC and Cause bits when not in delay slot', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable CP0 Status: IE and IM2 (bit for IP2)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Program: a couple of NOPs
    const prog = [NOP(), NOP()];
    loadProgram(rdram, prog, 0);

    // Step once, then assert PI interrupt (pending + mask)
    cpu.step();
    // Mask MI for PI interrupt
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, MI_INTR_PI);
    bus.mi.raise(MI_INTR_PI);

    // Next step should take interrupt before executing instruction at PC=4
    const expectedEPC = cpu.pc >>> 0; // EPC should be PC before taking exception
    cpu.step();

    const status = cpu.cop0.read(12);
    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);

    // EXL set
    expect((status & (1 << 1)) !== 0).toBe(true);
    // ExcCode 0 for interrupt
    expect(((cause >>> 2) & 0x1f) >>> 0).toBe(0);
    // IP2 should be set in Cause
    expect(((cause >>> 10) & 1) !== 0).toBe(true);
    // EPC equals expected
    expect(epc >>> 0).toBe(expectedEPC >>> 0);
  });

  it('sets BD when interrupt occurs after executing a delay slot (before branch takes)', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable CP0 Status: IE and IM2
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Program:
    //   BEQ r0, r0, +1    ; branch taken
    //   ORI r1, r0, 0x1234 ; delay slot
    //   ORI r2, r0, 0x5678 ; at branch target (should not execute before interrupt)
    const prog = [
      BEQ(0, 0, 1),
      ORI(1, 0, 0x1234),
      ORI(2, 0, 0x5678),
    ];
    loadProgram(rdram, prog, 0);

    // Also set MI mask for PI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, MI_INTR_PI);

    // Step BEQ (sets branchPending)
    cpu.step();
    // Step delay slot; right after this, we'll raise PI interrupt
    cpu.step();
    // Raise PI pending
    bus.mi.raise(MI_INTR_PI);

    // Next step should take interrupt with BD=1 and EPC=branch PC (0)
    cpu.step();

    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);

    // BD set
    expect((cause >>> 31) !== 0).toBe(true);
    // EPC should be the branch instruction address (0)
    expect(epc >>> 0).toBe(0 >>> 0);

    // After interrupt, r1 should have been set by delay slot, r2 must not yet be set (branch not taken yet)
    expect(cpu.regs[1] >>> 0).toBe(0x00001234 >>> 0);
    expect(cpu.regs[2] >>> 0).toBe(0);
  });

  it('Cause IP2 reflects MI line only when MI mask enables it; enabling mask triggers interrupt on next boundary', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Program a few NOPs
    loadProgram(rdram, [NOP(), NOP(), NOP()], 0);

    // Enable CPU IE and IM2
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);

    // Raise SI pending but leave MI mask disabled
    bus.mi.raise(1 << 1);

    // Step: since MI mask is off, IP2 should be 0 and no interrupt taken
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    const cause0 = cpu.cop0.read(13);
    const status0 = cpu.cop0.read(12);
    expect(((cause0 >>> 10) & 1)).toBe(0); // IP2 off
    expect((status0 & (1 << 1)) !== 0).toBe(false); // EXL off
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Enable MI mask for SI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Next step: interrupt should be taken before executing instruction
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    const status1 = cpu.cop0.read(12);
    const cause1 = cpu.cop0.read(13);
    expect((status1 & (1 << 1)) !== 0).toBe(true); // EXL set
    expect(((cause1 >>> 10) & 1)).toBe(1); // IP2 on
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Cleanup: ack SI and clear EXL
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    cpu.cop0.write(12, status1 & ~(1 << 1));
  });

  it('EXL masks interrupts; clearing EXL allows immediate handling on next boundary', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    loadProgram(rdram, [NOP(), NOP()], 0);

    // Enable CPU IE and IM2; enable MI mask for SI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Raise SI pending
    bus.mi.raise(1 << 1);

    // Manually set EXL to block interrupts
    const st0 = cpu.cop0.read(12);
    cpu.cop0.write(12, st0 | (1 << 1));

    // Step: no interrupt should be taken, but IP2 should reflect asserted MI line
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    const cause0 = cpu.cop0.read(13);
    expect(((cause0 >>> 10) & 1)).toBe(1); // IP2 on
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));

    // Clear EXL and step: interrupt should fire now
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);

    // Ack SI
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
  });
});
