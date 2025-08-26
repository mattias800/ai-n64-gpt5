import { readU32BE, writeU32BE } from '../utils/bit.js';

export class MMIO {
  constructor(public readonly size: number) {
    this.bytes = new Uint8Array(size);
  }
  readonly bytes: Uint8Array;
  readU32(off: number): number {
    if (off < 0 || off + 4 > this.size) return 0;
    return readU32BE(this.bytes, off);
  }
  writeU32(off: number, val: number): void {
    if (off < 0 || off + 4 > this.size) return;
    writeU32BE(this.bytes, off, val >>> 0);
  }
}

export const MI_BASE = 0x04300000 >>> 0; export const MI_SIZE = 0x1000;
export const SP_BASE = 0x04000000 >>> 0; export const SP_SIZE = 0x1000;
export const DP_BASE = 0x04100000 >>> 0; export const DP_SIZE = 0x1000;
export const VI_BASE = 0x04400000 >>> 0; export const VI_SIZE = 0x1000;
export const AI_BASE = 0x04500000 >>> 0; export const AI_SIZE = 0x1000;
export const PI_BASE = 0x04600000 >>> 0; export const PI_SIZE = 0x1000;
export const SI_BASE = 0x04800000 >>> 0; export const SI_SIZE = 0x1000;

// MI (MIPS Interface) registers and bits
export const MI_MODE_OFF = 0x00;
export const MI_VERSION_OFF = 0x04;
export const MI_INTR_OFF = 0x08; // pending
export const MI_INTR_MASK_OFF = 0x0C;

export const MI_INTR_SP = 1 << 0;
export const MI_INTR_SI = 1 << 1;
export const MI_INTR_AI = 1 << 2;
export const MI_INTR_VI = 1 << 3;
export const MI_INTR_PI = 1 << 4;
export const MI_INTR_DP = 1 << 5;

export class MI extends MMIO {
  mode = 0 >>> 0;
  // A plausible version value; exact value not critical for our use yet.
  version = 0x02020102 >>> 0;
  intrPending = 0 >>> 0;
  intrMask = 0 >>> 0;
  constructor() { super(MI_SIZE); }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case MI_MODE_OFF: return this.mode >>> 0;
      case MI_VERSION_OFF: return this.version >>> 0;
      case MI_INTR_OFF: return this.intrPending >>> 0;
      case MI_INTR_MASK_OFF: return this.intrMask >>> 0;
      default: return super.readU32(off);
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case MI_MODE_OFF:
        // Model basic write-one-to-clear semantics for MI pending bits using low 6 bits
        // Also store mode value for potential future use
        this.mode = val >>> 0;
        const clearMask = (val & 0x3f) >>> 0;
        if (clearMask) this.intrPending = (this.intrPending & ~clearMask) >>> 0;
        return;
      case MI_INTR_OFF:
        // Typically read-only; ignore writes
        return;
      case MI_INTR_MASK_OFF:
        // Lower 6 bits set mask, upper 6 (bits 16..21) clear mask
        const setBits = val & 0x3f;
        const clrBits = (val >>> 16) & 0x3f;
        this.intrMask = (this.intrMask | setBits) >>> 0;
        this.intrMask = (this.intrMask & (~clrBits)) >>> 0;
        return;
      default:
        super.writeU32(off, val);
        return;
    }
  }
  // Raise or clear device interrupt pending bits
  raise(mask: number): void {
    this.intrPending = (this.intrPending | (mask & 0x3f)) >>> 0;
  }
  clear(mask: number): void {
    this.intrPending = (this.intrPending & (~(mask & 0x3f))) >>> 0;
  }
  // CPU interrupt line asserted if any enabled pending
  cpuIntAsserted(): boolean {
    return ((this.intrPending & this.intrMask) >>> 0) !== 0;
  }
}

