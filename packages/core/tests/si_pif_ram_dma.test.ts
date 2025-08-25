import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

function fill(arr: Uint8Array, off: number, len: number, base: number) {
  for (let i = 0; i < len; i++) arr[off + i] = ((base + i) & 0xff) >>> 0;
}

describe('SI PIF RAM 64B deterministic DMA', () => {
  it('kickWrite64B copies 64 bytes RDRAM -> PIF RAM; raises MI pending; STATUS write clears busy and MI', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    // Enable SI mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Prepare source in RDRAM at 0x100
    fill(rdram.bytes, 0x100, 64, 0x20);

    // Set SI DRAM addr
    w32(bus, SI_BASE + 0x00, 0x00000100);

    // Kick write (RDRAM -> PIF)
    bus.si.kickWrite64B();

    // Check PIF RAM contents
    for (let i = 0; i < 64; i++) {
      expect(bus.si.pifRam[i]).toBe((0x20 + i) & 0xff);
    }

    // MI pending set for SI
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 1)) !== 0).toBe(true);

    // Clear via SI STATUS write
    w32(bus, SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 1)) !== 0).toBe(false);
  });

  it('kickRead64B copies 64 bytes PIF RAM -> RDRAM; raises MI pending and supports ack', () => {
    const rdram = new RDRAM(4096);
    const bus = new Bus(rdram);

    // Enable SI mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 1);

    // Pre-fill PIF RAM pattern
    for (let i = 0; i < 64; i++) bus.si.pifRam[i] = (0xA0 + i) & 0xff;

    // Set DRAM destination and kick read
    w32(bus, SI_BASE + 0x00, 0x00000200);
    bus.si.kickRead64B();

    for (let i = 0; i < 64; i++) {
      expect(rdram.bytes[0x200 + i]).toBe((0xA0 + i) & 0xff);
    }

    // MI pending set for SI
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 1)) !== 0).toBe(true);
    // Ack
    w32(bus, SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 1)) !== 0).toBe(false);
  });
});
