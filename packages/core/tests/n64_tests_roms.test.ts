import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { normalizeRomToBigEndian } from '../src/rom/byteorder.ts';

// Dillon's n64-tests harness (opt-in)
// Enable with: N64_TESTS=1
// Default ROM dir: test-roms/n64-tests/roms (override with N64_TESTS_ROM_DIR)
// Max cycles per ROM: N64_TESTS_MAX_CYCLES (default 10,000,000)

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const ENABLED = isTruthy(process.env.N64_TESTS);
const DEFAULT_ROM_DIR = path.resolve(__dirname, '../../../test-roms/n64-tests/roms');
const ROM_DIR = process.env.N64_TESTS_ROM_DIR
  ? path.resolve(process.cwd(), process.env.N64_TESTS_ROM_DIR)
  : DEFAULT_ROM_DIR;
const MAX_CYCLES = Number.isFinite(Number(process.env.N64_TESTS_MAX_CYCLES))
  ? parseInt(process.env.N64_TESTS_MAX_CYCLES as string, 10)
  : 10_000_000;

const START_PC = 0x80001000 >>> 0; // as per n64-tests README for young emulators

function listZ64(dir: string): string[] {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.z64'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function runRomAndGetR30(romPath: string): number {
  const romBuf = fs.readFileSync(romPath);
  const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.byteLength);

  // 8MB RDRAM to match typical hardware size and allow simple physical mapping
  const rdram = new RDRAM(8 * 1024 * 1024);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  // Enable fastboot skip to avoid getting stuck in empty exception vectors during early bringup
  cpu.fastbootSkipReserved = true;
  const sys = new System(cpu, bus);

  // Normalize ROM to big-endian (z64) and present it to PI
  const { data: beRom } = normalizeRomToBigEndian(rom);
  bus.setROM(beRom);

  // Young-emulator path per README: copy 1MB from ROM to RDRAM at physical 0x00001000
  const dst = 0x1000 >>> 0;
  const src = 0x1000 >>> 0; // ROM offset corresponding to 0x10001000 PI address
  const maxCopy = Math.min(Math.max(0, (beRom.length - src) >>> 0), 0x100000 >>> 0, Math.max(0, rdram.bytes.length - dst));
  if (maxCopy > 0) rdram.bytes.set(beRom.subarray(src, src + maxCopy), dst);

  // Jump directly to the test harness entry point
  cpu.pc = START_PC >>> 0;

  // Run until r30 != 0 or until we exhaust the cycle budget
  let r30 = (cpu.regs[30] | 0);
  for (let i = 0; i < MAX_CYCLES && r30 === 0; i++) {
    sys.stepCycles(1);
    r30 = (cpu.regs[30] | 0);
  }
  return r30 | 0;
}

const roms = listZ64(ROM_DIR);
const suite = (ENABLED && roms.length > 0) ? describe : describe.skip;

suite('n64-tests ROMs (opt-in; set N64_TESTS=1)', () => {
  if (!ENABLED) {
    // eslint-disable-next-line no-console
    console.warn('Skipping n64-tests: set N64_TESTS=1 to enable.');
  } else if (roms.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`Skipping n64-tests: no .z64 ROMs found in ${ROM_DIR}.`);
  }

  for (const romPath of roms) {
    const name = path.basename(romPath);
    test(`n64-tests: ${name}`, () => {
      const r30 = runRomAndGetR30(romPath);
      // Pass iff r30 == -1 (0xFFFFFFFF); any other non-zero value is a failure code
      if (r30 === -1) {
        expect(r30).toBe(-1);
      } else if (r30 === 0) {
        throw new Error(`Timed out waiting for r30 != 0 (MAX_CYCLES=${MAX_CYCLES}).`);
      } else {
        throw new Error(`n64-tests failure: r30=${r30} (0x${(r30 >>> 0).toString(16)})`);
      }
    }, 120_000);
  }
});