// SP (RSP) minimal device
export const SP_MEM_ADDR_OFF = 0x00; // also used for our SP_CMD_START compatibility
export const SP_DRAM_ADDR_OFF = 0x04;
export const SP_RD_LEN_OFF = 0x08;
export const SP_WR_LEN_OFF = 0x0C;
export const SP_CMD_OFF = SP_MEM_ADDR_OFF;
export const SP_CMD_START = 1 << 0; // writing 1 to MEM_ADDR is treated as START for our stub compatibility
export const SP_STATUS_OFF = 0x10;
export const SP_STATUS_INTR = 1 << 0; // writing 1 clears pending
export class SP extends MMIO {
  status = 0 >>> 0;
  private mi: MI | null = null;
  private rdram: Uint8Array | null = null;
  // Minimal 4KB DMEM buffer
  readonly dmem = new Uint8Array(0x1000);
  private memAddr = 0 >>> 0;
  private dramAddr = 0 >>> 0;
  constructor() { super(SP_SIZE); }
  setMI(mi: MI) { this.mi = mi; }
  setRDRAM(bytes: Uint8Array) { this.rdram = bytes; }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case SP_STATUS_OFF: return this.status >>> 0;
      case SP_MEM_ADDR_OFF: return this.memAddr >>> 0;
      case SP_DRAM_ADDR_OFF: return this.dramAddr >>> 0;
      default: {
        // Treat other offsets within 0x0000..0x0FFF as DMEM memory for CPU fetch/load
        const o = off & 0x0FFC; // 32-bit aligned within DMEM
        return (((this.dmem[o]! << 24) | (this.dmem[o + 1]! << 16) | (this.dmem[o + 2]! << 8) | (this.dmem[o + 3]!)) >>> 0);
      }
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case SP_MEM_ADDR_OFF: {
        // Compatibility: treat bit0=1 as START command for tests; otherwise set mem addr
        if ((val & SP_CMD_START) !== 0 && val === SP_CMD_START) {
          if (this.mi) { this.mi.raise(MI_INTR_SP); this.mi.raise(MI_INTR_DP); }
        } else {
          this.memAddr = val >>> 0;
        }
        super.writeU32(off, val);
        return;
      }
      case SP_DRAM_ADDR_OFF:
        this.dramAddr = val >>> 0;
        super.writeU32(off, val);
        return;
      case SP_RD_LEN_OFF: {
        // Copy from RDRAM[dramAddr] -> DMEM[memAddr]
        const len = ((val & 0x00ffffff) >>> 0) + 1;
        if (this.rdram) {
          for (let i = 0; i < len; i++) {
            const b = this.rdram[(this.dramAddr + i) >>> 0] ?? 0;
            const di = (this.memAddr + i) & 0x0FFF;
            this.dmem[di] = b;
          }
        }
        super.writeU32(off, val);
        return;
      }
      case SP_WR_LEN_OFF: {
        // Copy from DMEM[memAddr] -> RDRAM[dramAddr]
        const len = ((val & 0x00ffffff) >>> 0) + 1;
        if (this.rdram) {
          for (let i = 0; i < len; i++) {
            const si = (this.memAddr + i) & 0x0FFF;
            const b = this.dmem[si] ?? 0;
            if ((this.dramAddr + i) < this.rdram.length) this.rdram[this.dramAddr + i] = b;
          }
        }
        super.writeU32(off, val);
        return;
      }
      case SP_STATUS_OFF:
        if (val & SP_STATUS_INTR) { if (this.mi) this.mi.clear(MI_INTR_SP); }
        // Also store value for visibility
        super.writeU32(off, val);
        return;
      default: {
        // Writes to other offsets within DMEM write the memory (for completeness)
        const o = off & 0x0FFF;
        this.dmem[o] = (val >>> 24) & 0xff;
        this.dmem[(o + 1) & 0x0FFF] = (val >>> 16) & 0xff;
        this.dmem[(o + 2) & 0x0FFF] = (val >>> 8) & 0xff;
        this.dmem[(o + 3) & 0x0FFF] = val & 0xff;
        return;
      }
    }
  }
  raiseInterrupt(): void { if (this.mi) this.mi.raise(MI_INTR_SP); }
}

