/**
 * COP1 (Floating Point Unit) implementation
 * Provides cycle-accurate floating-point operations for MIPS R4300
 */

export enum FPURoundingMode {
  RN = 0, // Round to Nearest
  RZ = 1, // Round toward Zero (Truncate)
  RP = 2, // Round toward Plus Infinity
  RM = 3, // Round toward Minus Infinity
}

export enum FPUException {
  INEXACT = 1 << 0,
  UNDERFLOW = 1 << 1,
  OVERFLOW = 1 << 2,
  DIV_BY_ZERO = 1 << 3,
  INVALID = 1 << 4,
  UNIMPLEMENTED = 1 << 5,
}

export class COP1 {
  // FPU registers (32 single-precision or 16 double-precision)
  private regs = new Float32Array(32);
  private regsDouble = new Float64Array(16);
  
  // Control/Status register
  private fcr31 = 0;
  
  // FPU timing (cycles for various operations)
  private static readonly TIMING = {
    ADD_S: 3,
    ADD_D: 3,
    SUB_S: 3,
    SUB_D: 3,
    MUL_S: 5,
    MUL_D: 8,
    DIV_S: 29,
    DIV_D: 58,
    SQRT_S: 29,
    SQRT_D: 58,
    CVT: 2,
    CMP: 1,
    MOV: 1,
  };
  
  private pendingOp: { cycles: number; callback: () => void } | null = null;
  
  constructor() {
    this.reset();
  }
  
  reset(): void {
    this.regs.fill(0);
    this.regsDouble.fill(0);
    this.fcr31 = 0x01000800; // Default: round to nearest, no exceptions enabled
    this.pendingOp = null;
  }
  
  /**
   * Read single-precision register
   */
  readS(reg: number): number {
    // Don't use || 0 as it would convert NaN to 0
    const value = this.regs[reg & 31];
    return value !== undefined ? value : 0;
  }
  
  /**
   * Write single-precision register
   */
  writeS(reg: number, value: number): void {
    this.regs[reg & 31] = value;
  }
  
  /**
   * Read double-precision register
   */
  readD(reg: number): number {
    const idx = (reg >> 1) & 15;
    // Don't use || 0 as it would convert NaN to 0
    const value = this.regsDouble[idx];
    return value !== undefined ? value : 0;
  }
  
  /**
   * Write double-precision register
   */
  writeD(reg: number, value: number): void {
    const idx = (reg >> 1) & 15;
    this.regsDouble[idx] = value;
  }
  
  /**
   * Read control register
   */
  readControl(reg: number): number {
    if (reg === 31) return this.fcr31;
    if (reg === 0) return 0x00000B00; // Implementation/Revision register
    return 0;
  }
  
  /**
   * Write control register
   */
  writeControl(reg: number, value: number): void {
    if (reg === 31) {
      this.fcr31 = value >>> 0;
      this.updateRoundingMode();
    }
  }
  
  private updateRoundingMode(): void {
    // Update native rounding mode based on FCR31
    // Note: JavaScript doesn't directly support changing rounding modes
    // This would need platform-specific code in a real implementation
  }
  
  /**
   * Get current rounding mode
   */
  getRoundingMode(): FPURoundingMode {
    return (this.fcr31 & 3) as FPURoundingMode;
  }
  
  /**
   * Check if FPU is enabled
   */
  isEnabled(): boolean {
    return true; // Should check COP1 usable bit in Status register
  }
  
  /**
   * Set exception flag
   */
  private setException(exc: FPUException): void {
    // Set flag bits (bits 2-7)
    this.fcr31 |= (exc << 2);
    // Always set cause bits (bits 12-17) when exception occurs
    this.fcr31 |= (exc << 12);
    // If exception is enabled (bits 7-11), would trigger trap
    if (this.fcr31 & (exc << 7)) {
      // In real hardware, this would cause an exception trap
      // For now, we just record it
    }
  }
  
  /**
   * Clear exception flags
   */
  clearExceptions(): void {
    this.fcr31 &= ~0x0003F000; // Clear cause bits
  }
  
  /**
   * Perform single-precision addition
   */
  addS(fd: number, fs: number, ft: number): number {
    const a = this.readS(fs);
    const b = this.readS(ft);
    const result = a + b;
    this.writeS(fd, result);
    
    if (!isFinite(result)) {
      this.setException(FPUException.OVERFLOW);
    }
    
    return COP1.TIMING.ADD_S;
  }
  
