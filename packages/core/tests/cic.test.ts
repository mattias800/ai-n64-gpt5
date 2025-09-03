import { describe, it, expect, beforeEach } from 'vitest';
import { CIC, CICType } from '../src/devices/cic.js';

describe('CIC Chip Emulation', () => {
  let cic: CIC;
  let pifRam: Uint8Array;

  beforeEach(() => {
    cic = new CIC(CICType.CIC_6102);
    pifRam = new Uint8Array(64);
  });

  describe('initialization', () => {
    it('should initialize with correct type and seed', () => {
      const status = cic.getStatus();
      expect(status.type).toBe(CICType.CIC_6102);
      expect(status.seed).toBe(0x3F);
      expect(status.authenticated).toBe(false);
    });

    it('should set correct seed for different CIC types', () => {
      const cic6103 = new CIC(CICType.CIC_6103);
      expect(cic6103.getStatus().seed).toBe(0x78);
      
      const cic6105 = new CIC(CICType.CIC_6105);
      expect(cic6105.getStatus().seed).toBe(0x91);
      
      const cic6106 = new CIC(CICType.CIC_6106);
      expect(cic6106.getStatus().seed).toBe(0x85);
    });
  });

  describe('authentication', () => {
    it('should not authenticate immediately', () => {
      const result = cic.authenticate(pifRam);
      expect(result).toBe(false);
      expect(cic.getStatus().authenticated).toBe(false);
    });

    it('should authenticate after sufficient cycles', () => {
      // Simulate 50,000 authentication cycles
      for (let i = 0; i < 50000; i++) {
        cic.authenticate(pifRam);
      }
      expect(cic.getStatus().authenticated).toBe(true);
    });

    it('should write authentication result to PIF RAM', () => {
      // Force authentication
      for (let i = 0; i < 50000; i++) {
        cic.authenticate(pifRam);
      }
      
      // Check that PIF RAM has been modified
      expect(pifRam[0x26]).toBe(0x3F); // Seed for CIC-6102
      expect(pifRam[0x27]).toBe(CICType.CIC_6102);
    });
  });

  describe('boot delay', () => {
    it('should not allow boot before authentication', () => {
      expect(cic.canBoot()).toBe(false);
    });

    it('should allow boot after authentication', () => {
      for (let i = 0; i < 50000; i++) {
        cic.authenticate(pifRam);
      }
      expect(cic.canBoot()).toBe(true);
    });

    it('should allow boot after timeout even without authentication', () => {
      // Simulate boot delay timeout (1,310,720 cycles)
      for (let i = 0; i < 1310720; i++) {
        cic.tick();
      }
      expect(cic.canBoot()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset authentication state', () => {
      // Authenticate first
      for (let i = 0; i < 50000; i++) {
        cic.authenticate(pifRam);
      }
      expect(cic.getStatus().authenticated).toBe(true);
      
      // Reset
      cic.reset();
      expect(cic.getStatus().authenticated).toBe(false);
    });
  });

  describe('cycle accuracy', () => {
    it('should take exactly AUTH_CYCLES to authenticate', () => {
      let authenticated = false;
      let cycleCount = 0;
      
      while (!authenticated && cycleCount < 100000) {
        authenticated = cic.authenticate(pifRam);
        cycleCount++;
      }
      
      // Should authenticate at exactly 50,000 cycles
      expect(cycleCount).toBe(50000);
      expect(authenticated).toBe(true);
    });
  });
});
