import { readU16BE, readU32BE, writeU16BE, writeU32BE } from '../utils/bit.js';
import { AI, AI_BASE, AI_SIZE, DP, DP_BASE, DP_SIZE, MI, MI_BASE, MI_SIZE, PI, PI_BASE, PI_SIZE, SI, SI_BASE, SI_SIZE, SP, SP_BASE, SP_SIZE, VI, VI_BASE, VI_SIZE, RI, RI_BASE, RI_SIZE } from '../devices/mmio.js';

export class RDRAM {
  readonly bytes: Uint8Array;
  constructor(size = 8 * 1024 * 1024) {
    this.bytes = new Uint8Array(size);
  }
}

function toPhysical(addr: number): number {
  addr = addr >>> 0;
  const region = addr >>> 28;
  // KSEG0 (0x8000_0000-0x9FFF_FFFF) and KSEG1 (0xA000_0000-0xBFFF_FFFF)
  if (region === 0x8 || region === 0x9) return (addr - 0x8000_0000) >>> 0;
  if (region === 0xA || region === 0xB) return (addr - 0xA000_0000) >>> 0;
  return addr >>> 0; // use as physical for low addresses
}

export class Bus {
  readonly mi = new MI();
  readonly sp = new SP();
  readonly dp = new DP();
  readonly vi = new VI();
  readonly ai = new AI();
  readonly pi = new PI();
  readonly si = new SI();
  readonly ri = new RI();

  private rom: Uint8Array | null = null;

  constructor(public readonly rdram: RDRAM) {
    // Wire devices to MI so they can signal interrupts
    this.sp.setMI(this.mi);
    this.dp.setMI(this.mi);
    this.pi.setMI(this.mi);
    this.si.setMI(this.mi);
    this.vi.setMI(this.mi);
    this.ai.setMI(this.mi);
    // Provide SI/PI/SP access to RDRAM for deterministic DMA
    this.si.setRDRAM(this.rdram.bytes);
    this.pi.setRDRAM(this.rdram.bytes);
    this.sp.setRDRAM(this.rdram.bytes);
  }

  // Raw physical MMIO read/write helpers (skip virtual translation)
  private readMMIOPhys(paddr: number): number | null {
    if (paddr >= MI_BASE && paddr < (MI_BASE + MI_SIZE)) return this.mi.readU32(paddr - MI_BASE);
    if (paddr >= SP_BASE && paddr < (SP_BASE + SP_SIZE)) return this.sp.readU32(paddr - SP_BASE);
    if (paddr >= 0x04040000 && paddr < (0x04040000 + 0x1000)) return this.sp.readU32(paddr - 0x04040000);
    if (paddr >= DP_BASE && paddr < (DP_BASE + DP_SIZE)) return this.dp.readU32(paddr - DP_BASE);
    if (paddr >= VI_BASE && paddr < (VI_BASE + VI_SIZE)) return this.vi.readU32(paddr - VI_BASE);
    if (paddr >= AI_BASE && paddr < (AI_BASE + AI_SIZE)) return this.ai.readU32(paddr - AI_BASE);
    if (paddr >= PI_BASE && paddr < (PI_BASE + PI_SIZE)) return this.pi.readU32(paddr - PI_BASE);
    if (paddr >= SI_BASE && paddr < (SI_BASE + SI_SIZE)) return this.si.readU32(paddr - SI_BASE);
    if (paddr >= RI_BASE && paddr < (RI_BASE + RI_SIZE)) return this.ri.readU32(paddr - RI_BASE);
    return null;
  }
  private writeMMIOPhys(paddr: number, value: number): boolean {
    if (paddr >= MI_BASE && paddr < (MI_BASE + MI_SIZE)) { this.mi.writeU32(paddr - MI_BASE, value); return true; }
    if (paddr >= SP_BASE && paddr < (SP_BASE + SP_SIZE)) { this.sp.writeU32(paddr - SP_BASE, value); return true; }
    if (paddr >= 0x04040000 && paddr < (0x04040000 + 0x1000)) { this.sp.writeU32(paddr - 0x04040000, value); return true; }
    if (paddr >= DP_BASE && paddr < (DP_BASE + DP_SIZE)) { this.dp.writeU32(paddr - DP_BASE, value); return true; }
    if (paddr >= VI_BASE && paddr < (VI_BASE + VI_SIZE)) { this.vi.writeU32(paddr - VI_BASE, value); return true; }
    if (paddr >= AI_BASE && paddr < (AI_BASE + AI_SIZE)) { this.ai.writeU32(paddr - AI_BASE, value); return true; }
    if (paddr >= PI_BASE && paddr < (PI_BASE + PI_SIZE)) { this.pi.writeU32(paddr - PI_BASE, value); return true; }
    if (paddr >= SI_BASE && paddr < (SI_BASE + SI_SIZE)) { this.si.writeU32(paddr - SI_BASE, value); return true; }
    if (paddr >= RI_BASE && paddr < (RI_BASE + RI_SIZE)) { this.ri.writeU32(paddr - RI_BASE, value); return true; }
    return false;
  }

