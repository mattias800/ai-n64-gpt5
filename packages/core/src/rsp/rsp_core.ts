import type { IRspCore } from '../devices/interfaces.js';
import { MI_INTR_SP } from '../devices/mmio.js';
import { RspVectorUnit } from './rsp_vu.js';

// RSP COP0 register numbers
const RSP_COP0_MEM_ADDR = 0;
const RSP_COP0_DRAM_ADDR = 1;
const RSP_COP0_RD_LEN = 2;
const RSP_COP0_WR_LEN = 3;
const RSP_COP0_STATUS = 4;
const RSP_COP0_DMA_FULL = 5;
const RSP_COP0_DMA_BUSY = 6;
const RSP_COP0_SEMAPHORE = 7;
const RSP_COP0_CMD_START = 8;
const RSP_COP0_CMD_END = 9;
const RSP_COP0_CMD_CURRENT = 10;
const RSP_COP0_CMD_STATUS = 11;
const RSP_COP0_CMD_CLOCK = 12;

// SP_STATUS bits (read)
const SP_STATUS_HALT = 1 << 0;
const SP_STATUS_BROKE = 1 << 1;
const SP_STATUS_DMA_BUSY = 1 << 2;
const SP_STATUS_DMA_FULL = 1 << 3;
const SP_STATUS_IO_FULL = 1 << 4;
const SP_STATUS_SSTEP = 1 << 5;
const SP_STATUS_INTR_ON_BREAK = 1 << 6;
const SP_STATUS_SIG0 = 1 << 7;
const SP_STATUS_SIG1 = 1 << 8;
const SP_STATUS_SIG2 = 1 << 9;
const SP_STATUS_SIG3 = 1 << 10;
const SP_STATUS_SIG4 = 1 << 11;
const SP_STATUS_SIG5 = 1 << 12;
const SP_STATUS_SIG6 = 1 << 13;
const SP_STATUS_SIG7 = 1 << 14;

// SP_STATUS write bits (write-one-to-set/clear)
const SP_CLR_HALT = 1 << 0;
const SP_SET_HALT = 1 << 1;
const SP_CLR_BROKE = 1 << 2;
const SP_CLR_INTR = 1 << 3;
const SP_SET_INTR = 1 << 4;
const SP_CLR_SSTEP = 1 << 5;
const SP_SET_SSTEP = 1 << 6;
const SP_CLR_INTR_ON_BREAK = 1 << 7;
const SP_SET_INTR_ON_BREAK = 1 << 8;
const SP_CLR_SIG0 = 1 << 9;
const SP_SET_SIG0 = 1 << 10;
const SP_CLR_SIG1 = 1 << 11;
const SP_SET_SIG1 = 1 << 12;
const SP_CLR_SIG2 = 1 << 13;
const SP_SET_SIG2 = 1 << 14;
const SP_CLR_SIG3 = 1 << 15;
const SP_SET_SIG3 = 1 << 16;
const SP_CLR_SIG4 = 1 << 17;
const SP_SET_SIG4 = 1 << 18;
const SP_CLR_SIG5 = 1 << 19;
const SP_SET_SIG5 = 1 << 20;
const SP_CLR_SIG6 = 1 << 21;
const SP_SET_SIG6 = 1 << 22;
const SP_CLR_SIG7 = 1 << 23;
const SP_SET_SIG7 = 1 << 24;

interface RspState {
  pc: number;
  nextPc: number;
  gpr: Uint32Array;
  hi: number;
  lo: number;
  halted: boolean;
  broke: boolean;
  cycles: number;
  
  // SP status bits
  dmaBusy: boolean;
  dmaFull: boolean;
  ioFull: boolean;
  singleStep: boolean;
  intrOnBreak: boolean;
  signals: number; // 8 signal bits
  
  // SP semaphore
  semaphore: number;
  
  // DMA registers
  memAddr: number;
  dramAddr: number;
}

