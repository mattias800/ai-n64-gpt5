import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, PI_STATUS_IO_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

// Verify that writing only IO_BUSY to PI_STATUS does not clear MI PI pending; only DMA_BUSY write should clear MI pending

describe('PI STATUS IO_BUSY-only write does not clear MI PI pending', () => {
  it('leaves MI pending set until DMA_BUSY bit is written', () => {
    const bus = new Bus(new RDRAM(0x200));
    // Enable MI mask for PI
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 4);

    // Setup a small DMA
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x40);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, 0x00);
    w32(bus, PI_BASE + PI_RD_LEN_OFF, 0x0F);

    // Complete DMA -> MI PI pending set
    bus.pi.completeDMA();
    const MI_INTR = MI_BASE + 0x08;
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Write IO_BUSY only -> should clear IO_BUSY flag in STATUS but must not clear MI pending
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_IO_BUSY);
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(true);

    // Now write DMA_BUSY -> should clear MI pending
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(false);
  });
});

