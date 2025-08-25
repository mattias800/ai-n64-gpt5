import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { hleBootAndInitController } from '../src/index.js';

function makeZ64(initialPC: number): Uint8Array {
  const rom = new Uint8Array(0x1000);
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40; // magic
  rom[8] = (initialPC >>> 24) & 0xff;
  rom[9] = (initialPC >>> 16) & 0xff;
  rom[10] = (initialPC >>> 8) & 0xff;
  rom[11] = (initialPC >>> 0) & 0xff;
  return rom;
}

describe('HLE boot + controller init flow', () => {
  it('boots and queries controller deterministically', () => {
    const initialPC = 0x80200000 >>> 0;
    const rom = makeZ64(initialPC);
    const bus = new Bus(new RDRAM(2 * 1024 * 1024));
    const cpu = new CPU(bus);

    const ret = hleBootAndInitController(cpu, bus, rom, 0x3000);
    expect(ret.initialPC >>> 0).toBe(initialPC >>> 0);
    expect(ret.controller.present).toBe(true);
    expect(ret.controller.pak).toBe(0x00);
    expect(ret.state.status).toBe(0x00);
    expect(ret.state.buttons >>> 0).toBe(0x1234 >>> 0);
    expect(ret.state.stickX).toBe(5);
    expect(ret.state.stickY).toBe(-5);
  });
});
