import { describe, it, expect, beforeEach } from 'vitest';
import { COP1, FPURoundingMode, FPUException } from '../src/cpu/cop1.js';

describe('COP1 (Floating Point Unit)', () => {
  let fpu: COP1;

  beforeEach(() => {
    fpu = new COP1();
  });

  describe('initialization', () => {
    it('should initialize with default FCR31', () => {
      const status = fpu.getStatus();
      expect(status.fcr31).toBe(0x01000800);
      expect(status.busy).toBe(false);
      expect(status.exceptions).toBe(0);
    });

    it('should have correct default rounding mode', () => {
      expect(fpu.getRoundingMode()).toBe(FPURoundingMode.RN);
    });
  });

  describe('single-precision operations', () => {
    it('should perform addition correctly', () => {
      fpu.writeS(1, 3.5);
      fpu.writeS(2, 2.5);
      const cycles = fpu.addS(3, 1, 2);
      
      expect(fpu.readS(3)).toBeCloseTo(6.0);
      expect(cycles).toBe(3); // ADD_S takes 3 cycles
    });

    it('should perform subtraction correctly', () => {
      fpu.writeS(1, 5.5);
      fpu.writeS(2, 2.5);
      const cycles = fpu.subS(3, 1, 2);
      
      expect(fpu.readS(3)).toBeCloseTo(3.0);
      expect(cycles).toBe(3); // SUB_S takes 3 cycles
    });

    it('should perform multiplication correctly', () => {
      fpu.writeS(1, 3.0);
      fpu.writeS(2, 4.0);
      const cycles = fpu.mulS(3, 1, 2);
      
      expect(fpu.readS(3)).toBeCloseTo(12.0);
      expect(cycles).toBe(5); // MUL_S takes 5 cycles
    });

    it('should perform division correctly', () => {
      fpu.writeS(1, 10.0);
      fpu.writeS(2, 2.0);
      const cycles = fpu.divS(3, 1, 2);
      
      expect(fpu.readS(3)).toBeCloseTo(5.0);
      expect(cycles).toBe(29); // DIV_S takes 29 cycles
    });

    it('should handle division by zero', () => {
      fpu.writeS(1, 10.0);
      fpu.writeS(2, 0.0);
      fpu.divS(3, 1, 2);
      
      expect(fpu.readS(3)).toBe(Infinity);
      const status = fpu.getStatus();
      // Check if DIV_BY_ZERO (bit 3) is set in exceptions (which are in bits 12-17 of FCR31)
      expect(status.exceptions & FPUException.DIV_BY_ZERO).toBeGreaterThan(0);
    });

    it('should perform square root correctly', () => {
      fpu.writeS(1, 16.0);
      const cycles = fpu.sqrtS(2, 1);
      
      expect(fpu.readS(2)).toBeCloseTo(4.0);
      expect(cycles).toBe(29); // SQRT_S takes 29 cycles
    });

    it('should handle negative square root', () => {
      fpu.writeS(1, -4.0);
      fpu.sqrtS(2, 1);
      
      expect(fpu.readS(2)).toBeNaN();
    });
  });

  describe('double-precision operations', () => {
    it('should perform addition correctly', () => {
      fpu.writeD(0, 3.5);
      fpu.writeD(2, 2.5);
      const cycles = fpu.addD(4, 0, 2);
      
      expect(fpu.readD(4)).toBeCloseTo(6.0);
      expect(cycles).toBe(3); // ADD_D takes 3 cycles
    });

    it('should perform multiplication correctly', () => {
      fpu.writeD(0, 3.0);
      fpu.writeD(2, 4.0);
      const cycles = fpu.mulD(4, 0, 2);
      
      expect(fpu.readD(4)).toBeCloseTo(12.0);
      expect(cycles).toBe(8); // MUL_D takes 8 cycles
    });

    it('should perform division correctly', () => {
      fpu.writeD(0, 10.0);
      fpu.writeD(2, 2.0);
      const cycles = fpu.divD(4, 0, 2);
      
      expect(fpu.readD(4)).toBeCloseTo(5.0);
      expect(cycles).toBe(58); // DIV_D takes 58 cycles
    });

    it('should perform square root correctly', () => {
      fpu.writeD(0, 25.0);
      const cycles = fpu.sqrtD(2, 0);
      
      expect(fpu.readD(2)).toBeCloseTo(5.0);
      expect(cycles).toBe(58); // SQRT_D takes 58 cycles
    });
  });

  describe('format conversions', () => {
    it('should convert single to double', () => {
      fpu.writeS(1, 3.14159);
      const cycles = fpu.cvtDS(2, 1);
      
      expect(fpu.readD(2)).toBeCloseTo(3.14159, 5);
      expect(cycles).toBe(2); // CVT takes 2 cycles
    });

    it('should convert double to single', () => {
      fpu.writeD(0, 3.14159265359);
      const cycles = fpu.cvtSD(1, 0);
      
      expect(fpu.readS(1)).toBeCloseTo(3.14159, 5);
      expect(cycles).toBe(2);
    });

    it('should convert word to single', () => {
      fpu.writeS(1, 42); // Store integer as float bits
      const cycles = fpu.cvtSW(2, 1);
      
      expect(cycles).toBe(2);
    });

    it('should convert single to word with rounding modes', () => {
      // Test round to nearest (default)
      fpu.writeS(1, 3.7);
      fpu.cvtWS(2, 1);
      expect(fpu.readS(2)).toBe(4);

      // Test truncate (round toward zero)
      fpu.writeControl(31, (fpu.readControl(31) & ~3) | FPURoundingMode.RZ);
      fpu.writeS(1, 3.7);
      fpu.cvtWS(3, 1);
      expect(fpu.readS(3)).toBe(3);

      // Test round toward +infinity
      fpu.writeControl(31, (fpu.readControl(31) & ~3) | FPURoundingMode.RP);
      fpu.writeS(1, 3.1);
      fpu.cvtWS(4, 1);
      expect(fpu.readS(4)).toBe(4);

      // Test round toward -infinity
      fpu.writeControl(31, (fpu.readControl(31) & ~3) | FPURoundingMode.RM);
      fpu.writeS(1, 3.9);
      fpu.cvtWS(5, 1);
      expect(fpu.readS(5)).toBe(3);
    });
  });

  describe('comparisons', () => {
    it('should compare single-precision values', () => {
      fpu.writeS(1, 3.0);
      fpu.writeS(2, 5.0);
      
      // Less than comparison (cond = 4)
      const cycles = fpu.compareS(1, 2, 4);
      expect(fpu.getCondition()).toBe(true);
      expect(cycles).toBe(1); // CMP takes 1 cycle
    });

    it('should compare equal values', () => {
      fpu.writeS(1, 3.0);
      fpu.writeS(2, 3.0);
      
      // Equal comparison (cond = 2)
      fpu.compareS(1, 2, 2);
      expect(fpu.getCondition()).toBe(true);
    });

    it('should handle unordered comparisons', () => {
      fpu.writeS(1, NaN);
      fpu.writeS(2, 3.0);
      
      // Unordered comparison (cond = 1)
      fpu.compareS(1, 2, 1);
      expect(fpu.getCondition()).toBe(true);
    });

    it('should compare double-precision values', () => {
      fpu.writeD(0, 3.0);
      fpu.writeD(2, 5.0);
      
      // Less than comparison
      const cycles = fpu.compareD(0, 2, 4);
      expect(fpu.getCondition()).toBe(true);
      expect(cycles).toBe(1);
    });
  });

  describe('control registers', () => {
    it('should read FCR31', () => {
      expect(fpu.readControl(31)).toBe(0x01000800);
    });

    it('should read FCR0 (implementation register)', () => {
      expect(fpu.readControl(0)).toBe(0x00000B00);
    });

    it('should write FCR31', () => {
      fpu.writeControl(31, 0x01000801);
      expect(fpu.readControl(31)).toBe(0x01000801);
    });

    it('should update rounding mode', () => {
      fpu.writeControl(31, (fpu.readControl(31) & ~3) | FPURoundingMode.RZ);
      expect(fpu.getRoundingMode()).toBe(FPURoundingMode.RZ);
    });
  });

  describe('exception handling', () => {
    it('should clear exception flags', () => {
      // Cause an exception
      fpu.writeS(1, 1.0);
      fpu.writeS(2, 0.0);
      fpu.divS(3, 1, 2);
      
      let status = fpu.getStatus();
      expect(status.exceptions).toBeGreaterThan(0);
      
      // Clear exceptions
      fpu.clearExceptions();
      
      status = fpu.getStatus();
      expect(status.exceptions).toBe(0);
    });
  });

  describe('cycle timing accuracy', () => {
    const operations = [
      { name: 'ADD_S', fn: () => fpu.addS(0, 1, 2), expected: 3 },
      { name: 'ADD_D', fn: () => fpu.addD(0, 2, 4), expected: 3 },
      { name: 'SUB_S', fn: () => fpu.subS(0, 1, 2), expected: 3 },
      { name: 'SUB_D', fn: () => fpu.subD(0, 2, 4), expected: 3 },
      { name: 'MUL_S', fn: () => fpu.mulS(0, 1, 2), expected: 5 },
      { name: 'MUL_D', fn: () => fpu.mulD(0, 2, 4), expected: 8 },
      { name: 'DIV_S', fn: () => fpu.divS(0, 1, 2), expected: 29 },
      { name: 'DIV_D', fn: () => fpu.divD(0, 2, 4), expected: 58 },
      { name: 'SQRT_S', fn: () => fpu.sqrtS(0, 1), expected: 29 },
      { name: 'SQRT_D', fn: () => fpu.sqrtD(0, 2), expected: 58 },
      { name: 'CVT', fn: () => fpu.cvtDS(0, 1), expected: 2 },
      { name: 'CMP', fn: () => fpu.compareS(1, 2, 0), expected: 1 },
    ];

    operations.forEach(({ name, fn, expected }) => {
      it(`should have correct cycle count for ${name}`, () => {
        // Initialize some values
        fpu.writeS(1, 1.0);
        fpu.writeS(2, 2.0);
        fpu.writeD(2, 1.0);
        fpu.writeD(4, 2.0);
        
        const cycles = fn();
        expect(cycles).toBe(expected);
      });
    });
  });
});
