import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { SP_BASE, SP_STATUS_OFF, SP_STATUS_INTR } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }

describe('SP onStart callback', () => {
  it('invokes onStart when SP_CMD_START is written to MEM_ADDR and when STATUS bit0 is set', () => {
    const bus = new Bus(new RDRAM(2048));
    let count = 0;
    (bus.sp as any).onStart = () => { count++; };

    // Start via MEM_ADDR write of 1
    w32(bus, SP_BASE + 0x00, 1);
    expect(count).toBe(1);

    // Start via STATUS bit0 (CLEAR_HALT/START)
    w32(bus, SP_BASE + SP_STATUS_OFF, SP_STATUS_INTR);
    expect(count).toBe(2);
  });
});

