import { signExtend16, signExtend8, toUint32, mul64Signed, mul64Unsigned, div32Signed, div32Unsigned } from '../utils/bit.js';
import { Bus } from '../mem/bus.js';
import { CPUException } from './exceptions.js';
import { Cop0 } from './cop0.js';

export class CPU {
  readonly regs = new Uint32Array(32);
  // Minimal COP1 (FPU) register file stub
  readonly fpr = new Uint32Array(32);
  fcr31 = 0 >>> 0; // control/status; bit 23 = condition flag
  hi = 0 >>> 0;
  lo = 0 >>> 0;
  pc = 0 >>> 0;
  inDelaySlot = false;

  // Minimal CP0 for exception state
  readonly cop0 = new Cop0();

  // Branch delay management
  private branchPending = false; // delay slot to execute
  private branchCommitPending = false; // delay slot executed, branch commit pending at boundary
  private branchTarget = 0 >>> 0;
  private branchPC = 0 >>> 0; // address of branch instruction (for EPC when BD)

  // Minimal LL/SC state
  private llValid = false;
  private llAddr = 0 >>> 0;

  constructor(public readonly bus: Bus) {
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
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
    this.regs[i] = toUint32(value);
  }

  step(): void {
    // Advance CP0 timer
    this.cop0.tick();

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
      const delayInstr = this.bus.loadU32(delayInstrPC);
      const afterDelay = (delayInstrPC + 4) >>> 0;
      const target = this.branchTarget >>> 0;
      // Execute delay slot with BD semantics
      this.pc = afterDelay;
      this.inDelaySlot = true;
      try {
        this.execute(delayInstr);
      } catch (e) {
        if (e instanceof CPUException) {
          this.enterException(e, branchInstrPC, e.code.startsWith('AddressError') ? e.badVAddr : null, true);
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

    const instr = this.bus.loadU32(instrPC);
    this.pc = (instrPC + 4) >>> 0;
    try {
      this.execute(instr);
    } catch (e) {
      if (e instanceof CPUException) {
        this.enterException(e, instrPC, e.code.startsWith('AddressError') ? e.badVAddr : null, false);
      } else {
        throw e;
      }
    }
    this.regs[0] = 0; // enforce $zero
  }

  private addrCalc(baseReg: number, imm: number): number {
    return (this.getReg(baseReg) + (signExtend16(imm) >>> 0)) >>> 0;
  }

  private checkAlign(addr: number, align: number, isStore: boolean): void {
    if ((addr & (align - 1)) !== 0) {
      throw new CPUException(isStore ? 'AddressErrorStore' : 'AddressErrorLoad', addr >>> 0);
    }
  }

  private enterException(ex: CPUException, faultingPC: number, badVAddr: number | null, inDelaySlot: boolean): void {
    const excMap: Record<string, number> = {
      AddressErrorLoad: 4,
      AddressErrorStore: 5,
      Overflow: 12,
      Interrupt: 0,
      Syscall: 8,
      Breakpoint: 9,
      ReservedInstruction: 10,
    };
    const code = excMap[ex.code] ?? 0;
    this.cop0.setException(code, faultingPC >>> 0, badVAddr, inDelaySlot);
    // Vector selection: BEV bit selects 0xBFC00180, else 0x80000180
    const status = this.cop0.read(12);
    const bev = (status >>> 22) & 1;
    this.pc = bev ? 0xBFC00180 >>> 0 : 0x80000180 >>> 0;
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
          case 0x03: { // SRA rd, rt, shamt
            const v = (this.getReg(rt) >> shamt) >>> 0;
            this.setReg(rd, v);
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
          case 0x07: { // SRAV rd, rt, rs
            const sa = (this.getReg(rs) & 0x1f) >>> 0;
            const v = (this.getReg(rt) >> sa) >>> 0;
            this.setReg(rd, v);
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
          case 0x24: { // AND rd, rs, rt
            const v = (this.getReg(rs) & this.getReg(rt)) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x25: { // OR rd, rs, rt
            const v = (this.getReg(rs) | this.getReg(rt)) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x26: { // XOR rd, rs, rt
            const v = (this.getReg(rs) ^ this.getReg(rt)) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x27: { // NOR rd, rs, rt
            const v = (~(this.getReg(rs) | this.getReg(rt))) >>> 0;
            this.setReg(rd, v);
            return;
          }
          case 0x2a: { // SLT rd, rs, rt (signed)
            const a = (this.getReg(rs) | 0);
            const b = (this.getReg(rt) | 0);
            this.setReg(rd, a < b ? 1 : 0);
            return;
          }
          case 0x2b: { // SLTU rd, rs, rt (unsigned)
            const a = this.getReg(rs) >>> 0;
            const b = this.getReg(rt) >>> 0;
            this.setReg(rd, a < b ? 1 : 0);
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
          default:
            throw new Error(`Unimplemented R-type funct=0x${funct.toString(16)}`);
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
      case 0x04: { // BEQ rs, rt, offset
        if (this.getReg(rs) === this.getReg(rt)) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      case 0x05: { // BNE rs, rt, offset
        if (this.getReg(rs) !== this.getReg(rt)) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      case 0x06: { // BLEZ rs, offset (signed)
        if ((this.getReg(rs) | 0) <= 0) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target;
          this.branchPending = true;
          this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.branchPending = false;
        }
        return;
      }
      case 0x07: { // BGTZ rs, offset (signed)
        if ((this.getReg(rs) | 0) > 0) {
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
      case 0x14: { // BEQL rs, rt, offset
        if (this.getReg(rs) === this.getReg(rt)) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          // Skip delay slot
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x15: { // BNEL rs, rt, offset
        if (this.getReg(rs) !== this.getReg(rt)) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x16: { // BLEZL rs, offset (signed)
        if ((this.getReg(rs) | 0) <= 0) {
          const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
          this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0);
        } else {
          this.pc = (this.pc + 4) >>> 0;
          this.branchPending = false;
        }
        return;
      }
      case 0x17: { // BGTZL rs, offset (signed)
        if ((this.getReg(rs) | 0) > 0) {
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
        const rsValSigned = this.getReg(rs) | 0;
        const target = (this.pc + ((signExtend16(imm) << 2) >>> 0)) >>> 0;
        const linkAddr = (this.pc + 4) >>> 0;
        switch (rtField) {
          case 0x00: // BLTZ
            if (rsValSigned < 0) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x01: // BGEZ
            if (rsValSigned >= 0) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x02: // BLTZL
            if (rsValSigned < 0) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.pc = (this.pc + 4) >>> 0; this.branchPending = false; }
            return;
          case 0x03: // BGEZL
            if (rsValSigned >= 0) { this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.pc = (this.pc + 4) >>> 0; this.branchPending = false; }
            return;
          case 0x10: // BLTZAL
            if (rsValSigned < 0) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x11: // BGEZAL
            if (rsValSigned >= 0) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); } else this.branchPending = false;
            return;
          case 0x12: // BLTZALL
            if (rsValSigned < 0) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.branchPending = false; this.pc = (this.pc + 4) >>> 0; }
            return;
          case 0x13: // BGEZALL
            if (rsValSigned >= 0) { this.setReg(31, linkAddr); this.branchTarget = target; this.branchPending = true; this.branchPC = ((this.pc - 4) >>> 0); }
            else { this.branchPending = false; this.pc = (this.pc + 4) >>> 0; }
            return;
          default:
            throw new Error(`Unimplemented REGIMM rt=0x${rtField.toString(16)}`);
        }
      }
      case 0x0c: { // ANDI rt, rs, imm
        this.setReg(rt, (this.getReg(rs) & (imm & 0xffff)) >>> 0);
        return;
      }
      case 0x0d: { // ORI rt, rs, imm
        this.setReg(rt, (this.getReg(rs) | (imm & 0xffff)) >>> 0);
        return;
      }
      case 0x0e: { // XORI rt, rs, imm
        this.setReg(rt, (this.getReg(rs) ^ (imm & 0xffff)) >>> 0);
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
        const b = this.bus.loadU8(addr);
        this.setReg(rt, signExtend8(b));
        return;
      }
      case 0x24: { // LBU rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        const b = this.bus.loadU8(addr);
        this.setReg(rt, b & 0xff);
        return;
      }
      case 0x21: { // LH rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 2, false);
        const h = this.bus.loadU16(addr);
        // sign extend 16
        this.setReg(rt, signExtend16(h));
        return;
      }
      case 0x25: { // LHU rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 2, false);
        const h = this.bus.loadU16(addr);
        this.setReg(rt, h & 0xffff);
        return;
      }
      case 0x22: { // LWL rt, offset(base) - big-endian per-byte semantics
        const addr = this.addrCalc(rs, imm);
        const aligned = addr & ~3;
        const k = addr & 3;
        const old = this.getReg(rt);
        const m0 = this.bus.loadU8(aligned + 0);
        const m1 = this.bus.loadU8(aligned + 1);
        const m2 = this.bus.loadU8(aligned + 2);
        const m3 = this.bus.loadU8(aligned + 3);
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
        const w = this.bus.loadU32(addr);
        this.setReg(rt, w);
        return;
      }
      case 0x26: { // LWR rt, offset(base) - big-endian per-byte semantics
        const addr = this.addrCalc(rs, imm);
        const aligned = addr & ~3;
        const k = addr & 3;
        const old = this.getReg(rt);
        const m0 = this.bus.loadU8(aligned + 0);
        const m1 = this.bus.loadU8(aligned + 1);
        const m2 = this.bus.loadU8(aligned + 2);
        const m3 = this.bus.loadU8(aligned + 3);
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
        this.bus.storeU8(addr, v);
        return;
      }
      case 0x29: { // SH rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 2, true);
        const v = this.getReg(rt) & 0xffff;
        this.bus.storeU16(addr, v);
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
        this.bus.storeU8(aligned + 0, b0);
        if (k <= 2) this.bus.storeU8(aligned + 1, b1);
        if (k <= 1) this.bus.storeU8(aligned + 2, b2);
        if (k <= 0) this.bus.storeU8(aligned + 3, b3);
        return;
      }
      case 0x2b: { // SW rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        this.checkAlign(addr, 4, true);
        const v = this.getReg(rt);
        this.bus.storeU32(addr, v);
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
        if (k >= 3) this.bus.storeU8(aligned + 0, b0);
        if (k >= 2) this.bus.storeU8(aligned + 1, b1);
        if (k >= 1) this.bus.storeU8(aligned + 2, b2);
        this.bus.storeU8(aligned + 3, b3);
        return;
      }
      case 0x0f: { // LUI rt, imm
        this.setReg(rt, (imm << 16) >>> 0);
        return;
      }
      case 0x31: { // LWC1 ft, offset(base)
        const addr = this.addrCalc(rs, imm);
        // ft encoded in rt field
        const v = this.bus.loadU32(addr);
        if ((rt >>> 0) < 32) this.fpr[rt] = v >>> 0;
        return;
      }
      case 0x39: { // SWC1 ft, offset(base)
        const addr = this.addrCalc(rs, imm);
        const v = (rt >>> 0) < 32 ? ((this.fpr[rt] ?? 0) >>> 0) : 0;
        this.bus.storeU32(addr, v >>> 0);
        return;
      }
      case 0x11: { // COP1 (FPU) minimal stub
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
                // Unsupported variant: treat as NOP branch not taken
                this.branchPending = false; return;
            }
          }
          default:
            // Treat unhandled COP1 ops as NOP to allow progression during boot
            return;
        }
      }
      case 0x18: { // DADDI rt, rs, imm (64-bit add immediate with overflow) - modeled as 32-bit ADDI
        const a = (this.getReg(rs) | 0);
        const b = (signExtend16(imm) | 0);
        const r = (a + b) | 0;
        if (((a ^ r) & (b ^ r)) < 0) {
          throw new CPUException('Overflow', this.pc >>> 0);
        }
        this.setReg(rt, r >>> 0);
        return;
      }
      case 0x19: { // DADDIU rt, rs, imm (64-bit add immediate unsigned) - modeled as 32-bit ADDIU
        const res = (this.getReg(rs) + (signExtend16(imm) >>> 0)) >>> 0;
        this.setReg(rt, res);
        return;
      }
      case 0x1a: { // LDL rt, offset(base) - model as LW rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        // No alignment trap for LDL in our model; do a 32-bit load
        const v = this.bus.loadU32(addr);
        this.setReg(rt, v >>> 0);
        return;
      }
      case 0x1b: { // LDR rt, offset(base) - model as LW rt, offset(base)
        const addr = this.addrCalc(rs, imm);
        const v = this.bus.loadU32(addr);
        this.setReg(rt, v >>> 0);
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
        const v = this.bus.loadU32(addr);
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
          this.bus.storeU32(addr, v);
          this.setReg(rt, 1);
        } else {
          this.setReg(rt, 0);
        }
        this.llValid = false;
        return;
      }
      case 0x3f: { // SD rt, offset(base) - store doubleword (modeled as SW)
        const addr = this.addrCalc(rs, imm) >>> 0;
        const v = this.getReg(rt) >>> 0;
        this.bus.storeU32(addr, v);
        return;
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
          case 0x10: { // COP0 rfe/eret group; check funct
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
            throw new Error(`Unimplemented COP0 rs=0x10 funct=0x${functField.toString(16)}`);
          }
          default:
            throw new Error(`Unimplemented COP0 rs=0x${rsField.toString(16)}`);
        }
      }
      default:
        throw new Error(`Unimplemented opcode=0x${op.toString(16)} instr=0x${instr.toString(16)}`);
    }
  }
}

