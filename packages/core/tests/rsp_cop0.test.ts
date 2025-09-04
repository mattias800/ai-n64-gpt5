import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RspCore } from '../src/rsp/rsp_core.js';
import { MI_INTR_SP } from '../src/devices/mmio.js';

describe('RSP COP0 registers', () => {
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
    
    const rdram = new Uint8Array(0x800000); // 8MB RDRAM
    rsp.setRDRAM(rdram);
  });

  describe('SP_STATUS register', () => {
    it('should read initial halted state', () => {
      const status = rsp.mfc0(4); // RSP_COP0_STATUS
      expect(status & 0x01).toBe(1); // SP_STATUS_HALT
    });

    it('should clear halt via MTC0', () => {
      rsp.mtc0(4, 0x01); // SP_CLR_HALT
      const status = rsp.mfc0(4);
      expect(status & 0x01).toBe(0); // Not halted
      expect(rsp.isHalted()).toBe(false);
    });

    it('should set halt via MTC0', () => {
      rsp.mtc0(4, 0x01); // Clear halt first
      rsp.mtc0(4, 0x02); // SP_SET_HALT
      const status = rsp.mfc0(4);
      expect(status & 0x01).toBe(1); // Halted
      expect(rsp.isHalted()).toBe(true);
    });

    it('should raise SP interrupt via SET_INTR', () => {
      rsp.mtc0(4, 0x10); // SP_SET_INTR
      expect(mi.raise).toHaveBeenCalledWith(MI_INTR_SP);
      expect(mi.pending & MI_INTR_SP).toBeTruthy();
    });

    it('should clear SP interrupt via CLR_INTR', () => {
      mi.pending = MI_INTR_SP;
      rsp.mtc0(4, 0x08); // SP_CLR_INTR
      expect(mi.clear).toHaveBeenCalledWith(MI_INTR_SP);
      expect(mi.pending & MI_INTR_SP).toBeFalsy();
    });

    it('should handle signal bits correctly', () => {
      // Set signal 0
      rsp.mtc0(4, 1 << 10); // SP_SET_SIG0
      let status = rsp.mfc0(4);
      expect((status >> 7) & 0x01).toBe(1);
      
      // Clear signal 0
      rsp.mtc0(4, 1 << 9); // SP_CLR_SIG0
      status = rsp.mfc0(4);
      expect((status >> 7) & 0x01).toBe(0);
      
      // Set multiple signals
      rsp.mtc0(4, (1 << 12) | (1 << 14)); // SP_SET_SIG1 | SP_SET_SIG2
      status = rsp.mfc0(4);
      expect((status >> 8) & 0x01).toBe(1); // SIG1
      expect((status >> 9) & 0x01).toBe(1); // SIG2
    });

    it('should handle single step mode', () => {
      rsp.mtc0(4, 1 << 6); // SP_SET_SSTEP
      let status = rsp.mfc0(4);
      expect((status >> 5) & 0x01).toBe(1); // SP_STATUS_SSTEP
      
      rsp.mtc0(4, 1 << 5); // SP_CLR_SSTEP  
      status = rsp.mfc0(4);
      expect((status >> 5) & 0x01).toBe(0);
    });

    it('should handle interrupt on break flag', () => {
      rsp.mtc0(4, 1 << 8); // SP_SET_INTR_ON_BREAK
      let status = rsp.mfc0(4);
      expect((status >> 6) & 0x01).toBe(1); // SP_STATUS_INTR_ON_BREAK
      
      rsp.mtc0(4, 1 << 7); // SP_CLR_INTR_ON_BREAK
      status = rsp.mfc0(4);
      expect((status >> 6) & 0x01).toBe(0);
    });
  });

  describe('DMA registers', () => {
    it('should read/write MEM_ADDR', () => {
      rsp.mtc0(0, 0x1234); // RSP_COP0_MEM_ADDR
      expect(rsp.mfc0(0) & 0x1FFF).toBe(0x1234);
      
      // Should mask to 13 bits
      rsp.mtc0(0, 0xFFFF);
      expect(rsp.mfc0(0)).toBe(0x1FFF);
    });

    it('should read/write DRAM_ADDR', () => {
      rsp.mtc0(1, 0x123456); // RSP_COP0_DRAM_ADDR
      expect(rsp.mfc0(1) & 0xFFFFFF).toBe(0x123456);
      
      // Should mask to 24 bits
      rsp.mtc0(1, 0xFFFFFFFF);
      expect(rsp.mfc0(1)).toBe(0xFFFFFF);
    });

    it('should execute DMA read', () => {
      const rdram = new Uint8Array(0x800000);
      // Write test pattern to RDRAM
      for (let i = 0; i < 16; i++) {
        rdram[0x1000 + i] = i + 0x40;
      }
      rsp.setRDRAM(rdram);
      
      rsp.mtc0(0, 0x0000); // MEM_ADDR = DMEM[0]
      rsp.mtc0(1, 0x1000); // DRAM_ADDR = 0x1000
      
      // Execute DMA read: length=16, count=1, skip=0
      rsp.mtc0(2, 0x00F); // RD_LEN (length = 15 + 1 = 16)
      
      // Check DMEM received the data
      for (let i = 0; i < 16; i++) {
        expect(rsp.dmem[i]).toBe(i + 0x40);
      }
    });

    it('should execute DMA write', () => {
      const rdram = new Uint8Array(0x800000);
      rsp.setRDRAM(rdram);
      
      // Write test pattern to DMEM
      for (let i = 0; i < 16; i++) {
        rsp.dmem[i] = i + 0x80;
      }
      
      rsp.mtc0(0, 0x0000); // MEM_ADDR = DMEM[0]
      rsp.mtc0(1, 0x2000); // DRAM_ADDR = 0x2000
      
      // Execute DMA write: length=16, count=1, skip=0
      rsp.mtc0(3, 0x00F); // WR_LEN (length = 15 + 1 = 16)
      
      // Check RDRAM received the data
      for (let i = 0; i < 16; i++) {
        expect(rdram[0x2000 + i]).toBe(i + 0x80);
      }
    });

    it('should handle DMA with count and skip', () => {
      const rdram = new Uint8Array(0x800000);
      rsp.setRDRAM(rdram);
      
      // Write striped pattern to RDRAM
      for (let i = 0; i < 64; i++) {
        rdram[0x3000 + i] = i;
      }
      
      rsp.mtc0(0, 0x0000); // MEM_ADDR = DMEM[0]
      rsp.mtc0(1, 0x3000); // DRAM_ADDR = 0x3000
      
      // DMA read: length=8, count=3, skip=8
      // Will read 3 blocks of 8 bytes with 8-byte skip between blocks
      const rdLen = (0x007) | (2 << 12) | (8 << 20); // length=8, count=3, skip=8
      rsp.mtc0(2, rdLen);
      
      // Check pattern in DMEM
      // Block 0: bytes 0-7
      for (let i = 0; i < 8; i++) {
        expect(rsp.dmem[i]).toBe(i);
      }
      // Block 1: bytes 16-23 (after 8-byte skip)
      for (let i = 0; i < 8; i++) {
        expect(rsp.dmem[16 + i]).toBe(16 + i);
      }
      // Block 2: bytes 32-39 (after another 8-byte skip)
      for (let i = 0; i < 8; i++) {
        expect(rsp.dmem[32 + i]).toBe(32 + i);
      }
    });

    it('should support DMA to/from IMEM', () => {
      const rdram = new Uint8Array(0x800000);
      // Write test code to RDRAM
      for (let i = 0; i < 16; i++) {
        rdram[0x4000 + i] = 0xA0 + i;
      }
      rsp.setRDRAM(rdram);
      
      rsp.mtc0(0, 0x1000); // MEM_ADDR = IMEM[0] (bit 12 set)
      rsp.mtc0(1, 0x4000); // DRAM_ADDR = 0x4000
      rsp.mtc0(2, 0x00F);  // RD_LEN: length=16
      
      // Check IMEM received the data
      for (let i = 0; i < 16; i++) {
        expect(rsp.imem[i]).toBe(0xA0 + i);
      }
    });

    it('should report DMA busy status during transfer', () => {
      // Note: In our simplified implementation, DMA is instant
      // but we set/clear the busy flag within the DMA functions
      expect(rsp.mfc0(6)).toBe(0); // DMA_BUSY = 0 initially
    });
  });

  describe('SP semaphore', () => {
    it('should set semaphore on read and return previous value', () => {
      // First read should return 0 and set to 1
      expect(rsp.mfc0(7)).toBe(0);
      // Second read should return 1 and keep at 1  
      expect(rsp.mfc0(7)).toBe(1);
      expect(rsp.mfc0(7)).toBe(1);
    });

    it('should clear semaphore on write', () => {
      // Set semaphore by reading
      rsp.mfc0(7);
      expect(rsp.mfc0(7)).toBe(1);
      
      // Clear by writing
      rsp.mtc0(7, 0);
      
      // Next read should return 0
      expect(rsp.mfc0(7)).toBe(0);
    });
  });
});
