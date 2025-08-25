import { readU16BE, readU32BE, writeU16BE, writeU32BE } from '../utils/bit.js';
import { AI, AI_BASE, AI_SIZE, DP, DP_BASE, DP_SIZE, MI, MI_BASE, MI_SIZE, PI, PI_BASE, PI_SIZE, SI, SI_BASE, SI_SIZE, SP, SP_BASE, SP_SIZE, VI, VI_BASE, VI_SIZE } from '../devices/mmio.js';

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

  private rom: Uint8Array | null = null;

  constructor(public readonly rdram: RDRAM) {
    // Wire devices to MI so they can signal interrupts
    this.sp.setMI(this.mi);
    this.dp.setMI(this.mi);
    this.pi.setMI(this.mi);
    this.si.setMI(this.mi);
    this.vi.setMI(this.mi);
    this.ai.setMI(this.mi);
    // Provide SI/PI access to RDRAM for deterministic DMA
    this.si.setRDRAM(this.rdram.bytes);
    this.pi.setRDRAM(this.rdram.bytes);
  }

  setROM(rom: Uint8Array): void {
    this.rom = rom;
    this.pi.setROM(rom);
  }

  private readMMIO(paddr: number): number | null {
    if (paddr >= MI_BASE && paddr < (MI_BASE + MI_SIZE)) return this.mi.readU32(paddr - MI_BASE);
    if (paddr >= SP_BASE && paddr < (SP_BASE + SP_SIZE)) return this.sp.readU32(paddr - SP_BASE);
    if (paddr >= DP_BASE && paddr < (DP_BASE + DP_SIZE)) return this.dp.readU32(paddr - DP_BASE);
    if (paddr >= VI_BASE && paddr < (VI_BASE + VI_SIZE)) return this.vi.readU32(paddr - VI_BASE);
    if (paddr >= AI_BASE && paddr < (AI_BASE + AI_SIZE)) return this.ai.readU32(paddr - AI_BASE);
    if (paddr >= PI_BASE && paddr < (PI_BASE + PI_SIZE)) return this.pi.readU32(paddr - PI_BASE);
    if (paddr >= SI_BASE && paddr < (SI_BASE + SI_SIZE)) return this.si.readU32(paddr - SI_BASE);
    return null;
  }

  private writeMMIO(paddr: number, value: number): boolean {
    if (paddr >= MI_BASE && paddr < (MI_BASE + MI_SIZE)) { this.mi.writeU32(paddr - MI_BASE, value); return true; }
    if (paddr >= SP_BASE && paddr < (SP_BASE + SP_SIZE)) { this.sp.writeU32(paddr - SP_BASE, value); return true; }
    if (paddr >= DP_BASE && paddr < (DP_BASE + DP_SIZE)) { this.dp.writeU32(paddr - DP_BASE, value); return true; }
    if (paddr >= VI_BASE && paddr < (VI_BASE + VI_SIZE)) { this.vi.writeU32(paddr - VI_BASE, value); return true; }
    if (paddr >= AI_BASE && paddr < (AI_BASE + AI_SIZE)) { this.ai.writeU32(paddr - AI_BASE, value); return true; }
    if (paddr >= PI_BASE && paddr < (PI_BASE + PI_SIZE)) { this.pi.writeU32(paddr - PI_BASE, value); return true; }
    if (paddr >= SI_BASE && paddr < (SI_BASE + SI_SIZE)) { this.si.writeU32(paddr - SI_BASE, value); return true; }
    return false;
  }

  loadU8(addr: number): number {
    const p = toPhysical(addr);
    if (p < this.rdram.bytes.length) {
      return this.rdram.bytes[p]!;
    }
    return 0;
  }

  loadU16(addr: number): number {
    const p = toPhysical(addr);
    // MMIO requires 32-bit aligned access; we'll expose via loadU32
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
    if (p < this.rdram.bytes.length) {
      this.rdram.bytes[p] = value & 0xff;
    }
  }

  storeU16(addr: number, value: number): void {
    const p = toPhysical(addr);
    if (p + 2 <= this.rdram.bytes.length) {
      writeU16BE(this.rdram.bytes, p, value >>> 0);
    }
  }

  storeU32(addr: number, value: number): void {
    const p = toPhysical(addr);
    if (this.writeMMIO(p, value >>> 0)) return;
    if (p + 4 <= this.rdram.bytes.length) {
      writeU32BE(this.rdram.bytes, p, value >>> 0);
      return;
    }
    // Ignore for now; later raise exceptions/MI
  }
}

