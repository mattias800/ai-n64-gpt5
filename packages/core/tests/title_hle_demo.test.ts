import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleDemo } from '../src/boot/title_hle.js';

function makeROM(): Uint8Array {
  const rom = new Uint8Array(0x400);
  // z64 magic
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40;
  // initial PC
  rom[8] = 0x80; rom[9] = 0x20; rom[10] = 0x00; rom[11] = 0x00;
  // Fill some bytes for segments
  for (let i = 0; i < rom.length; i++) rom[i] = (i & 0xff);
  return rom;
}

describe('HLE Title Demo sequence', () => {
  it('boots, loads segments, schedules VI and SP tasks, and runs a deterministic frame loop', () => {
    const rdram = new RDRAM(1 << 16);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const rom = makeROM();

    const res = hleTitleDemo(
      cpu,
      bus,
      sys,
      rom,
      [
        { cartAddr: 0x000, dramAddr: 0x1000, length: 64 },
        { cartAddr: 0x200, dramAddr: 0x1200, length: 32 },
      ],
      {
        vblank: { start: 1, interval: 3, times: 5 },
        spTasks: { start: 2, interval: 4, times: 4 },
        totalCycles: 24,
      }
    );

    // Expect 5 VI acks and 4 DP acks in 24 cycles; SP tasks scheduled same times as DP kicks
    expect(res.viAcks).toBe(5);
    expect(res.dpAcks).toBe(4);
    expect(res.spAcks).toBe(4);
    expect(res.steps).toBe(24);
    // Spot-check copies
    for (let i = 0; i < 16; i++) expect(rdram.bytes[0x1000 + i]).toBe(rom[0x000 + i]);
    for (let i = 0; i < 16; i++) expect(rdram.bytes[0x1200 + i]).toBe(rom[0x200 + i]);
  });
});