export class RspCore implements IRspCore {
  // Expose additional methods for testing
  getGPR(reg: number): number { return this.st.gpr[reg & 0x1F] ?? 0; }
  setGPR(reg: number, val: number): void { 
    if ((reg & 0x1F) !== 0) this.st.gpr[reg & 0x1F] = val >>> 0;
  }
  getPC(): number { return this.st.pc; }
  setPC(pc: number): void { 
    this.st.pc = pc & 0xFFF;
    this.st.nextPc = (pc + 4) & 0xFFF;
  }
  getHI(): number { return this.st.hi; }
  getLO(): number { return this.st.lo; }
  isBroke(): boolean { return this.st.broke; }
  
  private mi: { raise: (mask: number) => void; clear: (mask: number) => void } | null = null;
  private rdram: Uint8Array | null = null;
  private sp: any | null = null; // Reference to SP device for DMA operations
  readonly dmem: Uint8Array = new Uint8Array(0x1000);
  readonly imem: Uint8Array = new Uint8Array(0x1000);
  readonly vu: RspVectorUnit = new RspVectorUnit();
  private st: RspState = {
    pc: 0,
    nextPc: 4,
    gpr: new Uint32Array(32),
    hi: 0,
    lo: 0,
    halted: true,
    broke: false,
    cycles: 0,
    dmaBusy: false,
    dmaFull: false,
    ioFull: false,
    singleStep: false,
    intrOnBreak: false,
    signals: 0,
    semaphore: 0,
    memAddr: 0,
    dramAddr: 0,
  };

  setMI(mi: { raise: (mask: number) => void; clear: (mask: number) => void }): void { this.mi = mi; }
  setSP(sp: any): void { this.sp = sp; }
  setRDRAM(bytes: Uint8Array): void { this.rdram = bytes; }

  readU32(offset: number): number {
    const off = offset >>> 0;
    const isImem = (off & 0x1000) !== 0;
    const buf = isImem ? this.imem : this.dmem;
    const o = off & 0x0FFC;
    return (((buf[o] ?? 0) << 24) | ((buf[o + 1] ?? 0) << 16) | ((buf[o + 2] ?? 0) << 8) | (buf[o + 3] ?? 0)) >>> 0;
  }

  writeU32(offset: number, value: number): void {
    const off = offset >>> 0;
    const isImem = (off & 0x1000) !== 0;
    const buf = isImem ? this.imem : this.dmem;
    const o = off & 0x0FFF;
    buf[o & 0x0FFF] = (value >>> 24) & 0xFF;
    buf[(o + 1) & 0x0FFF] = (value >>> 16) & 0xFF;
    buf[(o + 2) & 0x0FFF] = (value >>> 8) & 0xFF;
    buf[(o + 3) & 0x0FFF] = value & 0xFF;
  }

  raiseInterrupt(): void { if (this.mi) this.mi.raise(MI_INTR_SP); }
  
  // RSP COP0 register access
  mfc0(rd: number): number {
    switch (rd & 0x1F) {
      case RSP_COP0_MEM_ADDR: return this.st.memAddr >>> 0;
      case RSP_COP0_DRAM_ADDR: return this.st.dramAddr >>> 0;
      case RSP_COP0_RD_LEN: return 0; // Write-only
      case RSP_COP0_WR_LEN: return 0; // Write-only  
      case RSP_COP0_STATUS: return this.getStatusReg();
      case RSP_COP0_DMA_FULL: return this.st.dmaFull ? 1 : 0;
      case RSP_COP0_DMA_BUSY: return this.st.dmaBusy ? 1 : 0;
      case RSP_COP0_SEMAPHORE: {
        const prev = this.st.semaphore;
        this.st.semaphore = 1; // Set on read
        return prev;
      }
      // DP command registers (read through SP if connected)
      case RSP_COP0_CMD_START:
      case RSP_COP0_CMD_END:
      case RSP_COP0_CMD_CURRENT:
      case RSP_COP0_CMD_STATUS:
      case RSP_COP0_CMD_CLOCK:
        // These would read from DP device if wired
        return 0;
      default:
        return 0;
    }
  }
  
