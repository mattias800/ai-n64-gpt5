import { signExtend16, signExtend8, toUint32, mul64Signed, mul64Unsigned, div32Signed, div32Unsigned } from '../utils/bit.js';
import { Bus } from '../mem/bus.js';
import { CPUException } from './exceptions.js';
import { Cop0 } from './cop0.js';

type CPUOptions = {
  identityMapKuseg?: boolean;
};

export class CPU {
  readonly regs = new Uint32Array(32); // low 32 bits of GPRs
  readonly regsHi = new Uint32Array(32); // high 32 bits of GPRs (for 64-bit ops)
  // Minimal COP1 (FPU) register file stub
  readonly fpr = new Uint32Array(32);
  fcr31 = 0 >>> 0; // control/status; bit 23 = condition flag
  hi = 0 >>> 0;
  lo = 0 >>> 0;
  pc = 0 >>> 0;
  inDelaySlot = false;

  // One-shot decode warning callback (first occurrence per unique key)
  onDecodeWarn?: (w: { pc: number; instr: number; kind: string; details?: any }) => void;

  // Fastboot/HLE option: when enabled, treat ReservedInstruction as a NOP (skip)
  // instead of raising an exception. Default is false to preserve accuracy.
  public fastbootSkipReserved = false;

  // Minimal CP0 for exception state
  readonly cop0 = new Cop0();

  // Minimal TLB implementation for KUSEG translation
  private static readonly TLB_SIZE = 32;
  private tlb: Array<{
    mask: number; // 0 for 4KB pages
    vpn2: number; // bits [31:13] of VA
    asid: number; // 8-bit
    g: boolean;
    pfn0: number; pfn1: number; // frame numbers >> 12
    v0: boolean; d0: boolean; v1: boolean; d1: boolean;
  }>; 
  private tlbRandom = 31 >>> 0; // start at max index

  // Branch delay management
  private branchPending = false; // delay slot to execute
  private branchCommitPending = false; // delay slot executed, branch commit pending at boundary
  private branchTarget = 0 >>> 0;
  private branchPC = 0 >>> 0; // address of branch instruction (for EPC when BD)

  // Minimal LL/SC state
  private llValid = false;
  private llAddr = 0 >>> 0;

  // Detect spinning in empty exception vector (fastboot-HLE aid)
  private vectorNopCount = 0;

  // Optional single-step trace callback
  onTrace?: (pc: number, instr: number) => void;

  // Track last fetched instruction for diagnostics and warning emission
  private lastInstrPC = 0 >>> 0;
  private lastInstrWord = 0 >>> 0;
  private decodeWarnedKeys = new Set<string>();
  private readonly identityMapKuseg: boolean;

  constructor(public readonly bus: Bus, opts?: CPUOptions) {
    // Initialize empty TLB entries
    this.tlb = new Array(CPU.TLB_SIZE);
    for (let i = 0; i < CPU.TLB_SIZE; i++) {
      this.tlb[i] = { mask: 0, vpn2: 0, asid: 0, g: false, pfn0: 0, pfn1: 0, v0: false, d0: false, v1: false, d1: false };
    }
    this.identityMapKuseg = opts?.identityMapKuseg ?? true;
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.regsHi.fill(0);
    this.hi = 0;
    this.lo = 0;
    this.pc = 0; // HLE boot will set this appropriately later
    this.branchPending = false;
    this.branchCommitPending = false;
    this.branchTarget = 0;
    this.branchPC = 0;
    this.llValid = false;
    this.llAddr = 0 >>> 0;
  }

  private getReg(i: number): number {
    // Guard against out-of-range to satisfy noUncheckedIndexedAccess
    if ((i >>> 0) >= 32) return 0;
    const v = this.regs[i] as number | undefined;
    return (v ?? 0) >>> 0;
  }

  private setReg(i: number, value: number): void {
    if ((i >>> 0) >= 32) return;
    if (i === 0) return; // $zero is immutable
    const v = toUint32(value);
    this.regs[i] = v;
    // Sign-extend 32-bit results into 64-bit GPRs per MIPS64 rules
    this.regsHi[i] = ((v >>> 31) !== 0) ? 0xFFFFFFFF : 0x00000000;
  }

  private setReg64(i: number, hi: number, lo: number): void {
    if ((i >>> 0) >= 32) return;
    if (i === 0) return;
    this.regs[i] = toUint32(lo);
    this.regsHi[i] = toUint32(hi);
  }

  private getRegHi(i: number): number {
    if ((i >>> 0) >= 32) return 0;
    const v = this.regsHi[i] as number | undefined;
    return (v ?? 0) >>> 0;
  }

  step(): void {
    // Advance CP0 timer
    this.cop0.tick();
    // Advance Random register domain (simple decrement within TLB range)
    const wired = (this.cop0.read(6) >>> 0) & 0x3f; // Wired
    const max = CPU.TLB_SIZE - 1;
    let r = this.tlbRandom | 0;
    r = (r - 1);
    if (r < Math.max(wired, 0)) r = max;
    this.tlbRandom = (r >>> 0);
    // Keep CP0 Random updated (for visibility)
    this.cop0.write(1, this.tlbRandom >>> 0);

    // If a branch commit is pending (delay slot already executed), check interrupts before committing branch
    if (this.branchCommitPending) {
      // Interrupts that occur now set BD and EPC to branchPC
      if (this.interruptsPendingAndUpdateCause()) {
        this.enterInterrupt(this.branchPC >>> 0, true);
        this.branchCommitPending = false; // cancel branch on exception
        this.branchPending = false;
        this.regs[0] = 0;
        return;
      }
      // Commit the branch now and continue with normal flow this step
      this.pc = this.branchTarget >>> 0;
      this.branchCommitPending = false;
      this.branchPending = false;
    }

    // If a branch was pending from the previous instruction, execute the delay slot now
    if (this.branchPending) {
      const delayInstrPC = this.pc; // address of delay slot instruction
      const branchInstrPC = (delayInstrPC - 4) >>> 0; // address of branch
      let delayInstr: number;
      try {
        delayInstr = this.loadU32TLB(delayInstrPC, true);
      } catch (e) {
        if (e instanceof CPUException) {
          // Exception occurred fetching the delay slot instruction; treat as BD exception at branch PC
          this.enterException(e, branchInstrPC >>> 0, e.badVAddr >>> 0, true);
          this.inDelaySlot = false;
          this.branchPending = false;
          this.regs[0] = 0;
          return;
        }
        throw e;
      }
      const afterDelay = (delayInstrPC + 4) >>> 0;
      const target = this.branchTarget >>> 0;
      // Execute delay slot with BD semantics
      this.pc = afterDelay;
      this.inDelaySlot = true;
      try {
        this.execute(delayInstr);
      } catch (e) {
        if (e instanceof CPUException) {
          const ec = e.code;
          const needBadV = (ec === 'AddressErrorLoad' || ec === 'AddressErrorStore' || ec === 'TLBLoad' || ec === 'TLBStore' || ec === 'TLBModified');
          this.enterException(e, branchInstrPC, needBadV ? (e.badVAddr >>> 0) : null, true);
          this.inDelaySlot = false;
          this.branchPending = false;
          this.regs[0] = 0;
          return;
        }
        throw e;
      }
      this.inDelaySlot = false;
      this.regs[0] = 0; // enforce $zero
      // Do not commit branch yet; allow an interrupt window at the next boundary.
      this.branchPC = branchInstrPC >>> 0;
      this.branchTarget = target >>> 0;
      this.branchPending = false;
      this.branchCommitPending = true;
      return;
    }

    // Normal instruction boundary: check interrupts before fetching next instruction
    const instrPC = this.pc;
    if (this.interruptsPendingAndUpdateCause()) {
      this.enterInterrupt(instrPC, false);
      this.regs[0] = 0;
      return;
    }

    let instr: number;
    try {
      instr = this.loadU32TLB(instrPC, true);
    } catch (e) {
      if (e instanceof CPUException) {
        // Treat instruction fetch faults as exceptions at this boundary
        this.enterException(e, instrPC >>> 0, e.badVAddr >>> 0, false);
        this.regs[0] = 0;
        return;
      }
      throw e;
    }
    // Latch last fetched for diagnostics
    this.lastInstrPC = instrPC >>> 0;
    this.lastInstrWord = instr >>> 0;
    // Emit trace for this instruction fetch
    if (this.onTrace) { try { this.onTrace(instrPC >>> 0, instr >>> 0); } catch {} }

    // Fastboot-HLE: auto-return from empty exception vector loops
    if (this.fastbootSkipReserved) {
      const status0 = this.cop0.read(12) >>> 0;
      const inVec = (instrPC >>> 0) >= 0x80000180 && (instrPC >>> 0) < 0x80001000;
      if (inVec && ((instr >>> 0) === 0)) {
        this.vectorNopCount = (this.vectorNopCount + 1) | 0;
      } else {
        this.vectorNopCount = 0;
      }
      // Only auto-return if we are actually in exception level (EXL set) and we've observed a short NOP loop
      if (((status0 & Cop0.STATUS_EXL) !== 0) && this.vectorNopCount >= 4) {
        const cause0 = this.cop0.read(13) >>> 0;
        const epc0 = this.cop0.read(14) >>> 0;
        // Clear EXL and pending IP bits to avoid immediate re-entry
        this.cop0.write(12, (status0 & ~Cop0.STATUS_EXL) >>> 0);
        this.cop0.setCauseInternal(cause0 & ~Cop0.CAUSE_IP_MASK);
        // Also clear all MI latched interrupts to un-assert IP2 quickly in fastboot
        // Write-one-to-clear via MI INIT_MODE (0x00), not INTR (0x08) which is read-only.
        try { (this.bus.mi as any).writeU32(0x00, 0xFFFFFFFF >>> 0); } catch {}
        // Cancel any pending branch state and return to EPC+4 (skip re-exec)
        this.branchPending = false;
        this.branchCommitPending = false;
        this.pc = (epc0 + 4) >>> 0;
        this.vectorNopCount = 0;
        this.regs[0] = 0; // enforce $zero
        return;
      }
    }

    this.pc = (instrPC + 4) >>> 0;
    try {
      this.execute(instr);
    } catch (e) {
      if (e instanceof CPUException) {
        const ec = e.code;
        const needBadV = (ec === 'AddressErrorLoad' || ec === 'AddressErrorStore' || ec === 'TLBLoad' || ec === 'TLBStore' || ec === 'TLBModified');
        this.enterException(e, instrPC, needBadV ? (e.badVAddr >>> 0) : null, false);
      } else {
        throw e;
      }
    }
    this.regs[0] = 0; // enforce $zero
  }

