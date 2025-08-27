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
const DEBUG = isTruthy(process.env.N64_TESTS_DEBUG);
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
  // Disable fastboot-skip for n64-tests to preserve exact control flow
  cpu.fastbootSkipReserved = false;
  const sys = new System(cpu, bus);
  if (DEBUG) {
    cpu.onDecodeWarn = (w) => {
      // eslint-disable-next-line no-console
      console.warn(`[decode-warn] pc=${w.pc.toString(16)} kind=${w.kind}`);
    };
    let norLogs = 0;
    const NOR_LOG_LIMIT = 1024;
    cpu.onTrace = (pc, instr) => {
      const op = (instr >>> 26) & 0x3f;
      if (op === 0) {
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const rd = (instr >>> 11) & 0x1f;
        const funct = instr & 0x3f;
        if (funct === 0x27 && norLogs < NOR_LOG_LIMIT) {
          const rsv = cpu.regs[rs] >>> 0;
          const rtv = cpu.regs[rt] >>> 0;
          const v = (~(rsv | rtv)) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[nor] pc=0x${pc.toString(16)} rs=$${rs}(0x${rsv.toString(16).padStart(8,'0')}) rt=$${rt}(0x${rtv.toString(16).padStart(8,'0')}) -> rd=$${rd} 0x${v.toString(16).padStart(8,'0')}`);
          norLogs++;
        }
      } else if (op === 0x04) { // BEQ
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const rsV = cpu.regs[rs] >>> 0;
        const rtV = cpu.regs[rt] >>> 0;
        if (rs === 3 && rt === 4 && rsV !== rtV) {
          // Mismatch between computed ($v1) and expected ($a0)
          // eslint-disable-next-line no-console
          console.log(`[mismatch] pc=0x${pc.toString(16)} v1=0x${rsV.toString(16).padStart(8,'0')} a0=0x${rtV.toString(16).padStart(8,'0')} r6=0x${(cpu.regs[6]>>>0).toString(16)} r7=0x${(cpu.regs[7]>>>0).toString(16)} r8=0x${(cpu.regs[8]>>>0).toString(16)}`);
        }
      } else if (op === 0x23) { // LW
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const imm = instr & 0xffff;
        let simm = imm;
        if (simm & 0x8000) simm = (simm | 0xffff0000) >>> 0;
        const base = cpu.regs[rs] >>> 0;
        const vaddr = (base + (simm >>> 0)) >>> 0;
        if (rt === 4 && norLogs < 8) {
          const mem = bus.loadU32(vaddr) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[lw $a0] pc=0x${pc.toString(16)} addr=0x${vaddr.toString(16)} data=0x${mem.toString(16).padStart(8,'0')}`);
        }
      } else if (op === 0x37) { // LD
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const imm = instr & 0xffff;
        let simm = imm;
        if (simm & 0x8000) simm = (simm | 0xffff0000) >>> 0;
        const base = cpu.regs[rs] >>> 0;
        const addr = (base + (simm >>> 0)) >>> 0;
        if (norLogs < 8) {
          const a0 = (0xA0000000 + (addr - 0xA0000000)) >>> 0; // normalize to A-region
          const b0 = bus.loadU32(a0) >>> 0;
          const b1 = bus.loadU32((a0 + 4) >>> 0) >>> 0;
          const hi = bus.loadU32(addr & ~7) >>> 0;
          const lo = bus.loadU32((addr & ~7) + 4) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[ld $${rt}] pc=0x${pc.toString(16)} addr=0x${addr.toString(16)} -> hi=0x${hi.toString(16).padStart(8,'0')} lo=0x${lo.toString(16).padStart(8,'0')} | bus(a0)=0x${b0.toString(16).padStart(8,'0')},0x${b1.toString(16).padStart(8,'0')}`);
        }
      }
    };
  }

  // Normalize ROM to big-endian (z64) and present it to PI
  const { data: beRom } = normalizeRomToBigEndian(rom);
  bus.setROM(beRom);

  // Young-emulator path per README: copy ROM contents from 0x00001000 as much as fits into RDRAM
  const dst = 0x1000 >>> 0;
  const src = 0x1000 >>> 0; // ROM offset corresponding to 0x10001000 PI address
  // Copy as much as fits from ROM into RDRAM starting at 0x00001000 to cover larger test tables
  const maxCopy = Math.min(Math.max(0, (beRom.length - src) >>> 0), Math.max(0, rdram.bytes.length - dst));
  if (maxCopy > 0) rdram.bytes.set(beRom.subarray(src, src + maxCopy), dst);

  if (DEBUG) {
    const readU32BE = (off: number) => {
      const b = rdram.bytes;
      return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | (b[off + 3])) >>> 0;
    };
    const dump = (off: number) => {
      const hi = readU32BE(off) >>> 0;
      const lo = readU32BE(off + 4) >>> 0;
      // eslint-disable-next-line no-console
      console.log(`[rdram] @0x${off.toString(16)} hi=0x${hi.toString(16).padStart(8,'0')} lo=0x${lo.toString(16).padStart(8,'0')}`);
      const be0 = bus.loadU32(0xA0000000 + off) >>> 0;
      const be1 = bus.loadU32(0xA0000000 + off + 4) >>> 0;
      const ce0 = bus.loadU32(0x80000000 + off) >>> 0;
      const ce1 = bus.loadU32(0x80000000 + off + 4) >>> 0;
      // eslint-disable-next-line no-console
      console.log(`[bus] @A+0x${off.toString(16)} w0=0x${be0.toString(16).padStart(8,'0')} w1=0x${be1.toString(16).padStart(8,'0')} | @8+0x${off.toString(16)} w0=0x${ce0.toString(16).padStart(8,'0')} w1=0x${ce1.toString(16).padStart(8,'0')}`);
    };
    dump(0x98f8);
    dump(0xa578);
  }

  // Jump directly to the test harness entry point
  cpu.pc = START_PC >>> 0;

  // Run until r30 != 0 or until we exhaust the cycle budget
  let r30 = (cpu.regs[30] | 0);
  for (let i = 0; i < MAX_CYCLES && r30 === 0; i++) {
    sys.stepCycles(1);
    r30 = (cpu.regs[30] | 0);
    if (DEBUG && (i % 1000000 === 0)) {
      // eslint-disable-next-line no-console
      console.log(`[debug] i=${i} pc=0x${(cpu.pc>>>0).toString(16)} r30=${r30}`);
    }
  }
  if (DEBUG && r30 !== 0) {
    // Dump low and high halves of a subset of GPRs
    const lows = Array.from({ length: 12 }, (_, i) => `r${i}=0x${(cpu.regs[i]>>>0).toString(16).padStart(8,'0')}`).join(' ');
    const highs = Array.from({ length: 12 }, (_, i) => `h${i}=0x${(cpu.regsHi[i]>>>0).toString(16).padStart(8,'0')}`).join(' ');
    // eslint-disable-next-line no-console
    console.log(`[final] r30=${r30} pc=0x${(cpu.pc>>>0).toString(16)} ${lows}`);
    // eslint-disable-next-line no-console
    console.log(`[final.hi] ${highs}`);

    // Dump nearby instruction words around failure PC
    const pc = cpu.pc >>> 0;
    const window = 6;
    const lines: string[] = [];
    for (let i = -window; i <= window; i++) {
      const va = (pc + (i * 4)) >>> 0;
      const w = bus.loadU32(va) >>> 0;
      lines.push(`${i === 0 ? '>' : ' '} [0x${va.toString(16)}] 0x${w.toString(16).padStart(8,'0')}`);
    }
    // eslint-disable-next-line no-console
    console.log('[nearby]\n' + lines.join('\n'));
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

