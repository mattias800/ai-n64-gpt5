import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_WR_LEN_OFF } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('PI register semantics', () => {
  it('sets DMA busy on RD/WR LEN writes and clears on STATUS write', () => {
    const bus = new Bus(new RDRAM(1024));
    const base = PI_BASE >>> 0;
    w32(bus, base + PI_DRAM_ADDR_OFF, 0x00100000);
    w32(bus, base + PI_CART_ADDR_OFF, 0x10000000);

    w32(bus, base + PI_RD_LEN_OFF, 0x0000000F);
    expect((r32(bus, base + PI_STATUS_OFF) & PI_STATUS_DMA_BUSY) !== 0).toBe(true);

    // clear DMA busy
    w32(bus, base + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    expect((r32(bus, base + PI_STATUS_OFF) & PI_STATUS_DMA_BUSY) !== 0).toBe(false);

    w32(bus, base + PI_WR_LEN_OFF, 0x0000001F);
    expect((r32(bus, base + PI_STATUS_OFF) & PI_STATUS_DMA_BUSY) !== 0).toBe(true);
  });

  it('raises MI interrupt on DMA completion and clears MI pending on STATUS write', () => {
    const bus = new Bus(new RDRAM(1024));
    // Enable MI mask for PI
    const MI_MASK = 0x04300000 + 0x0C;
    bus.storeU32(MI_MASK, 1 << 4);

    // Trigger busy, then complete DMA
    w32(bus, PI_BASE + PI_RD_LEN_OFF, 0x10);
    bus.pi.completeDMA();

    // MI pending should include PI bit and cpu line assert
    const MI_INTR = 0x04300000 + 0x08;
    expect((bus.loadU32(MI_INTR) & (1 << 4)) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Write STATUS busy bit to clear and ensure MI pending cleared
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    expect((bus.loadU32(MI_INTR) & (1 << 4)) !== 0).toBe(false);
  });
});

