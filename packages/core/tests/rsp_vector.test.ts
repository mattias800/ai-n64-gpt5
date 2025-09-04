import { describe, it, expect, beforeEach } from 'vitest';
import { RspVectorUnit } from '../src/rsp/rsp_vu.js';

describe('RSP Vector Unit', () => {
  let vu: RspVectorUnit;

  beforeEach(() => {
    vu = new RspVectorUnit();
    vu.reset();
  });

  // Helper to set a vector register with 8 16-bit elements
  const setVR = (reg: number, values: number[]) => {
    for (let i = 0; i < 8; i++) {
      vu.setVectorElement(reg, i, values[i] ?? 0);
    }
  };

  // Helper to get all 8 elements of a vector register
  const getVR = (reg: number): number[] => {
    const result: number[] = [];
    for (let i = 0; i < 8; i++) {
      result.push(vu.getVectorElement(reg, i));
    }
    return result;
  };

  // Helper to convert signed 16-bit to unsigned for comparison
  const toU16 = (n: number): number => (n & 0xFFFF);
  const toS16 = (n: number): number => {
    const u = n & 0xFFFF;
    return (u & 0x8000) ? (u - 0x10000) : u;
  };

  describe('Vector Add Operations', () => {
    it('should execute VADD (signed add with saturation)', () => {
      setVR(1, [0x4000, 0x2000, -0x4000, -0x2000, 0x7FFF, -0x8000, 100, -100]);
      setVR(2, [0x3000, 0x1000, -0x3000, -0x1000, 1, -1, 200, -50]);
      
      vu.executeVADD(3, 1, 2, 0);
      
      const result = getVR(3);
      expect(result[0]).toBe(0x7000); // 0x4000 + 0x3000
      expect(result[1]).toBe(0x3000); // 0x2000 + 0x1000
      expect(result[2]).toBe(toU16(-0x7000)); // -0x4000 + -0x3000
      expect(result[3]).toBe(toU16(-0x3000)); // -0x2000 + -0x1000
      expect(result[4]).toBe(0x7FFF); // Saturated at max
      expect(result[5]).toBe(0x8000); // Saturated at min
      expect(result[6]).toBe(300);
      expect(result[7]).toBe(toU16(-150));
      
      // Check VCO carry flags
      expect(vu.getVCO()).toBe(0); // No unsigned overflow expected for these values
    });

    it('should execute VADDC (add with carry out)', () => {
      setVR(4, [0xFFFF, 0x8000, 0x7FFF, 0x0001, 0x1234, 0, 0xAAAA, 0x5555]);
      setVR(5, [0x0001, 0x8001, 0x0001, 0xFFFF, 0x5678, 0, 0x5556, 0xAAAB]);
      
      vu.executeVADDC(6, 4, 5, 0);
      
      const result = getVR(6);
      // Results are lower 16 bits of sum
      expect(result[0]).toBe(0x0000); // 0xFFFF + 1 = 0x10000, keep lower 16
      expect(result[1]).toBe(0x0001); // 0x8000 + 0x8001 = 0x10001
      expect(result[2]).toBe(0x8000); // 0x7FFF + 1
      expect(result[3]).toBe(0x0000); // 1 + 0xFFFF = 0x10000
      expect(result[4]).toBe(0x68AC); // 0x1234 + 0x5678
      expect(result[5]).toBe(0);
      expect(result[6]).toBe(0x0000); // 0xAAAA + 0x5556 = 0x10000
      expect(result[7]).toBe(0x0000); // 0x5555 + 0xAAAB = 0x10000
      
      // VCO should have carry bits set for lanes that overflowed
      const vco = vu.getVCO();
      expect((vco >> 0) & 1).toBe(1); // Lane 0 carried
      expect((vco >> 1) & 1).toBe(1); // Lane 1 carried
      expect((vco >> 2) & 1).toBe(0); // Lane 2 no carry
      expect((vco >> 3) & 1).toBe(1); // Lane 3 carried
      expect((vco >> 6) & 1).toBe(1); // Lane 6 carried
      expect((vco >> 7) & 1).toBe(1); // Lane 7 carried
    });

    it('should execute VSUB (signed subtract with saturation)', () => {
      setVR(7, [0x4000, 0x2000, -0x4000, -0x2000, -0x7FFF, 0x7FFF, 100, -100]);
      setVR(8, [0x3000, -0x1000, -0x3000, 0x1000, 2, -2, 50, -50]);
      
      vu.executeVSUB(9, 7, 8, 0);
      
      const result = getVR(9);
      expect(result[0]).toBe(0x1000); // 0x4000 - 0x3000
      expect(result[1]).toBe(0x3000); // 0x2000 - (-0x1000)
      expect(result[2]).toBe(toU16(-0x1000)); // -0x4000 - (-0x3000)
      expect(result[3]).toBe(toU16(-0x3000)); // -0x2000 - 0x1000
      expect(result[4]).toBe(0x8000); // Saturated at min
      expect(result[5]).toBe(0x7FFF); // Saturated at max
      expect(result[6]).toBe(50);
      expect(result[7]).toBe(toU16(-50));
    });

    it('should execute VSUBC (subtract with borrow out)', () => {
      setVR(10, [0x5000, 0x0000, 0x8000, 0x7FFF, 0xFFFF, 0x1234, 0x0001, 0x8000]);
      setVR(11, [0x3000, 0x0001, 0x7FFF, 0x8000, 0x0001, 0x1234, 0x0002, 0x8001]);
      
      vu.executeVSUBC(12, 10, 11, 0);
      
      const result = getVR(12);
      expect(result[0]).toBe(0x2000); // 0x5000 - 0x3000
      expect(result[1]).toBe(0xFFFF); // 0x0000 - 0x0001 with borrow
      expect(result[2]).toBe(0x0001); // 0x8000 - 0x7FFF
      expect(result[3]).toBe(0xFFFF); // 0x7FFF - 0x8000 with borrow
      expect(result[4]).toBe(0xFFFE); // 0xFFFF - 0x0001
      expect(result[5]).toBe(0x0000); // 0x1234 - 0x1234
      expect(result[6]).toBe(0xFFFF); // 0x0001 - 0x0002 with borrow
      expect(result[7]).toBe(0xFFFF); // 0x8000 - 0x8001 with borrow
      
      // Check VCO borrow bits
      const vco = vu.getVCO();
      expect((vco >> 1) & 1).toBe(1); // Lane 1 borrowed
      expect((vco >> 3) & 1).toBe(1); // Lane 3 borrowed
      expect((vco >> 6) & 1).toBe(1); // Lane 6 borrowed
      expect((vco >> 7) & 1).toBe(1); // Lane 7 borrowed
    });

    it('should execute VABS (absolute value)', () => {
      setVR(13, [0x7FFF, -0x8000, -1, 0, 100, -100, 0x4000, -0x4000]);
      setVR(14, [0, 0, 0, 0, 0, 0, 0, 0]); // Not used for VABS but vs is still decoded
      
      vu.executeVABS(15, 13, 14, 0);
      
      const result = getVR(15);
      expect(result[0]).toBe(0x7FFF); // Already positive
      expect(result[1]).toBe(0x8000); // -0x8000 stays as 0x8000 (special case)
      expect(result[2]).toBe(1); // abs(-1) = 1
      expect(result[3]).toBe(0); // abs(0) = 0
      expect(result[4]).toBe(100); // Already positive
      expect(result[5]).toBe(100); // abs(-100) = 100
      expect(result[6]).toBe(0x4000); // Already positive
      expect(result[7]).toBe(0x4000); // abs(-0x4000) = 0x4000
    });
  });

  describe('Vector Logical Operations', () => {
    it('should execute VAND', () => {
      setVR(1, [0xFFFF, 0xF0F0, 0x0F0F, 0xAAAA, 0x5555, 0x1234, 0xABCD, 0x0000]);
      setVR(2, [0x1234, 0x0F0F, 0xF0F0, 0x5555, 0xAAAA, 0x5678, 0xDCBA, 0xFFFF]);
      
      vu.executeVAND(3, 1, 2, 0);
      
      const result = getVR(3);
      expect(result[0]).toBe(0x1234); // 0xFFFF & 0x1234
      expect(result[1]).toBe(0x0000); // 0xF0F0 & 0x0F0F
      expect(result[2]).toBe(0x0000); // 0x0F0F & 0xF0F0
      expect(result[3]).toBe(0x0000); // 0xAAAA & 0x5555
      expect(result[4]).toBe(0x0000); // 0x5555 & 0xAAAA
      expect(result[5]).toBe(0x1230); // 0x1234 & 0x5678
      expect(result[6]).toBe(0x8888); // 0xABCD & 0xDCBA
      expect(result[7]).toBe(0x0000); // 0x0000 & 0xFFFF
    });

    it('should execute VOR', () => {
      setVR(4, [0x0000, 0xF0F0, 0x0F0F, 0xAAAA, 0x5555, 0x1234, 0xABCD, 0x0000]);
      setVR(5, [0x1234, 0x0F0F, 0xF0F0, 0x5555, 0xAAAA, 0x5678, 0xDCBA, 0xFFFF]);
      
      vu.executeVOR(6, 4, 5, 0);
      
      const result = getVR(6);
      expect(result[0]).toBe(0x1234); // 0x0000 | 0x1234
      expect(result[1]).toBe(0xFFFF); // 0xF0F0 | 0x0F0F
      expect(result[2]).toBe(0xFFFF); // 0x0F0F | 0xF0F0
      expect(result[3]).toBe(0xFFFF); // 0xAAAA | 0x5555
      expect(result[4]).toBe(0xFFFF); // 0x5555 | 0xAAAA
      expect(result[5]).toBe(0x567C); // 0x1234 | 0x5678
      expect(result[6]).toBe(0xFFFF); // 0xABCD | 0xDCBA
      expect(result[7]).toBe(0xFFFF); // 0x0000 | 0xFFFF
    });

    it('should execute VXOR', () => {
      setVR(7, [0xFFFF, 0xF0F0, 0x0F0F, 0xAAAA, 0x5555, 0x1234, 0xABCD, 0x1111]);
      setVR(8, [0x1234, 0x0F0F, 0xF0F0, 0x5555, 0xAAAA, 0x1234, 0xABCD, 0x2222]);
      
      vu.executeVXOR(9, 7, 8, 0);
      
      const result = getVR(9);
      expect(result[0]).toBe(0xEDCB); // 0xFFFF ^ 0x1234
      expect(result[1]).toBe(0xFFFF); // 0xF0F0 ^ 0x0F0F
      expect(result[2]).toBe(0xFFFF); // 0x0F0F ^ 0xF0F0
      expect(result[3]).toBe(0xFFFF); // 0xAAAA ^ 0x5555
      expect(result[4]).toBe(0xFFFF); // 0x5555 ^ 0xAAAA
      expect(result[5]).toBe(0x0000); // 0x1234 ^ 0x1234
      expect(result[6]).toBe(0x0000); // 0xABCD ^ 0xABCD
      expect(result[7]).toBe(0x3333); // 0x1111 ^ 0x2222
    });

    it('should execute VNAND', () => {
      setVR(10, [0xFFFF, 0xF0F0, 0x0F0F, 0xAAAA, 0x5555, 0x0000, 0xFFFF, 0x1234]);
      setVR(11, [0xFFFF, 0x0F0F, 0xF0F0, 0x5555, 0xAAAA, 0xFFFF, 0x0000, 0x5678]);
      
      vu.executeVNAND(12, 10, 11, 0);
      
      const result = getVR(12);
      expect(result[0]).toBe(0x0000); // ~(0xFFFF & 0xFFFF)
      expect(result[1]).toBe(0xFFFF); // ~(0xF0F0 & 0x0F0F)
      expect(result[2]).toBe(0xFFFF); // ~(0x0F0F & 0xF0F0)
      expect(result[3]).toBe(0xFFFF); // ~(0xAAAA & 0x5555)
      expect(result[4]).toBe(0xFFFF); // ~(0x5555 & 0xAAAA)
      expect(result[5]).toBe(0xFFFF); // ~(0x0000 & 0xFFFF)
      expect(result[6]).toBe(0xFFFF); // ~(0xFFFF & 0x0000)
      expect(result[7]).toBe(0xEDCF); // ~(0x1234 & 0x5678)
    });

    it('should execute VNOR', () => {
      setVR(13, [0x0000, 0xF0F0, 0x0F0F, 0xAAAA, 0x5555, 0x0000, 0xFFFF, 0x1234]);
      setVR(14, [0x0000, 0x0F0F, 0xF0F0, 0x5555, 0xAAAA, 0x0000, 0xFFFF, 0x5678]);
      
      vu.executeVNOR(15, 13, 14, 0);
      
      const result = getVR(15);
      expect(result[0]).toBe(0xFFFF); // ~(0x0000 | 0x0000)
      expect(result[1]).toBe(0x0000); // ~(0xF0F0 | 0x0F0F)
      expect(result[2]).toBe(0x0000); // ~(0x0F0F | 0xF0F0)
      expect(result[3]).toBe(0x0000); // ~(0xAAAA | 0x5555)
      expect(result[4]).toBe(0x0000); // ~(0x5555 | 0xAAAA)
      expect(result[5]).toBe(0xFFFF); // ~(0x0000 | 0x0000)
      expect(result[6]).toBe(0x0000); // ~(0xFFFF | 0xFFFF)
      expect(result[7]).toBe(0xA983); // ~(0x1234 | 0x5678)
    });
  });

  describe('Vector Comparison Operations', () => {
    it('should execute VLT (less than)', () => {
      setVR(1, [100, -100, 0, 0x7FFF, -0x8000, 50, -50, 1000]);
      setVR(2, [200, -50, 0, -0x8000, 0x7FFF, 50, -51, 1000]);
      
      vu.executeVLT(3, 1, 2, 0);
      
      const result = getVR(3);
      const vcc = vu.getVCC();
      const vco = vu.getVCO();
      
      // Result stores comparison flags
      expect(result[0]).toBe(0xFFFF); // 100 < 200 = true
      expect(result[1]).toBe(0xFFFF); // -100 < -50 = true
      expect(result[2]).toBe(0); // 0 < 0 = false
      expect(result[3]).toBe(0); // 0x7FFF < -0x8000 = false
      expect(result[4]).toBe(0xFFFF); // -0x8000 < 0x7FFF = true
      expect(result[5]).toBe(0); // 50 < 50 = false
      expect(result[6]).toBe(0); // -50 < -51 = false
      expect(result[7]).toBe(0); // 1000 < 1000 = false
      
      // VCC should have compare bits set
      expect((vcc >> 0) & 1).toBe(1); // Lane 0: true
      expect((vcc >> 1) & 1).toBe(1); // Lane 1: true
      expect((vcc >> 2) & 1).toBe(0); // Lane 2: false
      expect((vcc >> 4) & 1).toBe(1); // Lane 4: true
      
      // VCO clear bits (not equal)
      expect((vco >> 0) & 1).toBe(1); // Lane 0: not equal (100 != 200)
      expect((vco >> 2) & 1).toBe(0); // Lane 2: equal (0 == 0)
    });

    it('should execute VEQ (equal)', () => {
      setVR(4, [100, -100, 0, 0x7FFF, -0x8000, 50, 1234, 0xFFFF]);
      setVR(5, [100, -100, 0, 0x7FFE, -0x8000, 51, 1234, 0]);
      
      vu.executeVEQ(6, 4, 5, 0);
      
      const result = getVR(6);
      const vcc = vu.getVCC();
      
      expect(result[0]).toBe(0xFFFF); // 100 == 100 = true
      expect(result[1]).toBe(0xFFFF); // -100 == -100 = true
      expect(result[2]).toBe(0xFFFF); // 0 == 0 = true
      expect(result[3]).toBe(0); // 0x7FFF == 0x7FFE = false
      expect(result[4]).toBe(0xFFFF); // -0x8000 == -0x8000 = true
      expect(result[5]).toBe(0); // 50 == 51 = false
      expect(result[6]).toBe(0xFFFF); // 1234 == 1234 = true
      expect(result[7]).toBe(0); // 0xFFFF == 0 = false
      
      // VCC compare bits
      expect((vcc >> 0) & 1).toBe(1); // Lane 0: true
      expect((vcc >> 1) & 1).toBe(1); // Lane 1: true
      expect((vcc >> 2) & 1).toBe(1); // Lane 2: true
      expect((vcc >> 3) & 1).toBe(0); // Lane 3: false
    });

    it('should execute VNE (not equal)', () => {
      setVR(7, [100, -100, 0, 0x7FFF, -0x8000, 50, 1234, 0xFFFF]);
      setVR(8, [100, -101, 1, 0x7FFF, 0x8000, 50, 1235, 0xFFFF]);
      
      vu.executeVNE(9, 7, 8, 0);
      
      const result = getVR(9);
      const vcc = vu.getVCC();
      
      expect(result[0]).toBe(0); // 100 != 100 = false
      expect(result[1]).toBe(0xFFFF); // -100 != -101 = true
      expect(result[2]).toBe(0xFFFF); // 0 != 1 = true
      expect(result[3]).toBe(0); // 0x7FFF != 0x7FFF = false
      expect(result[4]).toBe(0); // -0x8000 != 0x8000 = false (both are -32768 in signed 16-bit)
      expect(result[5]).toBe(0); // 50 != 50 = false
      expect(result[6]).toBe(0xFFFF); // 1234 != 1235 = true
      expect(result[7]).toBe(0); // 0xFFFF != 0xFFFF = false
      
      // VCC should have bits set for not equal
      expect((vcc >> 1) & 1).toBe(1); // Lane 1: not equal
      expect((vcc >> 2) & 1).toBe(1); // Lane 2: not equal
    });

    it('should execute VGE (greater or equal)', () => {
      setVR(10, [100, -100, 0, 0x7FFF, -0x8000, 50, -50, 1000]);
      setVR(11, [100, -101, -1, 0x7FFE, -0x8000, 51, -49, 999]);
      
      vu.executeVGE(12, 10, 11, 0);
      
      const result = getVR(12);
      const vcc = vu.getVCC();
      
      expect(result[0]).toBe(0xFFFF); // 100 >= 100 = true
      expect(result[1]).toBe(0xFFFF); // -100 >= -101 = true
      expect(result[2]).toBe(0xFFFF); // 0 >= -1 = true
      expect(result[3]).toBe(0xFFFF); // 0x7FFF >= 0x7FFE = true
      expect(result[4]).toBe(0xFFFF); // -0x8000 >= -0x8000 = true
      expect(result[5]).toBe(0); // 50 >= 51 = false
      expect(result[6]).toBe(0); // -50 >= -49 = false
      expect(result[7]).toBe(0xFFFF); // 1000 >= 999 = true
    });
  });

  describe('Vector Multiply Operations', () => {
    it('should execute VMULF (multiply signed fractions)', () => {
      // Treat inputs as Q1.15 fixed-point (-1.0 to ~1.0)
      setVR(1, [0x4000, 0x2000, 0x8000, 0x7FFF, 0x1000, 0xF000, 0x0800, 0x0000]);
      setVR(2, [0x4000, 0x4000, 0x4000, 0x0002, 0x1000, 0x1000, 0x0800, 0x7FFF]);
      
      vu.executeVMULF(3, 1, 2, 0);
      
      const result = getVR(3);
      // 0x4000 * 0x4000 = 0.5 * 0.5 = 0.25 => 0x2000
      expect(result[0]).toBe(0x2000);
      // 0x2000 * 0x4000 = 0.25 * 0.5 = 0.125 => 0x1000
      expect(result[1]).toBe(0x1000);
      // 0x8000 * 0x4000 = -1.0 * 0.5 = -0.5 => 0xC000
      expect(result[2]).toBe(0xC000);
      // Check accumulator was updated for lane 0
      expect(vu.getAccLane(0)).toBe(0x200000); // Extended to 48-bit
    });

    it('should execute VMULU (multiply unsigned fractions)', () => {
      setVR(4, [0x8000, 0x4000, 0xFFFF, 0x0001, 0x1234, 0x5678, 0x0000, 0xAAAA]);
      setVR(5, [0x8000, 0x8000, 0x0001, 0xFFFF, 0x5678, 0x1234, 0xFFFF, 0x5555]);
      
      vu.executeVMULU(6, 4, 5, 0);
      
      const result = getVR(6);
      // Results are high 16 bits of unsigned multiply
      expect(result[0]).toBe(0x4000); // (0x8000 * 0x8000) >> 16
      expect(result[1]).toBe(0x2000); // (0x4000 * 0x8000) >> 16
    });
  });

  describe('Vector Select/Merge Operations', () => {
    it('should execute VMRG (merge based on VCC)', () => {
      // Set up VCC with alternating bits
      vu.setVCC(0b10101010); // Lanes 1, 3, 5, 7 set
      
      setVR(1, [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888]);
      setVR(2, [0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF, 0x0000, 0x1234]);
      
      vu.executeVMRG(3, 1, 2, 0);
      
      const result = getVR(3);
      expect(result[0]).toBe(0xAAAA); // VCC[0]=0, take vt
      expect(result[1]).toBe(0x2222); // VCC[1]=1, take vs
      expect(result[2]).toBe(0xCCCC); // VCC[2]=0, take vt
      expect(result[3]).toBe(0x4444); // VCC[3]=1, take vs
      expect(result[4]).toBe(0xEEEE); // VCC[4]=0, take vt
      expect(result[5]).toBe(0x6666); // VCC[5]=1, take vs
      expect(result[6]).toBe(0x0000); // VCC[6]=0, take vt
      expect(result[7]).toBe(0x8888); // VCC[7]=1, take vs
    });
  });

  describe('VNOP operation', () => {
    it('should execute VNOP (no operation)', () => {
      // Set some initial values
      setVR(1, [1, 2, 3, 4, 5, 6, 7, 8]);
      const vccBefore = vu.getVCC();
      const vcoBefore = vu.getVCO();
      const vceBefore = vu.getVCE();
      
      // Execute VNOP
      vu.executeVNOP(1, 2, 3, 0);
      
      // Nothing should change
      expect(getVR(1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(vu.getVCC()).toBe(vccBefore);
      expect(vu.getVCO()).toBe(vcoBefore);
      expect(vu.getVCE()).toBe(vceBefore);
    });
  });

  describe('Element access', () => {
    it('should properly handle element indexing', () => {
      // Test broadcast with element >= 8
      setVR(1, [0x1234, 0, 0, 0, 0, 0, 0, 0]);
      setVR(2, [0x1000, 0, 0, 0, 0, 0, 0, 0]);
      
      // When element >= 8, it broadcasts a specific element from vt
      vu.executeVADD(3, 1, 2, 0x08); // Broadcast element 0 of vt (0x08 = broadcast lane 0)
      
      const result = getVR(3);
      // Each lane adds vs[lane] + vt[0] (broadcast)
      expect(result[0]).toBe(0x2234); // vs[0]=0x1234 + vt[0]=0x1000
      expect(result[1]).toBe(0x1000); // vs[1]=0 + vt[0]=0x1000
    });

    it('should handle quarter selection (e=2)', () => {
      setVR(1, [0x1000, 0x2000, 0x3000, 0x4000, 0x5000, 0x6000, 0x7000, 0x8000]);
      setVR(2, [0x0100, 0x0200, 0x0300, 0x0400, 0x0500, 0x0600, 0x0700, 0x0800]);
      
      // Element = 2 means use upper 4 elements (indices 0,1,2,3 -> 0,1,2,3, 4,5,6,7 -> 0,1,2,3)
      vu.executeVADD(3, 1, 2, 0x02);
      
      const result = getVR(3);
      // For e=2 (quarter), lanes 0-3 use vt[0-3], lanes 4-7 use vt[0-3]
      expect(result[0]).toBe(0x1100); // vs[0] + vt[0]
      expect(result[1]).toBe(0x2200); // vs[1] + vt[1]
      expect(result[4]).toBe(0x5100); // vs[4] + vt[0] (wrapped)
      expect(result[5]).toBe(0x6200); // vs[5] + vt[1] (wrapped)
    });
  });

  describe('Accumulator operations', () => {
    it('should properly update accumulator in VMULF', () => {
      setVR(1, [0x4000, 0x8000, 0x2000, 0x0000, 0x7FFF, 0x0001, 0x1234, 0x5678]);
      setVR(2, [0x4000, 0x4000, 0x8000, 0x7FFF, 0x7FFF, 0xFFFF, 0x5678, 0x1234]);
      
      vu.executeVMULF(3, 1, 2, 0);
      
      // Check accumulator values (48-bit results)
      expect(vu.getAccLane(0)).toBe(0x200000); // 0x4000 * 0x4000 << 1
      expect(vu.getAccLane(1)).toBe(0xFFFFFFC00000); // 0x8000 * 0x4000 << 1 (negative)
      expect(vu.getAccLane(2)).toBe(0xFFFFFF000000); // 0x2000 * 0x8000 << 1 (negative)
    });
  });

  describe('Flag register state', () => {
    it('should maintain independent VCC, VCO, VCE registers', () => {
      vu.setVCC(0xAAAA);
      vu.setVCO(0x5555);
      vu.setVCE(0xFF);
      
      expect(vu.getVCC()).toBe(0xAAAA);
      expect(vu.getVCO()).toBe(0x5555);
      expect(vu.getVCE()).toBe(0xFF);
      
      // Reset should clear all flags
      vu.reset();
      expect(vu.getVCC()).toBe(0);
      expect(vu.getVCO()).toBe(0);
      expect(vu.getVCE()).toBe(0);
    });
  });
});
