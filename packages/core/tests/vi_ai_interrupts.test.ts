import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT, AI_BASE, AI_DRAM_ADDR_OFF, AI_LEN_OFF, AI_STATUS_OFF, AI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('VI and AI interrupts integrated with MI', () => {
  it('VI vblank raises MI pending and STATUS write clears it', () => {
    const bus = new Bus(new RDRAM(1024));
    // Enable MI mask for VI (bit 3)
    const MI_MASK = 0x04300000 + 0x0C;
    bus.storeU32(MI_MASK, 1 << 3);

    // Trigger VI vblank
    bus.vi.vblank();
    const MI_INTR = 0x04300000 + 0x08;
    expect((r32(bus, MI_INTR) & (1 << 3)) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Ack via VI STATUS write
    w32(bus, VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    expect((r32(bus, MI_INTR) & (1 << 3)) !== 0).toBe(false);
  });

  it('AI completeDMA raises MI pending and STATUS write clears it', () => {
    const bus = new Bus(new RDRAM(1024));
    // Enable MI mask for AI (bit 2)
    const MI_MASK = 0x04300000 + 0x0C;
    bus.storeU32(MI_MASK, 1 << 2);

    // Start AI DMA by writing length
    w32(bus, AI_BASE + AI_DRAM_ADDR_OFF, 0x00100000);
    w32(bus, AI_BASE + AI_LEN_OFF, 0x00000100);
    expect((r32(bus, AI_BASE + AI_STATUS_OFF) & AI_STATUS_DMA_BUSY) !== 0).toBe(true);

    bus.ai.completeDMA();

    const MI_INTR = 0x04300000 + 0x08;
    expect((r32(bus, MI_INTR) & (1 << 2)) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Ack via AI STATUS write
    w32(bus, AI_BASE + AI_STATUS_OFF, AI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_INTR) & (1 << 2)) !== 0).toBe(false);
  });
});