  private addrCalc(baseReg: number, imm: number): number {
    return (this.getReg(baseReg) + (signExtend16(imm) >>> 0)) >>> 0;
  }

  // Count contiguous 1s in PageMask starting at bit 13 (determines page size 4KB << n)
  private pageMaskSpanBits(mask: number): number {
    let m = (mask >>> 13) >>> 0;
    let n = 0;
    while ((m & 1) !== 0 && n < 13) { n++; m >>>= 1; }
    return n;
  }

  // Address translation using KSEG rules and TLB with PageMask support
  private translateAddress(vaddr: number, acc: 'r'|'w'|'x'): number {
    const va = vaddr >>> 0;
    const region = va >>> 28;
    // Enforce user-mode restrictions: when in User (KSU==2) and not already in EXL, KSEG* (region >= 8) is inaccessible
    const status = this.cop0.read(12) >>> 0;
    const exl = (status & Cop0.STATUS_EXL) !== 0;
    const ksu = (status >>> 3) & 0x3; // 0=Kern,1=Sup,2=User
    const isUser = (ksu === 2) && !exl;
    if (isUser && region >= 0x8) {
      if (acc === 'w') throw new CPUException('AddressErrorStore', va >>> 0);
      else throw new CPUException('AddressErrorLoad', va >>> 0);
    }
    // KUSEG (0x00000000-0x7fffffff): optional identity map for tests; otherwise use TLB
    if (region < 0x8) {
      if (this.identityMapKuseg) return va >>> 0;
      const asid = (this.cop0.read(10) >>> 0) & 0xff;
      for (let i = 0; i < CPU.TLB_SIZE; i++) {
        const e = this.tlb[i]!;
        if (!(e.g || e.asid === asid)) continue;
        const xorTag = ((va ^ ((e.vpn2 << 13) >>> 0)) >>> 0);
        const tagMask = (~((e.mask | 0x1FFF) >>> 0)) >>> 0;
        if ((xorTag & tagMask) === 0) {
          const n = this.pageMaskSpanBits(e.mask >>> 0);
          const evenOddBit = (12 + n) | 0;
          const odd = (((va >>> evenOddBit) & 1) !== 0);
          const v = odd ? e.v1 : e.v0;
          const d = odd ? e.d1 : e.d0;
          if (!v) break;
          if (acc === 'w' && !d) throw new CPUException('TLBModified', va >>> 0);
          const pfn = odd ? e.pfn1 : e.pfn0;
          const offsetMask = (((1 << (12 + n)) >>> 0) - 1) >>> 0;
          const paddr = ((((pfn << 12) >>> 0) | (va & offsetMask)) >>> 0);
          return paddr >>> 0;
        }
      }
      if (acc === 'w') throw new CPUException('TLBStore', va >>> 0);
      else throw new CPUException('TLBLoad', va >>> 0);
    }
    if (region === 0x8 || region === 0x9) return (va - 0x8000_0000) >>> 0; // KSEG0 cached
    if (region === 0xA || region === 0xB) return (va - 0xA000_0000) >>> 0; // KSEG1 uncached
    // Other segments via TLB (with PageMask support)
    const asid = (this.cop0.read(10) >>> 0) & 0xff; // EntryHi ASID
    for (let i = 0; i < CPU.TLB_SIZE; i++) {
      const e = this.tlb[i]!;
      if (!(e.g || e.asid === asid)) continue;
      const xorTag = ((va ^ ((e.vpn2 << 13) >>> 0)) >>> 0);
      const tagMask = (~((e.mask | 0x1FFF) >>> 0)) >>> 0;
      if ((xorTag & tagMask) === 0) {
        const n = this.pageMaskSpanBits(e.mask >>> 0);
        const evenOddBit = (12 + n) | 0;
        const odd = (((va >>> evenOddBit) & 1) !== 0);
        const v = odd ? e.v1 : e.v0;
        const d = odd ? e.d1 : e.d0;
        if (!v) break;
        if (acc === 'w' && !d) throw new CPUException('TLBModified', va >>> 0);
        const pfn = odd ? e.pfn1 : e.pfn0;
        const offsetMask = (((1 << (12 + n)) >>> 0) - 1) >>> 0;
        const paddr = ((((pfn << 12) >>> 0) | (va & offsetMask)) >>> 0);
        return paddr >>> 0;
      }
    }
    // Fallback: return VA as physical (acts like unmapped cached)
    return va >>> 0;
  }

  private loadU8TLB(addr: number, exec = false): number { return this.bus.loadU8Phys(this.translateAddress(addr, exec ? 'x' : 'r')); }
  private loadU16TLB(addr: number): number { return this.bus.loadU16Phys(this.translateAddress(addr, 'r')); }
  private loadU32TLB(addr: number, exec = false): number { return this.bus.loadU32Phys(this.translateAddress(addr, exec ? 'x' : 'r')); }
  private storeU8TLB(addr: number, value: number): void { this.bus.storeU8Phys(this.translateAddress(addr, 'w'), value >>> 0); this.invalidateLL(addr); }
  private storeU16TLB(addr: number, value: number): void { this.bus.storeU16Phys(this.translateAddress(addr, 'w'), value >>> 0); this.invalidateLL(addr); }
  private storeU32TLB(addr: number, value: number): void { this.bus.storeU32Phys(this.translateAddress(addr, 'w'), value >>> 0); this.invalidateLL(addr); }

  private checkAlign(addr: number, align: number, isStore: boolean): void {
    if ((addr & (align - 1)) !== 0) {
      throw new CPUException(isStore ? 'AddressErrorStore' : 'AddressErrorLoad', addr >>> 0);
    }
  }

