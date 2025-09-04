import { describe, it, expect, beforeEach } from 'vitest';
import { RspVectorUnit } from '../src/rsp/rsp_vu.js';

describe('RSP Vector Unit - Basic Operations', () => {
  let vu: RspVectorUnit;

  beforeEach(() => {
    vu = new RspVectorUnit();
    vu.reset();
  });

  describe('Basic vector register access', () => {
    it('should store and retrieve vector elements', () => {
      vu.setVectorElement(1, 0, 0x1234);
      vu.setVectorElement(1, 1, 0x5678);
      vu.setVectorElement(1, 7, 0xABCD);
      
      expect(vu.getVectorElement(1, 0)).toBe(0x1234);
      expect(vu.getVectorElement(1, 1)).toBe(0x5678);
      expect(vu.getVectorElement(1, 7)).toBe(0xABCD);
    });
    
    it('should handle signed values', () => {
      vu.setVectorElement(2, 0, -100);
      vu.setVectorElement(2, 1, -32768);
      vu.setVectorElement(2, 2, 32767);
      
      // Values are stored as unsigned 16-bit
      expect(vu.getVectorElement(2, 0)).toBe((-100) & 0xFFFF);
      expect(vu.getVectorElement(2, 1)).toBe(0x8000);
      expect(vu.getVectorElement(2, 2)).toBe(0x7FFF);
    });
  });

  describe('Simple arithmetic', () => {
    it('should add vectors without overflow', () => {
      vu.setVectorElement(1, 0, 100);
      vu.setVectorElement(1, 1, 200);
      vu.setVectorElement(2, 0, 50);
      vu.setVectorElement(2, 1, 300);
      
      vu.executeVADD(3, 1, 2, 0);
      
      expect(vu.getVectorElement(3, 0)).toBe(150);
      expect(vu.getVectorElement(3, 1)).toBe(500);
    });

    it('should perform AND operation', () => {
      vu.setVectorElement(1, 0, 0xFFFF);
      vu.setVectorElement(1, 1, 0xF0F0);
      vu.setVectorElement(2, 0, 0x1234);
      vu.setVectorElement(2, 1, 0x0F0F);
      
      vu.executeVAND(3, 1, 2, 0);
      
      expect(vu.getVectorElement(3, 0)).toBe(0x1234);
      expect(vu.getVectorElement(3, 1)).toBe(0x0000);
    });

    it('should perform OR operation', () => {
      vu.setVectorElement(1, 0, 0xF000);
      vu.setVectorElement(1, 1, 0x00F0);
      vu.setVectorElement(2, 0, 0x0F00);
      vu.setVectorElement(2, 1, 0x000F);
      
      vu.executeVOR(3, 1, 2, 0);
      
      expect(vu.getVectorElement(3, 0)).toBe(0xFF00);
      expect(vu.getVectorElement(3, 1)).toBe(0x00FF);
    });
  });

  describe('Control flags', () => {
    it('should set and get VCC flags', () => {
      vu.setVCC(0xAA);
      expect(vu.getVCC()).toBe(0xAA);
      
      vu.setVCC(0x12345);
      expect(vu.getVCC()).toBe(0x2345); // Masked to 16 bits
    });

    it('should set and get VCO flags', () => {
      vu.setVCO(0x55);
      expect(vu.getVCO()).toBe(0x55);
    });

    it('should set and get VCE flags', () => {
      vu.setVCE(0xFF);
      expect(vu.getVCE()).toBe(0xFF);
      
      vu.setVCE(0x1FF);
      expect(vu.getVCE()).toBe(0xFF); // Masked to 8 bits
    });

    it('should clear flags on reset', () => {
      vu.setVCC(0xFFFF);
      vu.setVCO(0xFFFF);
      vu.setVCE(0xFF);
      
      vu.reset();
      
      expect(vu.getVCC()).toBe(0);
      expect(vu.getVCO()).toBe(0);
      expect(vu.getVCE()).toBe(0);
    });
  });

  describe('VADDC with carry detection', () => {
    it('should detect carry on unsigned overflow', () => {
      vu.setVectorElement(1, 0, 0xFFFF);
      vu.setVectorElement(1, 1, 0x8000);
      vu.setVectorElement(1, 2, 0x7FFF);
      vu.setVectorElement(2, 0, 0x0001);
      vu.setVectorElement(2, 1, 0x8001);
      vu.setVectorElement(2, 2, 0x0001);
      
      vu.executeVADDC(3, 1, 2, 0);
      
      // Check results (lower 16 bits)
      expect(vu.getVectorElement(3, 0)).toBe(0x0000); // Overflow
      expect(vu.getVectorElement(3, 1)).toBe(0x0001); // Overflow  
      expect(vu.getVectorElement(3, 2)).toBe(0x8000); // No overflow (0x7FFF + 1 = 0x8000)
      
      // Check VCO flags
      const vco = vu.getVCO();
      expect((vco >> 0) & 1).toBe(1); // Lane 0 carried
      expect((vco >> 1) & 1).toBe(1); // Lane 1 carried
      // Note: 0x7FFF + 1 = 0x8000 does not overflow in unsigned
    });
  });

  describe('VMRG merge operation', () => {
    it('should merge based on VCC flags', () => {
      // Set VCC with lanes 0,2,4,6 clear (take from vt)
      // and lanes 1,3,5,7 set (take from vs)
      vu.setVCC(0b10101010);
      
      // Set up source vectors
      for (let i = 0; i < 8; i++) {
        vu.setVectorElement(1, i, 0x1000 + i); // vs
        vu.setVectorElement(2, i, 0x2000 + i); // vt
      }
      
      vu.executeVMRG(3, 1, 2, 0);
      
      expect(vu.getVectorElement(3, 0)).toBe(0x2000); // VCC[0]=0, take vt
      expect(vu.getVectorElement(3, 1)).toBe(0x1001); // VCC[1]=1, take vs
      expect(vu.getVectorElement(3, 2)).toBe(0x2002); // VCC[2]=0, take vt
      expect(vu.getVectorElement(3, 3)).toBe(0x1003); // VCC[3]=1, take vs
      
      // VMRG should clear VCC and VCO after operation
      expect(vu.getVCC()).toBe(0);
      expect(vu.getVCO()).toBe(0);
    });
  });
});
