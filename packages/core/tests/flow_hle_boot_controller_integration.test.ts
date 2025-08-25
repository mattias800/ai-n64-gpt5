import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleBootAndInitController } from '../src/boot/flow.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_MODE_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function makeZ64(initialPC: number): Uint8Array {
  const rom = new Uint8Array(0x1000);
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40; // magic
  rom[8] = (initialPC >>> 24) & 0xff;
  rom[9] = (initialPC >>> 16) & 0xff;
  rom[10] = (initialPC >>> 8) & 0xff;
  rom[11] = (initialPC >>> 0) & 0xff;
  return rom;
}

describe('HLE boot + controller + DRAM + MI/SI interrupts integration', () => {
  it('boots, queries controller, writes back to DRAM, and handles SI/MI interrupts/clears', () => {
    const initialPC = 0x80200000 >>> 0;
    const rom = makeZ64(initialPC);
    const rdram = new RDRAM(2 * 1024 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    // Enable CPU IE and IM2 (IP2 for MI)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2);
    cpu.cop0.write(12, IE | IM2);
    // Enable MI mask for SI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Use our HLE flow to stage controller transactions at DRAM base
    const base = 0x2000;
    const ret = hleBootAndInitController(cpu, bus, rom, base);
    expect(ret.initialPC >>> 0).toBe(initialPC >>> 0);

    // After the helper returns, SI busy should be clearable, and MI pending should be set then clearable
    // Ack any SI interrupt raised by the helper
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    // Clear EXL for CPU to accept further interrupts if any
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));

    // Verify DRAM contents for controller status and state blocks
    // Status at base
    expect(rdram.bytes[base + 0]).toBe(0x10);
    expect(rdram.bytes[base + 1]).toBe(0x01);
    expect(rdram.bytes[base + 2]).toBe(0x00);
    expect(rdram.bytes[base + 3]).toBe(0x00);
    // State at base+0x40
    expect(rdram.bytes[base + 0x40 + 0]).toBe(0x11);
    expect(rdram.bytes[base + 0x40 + 1]).toBe(0x00);
    expect(rdram.bytes[base + 0x40 + 2]).toBe(0x12);
    expect(rdram.bytes[base + 0x40 + 3]).toBe(0x34);
    expect(rdram.bytes[base + 0x40 + 4]).toBe(0x05);
    expect(rdram.bytes[base + 0x40 + 5]).toBe(0xFB);

    // Now schedule a new SI read to confirm CPU interrupt handling path via System
    const readBase = base + 0x80;
    rdram.bytes[readBase + 0] = 0x11;

    sys.scheduleAt(1, () => {
      bus.storeU32(SI_BASE + 0x00, readBase);
      bus.si.kickWrite64B();
    });
    sys.scheduleAt(2, () => {
      bus.storeU32(SI_BASE + 0x00, readBase);
      bus.si.kickRead64B();
    });

    const pc0 = cpu.pc >>> 0;
    sys.stepCycles(1);
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);

    // Ack SI and clear EXL, restore PC for next interrupt
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
    cpu.pc = pc0;

    sys.stepCycles(1);
    expect(((cpu.cop0.read(12) & (1 << 1)) !== 0)).toBe(true);
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);

    // Ack again
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));

    // Verify DRAM response at readBase
    expect(rdram.bytes[readBase + 1]).toBe(0x00);
    expect(rdram.bytes[readBase + 2]).toBe(0x12);
    expect(rdram.bytes[readBase + 3]).toBe(0x34);
    expect(rdram.bytes[readBase + 4]).toBe(0x05);
    expect(rdram.bytes[readBase + 5]).toBe(0xFB);
  });
});

describe('MI_MODE write-one-to-clear semantics', () => {
  it('clears MI pending bits when low bits are written to MI_MODE', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    // Raise SI and PI pending
    bus.mi.raise(0b000010 | 0b000100);
    expect(bus.loadU32(MI_BASE + 0x08) >>> 0).toBe(((1<<1)|(1<<2)) >>> 0);

    // Write-one-to-clear both via MI_MODE low bits
    bus.storeU32(MI_BASE + MI_MODE_OFF, ((1<<1)|(1<<2)) >>> 0);
    expect(bus.loadU32(MI_BASE + 0x08) >>> 0).toBe(0 >>> 0);
  });
});

describe('System scheduler multi-event ordering', () => {
  it('runs multiple events scheduled at the same cycle before CPU step', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const log: string[] = [];
    sys.scheduleAt(1, () => log.push('a'));
    sys.scheduleAt(1, () => log.push('b'));
    sys.scheduleAt(1, () => log.push('c'));

    const pc0 = cpu.pc >>> 0;
    sys.stepCycles(1);

    expect(log).toStrictEqual(['a','b','c']);
    // CPU advanced one step
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));
  });
});

