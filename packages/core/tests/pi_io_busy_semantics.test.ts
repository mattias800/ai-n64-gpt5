import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_WR_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, PI_STATUS_IO_BUSY, MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('PI IO_BUSY semantics', () => {
  it('sets IO_BUSY on RD/WR LEN; clears via STATUS write; clears on completeDMA and raises MI PI pending', () => {
    const bus = new Bus(new RDRAM(0x2000));

    // Program addresses
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x00100000);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, 0x10000000);

    // Start a read DMA: both DMA_BUSY and IO_BUSY should set
    w32(bus, PI_BASE + PI_RD_LEN_OFF, 0x0000000F);
    let st = r32(bus, PI_BASE + PI_STATUS_OFF);
    expect((st & PI_STATUS_DMA_BUSY) !== 0).toBe(true);
    expect((st & PI_STATUS_IO_BUSY) !== 0).toBe(true);

    // Clear IO_BUSY only via STATUS write; DMA_BUSY remains
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_IO_BUSY);
    st = r32(bus, PI_BASE + PI_STATUS_OFF);
    expect((st & PI_STATUS_IO_BUSY) !== 0).toBe(false);
    expect((st & PI_STATUS_DMA_BUSY) !== 0).toBe(true);

    // Start a write DMA: IO_BUSY sets again
    w32(bus, PI_BASE + PI_WR_LEN_OFF, 0x0000001F);
    st = r32(bus, PI_BASE + PI_STATUS_OFF);
    expect((st & PI_STATUS_IO_BUSY) !== 0).toBe(true);

    // Enable MI mask for PI and complete DMA -> clears both busy and raises MI PI pending
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 4);
    bus.pi.completeDMA();
    st = r32(bus, PI_BASE + PI_STATUS_OFF);
    expect((st & (PI_STATUS_DMA_BUSY | PI_STATUS_IO_BUSY)) === 0).toBe(true);
    const MI_INTR = (0x04300000 >>> 0) + 0x08;
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Acknowledge MI PI pending via STATUS DMA_BUSY write
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(false);
  });
});