  private enterException(ex: CPUException, faultingPC: number, badVAddr: number | null, inDelaySlot: boolean): void {
    const excMap: Record<string, number> = {
      // MIPS R4300 exception codes (Cause.ExcCode)
      Interrupt: 0,
      TLBModified: 1, // Mod (store to clean page)
      TLBLoad: 2, // TLBL (load/fetch)
      TLBStore: 3, // TLBS (store)
      AddressErrorLoad: 4, // ADEL
      AddressErrorStore: 5, // ADES
      Breakpoint: 9,
      ReservedInstruction: 10,
      Syscall: 8,
      Overflow: 12,
      Trap: 13,
    };
    const code = excMap[ex.code] ?? 0;
    // Capture status before setting EXL to decide vectoring
    const statusBefore = this.cop0.read(12) >>> 0;
    const bev = (statusBefore >>> 22) & 1;
    const exlPrev = (statusBefore & Cop0.STATUS_EXL) !== 0;
    // For TLB exceptions, update EntryHi with faulting VPN2 | current ASID to aid OS refill handlers
    if ((ex.code === 'TLBLoad' || ex.code === 'TLBStore' || ex.code === 'TLBModified') && badVAddr !== null) {
      const asid = (this.cop0.read(10) >>> 0) & 0xff;
      const vpn2 = (badVAddr >>> 13) >>> 0;
      this.cop0.write(10, (((vpn2 << 13) >>> 0) | asid) >>> 0);
      // Also update Context.BadVPN2 (bits [31:23]) while preserving PTEBase [22:4]
      const ctxOld = this.cop0.read(4) >>> 0; // Context
      const pteBaseMask = 0x007FFFF0 >>> 0; // bits [22:4]
      const badVpn2High9 = ((badVAddr >>> 23) & 0x1ff) >>> 0; // VA[31:23]
      const ctxNew = (((ctxOld & pteBaseMask) | (badVpn2High9 << 23)) >>> 0);
      this.cop0.write(4, ctxNew >>> 0);
    }
    this.cop0.setException(code, faultingPC >>> 0, badVAddr, inDelaySlot);
    // Vector selection:
    // - For TLB Refill (TLBL/TLBS) when not already in EXL, use base + 0x0000
    // - Otherwise, use general exception vector base + 0x0180
    const isTLBRefill = (ex.code === 'TLBLoad' || ex.code === 'TLBStore');
    const base = bev ? 0xBFC00000 >>> 0 : 0x80000000 >>> 0;
    this.pc = (isTLBRefill && !exlPrev) ? base : ((base + 0x180) >>> 0);
  }

  private enterInterrupt(epc: number, inDelaySlot: boolean): void {
    // Exception code 0 = Interrupt
    this.enterException(new CPUException('Interrupt', 0), epc >>> 0, null, inDelaySlot);
  }

  private interruptsPendingAndUpdateCause(): boolean {
    // Update Cause IP2 based on MI aggregated interrupt output
    const ip2Bit = 1 << 10; // IP2 is bit 10
    const miAsserted = this.bus.mi.cpuIntAsserted();
    let cause = this.cop0.read(13) >>> 0;
    const newCause = miAsserted ? (cause | ip2Bit) >>> 0 : (cause & ~ip2Bit) >>> 0;
    if (newCause !== cause) this.cop0.setCauseInternal(newCause);

    const status = this.cop0.read(12) >>> 0;
    const exl = (status & Cop0.STATUS_EXL) !== 0;
    const ie = (status & Cop0.STATUS_IE) !== 0;
    if (!ie || exl) return false;
    const im = (status & Cop0.STATUS_IM_MASK) >>> 8;
    const ip = (newCause & Cop0.CAUSE_IP_MASK) >>> 8;
    return ((im & ip) >>> 0) !== 0;
  }