  /**
   * Perform double-precision addition
   */
  addD(fd: number, fs: number, ft: number): number {
    const a = this.readD(fs);
    const b = this.readD(ft);
    const result = a + b;
    this.writeD(fd, result);
    
    if (!isFinite(result)) {
      this.setException(FPUException.OVERFLOW);
    }
    
    return COP1.TIMING.ADD_D;
  }
  
  /**
   * Perform single-precision subtraction
   */
  subS(fd: number, fs: number, ft: number): number {
    const a = this.readS(fs);
    const b = this.readS(ft);
    const result = a - b;
    this.writeS(fd, result);
    
    if (!isFinite(result)) {
      this.setException(FPUException.OVERFLOW);
    }
    
    return COP1.TIMING.SUB_S;
  }
  
  /**
   * Perform double-precision subtraction
   */
  subD(fd: number, fs: number, ft: number): number {
    const a = this.readD(fs);
    const b = this.readD(ft);
    const result = a - b;
    this.writeD(fd, result);
    
    if (!isFinite(result)) {
      this.setException(FPUException.OVERFLOW);
    }
    
    return COP1.TIMING.SUB_D;
  }
  
  /**
   * Perform single-precision multiplication
   */
  mulS(fd: number, fs: number, ft: number): number {
    const a = this.readS(fs);
    const b = this.readS(ft);
    const result = a * b;
    this.writeS(fd, result);
    
    if (!isFinite(result)) {
      this.setException(FPUException.OVERFLOW);
    }
    
    return COP1.TIMING.MUL_S;
  }
  
  /**
   * Perform double-precision multiplication
   */
  mulD(fd: number, fs: number, ft: number): number {
    const a = this.readD(fs);
    const b = this.readD(ft);
    const result = a * b;
    this.writeD(fd, result);
    
    if (!isFinite(result)) {
      this.setException(FPUException.OVERFLOW);
    }
    
    return COP1.TIMING.MUL_D;
  }
  
  /**
   * Perform single-precision division
   */
  divS(fd: number, fs: number, ft: number): number {
    const a = this.readS(fs);
    const b = this.readS(ft);
    
    if (b === 0) {
      this.setException(FPUException.DIV_BY_ZERO);
      this.writeS(fd, a > 0 ? Infinity : -Infinity);
    } else {
      const result = a / b;
      this.writeS(fd, result);
      
      if (!isFinite(result)) {
        this.setException(FPUException.OVERFLOW);
      }
    }
    
    return COP1.TIMING.DIV_S;
  }
  
  /**
   * Perform double-precision division
   */
  divD(fd: number, fs: number, ft: number): number {
    const a = this.readD(fs);
    const b = this.readD(ft);
    
    if (b === 0) {
      this.setException(FPUException.DIV_BY_ZERO);
      this.writeD(fd, a > 0 ? Infinity : -Infinity);
    } else {
      const result = a / b;
      this.writeD(fd, result);
      
      if (!isFinite(result)) {
        this.setException(FPUException.OVERFLOW);
      }
    }
    
    return COP1.TIMING.DIV_D;
  }
  
  /**
   * Perform single-precision square root
   */
  sqrtS(fd: number, fs: number): number {
    const a = this.readS(fs);
    
    if (a < 0) {
      this.setException(FPUException.INVALID);
      // JavaScript NaN is already a proper IEEE-754 quiet NaN
      this.writeS(fd, NaN);
    } else {
      this.writeS(fd, Math.sqrt(a));
    }
    
    return COP1.TIMING.SQRT_S;
  }
  
  /**
   * Perform double-precision square root
   */
  sqrtD(fd: number, fs: number): number {
    const a = this.readD(fs);
    
    if (a < 0) {
      this.setException(FPUException.INVALID);
      // Store NaN as a float64 bit pattern
      const nanBits = 0x7FF8000000000000n; // Standard quiet NaN for double precision
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, nanBits, false);
      this.writeD(fd, view.getFloat64(0, false));
    } else {
      this.writeD(fd, Math.sqrt(a));
    }
    