  mtc0(rd: number, value: number): void {
    value >>>= 0;
    switch (rd & 0x1F) {
      case RSP_COP0_MEM_ADDR:
        this.st.memAddr = value & 0x1FFF;
        break;
      case RSP_COP0_DRAM_ADDR:
        this.st.dramAddr = value & 0xFFFFFF;
        break;
      case RSP_COP0_RD_LEN:
        this.executeDmaRead(value);
        break;
      case RSP_COP0_WR_LEN:
        this.executeDmaWrite(value);
        break;
      case RSP_COP0_STATUS:
        this.writeStatusReg(value);
        break;
      case RSP_COP0_SEMAPHORE:
        this.st.semaphore = 0; // Clear on write
        break;
      // DP command registers (write through to DP if connected)
      case RSP_COP0_CMD_START:
      case RSP_COP0_CMD_END:
        // These would write to DP device if wired
        break;
    }
  }
  
  private getStatusReg(): number {
    let status = 0;
    if (this.st.halted) status |= SP_STATUS_HALT;
    if (this.st.broke) status |= SP_STATUS_BROKE;
    if (this.st.dmaBusy) status |= SP_STATUS_DMA_BUSY;
    if (this.st.dmaFull) status |= SP_STATUS_DMA_FULL;
    if (this.st.ioFull) status |= SP_STATUS_IO_FULL;
    if (this.st.singleStep) status |= SP_STATUS_SSTEP;
    if (this.st.intrOnBreak) status |= SP_STATUS_INTR_ON_BREAK;
    status |= (this.st.signals & 0xFF) << 7;
    return status >>> 0;
  }
  
  private writeStatusReg(value: number): void {
    // Process write-one-to-set/clear bits
    if (value & SP_CLR_HALT) {
      this.st.halted = false;
      // Starting execution, update SP device if connected
      if (this.sp && this.sp.onStart) this.sp.onStart();
    }
    if (value & SP_SET_HALT) this.st.halted = true;
    if (value & SP_CLR_BROKE) this.st.broke = false;
    if (value & SP_CLR_INTR) {
      if (this.mi) this.mi.clear(MI_INTR_SP);
    }
    if (value & SP_SET_INTR) {
      if (this.mi) this.mi.raise(MI_INTR_SP);
    }
    if (value & SP_CLR_SSTEP) this.st.singleStep = false;
    if (value & SP_SET_SSTEP) this.st.singleStep = true;
    if (value & SP_CLR_INTR_ON_BREAK) this.st.intrOnBreak = false;
    if (value & SP_SET_INTR_ON_BREAK) this.st.intrOnBreak = true;
    
    // Signal bits
    for (let i = 0; i < 8; i++) {
      const clrBit = SP_CLR_SIG0 << (i * 2);
      const setBit = SP_SET_SIG0 << (i * 2);
      if (value & clrBit) this.st.signals &= ~(1 << i);
      if (value & setBit) this.st.signals |= (1 << i);
    }
  }
  
  private executeDmaRead(value: number): void {
    if (!this.rdram) return;
    
    const length = ((value & 0xFFF) >>> 0) + 1;
    const count = (((value >>> 12) & 0xFF) >>> 0) + 1;
    const skip = ((value >>> 20) & 0xFFF) >>> 0;
    
    this.st.dmaBusy = true;
    let mem = this.st.memAddr & 0x1FFF;
    let dram = this.st.dramAddr >>> 0;
    
    for (let c = 0; c < count; c++) {
      const toImem = (mem & 0x1000) !== 0;
      const base = mem & 0x0FFF;
      const dest = toImem ? this.imem : this.dmem;
      
      for (let i = 0; i < length; i++) {
        if (dram + i < this.rdram.length) {
          dest[(base + i) & 0x0FFF] = this.rdram[dram + i] ?? 0;
        }
      }
      
      mem = ((mem + length + skip) & 0x1FFF) >>> 0;
      dram = (dram + length + skip) >>> 0;
    }
    
    this.st.dmaBusy = false;
  }
  