// DP (RDP) minimal device
export const DP_STATUS_OFF = 0x10;
export const DP_STATUS_INTR = 1 << 0; // write 1 to ack pending
export const DP_STATUS_BUSY = 1 << 1;
export const DP_STATUS_PIPE_BUSY = 1 << 2;
export class DP extends MMIO {
  status = 0 >>> 0;
  private mi: MI | null = null;
  constructor() { super(DP_SIZE); }
  setMI(mi: MI) { this.mi = mi; }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case DP_STATUS_OFF: return this.status >>> 0;
      default: return super.readU32(off);
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case DP_STATUS_OFF:
        // Ack pending and clear busy flags when DP_STATUS_INTR is written.
        if (val & DP_STATUS_INTR) {
          // Clear MI pending for DP
          if (this.mi) this.mi.clear(MI_INTR_DP);
          // Clear minimal busy flags to model task completion
          this.status &= ~(DP_STATUS_BUSY | DP_STATUS_PIPE_BUSY);
        }
        return;
      default: super.writeU32(off, val); return;
    }
  }
  raiseInterrupt(): void {
    // Set minimal busy flags when work completes and DP interrupt is raised
    this.status |= (DP_STATUS_BUSY | DP_STATUS_PIPE_BUSY);
    if (this.mi) this.mi.raise(MI_INTR_DP);
  }
}

// VI (Video Interface) - minimal interrupt + framebuffer registers
export const VI_STATUS_OFF = 0x10; // choose offset away from 0 to avoid mmio_bus routing test conflicts
export const VI_STATUS_VINT = 1 << 0;
export const VI_ORIGIN_OFF = 0x14; // RDRAM base address of framebuffer
export const VI_WIDTH_OFF = 0x18;  // line stride (pixels)

export class VI extends MMIO {
  status = 0 >>> 0;
  origin = 0 >>> 0;
  width = 0 >>> 0;
  private mi: MI | null = null;
  constructor() { super(VI_SIZE); }
  setMI(mi: MI) { this.mi = mi; }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case VI_STATUS_OFF: return this.status >>> 0;
      case VI_ORIGIN_OFF: return this.origin >>> 0;
      case VI_WIDTH_OFF: return this.width >>> 0;
      default: return super.readU32(off);
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case VI_STATUS_OFF:
        // Writing VINT bit acknowledges and clears MI pending
        if (val & VI_STATUS_VINT) {
          this.status &= ~VI_STATUS_VINT;
          if (this.mi) this.mi.clear(MI_INTR_VI);
        }
        return;
      case VI_ORIGIN_OFF:
        this.origin = val >>> 0;
        return;
      case VI_WIDTH_OFF:
        this.width = val >>> 0;
        return;
      default:
        super.writeU32(off, val);
        return;
    }
  }
  vblank(): void {
    this.status |= VI_STATUS_VINT;
    if (this.mi) this.mi.raise(MI_INTR_VI);
  }
}

// AI (Audio Interface) - minimal DMA/interrupt semantics
export const AI_DRAM_ADDR_OFF = 0x00;
export const AI_LEN_OFF = 0x04;
export const AI_STATUS_OFF = 0x0C;
export const AI_STATUS_DMA_BUSY = 1 << 0;

export class AI extends MMIO {
  dramAddr = 0 >>> 0;
  len = 0 >>> 0;
  status = 0 >>> 0;
  private mi: MI | null = null;
  constructor() { super(AI_SIZE); }
  setMI(mi: MI) { this.mi = mi; }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case AI_DRAM_ADDR_OFF: return this.dramAddr >>> 0;
      case AI_LEN_OFF: return this.len >>> 0;
      case AI_STATUS_OFF: return this.status >>> 0;
      default: return super.readU32(off);
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case AI_DRAM_ADDR_OFF: this.dramAddr = val; return;
      case AI_LEN_OFF: this.len = val; this.status |= AI_STATUS_DMA_BUSY; return;
      case AI_STATUS_OFF:
        if (val & AI_STATUS_DMA_BUSY) {
          this.status &= ~AI_STATUS_DMA_BUSY;
          if (this.mi) this.mi.clear(MI_INTR_AI);
        }
        return;
      default: super.writeU32(off, val); return;
    }
  }
  completeDMA(): void {
    this.status &= ~AI_STATUS_DMA_BUSY;
    if (this.mi) this.mi.raise(MI_INTR_AI);
  }
}
// PI (Peripheral Interface)
export const PI_DRAM_ADDR_OFF = 0x00;
export const PI_CART_ADDR_OFF = 0x04;
export const PI_RD_LEN_OFF = 0x08;
export const PI_WR_LEN_OFF = 0x0C;
export const PI_STATUS_OFF = 0x10;
export const PI_STATUS_DMA_BUSY = 1 << 0;
export const PI_STATUS_IO_BUSY = 1 << 1;

