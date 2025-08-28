import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

// Helpers
function setCompare(cpu: CPU, value: number) { cpu.cop0.write(11, value >>> 0); }
function readCount(cpu: CPU) { return cpu.cop0.read(9) >>> 0; }
function readCause(cpu: CPU) { return cpu.cop0.read(13) >>> 0; }

describe('CP0 timer rate and IP7 semantics', () => {
  it('Count increments at configured half-rate (divisor=2)', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus, { countDivisor: 2 });

    // Reset Count
    cpu.cop0.write(9, 0);

    // Step 5 instructions, Count should be floor(5/2) = 2
    for (let i = 0; i < 5; i++) cpu.step();
    expect(readCount(cpu)).toBe(2);
  });

  it('IP7 sets exactly when Count==Compare and stays pending until Compare write', () => {
    const bus = new Bus(new RDRAM(64 * 1024));
    const cpu = new CPU(bus, { countDivisor: 2 });

    // Ensure BEV=0; IE enabled; IM7 enabled
    let status = cpu.cop0.read(12) >>> 0;
    status &= ~(1 << 22); // BEV=0
    status |= 1; // IE
    status |= (1 << (8 + 7)); // IM7
    cpu.cop0.write(12, status >>> 0);

    cpu.cop0.write(9, 0); // Count=0
    setCompare(cpu, 3);   // Fire when Count reaches 3

    // With divisor=2, tick happens every 2 steps
    // Steps: after 6 steps, Count increments 3 times -> equals Compare
    for (let i = 0; i < 6; i++) cpu.step();

    const causeAfter = readCause(cpu);
    const ip7 = (causeAfter >>> 15) & 1;
    expect(ip7).toBe(1);

    // Step more; IP7 should remain pending until Compare is written
    for (let i = 0; i < 4; i++) cpu.step();
    const causeStill = readCause(cpu);
    expect(((causeStill >>> 15) & 1)).toBe(1);

    // Write Compare to clear IP7
    setCompare(cpu, 10);
    const causeCleared = readCause(cpu);
    expect(((causeCleared >>> 15) & 1)).toBe(0);
  });
});

