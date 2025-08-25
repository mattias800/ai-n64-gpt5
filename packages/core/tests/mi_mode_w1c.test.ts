import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_OFF, MI_INTR_MASK_OFF, MI_MODE_OFF, MI_INTR_VI, MI_INTR_DP, MI_INTR_SI } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

describe('MI_MODE write-one-to-clear semantics', () => {
  it('clears only specified pending bits and does not alter mask', () => {
    const bus = new Bus(new RDRAM(2048));

    const MI_MASK = MI_BASE + MI_INTR_MASK_OFF;
    const MI_INTR = MI_BASE + MI_INTR_OFF;
    const MI_MODE = MI_BASE + MI_MODE_OFF;

    // Enable masks for VI, DP, SI
    w32(bus, MI_MASK, MI_INTR_VI | MI_INTR_DP | MI_INTR_SI);

    // Raise all three pendings
    bus.mi.raise(MI_INTR_VI | MI_INTR_DP | MI_INTR_SI);
    expect(r32(bus, MI_INTR)).toBe((MI_INTR_VI | MI_INTR_DP | MI_INTR_SI) >>> 0);

    // Clear only VI and SI via write-one-to-clear to MI_MODE
    w32(bus, MI_MODE, (MI_INTR_VI | MI_INTR_SI));

    // Pending should have only DP remaining; mask unchanged
    expect(r32(bus, MI_INTR)).toBe(MI_INTR_DP >>> 0);
    expect(r32(bus, MI_MASK)).toBe((MI_INTR_VI | MI_INTR_DP | MI_INTR_SI) >>> 0);
  });
});

