export type ExceptionCode = 'AddressErrorLoad' | 'AddressErrorStore' | 'Overflow' | 'Interrupt' | 'Syscall' | 'Breakpoint' | 'ReservedInstruction' | 'Trap' | 'TLBLoad' | 'TLBStore' | 'TLBModified' | 'CoprocessorUnusable';

export class CPUException extends Error {
  constructor(public readonly code: ExceptionCode, public readonly badVAddr: number) {
    super(`${code} at 0x${badVAddr.toString(16)}`);
    this.name = 'CPUException';
  }
}