  private executeDmaWrite(value: number): void {
    if (!this.rdram) return;
    
    const length = ((value & 0xFFF) >>> 0) + 1;
    const count = (((value >>> 12) & 0xFF) >>> 0) + 1;
    const skip = ((value >>> 20) & 0xFFF) >>> 0;
    
    this.st.dmaBusy = true;
    let mem = this.st.memAddr & 0x1FFF;
    let dram = this.st.dramAddr >>> 0;
    
    for (let c = 0; c < count; c++) {
      const fromImem = (mem & 0x1000) !== 0;
      const base = mem & 0x0FFF;
      const src = fromImem ? this.imem : this.dmem;
      
      for (let i = 0; i < length; i++) {
        const b = src[(base + i) & 0x0FFF] ?? 0;
        if (dram + i < this.rdram.length) {
          this.rdram[dram + i] = b;
        }
      }
      
      mem = ((mem + length + skip) & 0x1FFF) >>> 0;
      dram = (dram + length + skip) >>> 0;
    }
    
    this.st.dmaBusy = false;
  }

  // Execute RSP instructions for given number of cycles
  step(cycles: number): number {
    const maxCycles = Math.max(0, cycles | 0);
    let executed = 0;
    
    while (executed < maxCycles && !this.st.halted) {
      // Check for single-step mode
      if (this.st.singleStep && executed > 0) {
        this.st.halted = true;
        break;
      }
      
      // Fetch instruction from IMEM
      const instr = this.fetchInstruction(this.st.pc);
      
      // Execute in delay slot context
      const branchTarget = this.st.nextPc;
      this.st.pc = branchTarget;
      this.st.nextPc = (branchTarget + 4) & 0xFFF; // Wrap at 4KB IMEM
      
      // Decode and execute
      this.executeInstruction(instr);
      
      executed++;
      this.st.cycles++;
      
      // Check for break
      if (this.st.broke) {
        this.st.halted = true;
        if (this.st.intrOnBreak && this.mi) {
          this.mi.raise(MI_INTR_SP);
        }
        break;
      }
    }
    
    return executed;
  }
  
  private fetchInstruction(addr: number): number {
    const pc = addr & 0xFFC; // Align to 32-bit
    return (((this.imem[pc] ?? 0) << 24) | ((this.imem[pc + 1] ?? 0) << 16) |
            ((this.imem[pc + 2] ?? 0) << 8) | (this.imem[pc + 3] ?? 0)) >>> 0;
  }
  
  private executeInstruction(instr: number): void {
    const op = (instr >>> 26) & 0x3F;
    
    switch (op) {
      case 0x00: this.executeSpecial(instr); break;
      case 0x01: this.executeRegimm(instr); break;
      case 0x02: this.executeJ(instr); break;      // J
      case 0x03: this.executeJAL(instr); break;    // JAL
      case 0x04: this.executeBEQ(instr); break;    // BEQ
      case 0x05: this.executeBNE(instr); break;    // BNE
      case 0x06: this.executeBLEZ(instr); break;   // BLEZ
      case 0x07: this.executeBGTZ(instr); break;   // BGTZ
      case 0x08: this.executeADDI(instr); break;   // ADDI
      case 0x09: this.executeADDIU(instr); break;  // ADDIU
      case 0x0A: this.executeSLTI(instr); break;   // SLTI
      case 0x0B: this.executeSLTIU(instr); break;  // SLTIU
      case 0x0C: this.executeANDI(instr); break;   // ANDI
      case 0x0D: this.executeORI(instr); break;    // ORI
      case 0x0E: this.executeXORI(instr); break;   // XORI
      case 0x0F: this.executeLUI(instr); break;    // LUI
      case 0x10: this.executeCOP0(instr); break;   // COP0
      case 0x12: this.executeCOP2(instr); break;   // COP2 (Vector Unit)
      case 0x20: this.executeLB(instr); break;     // LB
      case 0x21: this.executeLH(instr); break;     // LH
      case 0x23: this.executeLW(instr); break;     // LW
      case 0x24: this.executeLBU(instr); break;    // LBU
      case 0x25: this.executeLHU(instr); break;    // LHU
      case 0x28: this.executeSB(instr); break;     // SB
      case 0x29: this.executeSH(instr); break;     // SH
      case 0x2B: this.executeSW(instr); break;     // SW
      default:
        // Unknown instruction - NOP
        break;
    }
  }
  
