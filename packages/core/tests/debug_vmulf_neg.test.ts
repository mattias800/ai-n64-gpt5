import { describe, it, expect } from 'vitest';
import { RspVectorUnit } from '../src/rsp/rsp_vu.js';

describe('Debug VMULF Negative', () => {
  it('should handle negative multiply correctly', () => {
    const vu = new RspVectorUnit();
    vu.reset();
    
    // Test case: 0x8000 * 0x4000
    // 0x8000 as signed = -32768 = -1.0 in Q1.15
    // 0x4000 as signed = 16384 = 0.5 in Q1.15
    // -1.0 * 0.5 = -0.5 => should be 0xC000
    vu.setVectorElement(1, 2, 0x8000);
    vu.setVectorElement(2, 2, 0x4000);
    
    console.log('Testing 0x8000 * 0x4000:');
    
    // Get actual Int16 values
    const vreg1 = (vu as any).vregs[1];
    const vreg2 = (vu as any).vregs[2];
    const a = vreg1[2];
    const b = vreg2[2];
    
    console.log('a (0x8000 as Int16):', a);
    console.log('b (0x4000 as Int16):', b);
    console.log('a * b:', a * b);
    console.log('(a * b) << 1:', (a * b) << 1);
    console.log('((a * b) << 1) >>> 16:', ((a * b) << 1) >>> 16);
    
    // The issue is that -32768 * 16384 = -536870912
    // And (-536870912 << 1) = -1073741824
    // And (-1073741824 >>> 16) = 49151 (0xBFFF)
    // But we need to handle this as signed properly
    
    vu.executeVMULF(3, 1, 2, 0);
    
    const result = vu.getVectorElement(3, 2);
    console.log('Result[2]:', result.toString(16), '(expected: 0xC000)');
    
    // Let's check what clamping does
    const prod = (a * b) << 1;
    console.log('prod before clamp:', prod);
    console.log('prod >>> 16:', prod >>> 16);
    
    expect(result).toBe(0xC000);
  });
});
