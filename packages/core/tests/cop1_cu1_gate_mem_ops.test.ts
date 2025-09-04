import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { Cop0 } from '../src/cpu/cop0.js';
import * as bit from '../src/utils/bit.js';

// Assembler helpers
const LUI = (rt: number, imm16: number) => (0x0f << 26) | (rt << 16) | (imm16 & 0xffff);
const ORI = (rt: number, rs: number, imm16: number) => (0x0d << 26) | (rs << 21) | (rt << 16) | (imm16 & 0xffff);
const BEQ = (rs: number, rt: number, off16: number) => (0x04 << 26) | (rs << 21) | (rt << 16) | (off16 & 0xffff);
const NOP = () => 0x00000000;

// FPU memory ops
const LWC1 = (ft: number, offset: number, base: number) => (0x31 << 26) | (base << 21) | (ft << 16) | (offset & 0xffff);
const SWC1 = (ft: number, offset: number, base: number) => (0x39 << 26) | (base << 21) | (ft << 16) | (offset & 0xffff);
const LDC1 = (ft: number, offset: number, base: number) => (0x35 << 26) | (base << 21) | (ft << 16) | (offset & 0xffff);
const SDC1 = (ft: number, offset: number, base: number) => (0x3d << 26) | (base << 21) | (ft << 16) | (offset & 0xffff);

const writeProgram = (rdram: RDRAM, words: number[], basePhys = 0) => {
  for (let i = 0; i < words.length; i++) {
    bit.writeU32BE(rdram.bytes, basePhys + i * 4, words[i] >>> 0);
  }
};

const kseg0 = (p: number) => (0x80000000 >>> 0) + (p >>> 0);