  private executeSpecial(instr: number): void {
    const func = instr & 0x3F;
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const rd = (instr >>> 11) & 0x1F;
    const shamt = (instr >>> 6) & 0x1F;
    
    switch (func) {
      case 0x00: // SLL
        this.st.gpr[rd] = ((this.st.gpr[rt] ?? 0) << shamt) >>> 0;
        break;
      case 0x02: // SRL
        this.st.gpr[rd] = (this.st.gpr[rt] ?? 0) >>> shamt;
        break;
      case 0x03: // SRA
        this.st.gpr[rd] = ((this.st.gpr[rt] ?? 0) | 0) >> shamt;
        break;
      case 0x04: // SLLV
        this.st.gpr[rd] = ((this.st.gpr[rt] ?? 0) << ((this.st.gpr[rs] ?? 0) & 0x1F)) >>> 0;
        break;
      case 0x06: // SRLV
        this.st.gpr[rd] = (this.st.gpr[rt] ?? 0) >>> ((this.st.gpr[rs] ?? 0) & 0x1F);
        break;
      case 0x07: // SRAV
        this.st.gpr[rd] = ((this.st.gpr[rt] ?? 0) | 0) >> ((this.st.gpr[rs] ?? 0) & 0x1F);
        break;
      case 0x08: // JR
        this.st.nextPc = (this.st.gpr[rs] ?? 0) & 0xFFF;
        break;
      case 0x09: // JALR
        this.st.gpr[rd] = (this.st.pc + 4) & 0xFFF;
        this.st.nextPc = (this.st.gpr[rs] ?? 0) & 0xFFF;
        break;
      case 0x0D: // BREAK
        this.st.broke = true;
        break;
      case 0x10: // MFHI
        this.st.gpr[rd] = this.st.hi;
        break;
      case 0x11: // MTHI
        this.st.hi = this.st.gpr[rs] ?? 0;
        break;
      case 0x12: // MFLO
        this.st.gpr[rd] = this.st.lo;
        break;
      case 0x13: // MTLO
        this.st.lo = this.st.gpr[rs] ?? 0;
        break;
      case 0x18: // MULT
        {
          const a = (this.st.gpr[rs] ?? 0) | 0;
          const b = (this.st.gpr[rt] ?? 0) | 0;
          const result = BigInt(a) * BigInt(b);
          this.st.lo = Number(result & 0xFFFFFFFFn);
          this.st.hi = Number(result >> 32n);
        }
        break;
      case 0x19: // MULTU
        {
          const a = (this.st.gpr[rs] ?? 0) >>> 0;
          const b = (this.st.gpr[rt] ?? 0) >>> 0;
          const result = BigInt(a) * BigInt(b);
          this.st.lo = Number(result & 0xFFFFFFFFn);
          this.st.hi = Number(result >> 32n);
        }
        break;
      case 0x1A: // DIV
        {
          const a = (this.st.gpr[rs] ?? 0) | 0;
          const b = (this.st.gpr[rt] ?? 0) | 0;
          if (b !== 0) {
            this.st.lo = Math.floor(a / b) >>> 0;
            this.st.hi = (a % b) >>> 0;
          }
        }
        break;
      case 0x1B: // DIVU
        {
          const a = (this.st.gpr[rs] ?? 0) >>> 0;
          const b = (this.st.gpr[rt] ?? 0) >>> 0;
          if (b !== 0) {
            this.st.lo = Math.floor(a / b) >>> 0;
            this.st.hi = (a % b) >>> 0;
          }
        }
        break;
      case 0x20: // ADD
      case 0x21: // ADDU
        this.st.gpr[rd] = ((this.st.gpr[rs] ?? 0) + (this.st.gpr[rt] ?? 0)) >>> 0;
        break;
      case 0x22: // SUB
      case 0x23: // SUBU
        this.st.gpr[rd] = ((this.st.gpr[rs] ?? 0) - (this.st.gpr[rt] ?? 0)) >>> 0;
        break;
      case 0x24: // AND
        this.st.gpr[rd] = (this.st.gpr[rs] ?? 0) & (this.st.gpr[rt] ?? 0);
        break;
      case 0x25: // OR
        this.st.gpr[rd] = (this.st.gpr[rs] ?? 0) | (this.st.gpr[rt] ?? 0);
        break;
      case 0x26: // XOR
        this.st.gpr[rd] = (this.st.gpr[rs] ?? 0) ^ (this.st.gpr[rt] ?? 0);
        break;
      case 0x27: // NOR
        this.st.gpr[rd] = ~((this.st.gpr[rs] ?? 0) | (this.st.gpr[rt] ?? 0)) >>> 0;
        break;
      case 0x2A: // SLT
        this.st.gpr[rd] = (((this.st.gpr[rs] ?? 0) | 0) < ((this.st.gpr[rt] ?? 0) | 0)) ? 1 : 0;
        break;
      case 0x2B: // SLTU
        this.st.gpr[rd] = ((this.st.gpr[rs] ?? 0) >>> 0) < ((this.st.gpr[rt] ?? 0) >>> 0) ? 1 : 0;
        break;
    }
    
    // GPR[0] is always 0
    this.st.gpr[0] = 0;
  }
  
