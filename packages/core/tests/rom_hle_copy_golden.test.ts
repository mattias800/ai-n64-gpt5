import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { hleBoot } from '../src/boot/hle.js';
import { hlePiLoadSegments } from '../src/boot/loader.js';
import { MI_BASE, MI_INTR_OFF, PI_BASE, PI_STATUS_OFF } from '../src/devices/mmio.js';
import { crc32 } from './helpers/test_utils.ts';

function makeRom(size = 0x800): Uint8Array {
  const rom = new Uint8Array(size);
  // z64 magic 0x80371240
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40;
  // initial PC at 0x8
  const pc = 0x80200000 >>> 0;
  rom[8] = (pc >>> 24) & 0xff; rom[9] = (pc >>> 16) & 0xff; rom[10] = (pc >>> 8) & 0xff; rom[11] = pc & 0xff;
  // Fill payload deterministically
  for (let i = 0x40; i < size; i++) rom[i] = (i * 37 + 13) & 0xff;
  return rom;
}

function sliceCrc32(u8: Uint8Array, start: number, len: number): string {
  return crc32(u8.subarray(start, start + len));
}

describe('ROM PI loader golden copy', () => {
  it('copies multiple segments via PI and yields stable CRC of assembled buffer', () => {
    const rdram = new RDRAM(1<<20);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const rom = makeRom(0x1000);
    const boot = hleBoot(cpu, bus, rom);
    expect(boot.initialPC >>> 0).toBe(0x80200000 >>> 0);

    // Now overwrite RDRAM region with zero to ensure PI copies are measured
    rdram.bytes.fill(0);

    // Copy 3 segments with gaps and overlaps to exercise DMA
    hlePiLoadSegments(bus, [
      { cartAddr: 0x040, dramAddr: 0x200, length: 64 },
      { cartAddr: 0x080, dramAddr: 0x300, length: 128 },
      { cartAddr: 0x100, dramAddr: 0x260, length: 96 },
    ], true);

    // Build an assembled buffer covering 0x200..0x3FF (512 bytes) to CRC
    const base = 0x200; const total = 0x200; // 0x200..0x3FF inclusive
    const assembled = rdram.bytes.subarray(base, base + total);

    const got = crc32(assembled);
    expect(got).toBe('d827bdcb');

    // PI busy cleared and MI PI pending cleared by ack between segments
    const miPending = bus.loadU32(MI_BASE + MI_INTR_OFF) >>> 0;
    const piStatus = bus.loadU32(PI_BASE + PI_STATUS_OFF) >>> 0;
    expect((miPending & (1<<4)) === 0).toBe(true);
    expect((piStatus & 0x3) === 0).toBe(true);

    // Spot-check CRCs directly from ROM slices as cross-checks
    expect(sliceCrc32(rom, 0x040, 64)).toBe(crc32(rdram.bytes.subarray(0x200, 0x200+64)));
    expect(sliceCrc32(rom, 0x080, 128)).toBe(crc32(rdram.bytes.subarray(0x300, 0x300+128)));
  });
});

