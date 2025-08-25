import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { hlePiLoadSegments } from '../src/boot/loader.js';

function makeROM(): Uint8Array {
  const rom = new Uint8Array(0x400);
  for (let i = 0; i < rom.length; i++) rom[i] = (i & 0xff);
  return rom;
}

describe('HLE PI multi-segment loader', () => {
  it('copies multiple segments and acks MI between segments deterministically', () => {
    const bus = new Bus(new RDRAM(0x1000));
    const rom = makeROM();
    bus.setROM(rom);

    // Copy three segments
    hlePiLoadSegments(bus, [
      { cartAddr: 0x000, dramAddr: 0x200, length: 16 },
      { cartAddr: 0x080, dramAddr: 0x220, length: 8 },
      { cartAddr: 0x100, dramAddr: 0x300, length: 32 },
    ], true);

    // Verify segment bytes
    for (let i = 0; i < 16; i++) expect(bus.rdram.bytes[0x200 + i]).toBe(rom[0x000 + i]);
    for (let i = 0; i < 8; i++) expect(bus.rdram.bytes[0x220 + i]).toBe(rom[0x080 + i]);
    for (let i = 0; i < 32; i++) expect(bus.rdram.bytes[0x300 + i]).toBe(rom[0x100 + i]);
  });
});

