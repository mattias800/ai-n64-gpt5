import { readU16BE, readU32BE, writeU16BE, writeU32BE } from '../utils/bit.js';
import { MI, MI_BASE, MI_SIZE, SP, SP_BASE, SP_SIZE, DP, DP_BASE, DP_SIZE, VI, VI_BASE, VI_SIZE, AI, AI_BASE, AI_SIZE, PI, PI_BASE, PI_SIZE, SI, SI_BASE, SI_SIZE, RI, RI_BASE, RI_SIZE, FlashRAM } from '../devices/mmio.js';
import { CART_ROM_BASE } from '../devices/mmio.js';
import type { IDpCore, IRspCore } from '../devices/interfaces.js';

// Safe environment flag checker for browser builds
function envFlag(name: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = (typeof process !== 'undefined') ? (process as any) : undefined;
    return !!p?.env?.[name];
  } catch {
    return false;
  }
}
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

  // Optional pluggable cores (LLE)
  private rspCore: IRspCore | null = null;
  private dpCore: IDpCore | null = null;

  private rom: Uint8Array | null = null;
  // Optional PIF boot ROM (mapped at phys 0x1FC00000..0x1FC00000+size)
  private pifRom: Uint8Array | null = null;
  // Minimal PIF status latch to emulate special reads at 0x1FC007E4/0x1FC007FC
  private pifStatus: number = 0 >>> 0;

  constructor(public readonly rdram: RDRAM) {
    // Wire devices to MI so they can signal interrupts
    this.sp.setMI(this.mi);
    this.dp.setMI(this.mi);
    this.pi.setMI(this.mi);
    this.si.setMI(this.mi);
    this.vi.setMI(this.mi);
    this.ai.setMI(this.mi);
    // Provide SI/PI/SP/DP access to RDRAM for deterministic DMA and command fetch
    this.si.setRDRAM(this.rdram.bytes);
    this.pi.setRDRAM(this.rdram.bytes);
    this.sp.setRDRAM(this.rdram.bytes);
    this.dp.setRDRAM(this.rdram.bytes);
  }

  // Register a pluggable RSP core (LLE). This does not replace SP MMIO; it augments it.
  setRSPCore(core: IRspCore): void {
    this.rspCore = core;
    core.setMI(this.mi as unknown as any);
    core.setRDRAM(this.rdram.bytes);
    // Keep DMEM/IMEM in sync: share SP buffers if possible
    try {
      Object.defineProperty(core, 'dmem', { get: () => this.sp.dmem });
      Object.defineProperty(core, 'imem', { get: () => this.sp.imem });
    } catch {}
    // Bridge SP start to RSP core if it exposes onStart
    this.sp.onStart = core.onStart;
  }

  // Register a pluggable DP core (LLE). This augments DP MMIO.
  setDPCore(core: IDpCore): void {
    this.dpCore = core;
    core.setMI(this.mi as unknown as any);
    if (core.setRDRAM) core.setRDRAM(this.rdram.bytes);
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

  // Install PIF boot ROM (e.g., pifdata.bin). CPU will fetch instructions at 0xBFC00000 (KSEG1)
  setPIFROM(bytes: Uint8Array): void {
    this.pifRom = bytes;
  }

  setSRAM(bytes: Uint8Array): void {
    this.pi.setSRAM(bytes);
  }

  setFlashRAM(bytes: Uint8Array): void {
    this.pi.setFlashRAM(new FlashRAM(bytes));
  }

  // Seed PIF RAM [0x24..0x27] with a CIC-dependent 32-bit big-endian value.
  // Safe no-op if SI/PIF RAM is unavailable.
  // cicName examples: '6102', '6105', '7102'.
  setCICSeed(cicName: string): void {
    try {
      const pr: Uint8Array = (this.si as any).pifRam;
      if (!pr || pr.length !== 64) return;
      const name = String(cicName || '').trim().toLowerCase();
      let seed: number | null = null;
      if (name === '6102' || name === 'ntsc-u' || name === 'sm64') seed = 0x00003F3F >>> 0; // Cen64-style 6102 seed in PIF RAM
      else if (name === '6105' || name === '3f3f') seed = 0x0000913F >>> 0; // Cen64-style 6105 seed
      else if (name === '7102' || name === 'pal') seed = 0x00003F3F >>> 0; // common PAL default (7102)
      else if (/^0x[0-9a-f]+$/.test(name)) {
        try { seed = Number(BigInt(name) & 0xffffffffn) >>> 0; } catch { seed = parseInt(name, 16) >>> 0; }
      } else {
        const n = Number(name); if (Number.isFinite(n)) seed = (n>>>0);
      }
      if (seed === null) return;
      // Only write if currently zeroed to avoid clobbering a running handshake
      const cur = ((pr[0x24] ?? 0) | (pr[0x25] ?? 0) | (pr[0x26] ?? 0) | (pr[0x27] ?? 0)) >>> 0;
      if (cur !== 0) return;
      pr[0x24] = (seed >>> 24) & 0xFF;
      pr[0x25] = (seed >>> 16) & 0xFF;
      pr[0x26] = (seed >>> 8) & 0xFF;
      pr[0x27] = seed & 0xFF;
      // pifStatus stays clear until first read at 0x24 (handled in bus)
    } catch {}
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
    // PIF RAM mapping at phys 0x1FC007C0..0x1FC00800 (64 bytes) takes precedence over ROM alias
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = (p - ramBase) >>> 0;
      if (p >= ramBase && off < 0x40) return (this.si as any).pifRam[off] ?? 0;
    }
    // PIF ROM mapping at phys 0x1FC00000
    if (this.pifRom) {
      const base = 0x1FC00000 >>> 0;
      const off = (p - base) >>> 0;
      if (p >= base && off < this.pifRom.length) return this.pifRom[off]!;
    }
    // Cart ROM mapping at phys 0x10000000 (KSEG1 alias 0xB0000000)
    if (this.rom) {
      const base = CART_ROM_BASE >>> 0;
      const off = (p - base) >>> 0;
      if (p >= base && off < this.rom.length) return this.rom[off]!;
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
    // PIF ROM mapping at phys 0x1FC00000
    if (this.pifRom) {
      const base = 0x1FC00000 >>> 0;
      const off = (p - base) >>> 0;
      if (p >= base && (off + 2) <= this.pifRom.length) {
        // Big-endian
        return (((this.pifRom[off]! << 8) | (this.pifRom[off + 1]!)) >>> 0);
      }
    }
    // Cart ROM mapping at phys 0x10000000
    if (this.rom) {
      const base = CART_ROM_BASE >>> 0;
      const off = (p - base) >>> 0;
      if (p >= base && (off + 2) <= this.rom.length) {
        return (((this.rom[off]! << 8) | (this.rom[off + 1]!)) >>> 0);
      }
    }
    if (p + 2 <= this.rdram.bytes.length) {
      return readU16BE(this.rdram.bytes, p);
    }
    return 0;
  }

  loadS16(addr: number): number {
    const value = this.loadU16(addr);
    // Sign extend from 16-bit to 32-bit
    return (value << 16) >> 16;
  }

  loadU32(addr: number): number {
    const p = toPhysical(addr);
    const mm = this.readMMIO(p);
    if (mm !== null) return mm >>> 0;
    // PIF RAM mapping at phys 0x1FC007C0..0x1FC00800 (64 bytes) takes precedence over ROM alias
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = (p - ramBase) >>> 0;
      if (p >= ramBase && (off + 4) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        // Special handling mirroring CEN64 for PIF RAM reads
        if (off === 0x24) {
          // Reading 0x24..0x27 sets pifStatus=0x80 and returns the BE32 from RAM
          this.pifStatus = 0x80 >>> 0;
          const b0 = pr[0x24] ?? 0, b1 = pr[0x25] ?? 0, b2 = pr[0x26] ?? 0, b3 = pr[0x27] ?? 0;
          return (((b0<<24)|(b1<<16)|(b2<<8)|b3)>>>0);
        }
        if (off === 0x3C) {
          // Reading 0x3C returns current pifStatus
          return this.pifStatus >>> 0;
        }
        const b0 = pr[off] ?? 0, b1 = pr[off+1] ?? 0, b2 = pr[off+2] ?? 0, b3 = pr[off+3] ?? 0;
        return (((b0<<24)|(b1<<16)|(b2<<8)|b3)>>>0);
      }
    }
    // PIF ROM mapping at phys 0x1FC00000
    if (this.pifRom) {
      const base = 0x1FC00000 >>> 0;
      const off = (p - base) >>> 0;
      if (p >= base && (off + 4) <= this.pifRom.length) {
        return (((this.pifRom[off]! << 24) | (this.pifRom[off + 1]! << 16) | (this.pifRom[off + 2]! << 8) | (this.pifRom[off + 3]!)) >>> 0);
      }
    }
    // Cart ROM mapping at phys 0x10000000
    if (this.rom) {
      const base = CART_ROM_BASE >>> 0;
      const off = (p - base) >>> 0;
      if (p >= base && (off + 4) <= this.rom.length) {
        return (((this.rom[off]! << 24) | (this.rom[off + 1]! << 16) | (this.rom[off + 2]! << 8) | (this.rom[off + 3]!)) >>> 0);
      }
    }
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
    // PIF RAM mapping at phys 0x1FC007C0..0x1FC00800 (64 bytes)
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = (p - ramBase) >>> 0;
      if (p >= ramBase && off < 0x40) { (this.si as any).pifRam[off] = value & 0xff; try { (this.si as any).status = (((this.si as any).status | (1<<12)) >>> 0); this.mi.raise(2 /* MI_INTR_SI */); } catch {}; return; }
    }
    if (p < this.rdram.bytes.length) {
      this.rdram.bytes[p] = value & 0xff;
      // debug: watch stores to test-data windows if enabled
      if (envFlag('N64_TESTS_DEBUG')) {
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
    // PIF RAM mapping at phys 0x1FC007C0..0x1FC00800 (64 bytes)
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = (p - ramBase) >>> 0;
      if (p >= ramBase && (off + 2) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        pr[off] = (value>>>8)&0xff; pr[off+1] = value & 0xff; try { (this.si as any).status = (((this.si as any).status | (1<<12)) >>> 0); this.mi.raise(2 /* MI_INTR_SI */); } catch {}; return;
      }
    }
    if (p + 2 <= this.rdram.bytes.length) {
      writeU16BE(this.rdram.bytes, p, value >>> 0);
      if (envFlag('N64_TESTS_DEBUG')) {
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
    // PIF RAM mapping at phys 0x1FC007C0..0x1FC00800 (64 bytes)
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = (p - ramBase) >>> 0;
      if (p >= ramBase && (off + 4) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        pr[off] = (value>>>24)&0xff; pr[off+1] = (value>>>16)&0xff; pr[off+2] = (value>>>8)&0xff; pr[off+3] = value & 0xff; try { (this.si as any).status = (((this.si as any).status | (1<<12)) >>> 0); this.mi.raise(2 /* MI_INTR_SI */); } catch {}; return;
      }
    }
    if (p + 4 <= this.rdram.bytes.length) {
      writeU32BE(this.rdram.bytes, p, value >>> 0);
      if (envFlag('N64_TESTS_DEBUG')) {
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
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = ((paddr>>>0) - ramBase) >>> 0;
      if ((paddr>>>0) >= ramBase && off < 0x40) return ((this.si as any).pifRam[off] ?? 0);
    }
    if (this.pifRom) {
      const base = 0x1FC00000 >>> 0;
      const off = (paddr - base) >>> 0;
      if ((paddr >>> 0) >= base && off < this.pifRom.length) return this.pifRom[off]!;
    }
    if (this.rom) {
      const base = CART_ROM_BASE >>> 0;
      const off = (paddr - base) >>> 0;
      if ((paddr >>> 0) >= base && off < this.rom.length) return this.rom[off]!;
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
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = ((paddr>>>0) - ramBase) >>> 0;
      if ((paddr>>>0) >= ramBase && (off + 2) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        return (((pr[off] ?? 0) << 8) | (pr[off+1] ?? 0)) >>> 0;
      }
    }
    if (this.pifRom) {
      const romBase = 0x1FC00000 >>> 0;
      const off = (paddr - romBase) >>> 0;
      if ((paddr >>> 0) >= romBase && (off + 2) <= this.pifRom.length) {
        return (((this.pifRom[off]! << 8) | (this.pifRom[off + 1]!)) >>> 0);
      }
    }
    if (this.rom) {
      const romBase = CART_ROM_BASE >>> 0;
      const off = (paddr - romBase) >>> 0;
      if ((paddr >>> 0) >= romBase && (off + 2) <= this.rom.length) {
        return (((this.rom[off]! << 8) | (this.rom[off + 1]!)) >>> 0);
      }
    }
    if ((paddr + 2) <= this.rdram.bytes.length) return readU16BE(this.rdram.bytes, paddr >>> 0);
    return 0;
  }
  loadU32Phys(paddr: number): number {
    const mmVal = this.readMMIOPhys(paddr >>> 0);
    if (mmVal !== null) return mmVal >>> 0;
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = ((paddr>>>0) - ramBase) >>> 0;
      if ((paddr>>>0) >= ramBase && (off + 4) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        if (off === 0x24) { this.pifStatus = 0x80 >>> 0; const b0 = pr[0x24] ?? 0, b1 = pr[0x25] ?? 0, b2 = pr[0x26] ?? 0, b3 = pr[0x27] ?? 0; return (((b0<<24)|(b1<<16)|(b2<<8)|b3)>>>0); }
        if (off === 0x3C) { return this.pifStatus >>> 0; }
        const b0 = pr[off] ?? 0, b1 = pr[off+1] ?? 0, b2 = pr[off+2] ?? 0, b3 = pr[off+3] ?? 0;
        return (((b0<<24)|(b1<<16)|(b2<<8)|b3)>>>0);
      }
    }
    if (this.pifRom) {
      const base = 0x1FC00000 >>> 0;
      const off = (paddr - base) >>> 0;
      if ((paddr >>> 0) >= base && (off + 4) <= this.pifRom.length) {
        return (((this.pifRom[off]! << 24) | (this.pifRom[off + 1]! << 16) | (this.pifRom[off + 2]! << 8) | (this.pifRom[off + 3]!)) >>> 0);
      }
    }
    if (this.rom) {
      const base = CART_ROM_BASE >>> 0;
      const off = (paddr - base) >>> 0;
      if ((paddr >>> 0) >= base && (off + 4) <= this.rom.length) {
        return (((this.rom[off]! << 24) | (this.rom[off + 1]! << 16) | (this.rom[off + 2]! << 8) | (this.rom[off + 3]!)) >>> 0);
      }
    }
    if ((paddr + 4) <= this.rdram.bytes.length) return readU32BE(this.rdram.bytes, paddr >>> 0);
    return 0;
  }
  storeU8Phys(paddr: number, value: number): void {
    if (this.writeMMIOPhys(paddr >>> 0, (value & 0xff) << ((3 - ((paddr >>> 0) & 3)) * 8))) return;
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = ((paddr>>>0) - ramBase) >>> 0;
      if ((paddr>>>0) >= ramBase && off < 0x40) { (this.si as any).pifRam[off] = value & 0xff; try { (this.si as any).status = (((this.si as any).status | (1<<12)) >>> 0); this.mi.raise(2 /* MI_INTR_SI */); } catch {}; return; }
    }
    if ((paddr >>> 0) < this.rdram.bytes.length) this.rdram.bytes[paddr >>> 0] = value & 0xff;
  }
  storeU16Phys(paddr: number, value: number): void {
    const base = paddr & ~3;
    const off2 = paddr & 2;
    if (this.writeMMIOPhys(base >>> 0, (value & 0xffff) << (off2 === 0 ? 16 : 0))) return;
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = ((paddr>>>0) - ramBase) >>> 0;
      if ((paddr>>>0) >= ramBase && (off + 2) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        pr[off] = (value>>>8)&0xff; pr[off+1] = value & 0xff; try { (this.si as any).status = (((this.si as any).status | (1<<12)) >>> 0); this.mi.raise(2 /* MI_INTR_SI */); } catch {}; return;
      }
    }
    if ((paddr + 2) <= this.rdram.bytes.length) writeU16BE(this.rdram.bytes, paddr >>> 0, value >>> 0);
  }
  storeU32Phys(paddr: number, value: number): void {
    if (this.writeMMIOPhys(paddr >>> 0, value >>> 0)) return;
    {
      const ramBase = 0x1FC007C0 >>> 0;
      const off = ((paddr>>>0) - ramBase) >>> 0;
      if ((paddr>>>0) >= ramBase && (off + 4) <= 0x40) {
        const pr = (this.si as any).pifRam as Uint8Array;
        pr[off] = (value>>>24)&0xff; pr[off+1] = (value>>>16)&0xff; pr[off+2] = (value>>>8)&0xff; pr[off+3] = value & 0xff; try { (this.si as any).status = (((this.si as any).status | (1<<12)) >>> 0); this.mi.raise(2 /* MI_INTR_SI */); } catch {}; return;
      }
    }
    if ((paddr + 4) <= this.rdram.bytes.length) writeU32BE(this.rdram.bytes, paddr >>> 0, value >>> 0);
  }
}

