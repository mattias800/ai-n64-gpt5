/**
 * Interfaces for pluggable RSP and DP cores.
 * These allow both HLE and LLE implementations to be swapped at runtime.
 */

export interface IRspCore {
  /**
   * Read a 32-bit word from RSP memory space
   * @param offset Offset within RSP address space (0x0000-0x1FFF)
   */
  readU32(offset: number): number;

  /**
   * Write a 32-bit word to RSP memory space
   * @param offset Offset within RSP address space
   * @param value Value to write
   */
  writeU32(offset: number, value: number): void;

  /**
   * Raise RSP interrupt to MI
   */
  raiseInterrupt(): void;

  /**
   * Set MI reference for interrupt signaling
   */
  setMI(mi: any): void;

  /**
   * Set RDRAM reference for DMA operations
   */
  setRDRAM(bytes: Uint8Array): void;

  /**
   * Optional callback when SP is started
   */
  onStart?: () => void;

  /**
   * Get DMEM buffer (4KB)
   */
  readonly dmem: Uint8Array;

  /**
   * Get IMEM buffer (4KB)
   */
  readonly imem: Uint8Array;

  /**
   * Step RSP execution by given cycles (LLE mode only)
   * @param cycles Number of cycles to execute
   * @returns Number of cycles actually executed
   */
  step?(cycles: number): number;

  /**
   * Check if RSP is halted
   */
  isHalted?(): boolean;

  /**
   * Reset RSP state
   */
  reset?(): void;
}

export interface IDpCore {
  /**
   * Read a 32-bit word from DP registers
   * @param offset Offset within DP address space
   */
  readU32(offset: number): number;

  /**
   * Write a 32-bit word to DP registers
   * @param offset Offset within DP address space
   * @param value Value to write
   */
  writeU32(offset: number, value: number): void;

  /**
   * Raise DP interrupt to MI
   */
  raiseInterrupt(): void;

  /**
   * Set MI reference for interrupt signaling
   */
  setMI(mi: any): void;

  /**
   * Set RDRAM reference for framebuffer and command fetch
   */
  setRDRAM?(bytes: Uint8Array): void;

  /**
   * Process RDP commands (LLE mode)
   * @param cycles Number of cycles available
   * @returns Number of cycles consumed
   */
  processCommands?(cycles: number): number;

  /**
   * Check if RDP is idle
   */
  isIdle?(): boolean;

  /**
   * Get DP status register value
   */
  getStatus?(): number;

  /**
   * Reset DP state
   */
  reset?(): void;
}

/**
 * Feature flags for enabling LLE mode
 */
export interface LLEFlags {
  /** Enable RSP Low-Level Emulation */
  rspLLE: boolean;
  /** Enable RDP Low-Level Emulation */
  rdpLLE: boolean;
}

/**
 * Helper to check environment flags
 */
export const getLLEFlags = (): LLEFlags => {
  const envFlag = (name: string): boolean => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = (typeof process !== 'undefined') ? (process as any) : undefined;
      return !!p?.env?.[name];
    } catch {
      return false;
    }
  };

  return {
    rspLLE: envFlag('N64_LLE_RSP'),
    rdpLLE: envFlag('N64_LLE_RDP'),
  };
};