  setROM(rom: Uint8Array): void {
    this.rom = rom;
    this.pi.setROM(rom);
  }

  private readMMIO(paddr: number): number | null {
    if (paddr >= MI_BASE && paddr < (MI_BASE + MI_SIZE)) return this.mi.readU32(paddr - MI_BASE);
    if (paddr >= SP_BASE && paddr < (SP_BASE + SP_SIZE)) return this.sp.readU32(paddr - SP_BASE);
    // Alias for SP registers at 0x04040000..0x04040FFF
    if (paddr >= 0x04040000 && paddr < (0x04040000 + 0x1000)) return this.sp.readU32(paddr - 0x04040000);
    if (paddr >= DP_BASE && paddr < (DP_BASE + DP_SIZE)) return this.dp.readU32(paddr - DP_BASE);
    if (paddr >= VI_BASE && paddr < (VI_BASE + VI_SIZE)) return this.vi.readU32(paddr - VI_BASE);
    if (paddr >= AI_BASE && paddr < (AI_BASE + AI_SIZE)) return this.ai.readU32(paddr - AI_BASE);
    if (paddr >= PI_BASE && paddr < (PI_BASE + PI_SIZE)) return this.pi.readU32(paddr - PI_BASE);
    if (paddr >= SI_BASE && paddr < (SI_BASE + SI_SIZE)) return this.si.readU32(paddr - SI_BASE);
    if (paddr >= RI_BASE && paddr < (RI_BASE + RI_SIZE)) return this.ri.readU32(paddr - RI_BASE);
    return null;
  }

  private writeMMIO(paddr: number, value: number): boolean {
    if (paddr >= MI_BASE && paddr < (MI_BASE + MI_SIZE)) { this.mi.writeU32(paddr - MI_BASE, value); return true; }
    if (paddr >= SP_BASE && paddr < (SP_BASE + SP_SIZE)) { this.sp.writeU32(paddr - SP_BASE, value); return true; }
    // Alias for SP registers at 0x04040000..0x04040FFF
    if (paddr >= 0x04040000 && paddr < (0x04040000 + 0x1000)) { this.sp.writeU32(paddr - 0x04040000, value); return true; }
    if (paddr >= DP_BASE && paddr < (DP_BASE + DP_SIZE)) { this.dp.writeU32(paddr - DP_BASE, value); return true; }
    if (paddr >= VI_BASE && paddr < (VI_BASE + VI_SIZE)) { this.vi.writeU32(paddr - VI_BASE, value); return true; }
    if (paddr >= AI_BASE && paddr < (AI_BASE + AI_SIZE)) { this.ai.writeU32(paddr - AI_BASE, value); return true; }
    if (paddr >= PI_BASE && paddr < (PI_BASE + PI_SIZE)) { this.pi.writeU32(paddr - PI_BASE, value); return true; }
    if (paddr >= SI_BASE && paddr < (SI_BASE + SI_SIZE)) { this.si.writeU32(paddr - SI_BASE, value); return true; }
    if (paddr >= RI_BASE && paddr < (RI_BASE + RI_SIZE)) { this.ri.writeU32(paddr - RI_BASE, value); return true; }
    return false;
  }

  loadU8(addr: number): number {
    const p = toPhysical(addr);
    // MMIO byte read support (big-endian lanes)
    const mmAligned = (p & ~3) >>> 0;
    const mmOff = p & 3;
    const mmVal = this.readMMIO(mmAligned);
    if (mmVal !== null) {
      const v = mmVal >>> 0;
      const shift = (3 - mmOff) * 8;
      return (v >>> shift) & 0xff;
    }
    if (p < this.rdram.bytes.length) {
      return this.rdram.bytes[p]!;
    }
    return 0;
  }

  loadU16(addr: number): number {
    const p = toPhysical(addr);
    // MMIO halfword read support (big-endian lanes)
    const mmAligned = (p & ~3) >>> 0;
    const mmOff2 = p & 2; // 0 or 2
    const mmVal = this.readMMIO(mmAligned);
    if (mmVal !== null) {
      const v = mmVal >>> 0;
      const shift = (mmOff2 === 0 ? 16 : 0);
      return (v >>> shift) & 0xffff;
    }
    if (p + 2 <= this.rdram.bytes.length) {
      return readU16BE(this.rdram.bytes, p);
    }
    return 0;
  }

  loadU32(addr: number): number {
    const p = toPhysical(addr);
    const mm = this.readMMIO(p);
    if (mm !== null) return mm >>> 0;
    if (p + 4 <= this.rdram.bytes.length) {
      return readU32BE(this.rdram.bytes, p);
    }
    // Out of range: return 0 (will be tightened later with exceptions)
    return 0;
  }