    return COP1.TIMING.SQRT_D;
  }
  
  /**
   * Convert single to double
   */
  cvtDS(fd: number, fs: number): number {
    const value = this.readS(fs);
    this.writeD(fd, value);
    return COP1.TIMING.CVT;
  }
  
  /**
   * Convert double to single
   */
  cvtSD(fd: number, fs: number): number {
    const value = this.readD(fs);
    this.writeS(fd, value);
    return COP1.TIMING.CVT;
  }
  
  /**
   * Convert word to single
   */
  cvtSW(fd: number, fs: number): number {
    const intVal = (this.regs[fs] || 0) | 0;
    this.writeS(fd, intVal);
    return COP1.TIMING.CVT;
  }
  
  /**
   * Convert word to double
   */
  cvtDW(fd: number, fs: number): number {
    const intVal = (this.regs[fs] || 0) | 0;
    this.writeD(fd, intVal);
    return COP1.TIMING.CVT;
  }
  
  /**
   * Convert single to word
   */
  cvtWS(fd: number, fs: number): number {
    const value = this.readS(fs);
    let result: number;
    
    switch (this.getRoundingMode()) {
      case FPURoundingMode.RN:
        result = Math.round(value);
        break;
      case FPURoundingMode.RZ:
        result = Math.trunc(value);
        break;
      case FPURoundingMode.RP:
        result = Math.ceil(value);
        break;
      case FPURoundingMode.RM:
        result = Math.floor(value);
        break;
    }
    
    this.regs[fd] = result | 0;
    return COP1.TIMING.CVT;
  }
  
  /**
   * Convert double to word
   */
  cvtWD(fd: number, fs: number): number {
    const value = this.readD(fs);
    let result: number;
    
    switch (this.getRoundingMode()) {
      case FPURoundingMode.RN:
        result = Math.round(value);
        break;
      case FPURoundingMode.RZ:
        result = Math.trunc(value);
        break;
      case FPURoundingMode.RP:
        result = Math.ceil(value);
        break;
      case FPURoundingMode.RM:
        result = Math.floor(value);
        break;
    }
    
    this.regs[fd] = result | 0;
    return COP1.TIMING.CVT;
  }
  
  /**
   * Compare single-precision values
   */
  compareS(fs: number, ft: number, cond: number): number {
    const a = this.readS(fs);
    const b = this.readS(ft);
    let result = false;
    
    // Check for unordered (when either operand is NaN)
    // Test both values with isNaN() method
    const unordered = isNaN(a) || isNaN(b);
    
    // Condition codes (bits 2:0 of cond)
    // Only evaluate less/equal if not unordered
    const less = !unordered && (a < b);
    const equal = !unordered && (a === b);
    
    if (cond & 4) result = result || less;
    if (cond & 2) result = result || equal;
    if (cond & 1) result = result || unordered;
    
    // Set condition bit in FCR31
    if (result) {
      this.fcr31 |= (1 << 23);
    } else {
      this.fcr31 &= ~(1 << 23);
    }
    
    return COP1.TIMING.CMP;
  }
  
  /**
   * Compare double-precision values
   */
  compareD(fs: number, ft: number, cond: number): number {
    const a = this.readD(fs);
    const b = this.readD(ft);
    let result = false;
    
    const less = a < b;
    const equal = a === b;
    const unordered = isNaN(a) || isNaN(b);
    
    if (cond & 4) result = result || less;
    if (cond & 2) result = result || equal;
    if (cond & 1) result = result || unordered;
    
    if (result) {
      this.fcr31 |= (1 << 23);
    } else {
      this.fcr31 &= ~(1 << 23);
    }
    
    return COP1.TIMING.CMP;
  }
  
  /**
   * Check condition flag
   */
  getCondition(): boolean {
    return (this.fcr31 & (1 << 23)) !== 0;
  }
  
  /**
   * Advance FPU by one cycle
   */
  tick(): void {
    if (this.pendingOp) {
      this.pendingOp.cycles--;
      if (this.pendingOp.cycles <= 0) {
        this.pendingOp.callback();
        this.pendingOp = null;
      }
    }
  }
  
  /**
   * Check if FPU is busy with an operation
   */
  isBusy(): boolean {
    return this.pendingOp !== null;
  }
  
  /**
   * Get FPU status for debugging
   */
  getStatus(): { fcr31: number; busy: boolean; exceptions: number } {
    return {
      fcr31: this.fcr31,
      busy: this.isBusy(),
      exceptions: (this.fcr31 >> 12) & 0x3F
    };
  }
}
