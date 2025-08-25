import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { SI_BASE, SI_PIF_ADDR_RD64B_OFF, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('SI interrupts integrated with MI', () => {
  it('raises MI pending on SI DMA completion and clears on STATUS write', () => {
    const bus = new Bus(new RDRAM(1024));

    // Enable MI mask for SI (bit 1)
    const MI_MASK = 0x04300000 + 0x0C;
    bus.storeU32(MI_MASK, 1 << 1);

    // Trigger SI busy via write to PIF_ADDR_RD64B, then complete
    w32(bus, SI_BASE + SI_PIF_ADDR_RD64B_OFF, 0x00000040);
    expect((r32(bus, SI_BASE + SI_STATUS_OFF) & SI_STATUS_DMA_BUSY) !== 0).toBe(true);

    bus.si.completeDMA();

    const MI_INTR = 0x04300000 + 0x08;
    expect((r32(bus, MI_INTR) & (1 << 1)) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Acknowledge via SI STATUS write
    w32(bus, SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_INTR) & (1 << 1)) !== 0).toBe(false);
  });
});
