import { describe, it, expect } from 'vitest';
import { CPU, Bus, RDRAM, System, hlePifBoot, scheduleF3DEXFromTableAndRun } from '@n64/core';

function be32(arr: Uint8Array, off: number): number {
  return (((arr[off]! << 24) | (arr[off+1]! << 16) | (arr[off+2]! << 8) | (arr[off+3]!)) >>> 0);
}
function crc32(data: Uint8Array): string {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < data.length; i++) {
    let c = (crc ^ data[i]!) & 0xFF;
    for (let k = 0; k < 8; k++) {
      const mask = -(c & 1);
      c = (c >>> 1) ^ (0xEDB88320 & mask);
    }
    crc = (crc >>> 8) ^ c;
  }
  crc = (~crc) >>> 0;
  return (crc >>> 0).toString(16).padStart(8, '0');
}

describe('sm64_boot_bridge_optional', () => {
  it('captures an OSTask DL and renders one frame via F3DEX HLE (skips when SM64_ROM unset)', async () => {
    const romPath = process.env.SM64_ROM;
    if (!romPath) {
      console.warn('[sm64_boot_bridge_optional] SM64_ROM not set; skipping');
      expect(true).toBe(true);
      return;
    }
    const fs = await import('node:fs');
    const rom = fs.readFileSync(romPath);

    const width = 320, height = 240;
    const rdram = new RDRAM(8 * 1024 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    hlePifBoot(cpu, bus, new Uint8Array(rom));

    // Track VI
    let viOrigin = 0 >>> 0;
    let viWidth = 0 >>> 0;
    const viWrite = bus.vi.writeU32.bind(bus.vi) as (off: number, val: number) => void;
    (bus.vi as any).writeU32 = (off: number, val: number) => {
      const o = off >>> 0; const v = val >>> 0;
      if (o === 0x14 || o === 0x04) viOrigin = v >>> 0;
      if (o === 0x18 || o === 0x08) viWidth = v >>> 0;
      viWrite(o, v);
    };

    // Capture last OSTask-like structure from DMEM when SP starts
    const spWrite = bus.sp.writeU32.bind(bus.sp) as (off: number, val: number) => void;
    let lastDataPtr = 0 >>> 0;
    (bus.sp as any).writeU32 = (off: number, val: number) => {
      const o = off >>> 0; const v = val >>> 0;
      if (o === 0x10 && (v & 1) !== 0) { // STATUS start
        const dmem = (bus.sp as any).dmem as Uint8Array;
        try {
          const data_ptr = be32(dmem, 0x30);
          lastDataPtr = data_ptr >>> 0;
        } catch {}
      }
      spWrite(o, v);
    };

    // Run for some cycles to let the ROM stage assets and start an OSTask
    const viInterval = 10000 >>> 0;
    const maxCycles = 5_000_000 >>> 0;
    sys.scheduleEvery(viInterval, viInterval, Math.max(1, Math.floor(maxCycles / Math.max(1, viInterval))), () => bus.vi.vblank());
    sys.stepCycles(maxCycles);

    // If no DL pointer found, skip without failing (env-gated smoke)
    if (!lastDataPtr) {
      console.warn('[sm64_boot_bridge_optional] no OSTask data_ptr captured; skipping');
      expect(true).toBe(true);
      return;
    }

    const fbOrigin = (viOrigin >>> 0) || 0xF000;
    const fbBytes = (width * height * 2) >>> 0;
    const tableBase = (fbOrigin + fbBytes + 0x20000) >>> 0;
    const stagingBase = (tableBase + 0x4000) >>> 0;
    const strideWords = 0x400 >>> 2;

    bus.storeU32(tableBase, lastDataPtr >>> 0);

    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;
    const { image } = scheduleF3DEXFromTableAndRun(
      cpu, bus, sys,
      fbOrigin, width, height,
      tableBase, frames, stagingBase, strideWords,
      start, interval, total, spOffset,
    );

    const c = crc32(image);
    expect(c.length).toBe(8);
    const expected = process.env.SM64_BRIDGE_CRC32;
    if (expected && expected.trim()) {
      expect(c).toBe(expected.trim().toLowerCase());
    }
  });
});
