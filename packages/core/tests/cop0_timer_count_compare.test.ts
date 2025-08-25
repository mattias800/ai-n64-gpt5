import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function NOP() { return 0; }
function MTC0(rt: number, rd: number) { return (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11); }
function MFC0(rt: number, rd: number) { return (0x10 << 26) | (0x00 << 21) | (rt << 16) | (rd << 11); }
function ORI(rt: number, rs: number, imm16: number) { return (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff); }

function loadProgram(bus: Bus, rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('CP0 Count/Compare timer interrupt (IP7)', () => {
  it('sets IP7 when Count == Compare; IP7 clears on writing Compare; CPU takes interrupt when enabled', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Enable IE and IM7 (bit for IP7)
    const IE = 1 << 0; const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM7);

    // Program: a handful of NOPs to advance time; place at 0
    loadProgram(bus, rdram, [NOP(), NOP(), NOP(), NOP(), NOP()], 0);

    // Set Count to 0, Compare to 3 -> after 3 steps, IP7 should set
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 3);

    // Step 2 times: Count=2, not equal yet, no interrupt
    cpu.step(); cpu.step();
    let cause = cpu.cop0.read(13);
    expect(((cause >>> 15) & 1) !== 0).toBe(false);

    // Next step: Count becomes 3, IP7 asserted; CPU should take interrupt at boundary
    const pcBefore = cpu.pc >>> 0;
    cpu.step();
    cause = cpu.cop0.read(13);
    expect(((cause >>> 15) & 1) !== 0).toBe(true);
    // Interrupt taken?
    const status = cpu.cop0.read(12);
    expect((status & (1 << 1)) !== 0).toBe(true);
    const epc = cpu.cop0.read(14);
    expect(epc >>> 0).toBe(pcBefore >>> 0);

    // Writing Compare clears IP7
    cpu.cop0.write(11, 100);
    cause = cpu.cop0.read(13);
    expect(((cause >>> 15) & 1) !== 0).toBe(false);
  });

  it('can trigger a second timer interrupt after writing Compare to a new value', () => {
    const rdram = new RDRAM(64 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const IE = 1 << 0; const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM7);

    // First interrupt: Count=0, Compare=2
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 2);

    // Step once (Count=1), capture boundary PC, then next step should take interrupt (Count=2)
    cpu.step();
    const pcBefore1 = cpu.pc >>> 0;
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(pcBefore1 >>> 0);

    // Re-arm: write Compare clears IP7
    cpu.cop0.write(11, 5);
    // Clear EXL to allow re-interrupt
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));

    // Advance until just before Count == 5
    while ((cpu.cop0.read(9) >>> 0) < 4) {
      cpu.step();
    }
    const pcBefore2 = cpu.pc >>> 0;
    // Next step should trigger at Count == 5
    cpu.step();
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.cop0.read(14) >>> 0).toBe(pcBefore2 >>> 0);
  });
});
