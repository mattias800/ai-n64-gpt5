import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, SP_BASE, SP_STATUS_OFF, SP_STATUS_INTR, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('SP task start (SP_CMD_START) raises SP and DP interrupts', () => {
  it('setting SP_CMD_START raises MI pending for SP and DP; STATUS writes clear them', () => {
    const bus = new Bus(new RDRAM(2048));
    // Enable MI masks for SP and DP
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5));

    // Write SP command start at SP base + 0x00
    w32(bus, SP_BASE + 0x00, 1);

    // Both SP and DP bits should be pending
    const pending = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(((pending >>> 0) & (1 << 0)) !== 0).toBe(true);
    expect(((pending >>> 0) & (1 << 5)) !== 0).toBe(true);

    // Ack SP via SP_STATUS write
    w32(bus, SP_BASE + SP_STATUS_OFF, SP_STATUS_INTR);
    let p2 = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(((p2 >>> 0) & (1 << 0)) !== 0).toBe(false);
    expect(((p2 >>> 0) & (1 << 5)) !== 0).toBe(true);

    // Ack DP via DP_STATUS write
    w32(bus, DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
    let p3 = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(p3 >>> 0).toBe(0);
  });
});