  storeU8(addr: number, value: number): void {
    const p = toPhysical(addr);
    const mmAligned = (p & ~3) >>> 0;
    const mmOff = p & 3;
    // MMIO byte write support: map to 32-bit write with proper big-endian lane
    if (this.writeMMIO(mmAligned, (value & 0xff) << ((3 - mmOff) * 8))) return;
    if (p < this.rdram.bytes.length) {
      this.rdram.bytes[p] = value & 0xff;
      // debug: watch stores to test-data windows if enabled
      if (process.env.N64_TESTS_DEBUG) {
        if ((p >= 0x98f8 && p < 0x98f8 + 8) || (p >= 0xa578 && p < 0xa578 + 8)) {
          // eslint-disable-next-line no-console
          console.log(`[bus.storeU8] p=0x${p.toString(16)} v=0x${(value & 0xff).toString(16).padStart(2,'0')}`);
        }
      }
    }
  }

  storeU16(addr: number, value: number): void {
    const p = toPhysical(addr);
    const mmAligned = (p & ~3) >>> 0;
    const mmOff2 = p & 2; // 0 or 2
    // MMIO halfword write support: map to 32-bit write with proper big-endian lane
    if (this.writeMMIO(mmAligned, (value & 0xffff) << (mmOff2 === 0 ? 16 : 0))) return;
    if (p + 2 <= this.rdram.bytes.length) {
      writeU16BE(this.rdram.bytes, p, value >>> 0);
      if (process.env.N64_TESTS_DEBUG) {
        if ((p >= 0x98f8 && p < 0x98f8 + 8) || (p >= 0xa578 && p < 0xa578 + 8)) {
          // eslint-disable-next-line no-console
          console.log(`[bus.storeU16] p=0x${p.toString(16)} v=0x${(value & 0xffff).toString(16).padStart(4,'0')}`);
        }
      }
    }
  }

  storeU32(addr: number, value: number): void {
    const p = toPhysical(addr);
    if (this.writeMMIO(p, value >>> 0)) return;
    if (p + 4 <= this.rdram.bytes.length) {
      writeU32BE(this.rdram.bytes, p, value >>> 0);
      if (process.env.N64_TESTS_DEBUG) {
        if ((p >= 0x98f8 && p < 0x98f8 + 8) || (p >= 0xa578 && p < 0xa578 + 8)) {
          // eslint-disable-next-line no-console
          console.log(`[bus.storeU32] p=0x${p.toString(16)} v=0x${(value >>> 0).toString(16).padStart(8,'0')}`);
        }
      }
      return;
    }
    // Ignore for now; later raise exceptions/MI
  }

  // Physical-address accessors (skip toPhysical)
  loadU8Phys(paddr: number): number {
    const mmVal = this.readMMIOPhys(paddr >>> 0);
    if (mmVal !== null) {
      const v = mmVal >>> 0;
      const shift = (3 - ((paddr >>> 0) & 3)) * 8;
      return (v >>> shift) & 0xff;
    }
    if ((paddr >>> 0) < this.rdram.bytes.length) return this.rdram.bytes[paddr >>> 0]!;
    return 0;
  }
  loadU16Phys(paddr: number): number {
    const base = paddr & ~3;
    const off2 = paddr & 2;
    const mmVal = this.readMMIOPhys(base >>> 0);
    if (mmVal !== null) {
      const v = mmVal >>> 0;
      const shift = (off2 === 0 ? 16 : 0);
      return (v >>> shift) & 0xffff;
    }
    if ((paddr + 2) <= this.rdram.bytes.length) return readU16BE(this.rdram.bytes, paddr >>> 0);
    return 0;
  }
  loadU32Phys(paddr: number): number {
    const mmVal = this.readMMIOPhys(paddr >>> 0);
    if (mmVal !== null) return mmVal >>> 0;
    if ((paddr + 4) <= this.rdram.bytes.length) return readU32BE(this.rdram.bytes, paddr >>> 0);
    return 0;
  }
  storeU8Phys(paddr: number, value: number): void {
    if (this.writeMMIOPhys(paddr >>> 0, (value & 0xff) << ((3 - ((paddr >>> 0) & 3)) * 8))) return;
    if ((paddr >>> 0) < this.rdram.bytes.length) this.rdram.bytes[paddr >>> 0] = value & 0xff;
  }
  storeU16Phys(paddr: number, value: number): void {
    const base = paddr & ~3;
    const off2 = paddr & 2;
    if (this.writeMMIOPhys(base >>> 0, (value & 0xffff) << (off2 === 0 ? 16 : 0))) return;
    if ((paddr + 2) <= this.rdram.bytes.length) writeU16BE(this.rdram.bytes, paddr >>> 0, value >>> 0);
  }
  storeU32Phys(paddr: number, value: number): void {
    if (this.writeMMIOPhys(paddr >>> 0, value >>> 0)) return;
    if ((paddr + 4) <= this.rdram.bytes.length) writeU32BE(this.rdram.bytes, paddr >>> 0, value >>> 0);
  }
}