  private executeRegimm(instr: number): void {
    const rt = (instr >>> 16) & 0x1F;
    const rs = (instr >>> 21) & 0x1F;
    const imm = (instr << 16) >> 16; // Sign extend
    
    switch (rt) {
      case 0x00: // BLTZ
        if ((this.st.gpr[rs] | 0) < 0) {
          this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
        }
        break;
      case 0x01: // BGEZ
        if ((this.st.gpr[rs] | 0) >= 0) {
          this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
        }
        break;
      case 0x10: // BLTZAL
        this.st.gpr[31] = (this.st.pc + 4) & 0xFFF;
        if ((this.st.gpr[rs] | 0) < 0) {
          this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
        }
        break;
      case 0x11: // BGEZAL
        this.st.gpr[31] = (this.st.pc + 4) & 0xFFF;
        if ((this.st.gpr[rs] | 0) >= 0) {
          this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
        }
        break;
    }
  }
  
  private executeJ(instr: number): void {
    const target = (instr & 0x3FFFFFF) << 2;
    this.st.nextPc = target & 0xFFF;
  }
  
  private executeJAL(instr: number): void {
    const target = (instr & 0x3FFFFFF) << 2;
    this.st.gpr[31] = (this.st.pc + 4) & 0xFFF;
    this.st.nextPc = target & 0xFFF;
  }
  
  private executeBEQ(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    
    if (this.st.gpr[rs] === this.st.gpr[rt]) {
      this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
    }
  }
  
  private executeBNE(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    
    if (this.st.gpr[rs] !== this.st.gpr[rt]) {
      this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
    }
  }
  
  private executeBLEZ(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const imm = (instr << 16) >> 16;
    
    if ((this.st.gpr[rs] | 0) <= 0) {
      this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
    }
  }
  
  private executeBGTZ(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const imm = (instr << 16) >> 16;
    
    if ((this.st.gpr[rs] | 0) > 0) {
      this.st.nextPc = (this.st.pc + (imm << 2)) & 0xFFF;
    }
  }
  
