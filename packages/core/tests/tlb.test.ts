import { describe, it, expect, beforeEach } from 'vitest';
import { TLB, TLBEntry } from '../src/cpu/tlb.js';

describe('TLB (Translation Lookaside Buffer)', () => {
  let tlb: TLB;

  beforeEach(() => {
    tlb = new TLB();
  });

  describe('initialization', () => {
    it('should initialize with 32 invalid entries', () => {
      const stats = tlb.getStats();
      expect(stats.entries).toBe(32);
      expect(stats.valid).toBe(0);
      expect(stats.wired).toBe(0);
      expect(stats.random).toBe(31);
    });
  });

  describe('entry management', () => {
    it('should write and read TLB entries', () => {
      const entry: TLBEntry = {
        vpn2: 0x80000,
        asid: 1,
        pageSize: 4096,
        global: false,
        valid0: true,
        valid1: true,
        dirty0: true,
        dirty1: true,
        pfn0: 0x1000,
        pfn1: 0x1001,
        cacheAttr0: 3,
        cacheAttr1: 3
      };

      tlb.writeEntry(0, entry);
      const readEntry = tlb.readEntry(0);
      
      expect(readEntry).toEqual(entry);
    });

    it('should return null for out-of-range entry index', () => {
      expect(tlb.readEntry(-1)).toBeNull();
      expect(tlb.readEntry(32)).toBeNull();
    });
  });

  describe('address translation', () => {
    beforeEach(() => {
      // Set up a valid TLB entry
      const entry: TLBEntry = {
        vpn2: 0x40000, // VPN2 for virtual address 0x80000000 is (0x80000000 >>> 13) = 0x40000
        asid: 1,
        pageSize: 4096,
        global: false,
        valid0: true,
        valid1: true,
        dirty0: true,
        dirty1: false, // Odd page is not dirty
        pfn0: 0x1000,
        pfn1: 0x1001,
        cacheAttr0: 3, // Cached
        cacheAttr1: 2  // Uncached
      };
      tlb.writeEntry(0, entry);
    });

    it('should translate valid virtual address to physical address', () => {
      const result = tlb.translate(0x80000000, false, 1);
      expect(result).not.toBeNull();
      expect(result?.paddr).toBe(0x1000000);
      expect(result?.cached).toBe(true);
    });

    it('should return null for TLB miss', () => {
      const result = tlb.translate(0x90000000, false, 1);
      expect(result).toBeNull();
    });

    it('should respect ASID matching', () => {
      // Wrong ASID
      const result = tlb.translate(0x80000000, false, 2);
      expect(result).toBeNull();
    });

    it('should honor global bit', () => {
      const globalEntry: TLBEntry = {
        vpn2: 0x48000, // VPN2 for virtual address 0x90000000 is (0x90000000 >>> 13) = 0x48000
        asid: 5,
        pageSize: 4096,
        global: true, // Global entry ignores ASID
        valid0: true,
        valid1: true,
        dirty0: true,
        dirty1: true,
        pfn0: 0x2000,
        pfn1: 0x2001,
        cacheAttr0: 3,
        cacheAttr1: 3
      };
      tlb.writeEntry(1, globalEntry);

      // Should match even with different ASID
      const result = tlb.translate(0x90000000, false, 99);
      expect(result).not.toBeNull();
      expect(result?.paddr).toBe(0x2000000);
    });

    it('should check dirty bit for writes', () => {
      // Try to write to odd page (not dirty)
      const result = tlb.translate(0x80001000, true, 1);
      expect(result).toBeNull(); // Should fail because page is not dirty
    });

    it('should handle different page sizes', () => {
      const largePageEntry: TLBEntry = {
        vpn2: 0x50000, // VPN2 for virtual address 0xA0000000 is (0xA0000000 >>> 13) = 0x50000
        asid: 1,
        pageSize: 16384, // 16KB page
        global: false,
        valid0: true,
        valid1: true,
        dirty0: true,
        dirty1: true,
        pfn0: 0x3000,
        pfn1: 0x3004,
        cacheAttr0: 3,
        cacheAttr1: 3
      };
      tlb.writeEntry(2, largePageEntry);

      // Should translate addresses within the 16KB page
      const result1 = tlb.translate(0xA0000000, false, 1);
      expect(result1?.paddr).toBe(0x3000000);

      const result2 = tlb.translate(0xA0003FFF, false, 1);
      expect(result2?.paddr).toBe(0x3003FFF);
    });

    it('should determine cache attributes correctly', () => {
      // Even page is cached (cacheAttr0 = 3)
      const resultEven = tlb.translate(0x80000000, false, 1);
      expect(resultEven?.cached).toBe(true);

      // Odd page is uncached (cacheAttr1 = 2)
      const resultOdd = tlb.translate(0x80001000, false, 1);
      expect(resultOdd?.cached).toBe(false);
    });
  });

  describe('probe operation', () => {
    beforeEach(() => {
      const entry: TLBEntry = {
        vpn2: 0x40000, // VPN2 for 0x80000000 is (0x80000000 >>> 13) = 0x40000
        asid: 1,
        pageSize: 4096,
        global: false,
        valid0: true,
        valid1: true,
        dirty0: true,
        dirty1: true,
        pfn0: 0x1000,
        pfn1: 0x1001,
        cacheAttr0: 3,
        cacheAttr1: 3
      };
      tlb.writeEntry(5, entry);
    });

    it('should find matching entry', () => {
      const index = tlb.probe(0x40000, 1);
      expect(index).toBe(5);
    });

    it('should return -1 for no match', () => {
      const index = tlb.probe(0x90000, 1);
      expect(index).toBe(-1);
    });
  });

  describe('wired entries', () => {
    it('should set and get wired entries', () => {
      tlb.setWired(8);
      expect(tlb.getWired()).toBe(8);
    });

    it('should limit wired entries to 32', () => {
      tlb.setWired(100);
      expect(tlb.getWired()).toBe(32);
    });

    it('should affect random index', () => {
      tlb.setWired(16);
      expect(tlb.getRandomIndex()).toBeGreaterThanOrEqual(16);
      expect(tlb.getRandomIndex()).toBeLessThanOrEqual(31);
    });
  });

  describe('random index', () => {
    it('should decrement random index periodically', () => {
      const initial = tlb.getRandomIndex();
      
      // Tick 32 times to trigger random update
      for (let i = 0; i < 32; i++) {
        tlb.tick();
      }
      
      const after = tlb.getRandomIndex();
      expect(after).toBe(initial - 1);
    });

    it('should wrap around at wired boundary', () => {
      tlb.setWired(29);
      
      // Force random index to wired boundary
      while (tlb.getRandomIndex() > 29) {
        for (let i = 0; i < 32; i++) {
          tlb.tick();
        }
      }
      
      // Should be at wired boundary (29)
      expect(tlb.getRandomIndex()).toBe(29);
      
      // Next update should wrap to 31
      for (let i = 0; i < 32; i++) {
        tlb.tick();
      }
      expect(tlb.getRandomIndex()).toBe(31);
    });
  });

  describe('invalidate operations', () => {
    it('should invalidate all entries', () => {
      // Add some valid entries
      for (let i = 0; i < 5; i++) {
        const entry: TLBEntry = {
          vpn2: 0x80000 + i * 0x1000,
          asid: 1,
          pageSize: 4096,
          global: false,
          valid0: true,
          valid1: true,
          dirty0: true,
          dirty1: true,
          pfn0: 0x1000 + i,
          pfn1: 0x1001 + i,
          cacheAttr0: 3,
          cacheAttr1: 3
        };
        tlb.writeEntry(i, entry);
      }

      const statsBefore = tlb.getStats();
      expect(statsBefore.valid).toBe(10); // 5 entries * 2 pages

      tlb.invalidateAll();

      const statsAfter = tlb.getStats();
      expect(statsAfter.valid).toBe(0);
    });
  });

  describe('cycle accuracy', () => {
    it('should update random index every 32 cycles', () => {
      const initialRandom = tlb.getRandomIndex();
      let changes = 0;
      let lastRandom = initialRandom;

      for (let i = 0; i < 320; i++) {
        tlb.tick();
        const currentRandom = tlb.getRandomIndex();
        if (currentRandom !== lastRandom) {
          changes++;
          lastRandom = currentRandom;
        }
      }

      // Should have changed approximately 10 times (320 / 32)
      expect(changes).toBeGreaterThanOrEqual(8);
      expect(changes).toBeLessThanOrEqual(11);
    });
  });
});
