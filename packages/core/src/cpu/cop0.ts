export type Cop0Reg = 0 | 12 | 13 | 14 | 8;

// Minimal CP0 for exceptions: Status (12), Cause (13), EPC (14), BadVAddr (8)
export class Cop0 {
  // Registers are 32-bit
  regs = new Uint32Array(32);

  // Status register bit masks
  static readonly STATUS_IE = 1 << 0; // Interrupt Enable
  static readonly STATUS_EXL = 1 << 1; // Exception Level
  static readonly STATUS_BEV = 1 << 22; // Bootstrap Exception Vectors
  static readonly STATUS_IM_MASK = 0xff << 8; // Interrupt mask bits [15:8]

  // Cause register fields
  static readonly CAUSE_BD = 1 << 31; // Branch Delay
  // ExcCode field is bits [6:2]
  static readonly CAUSE_IP_MASK = 0xff << 8; // Pending interrupt bits [15:8]

  read(reg: number): number {
    return (this.regs[reg] ?? 0) >>> 0;
  }

  // Internal setter for hardware-driven Cause updates (e.g., MI asserting IP2)
  setCauseInternal(value: number): void {
    this.regs[13] = value >>> 0;
  }

  // Advance Count and manage timer interrupt (IP7). Writing Compare clears IP7.
  tick(): void {
    this.regs[9] = (((this.regs[9] ?? 0) + 1) >>> 0); // Count
    // Only set IP7 on rising edge when Count transitions to equal Compare
    // This simple model sets IP7 when Count == Compare
    if ((((this.regs[9] ?? 0) >>> 0) === ((this.regs[11] ?? 0) >>> 0))) {
      this.regs[13] = (((this.regs[13] ?? 0) | (1 << 15)) >>> 0);
    }
  }

  write(reg: number, value: number): void {
    const v = value >>> 0;
    switch (reg) {
      case 12: { // Status
        // Allow writes to IE, EXL, KSU[4:3], IM[15:8], BEV; preserve others
        const allowed = (1 << 0) | (1 << 1) | (3 << 3) | (0xff << 8) | (1 << 22);
        const cur = (this.regs[12] ?? 0) >>> 0;
        this.regs[12] = ((cur & ~allowed) | (v & allowed)) >>> 0;
        break;
      }
      case 13: { // Cause
        // Software write only allowed for software IP[9:8]
        const cur = (this.regs[13] ?? 0) >>> 0;
        const swMask = (3 << 8); // IP1..IP0 (software)
        this.regs[13] = ((cur & ~swMask) | (v & swMask)) >>> 0;
        break;
      }
      case 14: // EPC
      case 8:  // BadVAddr
        this.regs[reg] = v;
        break;
      case 9: // Count
        this.regs[9] = v;
        break;
      case 11: // Compare
        this.regs[11] = v;
        // Clear timer interrupt pending IP7
        this.regs[13] = (((this.regs[13] ?? 0) & ~(1 << 15)) >>> 0);
        break;
      default:
        this.regs[reg] = v;
        break;
    }
  }

  setException(excCode: number, epc: number, badVAddr: number | null, inDelaySlot: boolean): void {
    // Set EXL in Status
    this.regs[12] = (((this.regs[12] ?? 0) | Cop0.STATUS_EXL) >>> 0);
    // Set Cause: ExcCode and BD
    let cause = (this.regs[13] ?? 0) >>> 0;
    cause &= ~0x7c; // clear ExcCode bits [6:2]
    cause |= ((excCode & 0x1f) << 2) >>> 0;
    if (inDelaySlot) cause |= Cop0.CAUSE_BD; else cause &= ~Cop0.CAUSE_BD;
    this.regs[13] = cause >>> 0;
    // Set EPC
    this.regs[14] = epc >>> 0;
    if (badVAddr !== null) this.regs[8] = badVAddr >>> 0;
  }
}
