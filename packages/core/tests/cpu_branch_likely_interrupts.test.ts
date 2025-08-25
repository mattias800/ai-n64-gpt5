import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

function BEQL(rs: number, rt: number, off: number) { return (0x14 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }
function NOP() { return 0; }

function writeWord(bytes: Uint8Array, off: number, w: number) {
  bytes[off + 0] = (w >>> 24) & 0xff;
  bytes[off + 1] = (w >>> 16) & 0xff;
  bytes[off + 2] = (w >>> 8) & 0xff;
  bytes[off + 3] = (w >>> 0) & 0xff;
}

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) writeWord(rdram.bytes, base + i * 4, words[i] >>> 0);
}

describe('Branch-likely + MI interrupt interaction', () => {
  it('BEQL taken: executes delay slot, interrupt after delay slot sets BD and EPC=branch PC', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable IE and IM2
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    // Enable MI mask for PI (use PI for variety)
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 4);

    // Program: BEQL r0,r0,+1 (taken), delay slot ORI r1,0,0x1234, then target ORI r2,0,0x5678
    loadProgram(rdram, [
      BEQL(0, 0, 1),
      ORI(1, 0, 0x1234),
      ORI(2, 0, 0x5678),
    ], 0);

    // Step BEQL
    cpu.step();
    // Step delay slot; right after this, raise PI pending
    cpu.step();
    bus.mi.raise(1 << 4);

    // Next step: should take interrupt with BD=1 and EPC=0
    cpu.step();
    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);
    expect((cause >>> 31) & 1).toBe(1);
    expect(epc >>> 0).toBe(0 >>> 0);
    // r1 was set by delay slot; r2 not yet set
    expect(cpu.regs[1] >>> 0).toBe(0x1234 >>> 0);
    expect(cpu.regs[2] >>> 0).toBe(0);
  });

  it('BEQL not taken: skips delay slot; interrupt at next boundary has BD=0 and EPC=PC after skip', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable IE and IM2 and MI mask for SI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Set r1=1 so BEQL r0,r1 is not taken
    // Program: ORI r1,0,1; BEQL r0,r1,+1 (not taken); delay slot ORI r2,0,0x9999 (should be skipped);
    // then ORI r3,0,0xAAAA (next instruction after skipped delay); interrupt will be raised before executing this.
    loadProgram(rdram, [
      ORI(1, 0, 1),
      BEQL(0, 1, 1),
      ORI(2, 0, 0x9999),
      ORI(3, 0, 0xAAAA),
    ], 0);

    // Execute ORI r1, step BEQL (not taken, should skip delay slot -> PC advances by 8)
    cpu.step();
    cpu.step();
    const expectedEPC = cpu.pc >>> 0; // should be 8
    // Raise SI pending, then step to take interrupt
    bus.mi.raise(1 << 1);
    cpu.step();

    const cause = cpu.cop0.read(13);
    const epc = cpu.cop0.read(14);
    expect((cause >>> 31) & 1).toBe(0); // BD not set
    expect(epc >>> 0).toBe(expectedEPC >>> 0);
    // r2 should remain 0 because delay slot was skipped; r3 not executed due to interrupt
    expect(cpu.regs[2] >>> 0).toBe(0);
    expect(cpu.regs[3] >>> 0).toBe(0);
  });
});

