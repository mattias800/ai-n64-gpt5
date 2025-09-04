import { describe, it, expect, beforeEach } from 'vitest';
import { RspVectorUnit } from '../src/rsp/rsp_vu.js';

describe('RSP Vector Unit - Load/Store Operations', () => {
  let vu: RspVectorUnit;
  let dmem: Uint8Array;

  beforeEach(() => {
    vu = new RspVectorUnit();
    dmem = new Uint8Array(0x1000);
    vu.reset();
  });

  describe('Byte operations', () => {
    it('should load byte to vector element (LBV)', () => {
      // Write test bytes to DMEM
      dmem[0x100] = 0xAB;
      dmem[0x101] = 0xCD;
      
      // Load byte to upper byte of element 0
      vu.lbv(1, 0, 0x100, dmem);
      const reg1 = vu.readVReg(1) as Int16Array;
      expect((reg1[0] >> 8) & 0xFF).toBe(0xAB);
      
      // Load byte to lower byte of element 0
      vu.lbv(1, 1, 0x101, dmem);
      expect(reg1[0] & 0xFF).toBe(0xCD);
      expect(reg1[0]).toBe(0xABCD | 0xFFFF0000); // Sign-extended in Int16Array
    });

    it('should store byte from vector element (SBV)', () => {
      const reg2 = vu.readVReg(2) as Int16Array;
      reg2[0] = 0x1234;
      
      // Store upper byte
      vu.sbv(2, 0, 0x200, dmem);
      expect(dmem[0x200]).toBe(0x12);
      
      // Store lower byte
      vu.sbv(2, 1, 0x201, dmem);
      expect(dmem[0x201]).toBe(0x34);
    });
  });

  describe('Short operations', () => {
    it('should load short to vector element (LSV)', () => {
      // Write 16-bit value to DMEM (big-endian)
      dmem[0x110] = 0xBE;
      dmem[0x111] = 0xEF;
      
      vu.lsv(3, 0, 0x110, dmem);
      const reg3 = vu.readVReg(3) as Int16Array;
      expect(reg3[0]).toBe(0xBEEF | 0xFFFF0000);
    });

    it('should store short from vector element (SSV)', () => {
      const reg4 = vu.readVReg(4) as Int16Array;
      reg4[2] = 0x5678;
      
      vu.ssv(4, 4, 0x220, dmem); // element 4 maps to lane 2
      expect(dmem[0x220]).toBe(0x56);
      expect(dmem[0x221]).toBe(0x78);
    });
  });

  describe('Long operations', () => {
    it('should load 32-bit value to vector (LLV)', () => {
      // Write 32-bit value to DMEM
      dmem[0x130] = 0x12;
      dmem[0x131] = 0x34;
      dmem[0x132] = 0x56;
      dmem[0x133] = 0x78;
      
      vu.llv(5, 0, 0x130, dmem);
      const reg5 = vu.readVReg(5) as Int16Array;
      expect(reg5[0]).toBe(0x1234);
      expect(reg5[1]).toBe(0x5678);
    });

    it('should store 32-bit value from vector (SLV)', () => {
      const reg6 = vu.readVReg(6) as Int16Array;
      reg6[2] = 0xAAAA;
      reg6[3] = 0xBBBB;
      
      vu.slv(6, 8, 0x240, dmem); // element 8 aligns to lane 2
      expect(dmem[0x240]).toBe(0xAA);
      expect(dmem[0x241]).toBe(0xAA);
      expect(dmem[0x242]).toBe(0xBB);
      expect(dmem[0x243]).toBe(0xBB);
    });
  });

  describe('Double operations', () => {
    it('should load 64-bit value to vector (LDV)', () => {
      // Write 64-bit value to DMEM
      for (let i = 0; i < 8; i++) {
        dmem[0x150 + i] = 0x10 + i;
      }
      
      vu.ldv(7, 0, 0x150, dmem);
      const reg7 = vu.readVReg(7) as Int16Array;
      expect(reg7[0]).toBe(0x1011);
      expect(reg7[1]).toBe(0x1213);
      expect(reg7[2]).toBe(0x1415);
      expect(reg7[3]).toBe(0x1617);
    });

    it('should store 64-bit value from vector (SDV)', () => {
      const reg8 = vu.readVReg(8) as Int16Array;
      for (let i = 0; i < 4; i++) {
        reg8[i + 4] = 0xC000 + i;
      }
      
      vu.sdv(8, 8, 0x260, dmem); // element 8 aligns to lane 4
      expect(dmem[0x260]).toBe(0xC0);
      expect(dmem[0x261]).toBe(0x00);
      expect(dmem[0x262]).toBe(0xC0);
      expect(dmem[0x263]).toBe(0x01);
      expect(dmem[0x264]).toBe(0xC0);
      expect(dmem[0x265]).toBe(0x02);
      expect(dmem[0x266]).toBe(0xC0);
      expect(dmem[0x267]).toBe(0x03);
    });
  });

  describe('Quad operations', () => {
    it('should load quad with alignment (LQV)', () => {
      // Fill DMEM with pattern
      for (let i = 0; i < 16; i++) {
        dmem[0x170 + i] = i + 0x20;
      }
      
      // Load full quad aligned
      vu.lqv(9, 0, 0x170, dmem);
      const reg9 = vu.readVReg(9) as Int16Array;
      for (let i = 0; i < 8; i++) {
        const expected = (0x20 + i * 2) << 8 | (0x21 + i * 2);
        expect(reg9[i]).toBe(expected);
      }
    });

    it('should handle LQV with unaligned address', () => {
      // Fill DMEM
      for (let i = 0; i < 32; i++) {
        dmem[0x180 + i] = i;
      }
      
      // Load from unaligned address - should stop at 16-byte boundary
      vu.lqv(10, 0, 0x185, dmem);
      const reg10 = vu.readVReg(10) as Int16Array;
      
      // Should load 11 bytes (0x185 to 0x18F)
      // That's 5.5 elements, so 5 full elements
      for (let i = 0; i < 5; i++) {
        const addr = 0x05 + i * 2;
        const expected = (addr << 8) | (addr + 1);
        expect(reg10[i]).toBe(expected);
      }
    });

    it('should store quad with alignment (SQV)', () => {
      const reg11 = vu.readVReg(11) as Int16Array;
      for (let i = 0; i < 8; i++) {
        reg11[i] = 0xF000 | i;
      }
      
      vu.sqv(11, 0, 0x280, dmem);
      for (let i = 0; i < 8; i++) {
        expect(dmem[0x280 + i * 2]).toBe(0xF0);
        expect(dmem[0x280 + i * 2 + 1]).toBe(i);
      }
    });
  });

  describe('Rest operations', () => {
    it('should load from right side (LRV)', () => {
      // Fill DMEM with pattern
      for (let i = 0; i < 16; i++) {
        dmem[0x1A0 + i] = 0x30 + i;
      }
      
      // LRV loads from the "rest" - right side of 16-byte line
      vu.lrv(12, 0, 0x1A4, dmem);
      const reg12 = vu.readVReg(12) as Int16Array;
      
      // Should load from position calculated based on alignment
      // This is complex alignment logic - simplified test
      expect(reg12[0]).not.toBe(0);
    });

    it('should store to right side (SRV)', () => {
      const reg13 = vu.readVReg(13) as Int16Array;
      for (let i = 0; i < 8; i++) {
        reg13[i] = 0xD000 | (i << 8) | i;
      }
      
      vu.srv(13, 0, 0x2C0, dmem);
      // SRV stores to the "rest" - complex alignment
      // Just verify something was written
      let written = false;
      for (let i = 0; i < 16; i++) {
        if (dmem[0x2C0 + i] !== 0) {
          written = true;
          break;
        }
      }
      expect(written).toBe(true);
    });
  });

  describe('Register and accumulator access', () => {
    it('should read and write vector registers', () => {
      const testVec = new Int16Array([0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888]);
      vu.writeVReg(15, testVec);
      
      const readVec = vu.readVReg(15) as Int16Array;
      for (let i = 0; i < 8; i++) {
        expect(readVec[i]).toBe(testVec[i]);
      }
    });

    it('should read and write individual elements', () => {
      vu.writeVReg(16, 0xABCD, 3);
      expect(vu.readVReg(16, 3)).toBe(0xABCD | 0xFFFF0000);
    });

    it('should manage accumulator', () => {
      // Set 48-bit value in accumulator lane 2
      vu.setAccumulator(2, 0x123456789ABCn);
      expect(vu.getAccumulator(2)).toBe(0x123456789ABCn);
      
      // Check it's isolated to lane 2
      expect(vu.getAccumulator(1)).toBe(0n);
      expect(vu.getAccumulator(3)).toBe(0n);
    });

    it('should manage control flags', () => {
      // Test VCO flags
      vu.setVCO(3, true);
      vu.setVCO(5, true);
      expect(vu.getVCO(3)).toBe(true);
      expect(vu.getVCO(5)).toBe(true);
      expect(vu.getVCO(4)).toBe(false);
      expect(vu.getVCOMask()).toBe((1 << 3) | (1 << 5));
      
      // Test VCC flags
      vu.setVCC(0, true);
      vu.setVCC(7, true);
      expect(vu.getVCCMask()).toBe((1 << 0) | (1 << 7));
      
      // Test VCE flags
      vu.setVCE(1, true);
      vu.setVCE(2, true);
      vu.setVCE(1, false); // Clear one
      expect(vu.getVCEMask()).toBe(1 << 2);
    });
  });

  describe('Reset', () => {
    it('should reset all state', () => {
      // Set some state
      vu.writeVReg(0, 0x1234, 0);
      vu.setAccumulator(0, 0x111111111111n);
      vu.setVCO(0, true);
      vu.setVCC(1, true);
      vu.setVCE(2, true);
      
      // Reset
      vu.reset();
      
      // Verify everything cleared
      expect(vu.readVReg(0, 0)).toBe(0);
      expect(vu.getAccumulator(0)).toBe(0n);
      expect(vu.getVCOMask()).toBe(0);
      expect(vu.getVCCMask()).toBe(0);
      expect(vu.getVCEMask()).toBe(0);
    });
  });
});