export class PI extends MMIO {
  dramAddr = 0 >>> 0;
  cartAddr = 0 >>> 0;
  rdLen = 0 >>> 0;
  wrLen = 0 >>> 0;
  status = 0 >>> 0;
  private mi: MI | null = null;
  private rom: Uint8Array | null = null;
  private rdram: Uint8Array | null = null;
  constructor() { super(PI_SIZE); }
  setMI(mi: MI) { this.mi = mi; }
  setROM(rom: Uint8Array) { this.rom = rom; }
  setRDRAM(bytes: Uint8Array) { this.rdram = bytes; }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case PI_DRAM_ADDR_OFF: return this.dramAddr >>> 0;
      case PI_CART_ADDR_OFF: return this.cartAddr >>> 0;
      case PI_RD_LEN_OFF: return this.rdLen >>> 0;
      case PI_WR_LEN_OFF: return this.wrLen >>> 0;
      case PI_STATUS_OFF: return this.status >>> 0;
      default: return super.readU32(off);
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case PI_DRAM_ADDR_OFF: this.dramAddr = val; return;
      case PI_CART_ADDR_OFF: this.cartAddr = val; return;
      case PI_RD_LEN_OFF:
        this.rdLen = val; this.status |= (PI_STATUS_DMA_BUSY | PI_STATUS_IO_BUSY);
        // Perform a synchronous copy from ROM[cartAddr] to RDRAM[dramAddr]
        if (this.rom && this.rdram) {
          const baseRom = this.cartAddr >>> 0;
          const baseRam = this.dramAddr >>> 0;
          const len = ((val & 0x00ffffff) >>> 0) + 1; // PI uses length-1 semantics
          for (let i = 0; i < len; i++) {
            const b = this.rom[baseRom + i] ?? 0;
            if (baseRam + i < this.rdram.length) this.rdram[baseRam + i] = b;
          }
        }
        // Leave DMA/IO busy set until STATUS write or explicit completion
        return;
      case PI_WR_LEN_OFF:
        this.wrLen = val; this.status |= (PI_STATUS_DMA_BUSY | PI_STATUS_IO_BUSY);
        // For now, ignore writes to cart and leave busy until STATUS write or explicit completion
        return;
      case PI_STATUS_OFF:
        // Writing 1 bits clears corresponding busy flags; also clear MI pending for PI when busy bit is cleared
        if (val & PI_STATUS_DMA_BUSY) {
          this.status &= ~PI_STATUS_DMA_BUSY;
          if (this.mi) this.mi.clear(MI_INTR_PI);
        }
        if (val & PI_STATUS_IO_BUSY) this.status &= ~PI_STATUS_IO_BUSY;
        return;
      default: super.writeU32(off, val); return;
    }
  }
  // Simulate DMA completion: clear busy and raise MI interrupt
  completeDMA(): void {
    this.status &= ~PI_STATUS_DMA_BUSY;
    this.status &= ~PI_STATUS_IO_BUSY;
    if (this.mi) this.mi.raise(MI_INTR_PI);
  }
}

// SI (Serial Interface)
export const SI_DRAM_ADDR_OFF = 0x00;
export const SI_PIF_ADDR_RD64B_OFF = 0x04;
export const SI_PIF_ADDR_WR64B_OFF = 0x10;
export const SI_STATUS_OFF = 0x18;
export const SI_STATUS_DMA_BUSY = 1 << 0;

