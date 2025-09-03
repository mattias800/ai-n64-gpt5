/**
 * TLB (Translation Lookaside Buffer) implementation
 * Provides cycle-accurate virtual to physical address translation
 */

export interface TLBEntry {
  // Entry fields per MIPS R4300 architecture
  vpn2: number;      // Virtual Page Number / 2 (bits 31:13 of virtual address)
  asid: number;      // Address Space ID (8 bits)
  pageSize: number;  // Page size (4KB to 16MB)
  global: boolean;   // Global bit (ignore ASID)
  valid0: boolean;   // Valid bit for even page
  valid1: boolean;   // Valid bit for odd page
  dirty0: boolean;   // Dirty bit for even page
  dirty1: boolean;   // Dirty bit for odd page
  pfn0: number;      // Physical Frame Number for even page
  pfn1: number;      // Physical Frame Number for odd page
  cacheAttr0: number; // Cache attributes for even page
  cacheAttr1: number; // Cache attributes for odd page
}

export class TLB {
  private static readonly NUM_ENTRIES = 32; // R4300 has 32 TLB entries
  private entries: TLBEntry[];
  private wiredEntries: number = 0;
  private randomIndex: number = 31;
  private cycleCount: number = 0;
  
  // TLB timing constants (in CPU cycles)
  private static readonly LOOKUP_CYCLES = 1;
  private static readonly REFILL_CYCLES = 20;
  private static readonly PROBE_CYCLES = 5;
  
  // Page size masks
  private static readonly PAGE_SIZES: Map<number, number> = new Map([
    [0x000, 4096],       // 4 KB
    [0x003, 16384],      // 16 KB
    [0x00F, 65536],      // 64 KB
    [0x03F, 262144],     // 256 KB
    [0x0FF, 1048576],    // 1 MB
    [0x3FF, 4194304],    // 4 MB
    [0xFFF, 16777216],   // 16 MB
  ]);
  
  constructor() {
    this.entries = new Array(TLB.NUM_ENTRIES);
    this.reset();
  }
  
  reset(): void {
    // Initialize all TLB entries to invalid
    for (let i = 0; i < TLB.NUM_ENTRIES; i++) {
      this.entries[i] = {
        vpn2: 0,
        asid: 0,
        pageSize: 4096,
        global: false,
        valid0: false,
        valid1: false,
        dirty0: false,
        dirty1: false,
        pfn0: 0,
        pfn1: 0,
        cacheAttr0: 0,
        cacheAttr1: 0,
      };
    }
    this.wiredEntries = 0;
    this.randomIndex = 31;
  }
  
  /**
   * Translate virtual address to physical address
   * Returns null if translation fails (TLB miss)
   */
  translate(vaddr: number, write: boolean, asid: number): { paddr: number; cached: boolean } | null {
    const va = vaddr >>> 0;
    
    // Search TLB for matching entry
    for (let i = 0; i < TLB.NUM_ENTRIES; i++) {
      const entry = this.entries[i]!;
      
      // Check if entry matches (considering ASID and global bit)
      if (!entry.global && entry.asid !== asid) continue;
      
      // Calculate page size parameters
      // For 4KB (2^12): covers 8KB total (2 pages), so bits [12] and below are offset
      // For 16KB (2^14): covers 32KB total (2 pages), so bits [14] and below are offset  
      const pageSizeBits = Math.log2(entry.pageSize) | 0;
      
      // VPN2 comparison mask - which VPN2 bits to compare
      // For 4KB pages: compare all 19 bits of VPN2
      // For 16KB pages: ignore lower 2 bits of VPN2 (because 16KB = 4 * 4KB)
      // For 64KB pages: ignore lower 4 bits of VPN2 (because 64KB = 16 * 4KB)
      const vpn2IgnoreBits = Math.max(0, pageSizeBits - 12);
      const vpn2Mask = ~((1 << vpn2IgnoreBits) - 1) & 0x7FFFF;
      
      // Extract VPN2 from virtual address (bits 31:13)
      const vaVpn2 = (va >>> 13) & 0x7FFFF;
      
      // Check if VPN2 matches (with mask for larger pages)
      if ((vaVpn2 & vpn2Mask) !== (entry.vpn2 & vpn2Mask)) continue;
      
      // Determine which page (even or odd) based on the page size
      // For 4KB pages: bit 12 selects between even/odd
      // For 16KB pages: bit 14 selects between even/odd
      const oddPageBit = pageSizeBits;
      const oddPage = (va >>> oddPageBit) & 1;
      
      const valid = oddPage ? entry.valid1 : entry.valid0;
      const dirty = oddPage ? entry.dirty1 : entry.dirty0;
      const pfn = oddPage ? entry.pfn1 : entry.pfn0;
      const cacheAttr = oddPage ? entry.cacheAttr1 : entry.cacheAttr0;
      
      if (!valid) continue; // Invalid page, keep searching
      if (write && !dirty) return null; // Write to clean page - TLB exception
      
      // Calculate physical address
      // Keep the offset bits from the virtual address
      const offsetMask = (1 << pageSizeBits) - 1;
      const offset = va & offsetMask;
      const paddr = ((pfn << 12) | offset) >>> 0;
      
      // Determine if cached based on cache attributes
      // 0=Invalid, 1=Reserved, 2=Uncached, 3=Cached, 4=Reserved, 5=Reserved, 6=Reserved, 7=Uncached
      const cached = cacheAttr === 3;
      
      return { paddr, cached };
    }
    
    return null; // TLB miss
  }
  
