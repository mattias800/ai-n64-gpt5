import { describe, it, expect } from 'vitest';
import { Bus, RDRAM, CPU, System } from '../src/index.js';

// This test validates the targeted reserved-instruction skip at a specific PC.
// It programs the general exception vector to jump to 0x8005c800, plants a
// deliberately invalid/unknown REGIMM-variant instruction at that PC, enables
// the targeted skip for 0x8005c800, and steps the CPU. The CPU should treat the
// bad instruction as a NOP at that PC and continue to 0x8005c804 (the 'j' to +12).
//
// Encodings used:
//  - j 0x8005c800 => 0x08017200 (imm26 = (0x8005c800 & 0x0fffffff) >> 2)
//  - invalid regimm variant => 0x041f1234 (op=REGIMM, rt=0x1f is unknown)
//  - j 0x8005c80c => 0x08017203
//  - nop => 0x00000000

describe('CPU targeted reserved-instruction skip', () => {
  it('skips a reserved instruction only at the targeted PC', () => {
    const rdram = new RDRAM(8 * 1024 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Program general exception vector at 0x80000180 (phys 0x00000180)
    // j 0x8005c800; nop
    bus.storeU32(0x00000180 >>> 0, 0x08017200 >>> 0);
    bus.storeU32(0x00000184 >>> 0, 0x00000000 >>> 0);

    // Plant a reserved/unknown instruction at the targeted PC, followed by j target+12; nop
    const targetVA = 0x8005c800 >>> 0;
    const targetPA = (targetVA - 0x80000000) >>> 0; // KSEG0 mapping
    bus.storeU32(targetPA >>> 0, 0x041f1234 >>> 0); // invalid REGIMM variant (unknown rt)
    // After skipping the bad instruction, execute an absolute jump to target+12
    // j 0x8005c80c => 0x08017203; then nop
    bus.storeU32((targetPA + 4) >>> 0, 0x08017203 >>> 0); // j 0x8005c80c
    bus.storeU32((targetPA + 8) >>> 0, 0x00000000 >>> 0); // nop

    // Enable targeted skip at 0x8005c800
    try {
      (cpu as any).addReservedSkipPC?.(targetVA);
    } catch {
      // If method is available strongly typed
      (cpu as any).addReservedSkipPC?.(targetVA);
    }

    // Collect a short execution trace
    const trace: Array<{ pc: number; instr: number }> = [];
    (cpu as any).onTrace = (pc: number, instr: number) => {
      if (trace.length < 16) trace.push({ pc: pc >>> 0, instr: instr >>> 0 });
    };

    // Start at the exception vector and step a few cycles
    cpu.pc = 0x80000180 >>> 0;
    sys.stepCycles(32);

    // We expect to see 0x80000180 (jump), then PC == 0x8005c800 (bad instr),
    // and crucially the next PC observed should be 0x8005c804 (the 'j'), meaning
    // the reserved instruction was treated as NOP at that exact address.
    const pcs = trace.map(t => t.pc);
    const hasJump = pcs.includes(0x80000180 >>> 0);
    const sawTarget = pcs.includes(targetVA >>> 0);
    const sawAfterTarget = pcs.includes((targetVA + 4) >>> 0);
    const sawFinal = pcs.includes((targetVA + 12) >>> 0);

    expect(hasJump).toBe(true);
    expect(sawTarget).toBe(true);
    // We should see the instruction immediately after the bad one (the 'j')
    expect(sawAfterTarget).toBe(true);
    // And we should observe landing at target+12 as the jump destination
    expect(sawFinal).toBe(true);
  });
});

