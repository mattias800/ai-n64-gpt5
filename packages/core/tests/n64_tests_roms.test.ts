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
const TRACE_MEM = isTruthy(process.env.N64_TESTS_TRACE_MEM);
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
      const details = w.details ? ` details=${JSON.stringify(w.details)}` : '';
      console.warn(`[decode-warn] pc=${w.pc.toString(16)} kind=${w.kind}${details}`);
    };
    // Debug trace caps
    const LIMITS = { nor: 64, shift: 64, mem: 8, basic: 256 } as const;
    const traceCounts = { nor: 0, sra: 0, srav: 0, dsllv: 0, dsrav: 0, dsra: 0, slt: 0, sltu: 0, lw: 0, ld: 0 };
    cpu.onTrace = (pc, instr) => {
      const op = (instr >>> 26) & 0x3f;
      if (op === 0) {
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const rd = (instr >>> 11) & 0x1f;
        const shamt = (instr >>> 6) & 0x1f;
        const funct = instr & 0x3f;
        if (funct === 0x27 && traceCounts.nor < LIMITS.nor) {
          const rsv = cpu.regs[rs] >>> 0;
          const rtv = cpu.regs[rt] >>> 0;
          const v = (~(rsv | rtv)) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[nor] pc=0x${pc.toString(16)} rs=$${rs}(0x${rsv.toString(16).padStart(8,'0')}) rt=$${rt}(0x${rtv.toString(16).padStart(8,'0')}) -> rd=$${rd} 0x${v.toString(16).padStart(8,'0')}`);
          traceCounts.nor++;
        }
        // Targeted tracing for failing tests
        if (funct === 0x03 && traceCounts.sra < LIMITS.shift) { // SRA
          const rtv = cpu.regs[rt] | 0; const v = (rtv >> shamt) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[sra] pc=0x${pc.toString(16)} rt=$${rt}(0x${(cpu.regs[rt]>>>0).toString(16).padStart(8,'0')}) sh=${shamt} -> rd=$${rd} 0x${v.toString(16).padStart(8,'0')}`);
          traceCounts.sra++;
        } else if (funct === 0x07 && traceCounts.srav < LIMITS.shift) { // SRAV
          const sa = (cpu.regs[rs] & 0x1f) >>> 0; const rtv = cpu.regs[rt] | 0; const v = (rtv >> sa) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[srav] pc=0x${pc.toString(16)} rs=$${rs}(0x${(cpu.regs[rs]>>>0).toString(16)}) rt=$${rt}(0x${(cpu.regs[rt]>>>0).toString(16)}) sa=${sa} -> rd=$${rd} 0x${v.toString(16).padStart(8,'0')}`);
          traceCounts.srav++;
        } else if (funct === 0x14 && traceCounts.dsllv < LIMITS.shift) { // DSLLV
          const sa = (cpu.regs[rs] & 0x3f) >>> 0; const hi0 = cpu.regsHi[rt]>>>0; const lo0 = cpu.regs[rt]>>>0;
          let hiN=0>>>0, loN=0>>>0; if (sa===0){hiN=hi0;loN=lo0;} else if(sa<32){hiN=((hi0<<sa)|(lo0>>>(32-sa)))>>>0; loN=(lo0<<sa)>>>0;} else if(sa<64){hiN=(lo0<<(sa-32))>>>0; loN=0;} else {hiN=0;loN=0;}
          // eslint-disable-next-line no-console
          console.log(`[dsllv] pc=0x${pc.toString(16)} rs=$${rs}(sa=${sa}) rt=$${rt}(hi=0x${hi0.toString(16).padStart(8,'0')} lo=0x${lo0.toString(16).padStart(8,'0')}) -> rd=$${rd} hi=0x${hiN.toString(16).padStart(8,'0')} lo=0x${loN.toString(16).padStart(8,'0')}`);
          traceCounts.dsllv++;
        } else if (funct === 0x17 && traceCounts.dsrav < LIMITS.shift) { // DSRAV
          const sa = (cpu.regs[rs] & 0x3f) >>> 0; const hi0 = cpu.regsHi[rt]>>>0; const lo0 = cpu.regs[rt]>>>0; const hiS = (hi0|0);
          let hiN=0>>>0, loN=0>>>0; if (sa===0){hiN=hi0;loN=lo0;} else if(sa<32){loN=((lo0>>>sa)|((hi0<<(32-sa))>>>0))>>>0; hiN=(hiS>>sa)>>>0;} else if(sa<64){loN=(hiS>>(sa-32))>>>0; hiN=((hi0>>>31)!==0)?0xffffffff:0;} else {loN=((hi0>>>31)!==0)?0xffffffff:0; hiN=loN;}
          // eslint-disable-next-line no-console
          console.log(`[dsrav] pc=0x${pc.toString(16)} rs=$${rs}(sa=${sa}) rt=$${rt}(hi=0x${hi0.toString(16).padStart(8,'0')} lo=0x${lo0.toString(16).padStart(8,'0')}) -> rd=$${rd} hi=0x${hiN.toString(16).padStart(8,'0')} lo=0x${loN.toString(16).padStart(8,'0')}`);
          traceCounts.dsrav++;
        } else if (funct === 0x3b && traceCounts.dsra < LIMITS.shift) { // DSRA (immediate, 0..31)
          const sa = (shamt & 0x1f) >>> 0; const hi0 = cpu.regsHi[rt]>>>0; const lo0 = cpu.regs[rt]>>>0; const hiS = (hi0|0);
          let hiN=0>>>0, loN=0>>>0; if (sa===0){hiN=hi0;loN=lo0;} else { loN=((lo0>>>sa)|((hi0<<(32-sa))>>>0))>>>0; hiN=(hiS>>sa)>>>0; }
          // eslint-disable-next-line no-console
          console.log(`[dsra] pc=0x${pc.toString(16)} rt=$${rt}(hi=0x${hi0.toString(16).padStart(8,'0')} lo=0x${lo0.toString(16).padStart(8,'0')}) sh=${sa} -> rd=$${rd} hi=0x${hiN.toString(16).padStart(8,'0')} lo=0x${loN.toString(16).padStart(8,'0')}`);
        } else if (funct === 0x2a && traceCounts.slt < LIMITS.shift) { // SLT
          const a = cpu.regs[rs] | 0; const b = cpu.regs[rt] | 0; const v = (a < b) ? 1 : 0;
          // eslint-disable-next-line no-console
          console.log(`[slt] pc=0x${pc.toString(16)} rs=$${rs}(0x${(cpu.regs[rs]>>>0).toString(16).padStart(8,'0')}) rt=$${rt}(0x${(cpu.regs[rt]>>>0).toString(16).padStart(8,'0')}) -> rd=$${rd} ${v}`);
          traceCounts.slt++;
        } else if (funct === 0x2b && traceCounts.sltu < LIMITS.shift) { // SLTU
          const a = cpu.regs[rs] >>> 0; const b = cpu.regs[rt] >>> 0; const v = (a < b) ? 1 : 0;
          // eslint-disable-next-line no-console
          console.log(`[sltu] pc=0x${pc.toString(16)} rs=$${rs}(0x${(cpu.regs[rs]>>>0).toString(16).padStart(8,'0')}) rt=$${rt}(0x${(cpu.regs[rt]>>>0).toString(16).padStart(8,'0')}) -> rd=$${rd} ${v}`);
          traceCounts.sltu++;
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
      }
      // Targeted debug around basic.z64 harness epilogue
      const inBasicWindow = (pc >>> 0) >= 0x80001000 && (pc >>> 0) <= 0x80001410;
      // Limit to avoid runaway logs
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      if (inBasicWindow && (((traceCounts as any).basicWindow ?? 0) < LIMITS.basic)) {
        (traceCounts as any).basicWindow = ((traceCounts as any).basicWindow ?? 0) + 1;
        if ((traceCounts as any).basicWindow <= LIMITS.basic) {
          const rs = (instr >>> 21) & 0x1f;
          const rt = (instr >>> 16) & 0x1f;
          const rd = (instr >>> 11) & 0x1f;
          const shamt = (instr >>> 6) & 0x1f;
          const funct = instr & 0x3f;
          const imm = instr & 0xffff;
          const opNameMap: Record<number,string> = { 0x00:'SPECIAL',0x01:'REGIMM',0x02:'J',0x03:'JAL',0x04:'BEQ',0x05:'BNE',0x08:'ADDI',0x09:'ADDIU',0x0c:'ANDI',0x0d:'ORI',0x0e:'XORI',0x0f:'LUI',0x15:'BNEL',0x20:'LB',0x21:'LH',0x22:'LWL',0x23:'LW',0x24:'LBU',0x25:'LHU',0x26:'LWR',0x27:'LWU',0x28:'SB',0x29:'SH',0x2a:'SWL',0x2b:'SW',0x2e:'SWR',0x30:'LL',0x37:'LD',0x38:'SC' };
          const opName = opNameMap[op] ?? `OP_${op.toString(16)}`;
          const v0 = cpu.regs[2]>>>0, v1 = cpu.regs[3]>>>0, a0 = cpu.regs[4]>>>0, ra = cpu.regs[31]>>>0;
          // eslint-disable-next-line no-console
          console.log(`[basic.win] pc=0x${pc.toString(16)} op=${opName} instr=0x${(instr>>>0).toString(16).padStart(8,'0')} v0=0x${v0.toString(16).padStart(8,'0')} v1=0x${v1.toString(16).padStart(8,'0')} a0=0x${a0.toString(16).padStart(8,'0')} ra=0x${ra.toString(16).padStart(8,'0')}`);
          if (op === 0x04 || op === 0x05 || op === 0x15) {
            const rsV = cpu.regs[rs]>>>0, rtV = cpu.regs[rt]>>>0;
            // eslint-disable-next-line no-console
            console.log(`[basic.br] rs=$${rs}(0x${rsV.toString(16).padStart(8,'0')}) rt=$${rt}(0x${rtV.toString(16).padStart(8,'0')})`);
          } else if (op === 0x02 || op === 0x03) {
            const target = ((pc + 4) & 0xF0000000) | ((instr & 0x03ffffff) << 2);
            // eslint-disable-next-line no-console
            console.log(`[basic.j] target=0x${(target>>>0).toString(16)}`);
          } else if (op === 0x23 || op === 0x27 || op === 0x37) {
            let simm = imm; if (simm & 0x8000) simm = (simm | 0xffff0000) >>> 0;
            const base = cpu.regs[rs]>>>0; const addr = (base + (simm>>>0))>>>0;
            const mem0 = bus.loadU32(addr & ~3)>>>0; const mem1 = bus.loadU32(((addr & ~3)+4)>>>0)>>>0;
            // eslint-disable-next-line no-console
            console.log(`[basic.mem] rs=$${rs} base=0x${base.toString(16)} imm=0x${(imm>>>0).toString(16)} addr=0x${addr.toString(16)} w0=0x${mem0.toString(16).padStart(8,'0')} w1=0x${mem1.toString(16).padStart(8,'0')}`);
          } else if (op === 0x00) {
            const fMap: Record<number,string> = {0x00:'SLL',0x02:'SRL',0x03:'SRA',0x04:'SLLV',0x06:'SRLV',0x07:'SRAV',0x08:'JR',0x09:'JALR',0x20:'ADD',0x21:'ADDU',0x23:'SUBU',0x24:'AND',0x25:'OR',0x26:'XOR',0x27:'NOR',0x2a:'SLT',0x2b:'SLTU'};
            const fName = fMap[funct] ?? `FUNCT_${funct.toString(16)}`;
            // eslint-disable-next-line no-console
            console.log(`[basic.rtype] ${fName} rs=$${rs} rt=$${rt} rd=$${rd} sh=${shamt}`);
          }
        }
      }
      else if (op === 0x23) { // LW
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const imm = instr & 0xffff;
        let simm = imm;
        if (simm & 0x8000) simm = (simm | 0xffff0000) >>> 0;
        const base = cpu.regs[rs] >>> 0;
        const vaddr = (base + (simm >>> 0)) >>> 0;
        if (TRACE_MEM && traceCounts.lw < LIMITS.mem) {
          const mem = bus.loadU32(vaddr) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[lw $${rt}] pc=0x${pc.toString(16)} addr=0x${vaddr.toString(16)} data=0x${mem.toString(16).padStart(8,'0')}`);
          traceCounts.lw++;
        }
      } else if (op === 0x37) { // LD
        const rs = (instr >>> 21) & 0x1f;
        const rt = (instr >>> 16) & 0x1f;
        const imm = instr & 0xffff;
        let simm = imm;
        if (simm & 0x8000) simm = (simm | 0xffff0000) >>> 0;
        const base = cpu.regs[rs] >>> 0;
        const addr = (base + (simm >>> 0)) >>> 0;
        if (TRACE_MEM && traceCounts.ld < LIMITS.mem) {
          const a0 = (0xA0000000 + (addr - 0xA0000000)) >>> 0; // normalize to A-region
          const b0 = bus.loadU32(a0) >>> 0;
          const b1 = bus.loadU32((a0 + 4) >>> 0) >>> 0;
          const hi = bus.loadU32(addr & ~7) >>> 0;
          const lo = bus.loadU32((addr & ~7) + 4) >>> 0;
          // eslint-disable-next-line no-console
          console.log(`[ld $${rt}] pc=0x${pc.toString(16)} addr=0x${addr.toString(16)} -> hi=0x${hi.toString(16).padStart(8,'0')} lo=0x${lo.toString(16).padStart(8,'0')} | bus(a0)=0x${b0.toString(16).padStart(8,'0')},0x${b1.toString(16).padStart(8,'0')}`);
          traceCounts.ld++;
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

  if (DEBUG && TRACE_MEM) {
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