describe('COP1 memory operations CU1 gating', () => {
  describe('CU1 disabled - should raise Coprocessor Unusable', () => {
    it('LWC1 with CU1 disabled raises exception without loading', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      // Disable BEV for deterministic vectors
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      // Ensure CU1 is disabled (bit 29)
      cpu.cop0.write(12, cpu.cop0.read(12) & ~Cop0.STATUS_CU1);
      
      // Store test value in memory
      bit.writeU32BE(rdram.bytes, 0, 0x3f800000);
      
      // Program: LUI r1 with upper part of kseg0(0), ORI to complete address, LWC1 ft=2, 0(r1)
      const prog = [
        LUI(1, 0x8000),  // r1 = 0x80000000
        LWC1(2, 0, 1),   // LWC1 ft=2, 0(r1)
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      // Save initial FPR value
      const initialFpr2 = cpu.fpr[2];
      
      // Step through
      cpu.step(); // LUI
      expect(cpu.regs[1]).toBe(0x80000000);
      
      cpu.step(); // LWC1 -> should trap
      
      // Check exception state
      const cause = cpu.cop0.read(13) >>> 0;
      const status = cpu.cop0.read(12) >>> 0;
      
      expect(((cause >>> 2) & 0x1f) >>> 0).toBe(11); // Coprocessor Unusable
      expect((cause >>> 31) & 1).toBe(0); // BD not set
      expect(cpu.pc >>> 0).toBe((0x80000000 + 0x180) >>> 0); // Exception vector
      expect((status & Cop0.STATUS_EXL) >>> 0).toBeGreaterThan(0); // EXL set
      expect(cpu.fpr[2]).toBe(initialFpr2); // FPR unchanged
    });

    it('SWC1 with CU1 disabled raises exception without storing', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) & ~Cop0.STATUS_CU1);
      
      // Initialize memory with pattern
      bit.writeU32BE(rdram.bytes, 0, 0x11223344);
      
      // Set FPR value
      cpu.fpr[3] = 0xdeadbeef;
      
      const prog = [
        LUI(1, 0x8000),
        SWC1(3, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      cpu.step(); // SWC1 -> should trap
      
      const cause = cpu.cop0.read(13) >>> 0;
      expect(((cause >>> 2) & 0x1f) >>> 0).toBe(11);
      expect((cause >>> 31) & 1).toBe(0);
      
      // Memory should be unchanged
      expect(bit.readU32BE(rdram.bytes, 0)).toBe(0x11223344);
    });

    it('LDC1 with CU1 disabled raises exception without loading', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) & ~Cop0.STATUS_CU1);
      
      // Initialize memory with two words
      bit.writeU32BE(rdram.bytes, 0, 0x11223344);
      bit.writeU32BE(rdram.bytes, 4, 0x55667788);
      
      const prog = [
        LUI(1, 0x8000),
        LDC1(4, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      const initialFpr4 = cpu.fpr[4];
      const initialFpr5 = cpu.fpr[5];
      
      cpu.step(); // LUI
      cpu.step(); // LDC1 -> should trap
      
      const cause = cpu.cop0.read(13) >>> 0;
      expect(((cause >>> 2) & 0x1f) >>> 0).toBe(11);
      expect(cpu.fpr[4]).toBe(initialFpr4);
      expect(cpu.fpr[5]).toBe(initialFpr5);
    });

    it('SDC1 with CU1 disabled raises exception without storing', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) & ~Cop0.STATUS_CU1);
      
      // Initialize memory
      bit.writeU32BE(rdram.bytes, 0, 0x11111111);
      bit.writeU32BE(rdram.bytes, 4, 0x22222222);
      
      // Set FPR values
      cpu.fpr[6] = 0xaabbccdd;
      cpu.fpr[7] = 0x12345678;
      
      const prog = [
        LUI(1, 0x8000),
        SDC1(6, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      cpu.step(); // SDC1 -> should trap
      
      const cause = cpu.cop0.read(13) >>> 0;
      expect(((cause >>> 2) & 0x1f) >>> 0).toBe(11);
      
      // Memory should be unchanged
      expect(bit.readU32BE(rdram.bytes, 0)).toBe(0x11111111);
      expect(bit.readU32BE(rdram.bytes, 4)).toBe(0x22222222);
    });
  });

  describe('CU1 disabled in branch delay slot', () => {
    it('LWC1 in delay slot with CU1 disabled sets BD and correct EPC', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) & ~Cop0.STATUS_CU1);
      
      const prog = [
        LUI(1, 0x8000),
        BEQ(0, 0, 1),    // Always taken branch
        LWC1(2, 0, 1),   // In delay slot
        NOP(),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      const branchPC = cpu.pc; // Address of BEQ
      cpu.step(); // BEQ (schedules branch)
      cpu.step(); // LWC1 in delay slot -> should trap with BD
      
      const cause = cpu.cop0.read(13) >>> 0;
      const epc = cpu.cop0.read(14) >>> 0;
      
      expect(((cause >>> 2) & 0x1f) >>> 0).toBe(11); // Coprocessor Unusable
      expect((cause >>> 31) & 1).toBe(1); // BD set
      expect(epc >>> 0).toBe(branchPC >>> 0); // EPC points to branch
      expect(cpu.pc >>> 0).toBe((0x80000000 + 0x180) >>> 0);
    });
  });

  describe('CU1 enabled - operations succeed', () => {
    it('LWC1 succeeds when CU1 is enabled', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      // Enable CU1
      cpu.cop0.write(12, cpu.cop0.read(12) | Cop0.STATUS_CU1);
      
      // Store test value
      bit.writeU32BE(rdram.bytes, 0, 0x3f800000);
      
      const prog = [
        LUI(1, 0x8000),
        LWC1(2, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      cpu.step(); // LWC1
      
      // Should have loaded the value
      expect(cpu.fpr[2]).toBe(0x3f800000);
      // No exception
      expect(cpu.pc >>> 0).not.toBe((0x80000000 + 0x180) >>> 0);
    });

    it('SWC1 succeeds when CU1 is enabled', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) | Cop0.STATUS_CU1);
      
      cpu.fpr[3] = 0xdeadbeef;
      
      const prog = [
        LUI(1, 0x8000),
        SWC1(3, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      cpu.step(); // SWC1
      
      // Should have stored the value
      expect(bit.readU32BE(rdram.bytes, 0)).toBe(0xdeadbeef);
      expect(cpu.pc >>> 0).not.toBe((0x80000000 + 0x180) >>> 0);
    });

    it('LDC1 succeeds when CU1 is enabled', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) | Cop0.STATUS_CU1);
      
      bit.writeU32BE(rdram.bytes, 0, 0x11223344);
      bit.writeU32BE(rdram.bytes, 4, 0x55667788);
      
      const prog = [
        LUI(1, 0x8000),
        LDC1(4, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      cpu.step(); // LDC1
      
      // Should have loaded both values
      expect(cpu.fpr[4]).toBe(0x11223344);
      expect(cpu.fpr[5]).toBe(0x55667788);
      expect(cpu.pc >>> 0).not.toBe((0x80000000 + 0x180) >>> 0);
    });

    it('SDC1 succeeds when CU1 is enabled', () => {
      const rdram = new RDRAM(64 * 1024);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      
      cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 22));
      cpu.cop0.write(12, cpu.cop0.read(12) | Cop0.STATUS_CU1);
      
      cpu.fpr[6] = 0xaabbccdd;
      cpu.fpr[7] = 0x12345678;
      
      const prog = [
        LUI(1, 0x8000),
        SDC1(6, 0, 1),
      ];
      
      writeProgram(bus.rdram, prog, 0x100);
      cpu.pc = kseg0(0x100);
      
      cpu.step(); // LUI
      cpu.step(); // SDC1
      
      // Should have stored both values
      expect(bit.readU32BE(rdram.bytes, 0)).toBe(0xaabbccdd);
      expect(bit.readU32BE(rdram.bytes, 4)).toBe(0x12345678);
      expect(cpu.pc >>> 0).not.toBe((0x80000000 + 0x180) >>> 0);
    });
  });
});