  execute(instr: number): void {
    const op = (instr >>> 26) & 0x3f;
    const rs = (instr >>> 21) & 0x1f;
    const rt = (instr >>> 16) & 0x1f;
    const rd = (instr >>> 11) & 0x1f;
    const shamt = (instr >>> 6) & 0x1f;
    const funct = instr & 0x3f;
    const imm = instr & 0xffff;
    const targetOffset = ((signExtend16(imm) << 2) >>> 0) >>> 0;

    switch (op) {
      case 0x00: { // SPECIAL (R-type)
        switch (funct) {
          case 0x00: { // SLL rd, rt, shamt
            const v = (this.getReg(rt) << shamt) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x02: { // SRL rd, rt, shamt
            const v = (this.getReg(rt) >>> shamt) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x03: { // SRA rd, rt, shamt (treat operand as 64-bit; shift amount 0..31)
            const sa = (shamt & 0x1f) >>> 0;
            if (sa === 0) { this.setReg(rd, this.getReg(rt)); return; }
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            const loN = ((lo0 >>> sa) | ((hi0 << (32 - sa)) >>> 0)) >>> 0;
            this.setReg(rd, loN);
            return;
          }
          case 0x04: { // SLLV rd, rt, rs
            const sa = (this.getReg(rs) & 0x1f) >>> 0;
            const v = (this.getReg(rt) << sa) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x06: { // SRLV rd, rt, rs
            const sa = (this.getReg(rs) & 0x1f) >>> 0;
            const v = (this.getReg(rt) >>> sa) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x07: { // SRAV rd, rt, rs (treat operand as 64-bit; shift amount masked to 0..31)
            const sa = (this.getReg(rs) & 0x1f) >>> 0;
            if (sa === 0) { this.setReg(rd, this.getReg(rt)); return; }
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            const loN = ((lo0 >>> sa) | ((hi0 << (32 - sa)) >>> 0)) >>> 0;
            this.setReg(rd, loN);
            return;
          }
          case 0x08: { // JR rs
            const target = this.getReg(rs);
            this.branchTarget = target >>> 0;
            this.branchPending = true;
            this.branchPC = ((this.pc - 4) >>> 0);
            return;
          }
          case 0x09: { // JALR rd, rs
            const link = (this.pc + 4) >>> 0; // address after delay slot
            this.setReg(rd || 31, link);
            const target = this.getReg(rs);
            this.branchTarget = target >>> 0;
            this.branchPending = true;
            this.branchPC = ((this.pc - 4) >>> 0);
            return;
          }
          case 0x20: { // ADD rd, rs, rt (trap on overflow)
            const a = (this.getReg(rs) | 0);
            const b = (this.getReg(rt) | 0);
            const r = (a + b) | 0;
            // Overflow if sign of a and b are same and differ from r
            if (((a ^ r) & (b ^ r)) < 0) {
              throw new CPUException('Overflow', this.pc >>> 0);
            }
            this.setReg(rd, r >>> 0);
            return;
          }
          case 0x21: { // ADDU rd, rs, rt
            const v = (this.getReg(rs) + this.getReg(rt)) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x23: { // SUBU rd, rs, rt
            const v = (this.getReg(rs) - this.getReg(rt)) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x24: { // AND rd, rs, rt (64-bit logical)
            const lo = (this.getReg(rs) & this.getReg(rt)) >>> 0;
            const hi = (this.getRegHi(rs) & this.getRegHi(rt)) >>> 0;
            this.setReg64(rd, hi, lo);
            return;
          }
          case 0x25: { // OR rd, rs, rt (64-bit logical)
            const lo = (this.getReg(rs) | this.getReg(rt)) >>> 0;
            const hi = (this.getRegHi(rs) | this.getRegHi(rt)) >>> 0;
            this.setReg64(rd, hi, lo);
            return;
          }
          case 0x26: { // XOR rd, rs, rt (64-bit logical)
            const lo = (this.getReg(rs) ^ this.getReg(rt)) >>> 0;
            const hi = (this.getRegHi(rs) ^ this.getRegHi(rt)) >>> 0;
            this.setReg64(rd, hi, lo);
            return;
          }
          case 0x27: { // NOR rd, rs, rt (64-bit logical)
            const lo = (~(this.getReg(rs) | this.getReg(rt))) >>> 0;
            const hi = (~(this.getRegHi(rs) | this.getRegHi(rt))) >>> 0;
            this.setReg64(rd, hi, lo);
            return;
          }
          case 0x2a: { // SLT rd, rs, rt (signed 64-bit compare on GPR width)
            const aHi = this.getRegHi(rs) >>> 0, aLo = this.getReg(rs) >>> 0;
            const bHi = this.getRegHi(rt) >>> 0, bLo = this.getReg(rt) >>> 0;
            const aHiS = (aHi | 0), bHiS = (bHi | 0);
            let isLt = false;
            if (aHiS !== bHiS) {
              isLt = aHiS < bHiS;
            } else {
              isLt = (aLo >>> 0) < (bLo >>> 0);
            }
            this.setReg(rd, isLt ? 1 : 0);
            return;
          }
          case 0x2b: { // SLTU rd, rs, rt (unsigned 64-bit compare)
            const aHi = this.getRegHi(rs) >>> 0, aLo = this.getReg(rs) >>> 0;
            const bHi = this.getRegHi(rt) >>> 0, bLo = this.getReg(rt) >>> 0;
            let isLt = false;
            if (aHi !== bHi) {
              isLt = (aHi >>> 0) < (bHi >>> 0);
            } else {
              isLt = (aLo >>> 0) < (bLo >>> 0);
            }
            this.setReg(rd, isLt ? 1 : 0);
            return;
          }
          case 0x10: { // MFHI rd
            this.setReg(rd, this.hi);
            return;
          }
          case 0x12: { // MFLO rd
            this.setReg(rd, this.lo);
            return;
          }
          case 0x11: { // MTHI rs
            this.hi = this.getReg(rs);
            return;
          }
          case 0x13: { // MTLO rs
            this.lo = this.getReg(rs);
            return;
          }
          case 0x18: { // MULT rs, rt (signed)
            const { hi, lo } = mul64Signed(this.getReg(rs), this.getReg(rt));
            this.hi = hi; this.lo = lo;
            return;
          }
          case 0x19: { // MULTU rs, rt (unsigned)
            const { hi, lo } = mul64Unsigned(this.getReg(rs), this.getReg(rt));
            this.hi = hi; this.lo = lo;
            return;
          }
          case 0x1a: { // DIV rs, rt (signed)
            const { q, r } = div32Signed(this.getReg(rs), this.getReg(rt));
            this.lo = q; this.hi = r;
            return;
          }
          case 0x1b: { // DIVU rs, rt (unsigned)
            const { q, r } = div32Unsigned(this.getReg(rs), this.getReg(rt));
            this.lo = q; this.hi = r;
            return;
          }
          // 64-bit mult/div group (DMULT/DMULTU/DDIV/DDIVU) - modeled via 32-bit args
          case 0x1c: { // DMULT rs, rt (signed 64x64 -> 128, modeled from 32-bit inputs)
            const { hi, lo } = mul64Signed(this.getReg(rs), this.getReg(rt));
            this.hi = hi; this.lo = lo;
            return;
          }
          case 0x1d: { // DMULTU rs, rt (unsigned)
            const { hi, lo } = mul64Unsigned(this.getReg(rs), this.getReg(rt));
            this.hi = hi; this.lo = lo;
            return;
          }
          case 0x1e: { // DDIV rs, rt (signed) - modeled from 32-bit inputs
            const { q, r } = div32Signed(this.getReg(rs), this.getReg(rt));
            this.lo = q; this.hi = r;
            return;
          }
          case 0x1f: { // DDIVU rs, rt (unsigned)
            const { q, r } = div32Unsigned(this.getReg(rs), this.getReg(rt));
            this.lo = q; this.hi = r;
            return;
          }
          case 0x0c: { // SYSCALL
            throw new CPUException('Syscall', 0);
          }
          case 0x0d: { // BREAK
            throw new CPUException('Breakpoint', 0);
          }
          case 0x0f: { // SYNC (memory barrier)
            // R4300i treats SYNC as a memory ordering barrier; for our purposes, it's a NOP
            return;
          }
          // 64-bit shift group (MIPS64)
          case 0x14: { // DSLLV rd, rt, rs (variable, 0..63)
            const sa = (this.getReg(rs) & 0x3f) >>> 0;
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            let hiN = 0 >>> 0, loN = 0 >>> 0;
            if (sa === 0) { hiN = hi0; loN = lo0; }
            else if (sa < 32) {
              hiN = ((hi0 << sa) | (lo0 >>> (32 - sa))) >>> 0;
              loN = (lo0 << sa) >>> 0;
            } else if (sa < 64) {
              hiN = (lo0 << (sa - 32)) >>> 0;
              loN = 0 >>> 0;
            } else {
              hiN = 0 >>> 0; loN = 0 >>> 0;
            }
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x16: { // DSRLV rd, rt, rs (logical, variable 0..63)
            const sa = (this.getReg(rs) & 0x3f) >>> 0;
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            let hiN = 0 >>> 0, loN = 0 >>> 0;
            if (sa === 0) { hiN = hi0; loN = lo0; }
            else if (sa < 32) {
              loN = ((lo0 >>> sa) | (hi0 << (32 - sa))) >>> 0;
              hiN = (hi0 >>> sa) >>> 0;
            } else if (sa < 64) {
              loN = (hi0 >>> (sa - 32)) >>> 0;
              hiN = 0 >>> 0;
            } else {
              hiN = 0 >>> 0; loN = 0 >>> 0;
            }
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x17: { // DSRAV rd, rt, rs (arithmetic, variable 0..63)
            const sa = (this.getReg(rs) & 0x3f) >>> 0;
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            const hiSigned = (hi0 | 0);
            let hiN = 0 >>> 0, loN = 0 >>> 0;
            if (sa === 0) { hiN = hi0; loN = lo0; }
            else if (sa < 32) {
              loN = ((lo0 >>> sa) | ((hi0 << (32 - sa)) >>> 0)) >>> 0;
              hiN = (hiSigned >> sa) >>> 0;
            } else if (sa < 64) {
              loN = (hiSigned >> (sa - 32)) >>> 0;
              hiN = ((hi0 >>> 31) !== 0) ? 0xFFFFFFFF : 0x00000000;
            } else {
              loN = ((hi0 >>> 31) !== 0) ? 0xFFFFFFFF : 0x00000000;
              hiN = loN;
            }
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x38: { // DSLL rd, rt, shamt (0..31)
            const sa = shamt & 0x1f;
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            let hiN = 0 >>> 0, loN = 0 >>> 0;
            if (sa === 0) { hiN = hi0; loN = lo0; }
            else {
              hiN = ((hi0 << sa) | (lo0 >>> (32 - sa))) >>> 0;
              loN = (lo0 << sa) >>> 0;
            }
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x3a: { // DSRL rd, rt, shamt (logical, 0..31)
            const sa = shamt & 0x1f;
            const hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            let hiN = 0 >>> 0, loN = 0 >>> 0;
            if (sa === 0) { hiN = hi0; loN = lo0; }
            else {
              loN = ((lo0 >>> sa) | (hi0 << (32 - sa))) >>> 0;
              hiN = (hi0 >>> sa) >>> 0;
            }
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x3b: { // DSRA rd, rt, shamt (arithmetic, 0..31)
            const sa = shamt & 0x1f;
            let hi0 = this.getRegHi(rt) >>> 0;
            const lo0 = this.getReg(rt) >>> 0;
            let hiN = 0 >>> 0, loN = 0 >>> 0;
            if (sa === 0) { hiN = hi0; loN = lo0; }
            else {
              const hiSigned = (hi0 | 0);
              loN = ((lo0 >>> sa) | ((hi0 << (32 - sa)) >>> 0)) >>> 0;
              hiN = (hiSigned >> sa) >>> 0;
            }
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x3c: { // DSLL32 rd, rt, shamt (shifts left by 32+sa)
            const sa = shamt & 0x1f;
            const lo0 = this.getReg(rt) >>> 0;
            const hiN = (lo0 << sa) >>> 0;
            const loN = 0 >>> 0;
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x3e: { // DSRL32 rd, rt, shamt (logical right by 32+sa)
            const sa = shamt & 0x1f;
            const hi0 = this.getRegHi(rt) >>> 0;
            const loN = (hi0 >>> sa) >>> 0;
            const hiN = 0 >>> 0;
            this.setReg64(rd, hiN, loN);
            return;
          }
          case 0x3f: { // DSRA32 rd, rt, shamt (arith right by 32+sa)
            const sa = shamt & 0x1f;
            const hi0 = this.getRegHi(rt) >>> 0;
            const hiSigned = (hi0 | 0);
            const loN = (hiSigned >> sa) >>> 0;
            const hiN = ((hi0 >>> 31) !== 0) ? 0xFFFFFFFF : 0x00000000;
            this.setReg64(rd, hiN, loN);
            return;
          }
          default:
            // Unknown SPECIAL funct
            this.warnDecode('special_reserved', `special_funct_0x${funct.toString(16)}`, { funct: funct >>> 0 });
            // Treat unknown R-type as ReservedInstruction (or skip in fastboot)
            if (this.fastbootSkipReserved) return;
            throw new CPUException('ReservedInstruction', this.pc >>> 0);
        }
      }
      case 0x02: { // J target
        const target = ((this.pc & 0xf0000000) | ((instr & 0x03ffffff) << 2)) >>> 0;
        this.branchTarget = target;
        this.branchPending = true;
        this.branchPC = ((this.pc - 4) >>> 0);
        return;
      }
      case 0x03: { // JAL target
        const link = (this.pc + 4) >>> 0; // address after delay slot
        this.setReg(31, link);
        const target = ((this.pc & 0xf0000000) | ((instr & 0x03ffffff) << 2)) >>> 0;
        this.branchTarget = target;
        this.branchPending = true;
        this.branchPC = ((this.pc - 4) >>> 0);
        return;
      }
      case 0x04: { // BEQ rs, rt, offset (64-bit compare)
        const eq = (this.getReg(rs) === this.getReg(rt)) && (this.getRegHi(rs) === this.getRegHi(rt));
        if (eq) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      case 0x05: { // BNE rs, rt, offset (64-bit compare)
        const ne = (this.getReg(rs) !== this.getReg(rt)) || (this.getRegHi(rs) !== this.getRegHi(rt));
        if (ne) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      case 0x06: { // BLEZ rs, offset (signed 64-bit)
        const hi = this.getRegHi(rs) >>> 0; const lo = this.getReg(rs) >>> 0;
        const isNeg = ((hi >>> 31) !== 0);
        const isZero = (hi === 0 && lo === 0);
        if (isNeg || isZero) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      case 0x07: { // BGTZ rs, offset (signed 64-bit)
        const hi = this.getRegHi(rs) >>> 0; const lo = this.getReg(rs) >>> 0;
        const isNeg = ((hi >>> 31) !== 0);
        const isZero = (hi === 0 && lo === 0);
        if (!isNeg && !isZero) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      // Branch-likely variants: execute delay slot only when branch is taken; otherwise skip the delay slot
      case 0x14: { // BEQL rs, rt, offset (64-bit compare)
        const eq = (this.getReg(rs) === this.getReg(rt)) && (this.getRegHi(rs) === this.getRegHi(rt));
        if (eq) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          // Skip delay slot
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x15: { // BNEL rs, rt, offset (64-bit compare)
        const ne = (this.getReg(rs) !== this.getReg(rt)) || (this.getRegHi(rs) !== this.getRegHi(rt));
        if (ne) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x16: { // BLEZL rs, offset (signed 64-bit)
        const hi = this.getRegHi(rs) >>> 0; const lo = this.getReg(rs) >>> 0;
        const isNeg = ((hi >>> 31) !== 0);
        const isZero = (hi === 0 && lo === 0);
        if (isNeg || isZero) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x17: { // BGTZL rs, offset (signed 64-bit)
        const hi = this.getRegHi(rs) >>> 0; const lo = this.getReg(rs) >>> 0;
        const isNeg = ((hi >>> 31) !== 0);
        const isZero = (hi === 0 && lo === 0);
        if (!isNeg && !isZero) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x01: { // REGIMM
        const rtField = rt;
        const hi = this.getRegHi(rs) >>> 0; const lo = this.getReg(rs) >>> 0;
        const isNeg = ((hi >>> 31) !== 0);
        const isZero = (hi === 0 && lo === 0);
        const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
        const linkAddr = (this.pc + 4) >>> 0;
        switch (rtField) {
          case 0x00: // BLTZ (signed 64-bit)
            if (isNeg) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x01: // BGEZ (signed 64-bit)
            if (!isNeg) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x02: // BLTZL (likely)
            if (isNeg) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.pc = (this.pc + 4) >>> 0; this.branchPending = false; }
            return;
          case 0x03: // BGEZL (likely)
            if (!isNeg) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.pc = (this.pc + 4) >>> 0; this.branchPending = false; }
            return;
          case 0x10: // BLTZAL
            if (isNeg) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x11: // BGEZAL
            if (!isNeg) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x12: // BLTZALL (likely)
            if (isNeg) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.branchPending = false; this.pc = (this.pc + 4) >>> 0; }
            return;
          case 0x13: // BGEZALL (likely)
            if (!isNeg) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.branchPending = false; this.pc = (this.pc + 4) >>> 0; }
            return;
          case 0x08: { // TGEI rs, imm (signed)
            const rsS = (this.getReg(rs) | 0);
            const immS = (signExtend16(imm) | 0);
            if (rsS >= immS) {
              if (this.fastbootSkipReserved) { this.warnDecode('trap_suppressed', 'tgei', { rs: rs >>> 0, imm: immS }); }
              else { this.warnDecode('trap_taken', 'tgei', { rs: rs >>> 0, imm: immS }); throw new CPUException('Trap', 0); }
            }
            return;
          }
          case 0x09: { // TGEIU rs, imm (unsigned)
            const rsU = (this.getReg(rs) >>> 0);
            const immU = (signExtend16(imm) >>> 0);
            if (rsU >= immU) {
              if (this.fastbootSkipReserved) { this.warnDecode('trap_suppressed', 'tgeiu', { rs: rs >>> 0, imm: immU }); }
              else { this.warnDecode('trap_taken', 'tgeiu', { rs: rs >>> 0, imm: immU }); throw new CPUException('Trap', 0); }
            }
            return;
          }
          case 0x0a: { // TLTI rs, imm (signed)
            const rsS = (this.getReg(rs) | 0);
            const immS = (signExtend16(imm) | 0);
            if (rsS < immS) {
              if (this.fastbootSkipReserved) { this.warnDecode('trap_suppressed', 'tlti', { rs: rs >>> 0, imm: immS }); }
              else { this.warnDecode('trap_taken', 'tlti', { rs: rs >>> 0, imm: immS }); throw new CPUException('Trap', 0); }
            }
            return;
          }
          case 0x0b: { // TLTIU rs, imm (unsigned)
            const rsU = (this.getReg(rs) >>> 0);
            const immU = (signExtend16(imm) >>> 0);
            if (rsU < immU) {
              if (this.fastbootSkipReserved) { this.warnDecode('trap_suppressed', 'tltiu', { rs: rs >>> 0, imm: immU }); }
              else { this.warnDecode('trap_taken', 'tltiu', { rs: rs >>> 0, imm: immU }); throw new CPUException('Trap', 0); }
            }
            return;
          }
          case 0x0c: { // TEQI rs, imm
            const rsS = (this.getReg(rs) | 0);
            const immS = (signExtend16(imm) | 0);
            if (rsS === immS) {
              if (this.fastbootSkipReserved) { this.warnDecode('trap_suppressed', 'teqi', { rs: rs >>> 0, imm: immS }); }
              else { this.warnDecode('trap_taken', 'teqi', { rs: rs >>> 0, imm: immS }); throw new CPUException('Trap', 0); }
            }
            return;
          }
          case 0x0e: { // TNEI rs, imm
            const rsS = (this.getReg(rs) | 0);
            const immS = (signExtend16(imm) | 0);
            if (rsS !== immS) {
              if (this.fastbootSkipReserved) { this.warnDecode('trap_suppressed', 'tnei', { rs: rs >>> 0, imm: immS }); }
              else { this.warnDecode('trap_taken', 'tnei', { rs: rs >>> 0, imm: immS }); throw new CPUException('Trap', 0); }
            }
            return;
          }
          default:
            // Unknown REGIMM variant
            this.warnDecode('regimm_unknown_rt', `regimm_rt_0x${rtField.toString(16)}`, { rt: rtField >>> 0 });
            // Treat unknown REGIMM variant as ReservedInstruction (or skip in fastboot)
            if (this.fastbootSkipReserved) return;
            throw new CPUException('ReservedInstruction', this.pc >>> 0);
        }
      }
      case 0x0c: { // ANDI rt, rs, imm (64-bit logical with zero-extended imm)
        const immZ = (imm & 0xffff) >>> 0;
        const lo = (this.getReg(rs) & immZ) >>> 0;
        const hi = 0 >>> 0; // upper 48/32 bits AND 0 -> 0
        this.setReg64(rt, hi, lo);
        return;
      }
      case 0x0d: { // ORI rt, rs, imm (64-bit logical with zero-extended imm)
        const immZ = (imm & 0xffff) >>> 0;
        const lo = (this.getReg(rs) | immZ) >>> 0;
        const hi = this.getRegHi(rs) >>> 0; // OR with 0 leaves hi unchanged
        this.setReg64(rt, hi, lo);
        return;
      }
      case 0x0e: { // XORI rt, rs, imm (64-bit logical with zero-extended imm)
        const immZ = (imm & 0xffff) >>> 0;
        const lo = (this.getReg(rs) ^ immZ) >>> 0;
        const hi = this.getRegHi(rs) >>> 0; // XOR with 0 leaves hi unchanged
        this.setReg64(rt, hi, lo);
        return;
      }
      case 0x0a: { // SLTI rt, rs, imm (signed)
        const a = (this.getReg(rs) | 0);
        const b = (signExtend16(imm) | 0);
        this.setReg(rt, a < b ? 1 : 0);
        return;
      }
      case 0x0b: { // SLTIU rt, rs, imm (unsigned compares on zero-extended)
        const a = this.getReg(rs) >>> 0;
        const b = (signExtend16(imm) >>> 0);
        this.setReg(rt, a < b ? 1 : 0);
        return;
      }
      case 0x08: { // ADDI rt, rs, imm (trap on overflow)
        const a = (this.getReg(rs) | 0);
        const b = (signExtend16(imm) | 0);
        const r = (a + b) | 0;
        if (((a ^ r) & (b ^ r)) < 0) {
          throw new CPUException('Overflow', this.pc >>> 0);
        }
        this.setReg(rt, r >>> 0);
        return;
      }
      case 0x09: { // ADDIU rt, rs, imm
        const res = (this.getReg(rs) + (signExtend16(imm) >>> 0)) >>> 0;
        this.setReg(rt, res);
        return;
      }
      case 0x20: { // LB rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        const b = this.loadU8TLB(addr);
        this.setReg(rt, signExtend8(b));
        return;
      }
      case 0x24: { // LBU rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        const b = this.loadU8TLB(addr);
        this.setReg(rt, b & 0xff);
        return;
      }
      case 0x21: { // LH rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 2, false);
        const h = this.loadU16TLB(addr);
        // sign extend 16
        this.setReg(rt, signExtend16(h));
        return;
      }
      case 0x25: { // LHU rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 2, false);
        const h = this.loadU16TLB(addr);
        this.setReg(rt, h & 0xffff);
        return;
      }
      case 0x22: { // LWL rt, offset(base) - big-endian per-byte semantics
        const addr = this.addrCalc(rs, imm);
        const aligned = addr & ~3;
        const k = addr & 3;
        const old = this.getReg(rt);
        const m0 = this.loadU8TLB(aligned + 0);
        const m1 = this.loadU8TLB(aligned + 1);
        const m2 = this.loadU8TLB(aligned + 2);
        const m3 = this.loadU8TLB(aligned + 3);
        let b0 = (old >>> 24) & 0xff;
        let b1 = (old >>> 16) & 0xff;
        let b2 = (old >>> 8) & 0xff;
        let b3 = old & 0xff;
        // Load left bytes from m0..mk (k=0 -> all four; k=3 -> only b0)
        b0 = m0;
        if (k <= 2) b1 = m1;
        if (k <= 1) b2 = m2;
        if (k <= 0) b3 = m3;
        const v = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
        this.setReg(rt, v);
        return;
      }
      case 0x23: { // LW rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 4, false);
        const w = this.loadU32TLB(addr);
        this.setReg(rt, w);
        return;
      }
      case 0x27: { // LWU rt, offset(base) - zero-extend 32-bit word into 64-bit GPR
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 4, false);
        const w = this.loadU32TLB(addr) >>> 0;
        this.setReg64(rt, 0 >>> 0, w);
        return;
      }
      case 0x26: { // LWR rt, offset(base) - big-endian per-byte semantics
        const addr = this.addrCalc(rs, imm);
        const aligned = addr & ~3;
        const k = addr & 3;
        const old = this.getReg(rt);
        const m0 = this.loadU8TLB(aligned + 0);
        const m1 = this.loadU8TLB(aligned + 1);
        const m2 = this.loadU8TLB(aligned + 2);
        const m3 = this.loadU8TLB(aligned + 3);
        let b0 = (old >>> 24) & 0xff;
        let b1 = (old >>> 16) & 0xff;
        let b2 = (old >>> 8) & 0xff;
        let b3 = old & 0xff;
        // Load right bytes from mk..m3 (k=0 -> only b3; k=3 -> all four)
        b3 = m3;
        if (k >= 1) b2 = m2;
        if (k >= 2) b1 = m1;
        if (k >= 3) b0 = m0;
        const v = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
        this.setReg(rt, v);
        return;
      }
      case 0x28: { // SB rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        const v = this.getReg(rt) & 0xff;
        this.storeU8TLB(addr, v);
        return;
      }
      case 0x29: { // SH rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 2, true);
        const v = this.getReg(rt) & 0xffff;
        this.storeU16TLB(addr, v);
        return;
      }
      case 0x2a: { // SWL rt, offset(base) - big-endian per-byte semantics
        const addr = this.addrCalc(rs, imm);
        const aligned = addr & ~3;
        const k = addr & 3;
        const v = this.getReg(rt);
        const b0 = (v >>> 24) & 0xff;
        const b1 = (v >>> 16) & 0xff;
        const b2 = (v >>> 8) & 0xff;
        const b3 = v & 0xff;
        // store left bytes m0..mk (k=0 -> all four; k=3 -> only offset 0)
        this.storeU8TLB(aligned + 0, b0);
        if (k <= 2) this.storeU8TLB(aligned + 1, b1);
        if (k <= 1) this.storeU8TLB(aligned + 2, b2);
        if (k <= 0) this.storeU8TLB(aligned + 3, b3);
        return;
      }
      case 0x2b: { // SW rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 4, true);
        const v = this.getReg(rt);
        this.storeU32TLB(addr, v);
       return;
      }
      case 0x2e: { // SWR rt, offset(base) - big-endian per-byte semantics
        const addr = this.addrCalc(rs, imm);
        const aligned = addr & ~3;
        const k = addr & 3;
        const v = this.getReg(rt);
        const b0 = (v >>> 24) & 0xff;
        const b1 = (v >>> 16) & 0xff;
        const b2 = (v >>> 8) & 0xff;
        const b3 = v & 0xff;
        // store right bytes mk..m3 (k=0 -> offset 3 only; k=3 -> all four)
        if (k >= 3) this.storeU8TLB(aligned + 0, b0);
        if (k >= 2) this.storeU8TLB(aligned + 1, b1);
        if (k >= 1) this.storeU8TLB(aligned + 2, b2);
        this.storeU8TLB(aligned + 3, b3);
        return;
      }
      case 0x0f: { // LUI rt, imm
        this.setReg(rt, (imm << 16) >>> 0);
        return;
      }
      case 0x31: { // LWC1 ft, offset(base)
        const addr = this.addrCalc(rs, imm);
        // ft encoded in rt field
        const v = this.loadU32TLB(addr);
        if ((rt >>> 0) < 32) this.fpr[rt] = v >>> 0;
        return;
      }
      case 0x35: { // LDC1 ft, offset(base) - load 64-bit into ft(ft+1)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7;
        const b0 = this.loadU8TLB(p + 0) & 0xff;
        const b1 = this.loadU8TLB(p + 1) & 0xff;
        const b2 = this.loadU8TLB(p + 2) & 0xff;
        const b3 = this.loadU8TLB(p + 3) & 0xff;
        const b4 = this.loadU8TLB(p + 4) & 0xff;
        const b5 = this.loadU8TLB(p + 5) & 0xff;
        const b6 = this.loadU8TLB(p + 6) & 0xff;
        const b7 = this.loadU8TLB(p + 7) & 0xff;
        const hi = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
        const lo = ((b4 << 24) | (b5 << 16) | (b6 << 8) | b7) >>> 0;
        const ft = rt >>> 0;
        if (ft < 32) {
          this.fpr[ft] = hi >>> 0;
          if ((ft + 1) < 32) this.fpr[ft + 1] = lo >>> 0;
        }
        return;
      }
      case 0x39: { // SWC1 ft, offset(base)
        const addr = this.addrCalc(rs, imm);
        const v = (rt >>> 0) < 32 ? ((this.fpr[rt] ?? 0) >>> 0) : 0;
        this.storeU32TLB(addr, v >>> 0);
        return;
      }
      case 0x3d: { // SDC1 ft, offset(base) - store 64-bit from ft(ft+1)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7;
        const ft = rt >>> 0;
        const hi = (ft < 32) ? ((this.fpr[ft] ?? 0) >>> 0) : 0;
        const lo = ((ft + 1) < 32) ? ((this.fpr[ft + 1] ?? 0) >>> 0) : 0;
        this.storeU8TLB(p + 0, (hi >>> 24) & 0xff);
        this.storeU8TLB(p + 1, (hi >>> 16) & 0xff);
        this.storeU8TLB(p + 2, (hi >>> 8) & 0xff);
        this.storeU8TLB(p + 3, hi & 0xff);
        this.storeU8TLB(p + 4, (lo >>> 24) & 0xff);
        this.storeU8TLB(p + 5, (lo >>> 16) & 0xff);
        this.storeU8TLB(p + 6, (lo >>> 8) & 0xff);
        this.storeU8TLB(p + 7, lo & 0xff);
        return;
      }
      case 0x11: { // COP1
        const rsField = rs; // per MIPS enc, this is fmt/control selector
        // Control transfers and branch-on-c1 implement minimal semantics; arithmetic is NOP
        switch (rsField) {
          case 0x00: { // MFC1 rt, fs (move from FPR)
            const fs = rd;
            const val = (fs >>> 0) < 32 ? ((this.fpr[fs] ?? 0) >>> 0) : 0;
            this.setReg(rt, val >>> 0);
            return;
          }
          case 0x02: { // CFC1 rt, fs (move from FCR)
            // Only FCR31 supported; encode rd as control reg index; return 0 for others
            const ctrl = rd >>> 0;
            const val = ctrl === 31 ? (this.fcr31 >>> 0) : 0;
            this.setReg(rt, val >>> 0);
            return;
          }
          case 0x04: { // MTC1 rt, fs (move to FPR)
            const fs = rd;
            if ((fs >>> 0) < 32) this.fpr[fs] = this.getReg(rt) >>> 0;
            return;
          }
          case 0x06: { // CTC1 rt, fs (move to FCR)
            const ctrl = rd >>> 0;
            if (ctrl === 31) {
              this.fcr31 = this.getReg(rt) >>> 0;
            }
            return;
          }
          case 0x08: { // BC1* (branch on FP condition)
            const cond = ((this.fcr31 >>> 23) & 1) !== 0; // bit 23 is condition flag
            const takeF = !cond;
            const takeT = cond;
            const target = (this.pc + targetOffset) >>> 0;
            // rt encodes branch variant
            switch (rt >>> 0) {
              case 0x00: { // BC1F offset
                if (takeF) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else { this.branchPending = false; }
                return;
              }
              case 0x01: { // BC1T offset
                if (takeT) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else { this.branchPending = false; }
                return;
              }
              case 0x02: { // BC1FL offset (branch likely false)
                if (takeF) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
                else { this.pc = (this.pc + 4) >>> 0; this.branchPending = false; }
                return;
              }
              case 0x03: { // BC1TL offset (branch likely true)
                if (takeT) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
                else { this.pc = (this.pc + 4) >>> 0; this.branchPending = false; }
                return;
              }
              default:
                // Unsupported variant: warn once, then treat as not taken
                this.warnDecode('cop1_bc1_unknown_rt', `cop1_bc1_rt_0x${(rt>>>0).toString(16)}`, { rt: rt >>> 0 });
                this.branchPending = false; return;
            }
          }
          default:
            // Warn once about unhandled COP1 group, then treat as NOP to allow progression during boot
            this.warnDecode('cop1_unhandled_rs', `cop1_rs_0x${rsField.toString(16)}`, { rs: rsField >>> 0 });
            return;
        }
      }
      case 0x10: { // COP0
        const rsField = rs;
        const rdField = rd;
        switch (rsField) {
          case 0x00: // MFC0 rt, rd
            this.setReg(rt, this.cop0.read(rdField));
            return;
          case 0x04: // MTC0 rt, rd
            this.cop0.write(rdField, this.getReg(rt));
            return;
          case 0x10: { // COP0 function group (TLB ops, ERET, etc.)
            const functField = instr & 0x3f;
            if (functField === 0x18) { // ERET
              // If not in exception level, raise reserved instruction
              const status0 = this.cop0.read(12) >>> 0;
              if ((status0 & Cop0.STATUS_EXL) === 0) {
                throw new CPUException('ReservedInstruction', 0);
              }
              // Clear EXL, set PC to EPC
              this.cop0.write(12, (status0 & ~Cop0.STATUS_EXL) >>> 0);
              const epc = this.cop0.read(14) >>> 0;
              // On ERET, discard any branch-pending state
              this.branchPending = false;
              this.branchCommitPending = false;
              this.pc = epc >>> 0;
              return;
            }
            // Implement TLB ops
            switch (functField) {
              case 0x01: { // TLBR - read indexed entry into CP0 regs
                const idx = (this.cop0.read(0) >>> 0) & 0x3f;
                const e = this.tlb[idx % CPU.TLB_SIZE]!;
                // Assemble EntryHi, EntryLo0/1, PageMask
                const entryHi = (((e.vpn2 << 13) >>> 0) | (e.asid & 0xff)) >>> 0;
                this.cop0.write(10, entryHi);
                const loBits = (pfn: number, v: boolean, d: boolean, g: boolean) => (((pfn & 0xFFFFF) << 6) | ((0 /*C*/ & 0x7) << 3) | ((d?1:0) << 2) | ((v?1:0) << 1) | (g?1:0)) >>> 0;
                this.cop0.write(2, loBits(e.pfn0, e.v0, e.d0, e.g));
                this.cop0.write(3, loBits(e.pfn1, e.v1, e.d1, e.g));
                this.cop0.write(5, e.mask >>> 0);
                return;
              }
              case 0x02: { // TLBWI - write indexed entry from CP0 regs
                const idx = (this.cop0.read(0) >>> 0) & 0x3f;
                this.writeTLBEntry(idx % CPU.TLB_SIZE);
                return;
              }
              case 0x06: { // TLBWR - write random entry
                const idx = this.tlbRandom % CPU.TLB_SIZE;
                this.writeTLBEntry(idx);
                return;
              }
              case 0x08: { // TLBP - probe, set Index to match or high bit if not found
                const hi = this.cop0.read(10) >>> 0;
                const asid = hi & 0xff;
                const probeVA = (((hi >>> 13) << 13) >>> 0);
                let found = -1;
                for (let i = 0; i < CPU.TLB_SIZE; i++) {
                  const e = this.tlb[i]!;
                  if (!(e.g || e.asid === asid)) continue;
                  const xorTag = ((probeVA ^ ((e.vpn2 << 13) >>> 0)) >>> 0);
                  const tagMask = (~((e.mask | 0x1FFF) >>> 0)) >>> 0;
                  if ((xorTag & tagMask) === 0) { found = i; break; }
                }
                if (found >= 0) this.cop0.write(0, found >>> 0);
                else this.cop0.write(0, (1 << 31) >>> 0);
                return;
              }
          default:
            // Stubs for other COP0 function ops
            return;
          }
        }
        default:
          // Unknown COP0 rs group
          this.warnDecode('cop0_unknown_rs', `cop0_rs_0x${rsField.toString(16)}`, { rs: rsField >>> 0 });
          // Treat unimplemented COP0 variants as ReservedInstruction (or skip in fastboot)
          if (this.fastbootSkipReserved) return;
          throw new CPUException('ReservedInstruction', this.pc >>> 0);
      }
    }
      case 0x18: { // DADDI rt, rs, imm (64-bit add immediate with overflow)
        const aHi = this.getRegHi(rs) >>> 0; const aLo = this.getReg(rs) >>> 0;
        const immS = signExtend16(imm) >>> 0; // as unsigned 32, but sign encoded via hiB
        const bHi = ((immS >>> 15) & 1) !== 0 ? 0xFFFFFFFF >>> 0 : 0x00000000 >>> 0; // sign-extended to 64
        const bLo = immS >>> 0;
        const lo = (aLo + bLo) >>> 0;
        const carry = (lo < aLo) ? 1 : 0;
        const hi = (aHi + bHi + carry) >>> 0;
        // Signed overflow detection for 64-bit: if signs of operands equal and differ from result
        const aSign = (aHi >>> 31) & 1; const bSign = (bHi >>> 31) & 1; const rSign = (hi >>> 31) & 1;
        if (aSign === bSign && rSign !== aSign) {
          throw new CPUException('Overflow', this.pc >>> 0);
        }
        this.setReg64(rt, hi, lo);
        return;
      }
      case 0x19: { // DADDIU rt, rs, imm (64-bit add immediate unsigned)
        const aHi = this.getRegHi(rs) >>> 0; const aLo = this.getReg(rs) >>> 0;
        const immS = signExtend16(imm) >>> 0;
        const bHi = ((immS >>> 15) & 1) !== 0 ? 0xFFFFFFFF >>> 0 : 0x00000000 >>> 0;
        const bLo = immS >>> 0;
        const lo = (aLo + bLo) >>> 0;
        const carry = (lo < aLo) ? 1 : 0;
        const hi = (aHi + bHi + carry) >>> 0;
        this.setReg64(rt, hi, lo);
        return;
      }
      case 0x1a: { // LDL rt, offset(base) - big-endian 64-bit partial load (left)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7; const k = addr & 7;
        // Merge into existing 64-bit register
        let hi = this.getRegHi(rt) >>> 0;
        let lo = this.getReg(rt) >>> 0;
        const bytes = new Uint8Array(8);
        // compose current value into bytes 0..7 (big-endian)
        bytes[0] = (hi >>> 24) & 0xff; bytes[1] = (hi >>> 16) & 0xff; bytes[2] = (hi >>> 8) & 0xff; bytes[3] = hi & 0xff;
        bytes[4] = (lo >>> 24) & 0xff; bytes[5] = (lo >>> 16) & 0xff; bytes[6] = (lo >>> 8) & 0xff; bytes[7] = lo & 0xff;
        // replace left bytes 0..(7-k)
        for (let i = 0; i <= (7 - k); i++) bytes[i] = this.loadU8TLB(p + i) & 0xff;
        const hiN = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        const loN = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
        this.setReg64(rt, hiN, loN);
        return;
      }
      case 0x1b: { // LDR rt, offset(base) - big-endian 64-bit partial load (right)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7; const k = addr & 7;
        let hi = this.getRegHi(rt) >>> 0;
        let lo = this.getReg(rt) >>> 0;
        const bytes = new Uint8Array(8);
        bytes[0] = (hi >>> 24) & 0xff; bytes[1] = (hi >>> 16) & 0xff; bytes[2] = (hi >>> 8) & 0xff; bytes[3] = hi & 0xff;
        bytes[4] = (lo >>> 24) & 0xff; bytes[5] = (lo >>> 16) & 0xff; bytes[6] = (lo >>> 8) & 0xff; bytes[7] = lo & 0xff;
        for (let i = k; i < 8; i++) bytes[i] = this.loadU8TLB(p + i) & 0xff;
        const hiN = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        const loN = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
        this.setReg64(rt, hiN, loN);
        return;
      }
      case 0x2f: { // CACHE - no-op
        return;
      }
      case 0x33: { // PREF - no-op
        return;
      }
      case 0x30: { // LL rt, offset(base) - load linked (modeled as LW + set link)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const v = this.loadU32TLB(addr);
        this.setReg(rt, v >>> 0);
        this.llValid = true; this.llAddr = addr & ~3;
        return;
      }
      case 0x38: { // SC rt, offset(base) - store conditional (modeled as SW + success=1 when linked)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const aligned = addr & ~3;
        const success = this.llValid && (aligned === this.llAddr);
        if (success) {
          const v = this.getReg(rt) >>> 0;
          this.storeU32TLB(addr, v);
          this.setReg(rt, 1);
        } else {
          this.setReg(rt, 0);
        }
        this.llValid = false;
        return;
      }
      case 0x3f: { // SD rt, offset(base) - store doubleword
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7;
        const hi = this.getRegHi(rt) >>> 0;
        const lo = this.getReg(rt) >>> 0;
        const b0 = (hi >>> 24) & 0xff, b1 = (hi >>> 16) & 0xff, b2 = (hi >>> 8) & 0xff, b3 = hi & 0xff;
        const b4 = (lo >>> 24) & 0xff, b5 = (lo >>> 16) & 0xff, b6 = (lo >>> 8) & 0xff, b7 = lo & 0xff;
        this.storeU8TLB(p + 0, b0); this.storeU8TLB(p + 1, b1); this.storeU8TLB(p + 2, b2); this.storeU8TLB(p + 3, b3);
        this.storeU8TLB(p + 4, b4); this.storeU8TLB(p + 5, b5); this.storeU8TLB(p + 6, b6); this.storeU8TLB(p + 7, b7);
        return;
      }
      case 0x37: { // LD rt, offset(base) - load doubleword
        const addr = this.addrCalc(rs, imm) >>> 0;
        this.checkAlign(addr, 8, false);
        const p = addr & ~7;
        const b0 = this.loadU8TLB(p + 0) & 0xff;
        const b1 = this.loadU8TLB(p + 1) & 0xff;
        const b2 = this.loadU8TLB(p + 2) & 0xff;
        const b3 = this.loadU8TLB(p + 3) & 0xff;
        const b4 = this.loadU8TLB(p + 4) & 0xff;
        const b5 = this.loadU8TLB(p + 5) & 0xff;
        const b6 = this.loadU8TLB(p + 6) & 0xff;
        const b7 = this.loadU8TLB(p + 7) & 0xff;
        const hi = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
        const lo = ((b4 << 24) | (b5 << 16) | (b6 << 8) | b7) >>> 0;
        this.setReg64(rt, hi, lo);
        return;
      }
      case 0x2c: { // SDL rt, offset(base) - store doubleword left (big-endian)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7; const k = addr & 7;
        const hi = this.getRegHi(rt) >>> 0; const lo = this.getReg(rt) >>> 0;
        const bytes = [ (hi>>>24)&0xff, (hi>>>16)&0xff, (hi>>>8)&0xff, hi&0xff, (lo>>>24)&0xff, (lo>>>16)&0xff, (lo>>>8)&0xff, lo&0xff ];
        for (let i = 0; i <= (7 - k); i++) this.storeU8TLB(p + i, (bytes[i] as number) & 0xff);
        this.invalidateLL(addr);
        return;
      }
      case 0x2d: { // SDR rt, offset(base) - store doubleword right (big-endian)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const p = addr & ~7; const k = addr & 7;
        const hi = this.getRegHi(rt) >>> 0; const lo = this.getReg(rt) >>> 0;
        const bytes = [ (hi>>>24)&0xff, (hi>>>16)&0xff, (hi>>>8)&0xff, hi&0xff, (lo>>>24)&0xff, (lo>>>16)&0xff, (lo>>>8)&0xff, lo&0xff ];
        for (let i = k; i < 8; i++) this.storeU8TLB(p + i, (bytes[i] as number) & 0xff);
        this.invalidateLL(addr);
        return;
      }
      default:
        // Unknown major opcode: warn once
        this.warnDecode('opcode_reserved', `op_0x${op.toString(16)}`, { op: op >>> 0 });
        // Unknown major opcode -> ReservedInstruction exception (or skip in fastboot)
        if (this.fastbootSkipReserved) return;
        throw new CPUException('ReservedInstruction', this.pc >>> 0);
    }
  }

  private invalidateLL(addr: number): void {
    const aligned = (addr >>> 0) & ~3;
    if (this.llValid && this.llAddr === aligned) this.llValid = false;
  }

  // Emit a one-shot decode warning by unique key
  private warnDecode(kind: string, uniqueKey: string, details?: any): void {
    if (this.decodeWarnedKeys.has(uniqueKey)) return;
    this.decodeWarnedKeys.add(uniqueKey);
    if (this.onDecodeWarn) {
      try {
        this.onDecodeWarn({ pc: this.lastInstrPC >>> 0, instr: this.lastInstrWord >>> 0, kind, details });
      } catch {}
    }
  }

  private writeTLBEntry(idx: number): void {
    const mask = this.cop0.read(5) >>> 0; // PageMask
    const entryHi = this.cop0.read(10) >>> 0;
    const lo0 = this.cop0.read(2) >>> 0;
    const lo1 = this.cop0.read(3) >>> 0;
    const vpn2 = (entryHi >>> 13) >>> 0;
    const asid = entryHi & 0xff;
    const decodeLo = (lo: number) => {
      const pfn = (lo >>> 6) & 0xFFFFF;
      const c = (lo >>> 3) & 0x7; // unused
      const d = ((lo >>> 2) & 1) !== 0;
      const v = ((lo >>> 1) & 1) !== 0;
      const g = (lo & 1) !== 0;
      return { pfn, c, d, v, g };
    };
    const a0 = decodeLo(lo0);
    const a1 = decodeLo(lo1);
    const g = a0.g && a1.g;
    const e = this.tlb[idx]!;
    e.mask = mask >>> 0; e.vpn2 = vpn2 >>> 0; e.asid = asid >>> 0; e.g = g;
    e.pfn0 = a0.pfn >>> 0; e.pfn1 = a1.pfn >>> 0; e.v0 = a0.v; e.d0 = a0.d; e.v1 = a1.v; e.d1 = a1.d;
  }
}

