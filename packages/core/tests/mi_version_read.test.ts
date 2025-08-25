import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_VERSION_OFF } from '../src/devices/mmio.js';

// Assert MI_VERSION returns the modeled value

describe('MI_VERSION read', () => {
  it('returns 0x02020102', () => {
    const bus = new Bus(new RDRAM(1024));
    const val = bus.loadU32(MI_BASE + MI_VERSION_OFF) >>> 0;
    expect(val >>> 0).toBe(0x02020102 >>> 0);
  });
});