export class SI extends MMIO {
  dramAddr = 0 >>> 0;
  pifAddrRd = 0 >>> 0;
  pifAddrWr = 0 >>> 0;
  status = 0 >>> 0;
  private mi: MI | null = null;
  private rdram: Uint8Array | null = null;
  readonly pifRam = new Uint8Array(64);
  constructor() { super(SI_SIZE); }
  setMI(mi: MI) { this.mi = mi; }
  setRDRAM(bytes: Uint8Array) { this.rdram = bytes; }
  override readU32(off: number): number {
    switch (off >>> 0) {
      case SI_DRAM_ADDR_OFF: return this.dramAddr >>> 0;
      case SI_PIF_ADDR_RD64B_OFF: return this.pifAddrRd >>> 0;
      case SI_PIF_ADDR_WR64B_OFF: return this.pifAddrWr >>> 0;
      case SI_STATUS_OFF: return this.status >>> 0;
      default: return super.readU32(off);
    }
  }
  override writeU32(off: number, val: number): void {
    val >>>= 0;
    switch (off >>> 0) {
      case SI_DRAM_ADDR_OFF: this.dramAddr = val; return;
      case SI_PIF_ADDR_RD64B_OFF: this.pifAddrRd = val; this.status |= SI_STATUS_DMA_BUSY; return;
      case SI_PIF_ADDR_WR64B_OFF: this.pifAddrWr = val; this.status |= SI_STATUS_DMA_BUSY; return;
      case SI_STATUS_OFF:
        if (val & SI_STATUS_DMA_BUSY) {
          this.status &= ~SI_STATUS_DMA_BUSY;
          if (this.mi) this.mi.clear(MI_INTR_SI);
        }
        return;
      default: super.writeU32(off, val); return;
    }
  }
  // Simulate DMA completion: clear busy and raise MI interrupt
  completeDMA(): void {
    this.status &= ~SI_STATUS_DMA_BUSY;
    if (this.mi) this.mi.raise(MI_INTR_SI);
  }
  // Deterministic 64B write: RDRAM -> PIF RAM
  kickWrite64B(): void {
    this.status |= SI_STATUS_DMA_BUSY;
    const base = this.dramAddr >>> 0;
    if (this.rdram) {
      for (let i = 0; i < 64; i++) {
        const v = this.rdram[base + i] ?? 0;
        this.pifRam[i] = v;
      }
    }
    // Process a tiny subset of PIF commands for testing
    this.processPIF();
    if (this.mi) this.mi.raise(MI_INTR_SI);
  }

  private processPIF(): void {
    const cmd = (this.pifRam[0]! >>> 0);
    const port = (this.pifRam[63] ?? 0) & 0x03; // 0..3
    switch (cmd) {
      case 0x00: // NOP
        break;
      case 0x01: // Simple ACK
        this.pifRam[1] = 0x5a; // deterministic magic
        break;
      case 0x02: // Echo: copy byte [1] to [2]
        this.pifRam[2] = this.pifRam[1] ?? 0;
        break;
      case 0x10: { // Controller status (simplified): present + no pak for port 0 only
        const present = port === 0 ? 0x01 : 0x00;
        this.pifRam[1] = present; // present flag
        this.pifRam[2] = 0x00; // no pak
        this.pifRam[3] = 0x00; // reserved
        break;
      }
      case 0x11: { // Read controller state (simplified)
        if (port === 0) {
          this.pifRam[1] = 0x00; // status OK
          // Buttons 0x1234
          this.pifRam[2] = 0x12; // hi byte
          this.pifRam[3] = 0x34; // lo byte
          this.pifRam[4] = 0x05; // stick X = +5
          this.pifRam[5] = 0xFB; // stick Y = -5 (two's complement)
        } else {
          // Not connected / zero state for other ports
          this.pifRam[1] = 0xFF; // typical error/no response
          this.pifRam[2] = 0x00;
          this.pifRam[3] = 0x00;
          this.pifRam[4] = 0x00;
          this.pifRam[5] = 0x00;
        }
        break;
      }
      default:
        // For unknown commands, leave data unchanged to preserve raw DMA semantics
        break;
    }
  }
  // Deterministic 64B read: PIF RAM -> RDRAM
  kickRead64B(): void {
    this.status |= SI_STATUS_DMA_BUSY;
    const base = this.dramAddr >>> 0;
    if (this.rdram) {
      for (let i = 0; i < 64; i++) {
        const v = this.pifRam[i] ?? 0;
        if (base + i < this.rdram.length) this.rdram[base + i] = v;
      }
    }
    if (this.mi) this.mi.raise(MI_INTR_SI);
  }
}