  /**
   * Write a TLB entry at specified index
   */
  writeEntry(index: number, entry: TLBEntry): void {
    if (index >= 0 && index < TLB.NUM_ENTRIES) {
      this.entries[index] = { ...entry };
    }
  }
  
  /**
   * Read a TLB entry at specified index
   */
  readEntry(index: number): TLBEntry | null {
    if (index >= 0 && index < TLB.NUM_ENTRIES) {
      return { ...this.entries[index]! };
    }
    return null;
  }
  
  /**
   * Probe TLB for matching entry
   * Returns index of matching entry or -1 if not found
   */
  probe(vpn2: number, asid: number): number {
    for (let i = 0; i < TLB.NUM_ENTRIES; i++) {
      const entry = this.entries[i]!;
      if (entry.vpn2 === vpn2 && (entry.global || entry.asid === asid)) {
        return i;
      }
    }
    return -1;
  }
  
  /**
   * Get random index for TLBWR instruction
   * Random index cycles between wired and 31
   */
  getRandomIndex(): number {
    return this.randomIndex;
  }
  
  /**
   * Update random index (called every cycle)
   */
  updateRandom(): void {
    this.cycleCount++;
    if (this.cycleCount % 32 === 0) {
      this.randomIndex--;
      if (this.randomIndex < this.wiredEntries) {
        this.randomIndex = 31;
      }
    }
  }
  
  /**
   * Set number of wired (fixed) TLB entries
   */
  setWired(wired: number): void {
    this.wiredEntries = Math.min(wired, TLB.NUM_ENTRIES);
    if (this.randomIndex < this.wiredEntries) {
      this.randomIndex = 31;
    }
  }
  
  /**
   * Get number of wired entries
   */
  getWired(): number {
    return this.wiredEntries;
  }
  
  /**
   * Invalidate all TLB entries (for TLBIA instruction)
   */
  invalidateAll(): void {
    for (let i = 0; i < TLB.NUM_ENTRIES; i++) {
      this.entries[i]!.valid0 = false;
      this.entries[i]!.valid1 = false;
    }
  }
  
  /**
   * Get TLB statistics for debugging
   */
  getStats(): { entries: number; wired: number; random: number; valid: number } {
    let validCount = 0;
    for (const entry of this.entries) {
      if (entry.valid0) validCount++;
      if (entry.valid1) validCount++;
    }
    return {
      entries: TLB.NUM_ENTRIES,
      wired: this.wiredEntries,
      random: this.randomIndex,
      valid: validCount
    };
  }
  
  /**
   * Advance TLB by one cycle
   */
  tick(): void {
    this.updateRandom();
  }
}
