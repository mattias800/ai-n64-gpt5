import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RspCore } from '../src/rsp/rsp_core.js';
import { MI_INTR_SP } from '../src/devices/mmio.js';

describe('RSP Scalar Instructions', () => {
  let rsp: RspCore;
  let mi: { raise: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; pending: number };

  beforeEach(() => {
    rsp = new RspCore();
    mi = {
      raise: vi.fn((mask: number) => { mi.pending |= mask; }),
      clear: vi.fn((mask: number) => { mi.pending &= ~mask; }),
      pending: 0,
    };
    rsp.setMI(mi);
    const rdram = new Uint8Array(0x800000);
    rsp.setRDRAM(rdram);
    rsp.reset();
  });

  // Helper to write instruction to IMEM
  const writeInstruction = (addr: number, instr: number) => {
    rsp.imem[addr] = (instr >>> 24) & 0xFF;
    rsp.imem[addr + 1] = (instr >>> 16) & 0xFF;
    rsp.imem[addr + 2] = (instr >>> 8) & 0xFF;
    rsp.imem[addr + 3] = instr & 0xFF;
  };

  describe('ALU operations', () => {
    it('should execute ADD/ADDU', () => {
      rsp.setGPR(1, 100);
      rsp.setGPR(2, 50);
      // ADD r3, r1, r2 (opcode=0, func=0x20)
      writeInstruction(0, 0x00221820);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(3)).toBe(150);
    });

    it('should execute SUB/SUBU', () => {
      rsp.setGPR(4, 200);
      rsp.setGPR(5, 75);
      // SUB r6, r4, r5 (opcode=0, func=0x22)
      writeInstruction(0, 0x00853022);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(6)).toBe(125);
    });

    it('should execute AND', () => {
      rsp.setGPR(7, 0xFF00FF00);
      rsp.setGPR(8, 0x00FF00FF);
      // AND r9, r7, r8 (opcode=0, func=0x24)
      writeInstruction(0, 0x00E84824);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(9)).toBe(0);
    });

    it('should execute OR', () => {
      rsp.setGPR(10, 0xF0F0F0F0);
      rsp.setGPR(11, 0x0F0F0F0F);
      // OR r12, r10, r11 (opcode=0, func=0x25)
      writeInstruction(0, 0x014B6025);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(12)).toBe(0xFFFFFFFF);
    });

    it('should execute XOR', () => {
      rsp.setGPR(13, 0xAAAAAAAA);
      rsp.setGPR(14, 0xFFFFFFFF);
      // XOR r15, r13, r14 (opcode=0, func=0x26)
      writeInstruction(0, 0x01AE7826);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(15)).toBe(0x55555555);
    });

    it('should execute NOR', () => {
      rsp.setGPR(16, 0x0000FFFF);
      rsp.setGPR(17, 0xFFFF0000);
      // NOR r18, r16, r17 (opcode=0, func=0x27)
      writeInstruction(0, 0x02119027);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(18)).toBe(0);
    });

    it('should execute SLT (signed)', () => {
      rsp.setGPR(19, -10);
      rsp.setGPR(20, 10);
      // SLT r21, r19, r20 (opcode=0, func=0x2A)
      writeInstruction(0, 0x0274A82A);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(21)).toBe(1); // -10 < 10
    });

    it('should execute SLTU (unsigned)', () => {
      rsp.setGPR(22, 0xFFFFFFFF); // -1 as signed, max as unsigned
      rsp.setGPR(23, 1);
      // SLTU r24, r23, r22 (opcode=0, func=0x2B)
      writeInstruction(0, 0x02F6C02B);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(24)).toBe(1); // 1 < 0xFFFFFFFF
    });
  });

  describe('Shift operations', () => {
    it('should execute SLL', () => {
      rsp.setGPR(1, 0x1);
      // SLL r2, r1, 16 (opcode=0, func=0x00)
      writeInstruction(0, 0x00011400);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(2)).toBe(0x10000);
    });

    it('should execute SRL', () => {
      rsp.setGPR(3, 0x80000000);
      // SRL r4, r3, 16 (opcode=0, func=0x02)
      writeInstruction(0, 0x00032402);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(4)).toBe(0x8000);
    });

    it('should execute SRA', () => {
      rsp.setGPR(5, 0x80000000);
      // SRA r6, r5, 16 (opcode=0, func=0x03)
      writeInstruction(0, 0x00053403);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(6)).toBe(0xFFFF8000);
    });
  });

  describe('Immediate operations', () => {
    it('should execute ADDI/ADDIU', () => {
      rsp.setGPR(1, 100);
      // ADDIU r2, r1, 50 (opcode=0x09)
      writeInstruction(0, 0x24220032);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(2)).toBe(150);
    });

    it('should execute ANDI', () => {
      rsp.setGPR(3, 0xFFFFFFFF);
      // ANDI r4, r3, 0xFF00 (opcode=0x0C)
      writeInstruction(0, 0x3064FF00);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(4)).toBe(0xFF00);
    });

    it('should execute ORI', () => {
      rsp.setGPR(5, 0xFF000000);
      // ORI r6, r5, 0x00FF (opcode=0x0D)
      writeInstruction(0, 0x34A600FF);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(6)).toBe(0xFF0000FF);
    });

    it('should execute XORI', () => {
      rsp.setGPR(7, 0x0000FFFF);
      // XORI r8, r7, 0xFFFF (opcode=0x0E)
      writeInstruction(0, 0x38E8FFFF);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(8)).toBe(0x00000000);
    });

    it('should execute LUI', () => {
      // LUI r9, 0x1234 (opcode=0x0F)
      writeInstruction(0, 0x3C091234);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(9)).toBe(0x12340000);
    });

    it('should execute SLTI', () => {
      rsp.setGPR(10, 5);
      // SLTI r11, r10, 10 (opcode=0x0A)
      writeInstruction(0, 0x294B000A);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(11)).toBe(1); // 5 < 10
    });
  });

  describe('Branch operations', () => {
    it('should execute BEQ (taken)', () => {
      rsp.setGPR(1, 100);
      rsp.setGPR(2, 100);
      // BEQ r1, r2, +8 (opcode=0x04)
      writeInstruction(0, 0x10220002);
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(12); // Should branch to PC+4+8
    });

    it('should execute BNE (not taken)', () => {
      rsp.setGPR(3, 100);
      rsp.setGPR(4, 100);
      // BNE r3, r4, +8 (opcode=0x05)
      writeInstruction(0, 0x14640002);
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(8); // Should not branch
    });

    it('should execute BLEZ', () => {
      rsp.setGPR(5, -5);
      // BLEZ r5, +8 (opcode=0x06)
      writeInstruction(0, 0x18A00002);
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(12); // Should branch
    });

    it('should execute BGTZ', () => {
      rsp.setGPR(6, 10);
      // BGTZ r6, +8 (opcode=0x07)
      writeInstruction(0, 0x1CC00002);
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(12); // Should branch
    });
  });

  describe('Jump operations', () => {
    it('should execute J', () => {
      // J 0x100 (opcode=0x02)
      writeInstruction(0, 0x08000040); // Target = 0x100 / 4 = 0x40
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(0x100);
    });

    it('should execute JAL', () => {
      // JAL 0x200 (opcode=0x03)
      writeInstruction(0, 0x0C000080); // Target = 0x200 / 4 = 0x80
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(0x200);
      expect(rsp.getGPR(31)).toBe(8); // Return address
    });

    it('should execute JR', () => {
      rsp.setGPR(8, 0x300);
      // JR r8 (opcode=0, func=0x08)
      writeInstruction(0, 0x01000008);
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(0x300);
    });

    it('should execute JALR', () => {
      rsp.setGPR(9, 0x400);
      // JALR r10, r9 (opcode=0, func=0x09)
      writeInstruction(0, 0x0120F809);
      writeInstruction(4, 0); // Delay slot
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(2);
      
      expect(rsp.getPC()).toBe(0x400);
      expect(rsp.getGPR(31)).toBe(8); // Return address
    });
  });

  describe('Memory operations', () => {
    it('should execute LW and SW', () => {
      // Write test value to DMEM
      rsp.dmem[0x100] = 0x12;
      rsp.dmem[0x101] = 0x34;
      rsp.dmem[0x102] = 0x56;
      rsp.dmem[0x103] = 0x78;
      
      rsp.setGPR(1, 0x100);
      // LW r2, 0(r1) (opcode=0x23)
      writeInstruction(0, 0x8C220000);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(2)).toBe(0x12345678);
      
      // Now store it elsewhere
      rsp.setGPR(3, 0x200);
      // SW r2, 0(r3) (opcode=0x2B)
      writeInstruction(4, 0xAC620000);
      
      rsp.step(1);
      
      expect(rsp.dmem[0x200]).toBe(0x12);
      expect(rsp.dmem[0x201]).toBe(0x34);
      expect(rsp.dmem[0x202]).toBe(0x56);
      expect(rsp.dmem[0x203]).toBe(0x78);
    });

    it('should execute LH and SH', () => {
      rsp.dmem[0x150] = 0xAB;
      rsp.dmem[0x151] = 0xCD;
      
      rsp.setGPR(4, 0x150);
      // LH r5, 0(r4) (opcode=0x21)
      writeInstruction(0, 0x84850000);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(5)).toBe(0xFFFFABCD); // Sign-extended
      
      // Store halfword
      rsp.setGPR(6, 0x160);
      rsp.setGPR(7, 0x1234);
      // SH r7, 0(r6) (opcode=0x29)
      writeInstruction(4, 0xA4C70000);
      
      rsp.step(1);
      
      expect(rsp.dmem[0x160]).toBe(0x12);
      expect(rsp.dmem[0x161]).toBe(0x34);
    });

    it('should execute LB and SB', () => {
      rsp.dmem[0x180] = 0xEF;
      
      rsp.setGPR(8, 0x180);
      // LB r9, 0(r8) (opcode=0x20)
      writeInstruction(0, 0x81090000);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(9)).toBe(0xFFFFFFEF); // Sign-extended
      
      // Store byte
      rsp.setGPR(10, 0x190);
      rsp.setGPR(11, 0xABCDEF12);
      // SB r11, 0(r10) (opcode=0x28)
      writeInstruction(4, 0xA14B0000);
      
      rsp.step(1);
      
      expect(rsp.dmem[0x190]).toBe(0x12);
    });
  });

  describe('Multiply/Divide operations', () => {
    it('should execute MULT', () => {
      rsp.setGPR(1, 100);
      rsp.setGPR(2, 200);
      // MULT r1, r2 (opcode=0, func=0x18)
      writeInstruction(0, 0x00220018);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getLO()).toBe(20000);
      expect(rsp.getHI()).toBe(0);
    });

    it('should execute MULTU', () => {
      rsp.setGPR(3, 0xFFFFFFFF);
      rsp.setGPR(4, 2);
      // MULTU r3, r4 (opcode=0, func=0x19)
      writeInstruction(0, 0x00640019);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getLO()).toBe(0xFFFFFFFE);
      expect(rsp.getHI()).toBe(1);
    });

    it('should execute DIV', () => {
      rsp.setGPR(5, 100);
      rsp.setGPR(6, 7);
      // DIV r5, r6 (opcode=0, func=0x1A)
      writeInstruction(0, 0x00A6001A);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getLO()).toBe(14); // Quotient
      expect(rsp.getHI()).toBe(2);  // Remainder
    });

    it('should execute MFHI and MFLO', () => {
      // Set up HI/LO
      rsp.setGPR(7, 1000);
      rsp.setGPR(8, 33);
      // MULT r7, r8
      writeInstruction(0, 0x00E80018);
      // MFLO r9 (opcode=0, func=0x12)
      writeInstruction(4, 0x00004812);
      // MFHI r10 (opcode=0, func=0x10)
      writeInstruction(8, 0x00005010);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(3);
      
      expect(rsp.getGPR(9)).toBe(33000); // From LO
      expect(rsp.getGPR(10)).toBe(0);    // From HI
    });
  });

  describe('BREAK instruction', () => {
    it('should execute BREAK and halt', () => {
      // BREAK (opcode=0, func=0x0D)
      writeInstruction(0, 0x0000000D);
      
      // Enable interrupt on break
      rsp.mtc0(4, 0x100); // SET_INTR_ON_BREAK
      rsp.mtc0(4, 0x01);  // Clear halt
      
      rsp.step(1);
      
      expect(rsp.isHalted()).toBe(true);
      expect(rsp.isBroke()).toBe(true);
      expect(mi.raise).toHaveBeenCalledWith(MI_INTR_SP);
    });
  });

  describe('COP0 operations', () => {
    it('should execute MFC0 and MTC0', () => {
      // Set SP_MEM_ADDR via MTC0
      rsp.setGPR(1, 0x1234);
      // MTC0 r1, $0 (SP_MEM_ADDR)
      writeInstruction(0, 0x40810000);
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.mfc0(0)).toBe(0x1234);
      
      // Read it back with MFC0
      // MFC0 r2, $0
      writeInstruction(4, 0x40020000);
      
      rsp.step(1);
      
      expect(rsp.getGPR(2)).toBe(0x1234);
    });
  });

  describe('Execution loop', () => {
    it('should execute multiple instructions in sequence', () => {
      // Simple program: add numbers and store result
      rsp.setGPR(1, 10);
      rsp.setGPR(2, 20);
      
      writeInstruction(0, 0x00221820);  // ADD r3, r1, r2
      writeInstruction(4, 0x00232020);  // ADD r4, r1, r3
      writeInstruction(8, 0x00642820);  // ADD r5, r3, r4
      writeInstruction(12, 0x0000000D); // BREAK
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(10); // Execute with cycle budget
      
      expect(rsp.getGPR(3)).toBe(30);  // 10 + 20
      expect(rsp.getGPR(4)).toBe(40);  // 10 + 30
      expect(rsp.getGPR(5)).toBe(70);  // 30 + 40
      expect(rsp.isHalted()).toBe(true);
      expect(rsp.isBroke()).toBe(true);
    });

    it('should handle single-step mode', () => {
      writeInstruction(0, 0x00221820);  // ADD r3, r1, r2
      writeInstruction(4, 0x00432020);  // ADD r4, r2, r3
      
      rsp.setGPR(1, 5);
      rsp.setGPR(2, 10);
      
      // Enable single-step
      rsp.mtc0(4, 0x40); // SET_SSTEP
      rsp.mtc0(4, 0x01); // Clear halt
      
      // First step
      const executed1 = rsp.step(10);
      expect(executed1).toBe(1);
      expect(rsp.getGPR(3)).toBe(15);
      expect(rsp.isHalted()).toBe(true);
      
      // Continue with another step
      rsp.mtc0(4, 0x01); // Clear halt again
      const executed2 = rsp.step(10);
      expect(executed2).toBe(1);
      expect(rsp.getGPR(4)).toBe(25);
      expect(rsp.isHalted()).toBe(true);
    });
  });

  describe('GPR[0] always zero', () => {
    it('should keep GPR[0] as zero', () => {
      // Try to write to r0
      writeInstruction(0, 0x20000064); // ADDI r0, r0, 100
      
      rsp.mtc0(4, 0x01); // Clear halt
      rsp.step(1);
      
      expect(rsp.getGPR(0)).toBe(0);
    });
  });
});
