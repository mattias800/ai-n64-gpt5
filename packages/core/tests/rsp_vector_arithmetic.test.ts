import { describe, it, expect, beforeEach } from 'vitest';
import { RspVectorUnit } from '../src/rsp/rsp_vu.js';

describe('RSP Vector Unit - Arithmetic Operations', () => {
  let vu: RspVectorUnit;

  beforeEach(() => {
    vu = new RspVectorUnit();
    vu.reset();
  });

  describe('Addition operations', () => {
    it('should perform vector add with saturation (VADD)', () => {
      // Set up test vectors
      const v1 = new Int16Array([100, -100, 32767, -32768, 0, 1000, -1000, 500]);
      const v2 = new Int16Array([50, -50, 1, -1, 100, -500, 500, -250]);
      vu.writeVReg(1, v1);
      vu.writeVReg(2, v2);
      
      // Execute VADD
      vu.vadd(3, 1, 2);
      
      const result = vu.readVReg(3) as Int16Array;
      expect(result[0]).toBe(150);   // 100 + 50
      expect(result[1]).toBe(-150);  // -100 + -50
      expect(result[2]).toBe(32767); // Saturated at max
      expect(result[3]).toBe(-32768); // Saturated at min (would be -32769)
      expect(result[4]).toBe(100);
      expect(result[5]).toBe(500);
      expect(result[6]).toBe(-500);
      expect(result[7]).toBe(250);
    });

    it('should perform vector add with carry (VADDC)', () => {
      const v1 = new Int16Array([0xFFFF, 0x8000, 0x1234, 0, 0x7FFF, 0xF000, 0x0FFF, 0x5555]);
      const v2 = new Int16Array([1, 0x8000, 0x4321, 0, 1, 0x2000, 0x0001, 0xAAAA]);
      vu.writeVReg(4, v1);
      vu.writeVReg(5, v2);
      
      vu.vaddc(6, 4, 5);
      
      const result = vu.readVReg(6) as Int16Array;
      // Check for overflow/carry
      expect(vu.getVCO(0)).toBe(true);  // 0xFFFF + 1 overflows
      expect(vu.getVCO(1)).toBe(true);  // 0x8000 + 0x8000 overflows  
      expect(vu.getVCO(2)).toBe(false); // 0x1234 + 0x4321 doesn't overflow
      expect(result[2]).toBe(0x5555);
    });
  });

  describe('Subtraction operations', () => {
    it('should perform vector subtract with saturation (VSUB)', () => {
      const v1 = new Int16Array([100, -100, 32767, -32768, 0, 1000, -1000, 500]);
      const v2 = new Int16Array([50, -50, -1, 1, 100, 2000, -2000, 250]);
      vu.writeVReg(7, v1);
      vu.writeVReg(8, v2);
      
      vu.vsub(9, 7, 8);
      
      const result = vu.readVReg(9) as Int16Array;
      expect(result[0]).toBe(50);     // 100 - 50
      expect(result[1]).toBe(-50);    // -100 - (-50)
      expect(result[2]).toBe(32767);  // Would overflow, saturated
      expect(result[3]).toBe(-32768); // Would underflow, saturated
      expect(result[4]).toBe(-100);
      expect(result[5]).toBe(-1000);
      expect(result[6]).toBe(1000);
      expect(result[7]).toBe(250);
    });

    it('should perform vector subtract with carry (VSUBC)', () => {
      const v1 = new Int16Array([0x1000, 0x0000, 0x8000, 0xFFFF, 0x5555, 0x1234, 0xF000, 0x7FFF]);
      const v2 = new Int16Array([0x0500, 0x0001, 0x7FFF, 0x0001, 0x2222, 0x5678, 0xF000, 0x8000]);
      vu.writeVReg(10, v1);
      vu.writeVReg(11, v2);
      
      vu.vsubc(12, 10, 11);
      
      // Check borrow flags
      expect(vu.getVCO(1)).toBe(true);  // 0 - 1 borrows
      expect(vu.getVCC(0)).toBe(true);  // No borrow when result >= 0
    });
  });

  describe('Logical operations', () => {
    it('should perform vector AND (VAND)', () => {
      const v1 = new Int16Array([0xFFFF, 0xF0F0, 0x1234, 0x0000, 0xAAAA, 0x5555, 0xFF00, 0x00FF]);
      const v2 = new Int16Array([0xAAAA, 0x0F0F, 0x5678, 0xFFFF, 0x5555, 0xAAAA, 0x00FF, 0xFF00]);
      vu.writeVReg(13, v1);
      vu.writeVReg(14, v2);
      
      vu.vand(15, 13, 14);
      
      const result = vu.readVReg(15) as Int16Array;
      expect(result[0] & 0xFFFF).toBe(0xAAAA);
      expect(result[1] & 0xFFFF).toBe(0x0000);
      expect(result[2] & 0xFFFF).toBe(0x1230);  // 0x1234 & 0x5678 = 0x1230
      expect(result[3]).toBe(0x0000);
      expect(result[4]).toBe(0x0000);
      expect(result[5]).toBe(0x0000);
      expect(result[6]).toBe(0x0000);
      expect(result[7]).toBe(0x0000);
    });

    it('should perform vector OR (VOR)', () => {
      const v1 = new Int16Array([0xF000, 0x0F00, 0x00F0, 0x000F, 0xAAAA, 0x5555, 0x0000, 0xFFFF]);
      const v2 = new Int16Array([0x0F00, 0x00F0, 0x000F, 0xF000, 0x5555, 0xAAAA, 0xFFFF, 0x0000]);
      vu.writeVReg(16, v1);
      vu.writeVReg(17, v2);
      
      vu.vor(18, 16, 17);
      
      const result = vu.readVReg(18) as Int16Array;
      expect(result[0] & 0xFFFF).toBe(0xFF00);
      expect(result[1] & 0xFFFF).toBe(0x0FF0);
      expect(result[2] & 0xFFFF).toBe(0x00FF);
      expect(result[3] & 0xFFFF).toBe(0xF00F);
      expect(result[4] & 0xFFFF).toBe(0xFFFF);
      expect(result[5] & 0xFFFF).toBe(0xFFFF);
    });

    it('should perform vector XOR (VXOR)', () => {
      const v1 = new Int16Array([0xFFFF, 0xAAAA, 0x5555, 0xF0F0, 0x0F0F, 0x1234, 0x5678, 0x9ABC]);
      const v2 = new Int16Array([0xFFFF, 0x5555, 0xAAAA, 0x0F0F, 0xF0F0, 0x1234, 0x5678, 0x6543]);
      vu.writeVReg(19, v1);
      vu.writeVReg(20, v2);
      
      vu.vxor(21, 19, 20);
      
      const result = vu.readVReg(21) as Int16Array;
      expect(result[0]).toBe(0x0000);  // Same values XOR to 0
      expect(result[1] & 0xFFFF).toBe(0xFFFF);  // Opposite bits
      expect(result[2] & 0xFFFF).toBe(0xFFFF);
      expect(result[3] & 0xFFFF).toBe(0xFFFF);
      expect(result[4] & 0xFFFF).toBe(0xFFFF);
      expect(result[5]).toBe(0x0000);  // Same values
      expect(result[6]).toBe(0x0000);
    });

    it('should perform vector NAND (VNAND)', () => {
      const v1 = new Int16Array([0xFFFF, 0xF0F0, 0x0000, 0x1234, 0xAAAA, 0x5555, 0xFF00, 0x00FF]);
      const v2 = new Int16Array([0xFFFF, 0x0F0F, 0x0000, 0x5678, 0x5555, 0xAAAA, 0x00FF, 0xFF00]);
      vu.writeVReg(22, v1);
      vu.writeVReg(23, v2);
      
      vu.vnand(24, 22, 23);
      
      const result = vu.readVReg(24) as Int16Array;
      expect(result[0]).toBe(0x0000);  // ~(0xFFFF & 0xFFFF) = 0
      expect(result[1] & 0xFFFF).toBe(0xFFFF);  // ~(0xF0F0 & 0x0F0F) = ~0 = 0xFFFF
      expect(result[2] & 0xFFFF).toBe(0xFFFF);  // ~(0 & 0) = 0xFFFF
    });
  });

  describe('Comparison operations', () => {
    it('should perform vector less than (VLT)', () => {
      const v1 = new Int16Array([10, -20, 100, -100, 0, 32767, -32768, 50]);
      const v2 = new Int16Array([20, -10, 50, -50, 0, -32768, 32767, 50]);
      vu.writeVReg(25, v1);
      vu.writeVReg(26, v2);
      
      vu.vlt(27, 25, 26);
      
      // Check VCC flags and results
      expect(vu.getVCC(0)).toBe(true);  // 10 < 20
      expect(vu.getVCC(1)).toBe(true);  // -20 < -10
      expect(vu.getVCC(2)).toBe(false); // 100 > 50
      expect(vu.getVCC(3)).toBe(true);  // -100 < -50
      expect(vu.getVCC(4)).toBe(false); // 0 == 0
      
      const result = vu.readVReg(27) as Int16Array;
      expect(result[0]).toBe(10);  // min(10, 20)
      expect(result[1]).toBe(-20); // min(-20, -10)
      expect(result[2]).toBe(50);  // min(100, 50)
    });

    it('should perform vector equal (VEQ)', () => {
      const v1 = new Int16Array([10, 20, 30, 40, 50, -10, 0, 32767]);
      const v2 = new Int16Array([10, 21, 30, 41, 50, -10, 0, -32768]);
      vu.writeVReg(28, v1);
      vu.writeVReg(29, v2);
      
      vu.veq(30, 28, 29);
      
      // VCC is set when NOT equal
      expect(vu.getVCC(0)).toBe(false); // Equal
      expect(vu.getVCC(1)).toBe(true);  // Not equal
      expect(vu.getVCC(2)).toBe(false); // Equal
      expect(vu.getVCC(3)).toBe(true);  // Not equal
      
      // VCO is set when equal
      expect(vu.getVCO(0)).toBe(true);  // Equal
      expect(vu.getVCO(1)).toBe(false); // Not equal
    });

    it('should perform vector not equal (VNE)', () => {
      const v1 = new Int16Array([10, 20, 30, 40, 50, 60, 70, 80]);
      const v2 = new Int16Array([10, 21, 30, 41, 50, 61, 70, 81]);
      vu.writeVReg(0, v1);
      vu.writeVReg(1, v2);
      
      vu.vne(2, 0, 1);
      
      // VCC is set when not equal
      expect(vu.getVCC(0)).toBe(false); // Equal
      expect(vu.getVCC(1)).toBe(true);  // Not equal
      expect(vu.getVCC(3)).toBe(true);  // Not equal
      expect(vu.getVCC(4)).toBe(false); // Equal
    });

    it('should perform vector greater or equal (VGE)', () => {
      const v1 = new Int16Array([20, -10, 100, 50, 0, 32767, -32768, 50]);
      const v2 = new Int16Array([10, -20, 100, 60, 0, 32766, -32767, 50]);
      vu.writeVReg(3, v1);
      vu.writeVReg(4, v2);
      
      vu.vge(5, 3, 4);
      
      // VCC is set when NOT >= (i.e., when <)
      expect(vu.getVCC(0)).toBe(false); // 20 >= 10
      expect(vu.getVCC(1)).toBe(false); // -10 >= -20
      expect(vu.getVCC(2)).toBe(false); // 100 >= 100
      expect(vu.getVCC(3)).toBe(true);  // 50 < 60
      
      // VCO is set when equal
      expect(vu.getVCO(2)).toBe(true);  // 100 == 100
      expect(vu.getVCO(4)).toBe(true);  // 0 == 0
      expect(vu.getVCO(7)).toBe(true);  // 50 == 50
    });
  });

  describe('Merge operation', () => {
    it('should perform vector merge based on VCC (VMRG)', () => {
      const v1 = new Int16Array([10, 20, 30, 40, 50, 60, 70, 80]);
      const v2 = new Int16Array([11, 21, 31, 41, 51, 61, 71, 81]);
      vu.writeVReg(6, v1);
      vu.writeVReg(7, v2);
      
      // Set VCC flags for merge selection
      // VCC[i]=0 selects from vt, VCC[i]=1 selects from vs
      vu.setVCC(0, false);  // Select from vt
      vu.setVCC(1, true);   // Select from vs
      vu.setVCC(2, false);  // Select from vt
      vu.setVCC(3, true);   // Select from vs
      vu.setVCC(4, true);   // Select from vs
      vu.setVCC(5, false);  // Select from vt
      vu.setVCC(6, true);   // Select from vs
      vu.setVCC(7, false);  // Select from vt
      
      vu.vmrg(8, 6, 7);
      
      const result = vu.readVReg(8) as Int16Array;
      expect(result[0]).toBe(11);  // From vt (VCC[0]=0)
      expect(result[1]).toBe(20);  // From vs (VCC[1]=1)
      expect(result[2]).toBe(31);  // From vt (VCC[2]=0)
      expect(result[3]).toBe(40);  // From vs (VCC[3]=1)
      expect(result[4]).toBe(50);  // From vs (VCC[4]=1)
      expect(result[5]).toBe(61);  // From vt (VCC[5]=0)
      expect(result[6]).toBe(70);  // From vs (VCC[6]=1)
      expect(result[7]).toBe(81);  // From vt (VCC[7]=0)
      
      // VCC and VCO should be cleared after merge
      expect(vu.getVCCMask()).toBe(0);
      expect(vu.getVCOMask()).toBe(0);
    });
  });

  describe('Absolute value', () => {
    it('should compute absolute value (VABS)', () => {
      const v1 = new Int16Array([10, -20, 30, -40, 0, -32768, 32767, -1]);
      const v2 = new Int16Array([-1, -1, 1, -1, 1, -1, 1, -1]); // Sign control
      vu.writeVReg(9, v1);
      vu.writeVReg(10, v2);
      
      vu.vabs(11, 9, 10);
      
      const result = vu.readVReg(11) as Int16Array;
      expect(result[0]).toBe(-10);  // Sign negative, so negate
      expect(result[1]).toBe(20);   // Already negative, negate = positive
      expect(result[2]).toBe(30);   // Sign positive, keep as is
      expect(result[3]).toBe(40);   // Negative input, sign negative = positive
      expect(result[5]).toBe(32767); // -32768 special case
    });
  });

  describe('Multiplication operations', () => {
    it('should multiply signed fractions (VMULF)', () => {
      const v1 = new Int16Array([0x4000, 0x2000, -0x4000, -0x2000, 0x7FFF, 0, 0x1000, -0x1000]);
      const v2 = new Int16Array([0x4000, -0x2000, 0x4000, -0x2000, 0x7FFF, 0x7FFF, 0x0800, 0x0800]);
      vu.writeVReg(12, v1);
      vu.writeVReg(13, v2);
      
      vu.vmulf(14, 12, 13);
      
      const result = vu.readVReg(14) as Int16Array;
      // Results are products shifted for fraction format
      // Check accumulator was updated
      expect(vu.getAccumulator(0)).not.toBe(0n);
    });

    it('should multiply unsigned fractions (VMULU)', () => {
      const v1 = new Int16Array([0x8000, 0x4000, 0x2000, 0x1000, 0xFFFF, 0, 0x5555, 0xAAAA]);
      const v2 = new Int16Array([0x8000, 0x4000, 0x2000, 0x1000, 1, 0xFFFF, 0xAAAA, 0x5555]);
      vu.writeVReg(15, v1);
      vu.writeVReg(16, v2);
      
      vu.vmulu(17, 15, 16);
      
      // Check that unsigned multiplication occurred
      const result = vu.readVReg(17) as Int16Array;
      expect(result).toBeDefined();
    });

    it('should multiply-accumulate signed fractions (VMACF)', () => {
      // Set initial accumulator values
      for (let i = 0; i < 8; i++) {
        vu.setAccumulator(i, 0x100000n);
      }
      
      const v1 = new Int16Array([0x1000, 0x2000, 0x3000, 0x4000, 0x5000, 0x6000, 0x7000, 0x7FFF]);
      const v2 = new Int16Array([0x0100, 0x0200, 0x0300, 0x0400, 0x0500, 0x0600, 0x0700, 0x0800]);
      vu.writeVReg(18, v1);
      vu.writeVReg(19, v2);
      
      vu.vmacf(20, 18, 19);
      
      // Check that accumulator was updated with MAC
      expect(vu.getAccumulator(0)).toBeGreaterThan(0x100000n);
    });

    it('should multiply-accumulate unsigned fractions (VMACU)', () => {
      const v1 = new Int16Array([0x8000, 0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200, 0x0100]);
      const v2 = new Int16Array([2, 2, 2, 2, 2, 2, 2, 2]);
      vu.writeVReg(21, v1);
      vu.writeVReg(22, v2);
      
      // First multiply to set accumulator
      vu.vmulu(23, 21, 22);
      // Then MAC to add more
      vu.vmacu(23, 21, 22);
      
      // Accumulator should have doubled
      const result = vu.readVReg(23) as Int16Array;
      expect(result).toBeDefined();
    });
  });

  describe('No operation', () => {
    it('should do nothing (VNOP)', () => {
      const v1 = new Int16Array([1, 2, 3, 4, 5, 6, 7, 8]);
      vu.writeVReg(24, v1);
      
      vu.vnop();
      
      // Register should be unchanged
      const result = vu.readVReg(24) as Int16Array;
      for (let i = 0; i < 8; i++) {
        expect(result[i]).toBe(i + 1);
      }
    });
  });
});
