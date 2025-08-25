import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, SP_BASE, SP_STATUS_OFF, SP_STATUS_INTR, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('SP/DP devices minimal interrupt behavior', () => {
  it('SP raiseInterrupt sets MI pending and STATUS write clears it', () => {
    const bus = new Bus(new RDRAM(1024));
    // Enable SP mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 0);

    // Raise
    bus.sp.raiseInterrupt();
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 0)) !== 0).toBe(true);

    // Ack via SP STATUS write
    w32(bus, SP_BASE + SP_STATUS_OFF, SP_STATUS_INTR);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 0)) !== 0).toBe(false);
  });

  it('DP raiseInterrupt sets MI pending and STATUS write clears it', () => {
    const bus = new Bus(new RDRAM(1024));
    // Enable DP mask
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 5);

    // Raise
    bus.dp.raiseInterrupt();
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 5)) !== 0).toBe(true);

    // Ack via DP STATUS write
    w32(bus, DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    expect((r32(bus, MI_BASE + MI_INTR_OFF) & (1 << 5)) !== 0).toBe(false);
  });
});

