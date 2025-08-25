import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('SI PIF command processing', () => {
  it('ACK command (0x01) sets response byte at pifRam[1] and is observable via readback', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    // Enable SI mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Prepare command at DRAM 0x300: [0]=0x01, rest 0
    rdram.bytes[0x300] = 0x01;

    // Write to SI DRAM addr and kick write (RDRAM -> PIF), which processes the command
    w32(bus, SI_BASE + 0x00, 0x00000300);
    bus.si.kickWrite64B();

    // Response should be set
    expect(bus.si.pifRam[1]).toBe(0x5a);

    // Now kick read back into DRAM at 0x400
    w32(bus, SI_BASE + 0x00, 0x00000400);
    bus.si.kickRead64B();

    // Verify response visible in RDRAM
    expect(rdram.bytes[0x401]).toBe(0x5a);

    // Clear MI pending
    w32(bus, SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 1)) !== 0).toBe(false);
  });

  it('Echo command (0x02) copies pifRam[1] to pifRam[2]', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    // Enable SI mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Prepare command at DRAM 0x500: [0]=0x02, [1]=0xAB
    rdram.bytes[0x500] = 0x02;
    rdram.bytes[0x501] = 0xAB;

    // Write and process
    w32(bus, SI_BASE + 0x00, 0x00000500);
    bus.si.kickWrite64B();

    expect(bus.si.pifRam[2]).toBe(0xAB);
  });

  it('Controller status command (0x10) writes presence flags deterministically', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    rdram.bytes[0x600] = 0x10; // command

    // Kick write
    w32(bus, SI_BASE + 0x00, 0x00000600);
    bus.si.kickWrite64B();

    expect(bus.si.pifRam[1]).toBe(0x01);
    expect(bus.si.pifRam[2]).toBe(0x00);
    expect(bus.si.pifRam[3]).toBe(0x00);
  });

  it('Read controller state command (0x11) writes a fixed button mask and sticks', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    rdram.bytes[0x700] = 0x11; // command

    w32(bus, SI_BASE + 0x00, 0x00000700);
    bus.si.kickWrite64B();

    expect(bus.si.pifRam[1]).toBe(0x00);
    expect(bus.si.pifRam[2]).toBe(0x12);
    expect(bus.si.pifRam[3]).toBe(0x34);
    expect(bus.si.pifRam[4]).toBe(0x05);
    expect(bus.si.pifRam[5]).toBe(0xFB);
  });
});