  private executeADDI(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    this.st.gpr[rt] = (this.st.gpr[rs] + imm) >>> 0;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeADDIU(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    this.st.gpr[rt] = (this.st.gpr[rs] + imm) >>> 0;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeSLTI(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    this.st.gpr[rt] = ((this.st.gpr[rs] | 0) < imm) ? 1 : 0;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeSLTIU(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    this.st.gpr[rt] = ((this.st.gpr[rs] >>> 0) < (imm >>> 0)) ? 1 : 0;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeANDI(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = instr & 0xFFFF;
    this.st.gpr[rt] = this.st.gpr[rs] & imm;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeORI(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = instr & 0xFFFF;
    this.st.gpr[rt] = this.st.gpr[rs] | imm;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeXORI(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = instr & 0xFFFF;
    this.st.gpr[rt] = this.st.gpr[rs] ^ imm;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeLUI(instr: number): void {
    const rt = (instr >>> 16) & 0x1F;
    const imm = instr & 0xFFFF;
    this.st.gpr[rt] = (imm << 16) >>> 0;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeCOP0(instr: number): void {
    const func = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const rd = (instr >>> 11) & 0x1F;
    
    switch (func) {
      case 0x00: // MFC0
        this.st.gpr[rt] = this.mfc0(rd);
        if (rt === 0) this.st.gpr[0] = 0;
        break;
      case 0x04: // MTC0
        this.mtc0(rd, this.st.gpr[rt]);
        break;
    }
  }
  
  private executeCOP2(instr: number): void {
    // Vector unit operations - stub for now
    // Will implement when we add VU instruction execution
  }
  
  private executeLB(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFF;
    this.st.gpr[rt] = (this.dmem[addr] << 24) >> 24; // Sign extend
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeLH(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFE;
    const val = (this.dmem[addr] << 8) | this.dmem[addr + 1];
    this.st.gpr[rt] = (val << 16) >> 16; // Sign extend
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeLW(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFC;
    this.st.gpr[rt] = ((this.dmem[addr] << 24) | (this.dmem[addr + 1] << 16) |
                       (this.dmem[addr + 2] << 8) | this.dmem[addr + 3]) >>> 0;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeLBU(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFF;
    this.st.gpr[rt] = this.dmem[addr] & 0xFF;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeLHU(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFE;
    this.st.gpr[rt] = ((this.dmem[addr] << 8) | this.dmem[addr + 1]) & 0xFFFF;
    if (rt === 0) this.st.gpr[0] = 0;
  }
  
  private executeSB(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFF;
    this.dmem[addr] = this.st.gpr[rt] & 0xFF;
  }
  
  private executeSH(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFE;
    this.dmem[addr] = (this.st.gpr[rt] >>> 8) & 0xFF;
    this.dmem[addr + 1] = this.st.gpr[rt] & 0xFF;
  }
  
  private executeSW(instr: number): void {
    const rs = (instr >>> 21) & 0x1F;
    const rt = (instr >>> 16) & 0x1F;
    const imm = (instr << 16) >> 16;
    const addr = (this.st.gpr[rs] + imm) & 0xFFC;
    this.dmem[addr] = (this.st.gpr[rt] >>> 24) & 0xFF;
    this.dmem[addr + 1] = (this.st.gpr[rt] >>> 16) & 0xFF;
    this.dmem[addr + 2] = (this.st.gpr[rt] >>> 8) & 0xFF;
    this.dmem[addr + 3] = this.st.gpr[rt] & 0xFF;
  }

  isHalted(): boolean { return this.st.halted; }
  reset(): void {
    this.st.pc = 0;
    this.st.nextPc = 4;
    this.st.gpr.fill(0);
    this.st.hi = 0; this.st.lo = 0;
    this.st.halted = true; this.st.broke = false;
    this.st.cycles = 0;
    this.st.dmaBusy = false;
    this.st.dmaFull = false;
    this.st.ioFull = false;
    this.st.singleStep = false;
    this.st.intrOnBreak = false;
    this.st.signals = 0;
    this.st.semaphore = 0;
    this.st.memAddr = 0;
    this.st.dramAddr = 0;
    this.dmem.fill(0); this.imem.fill(0);
    this.vu.reset();
  }
}

