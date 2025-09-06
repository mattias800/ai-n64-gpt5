import { describe, it, expect } from 'vitest';

import { Bus, RDRAM } from '../src/mem/bus.js';
import {
  RI_BASE,
  RI_SELECT_OFF,
  RI_CURRENT_LOAD_OFF,
  SI_BASE,
  SI_STATUS_OFF,
  SI_DRAM_ADDR_OFF,
  SI_PIF_ADDR_WR64B_OFF,
  PI_BASE,
  PI_RD_LEN_OFF,
  PI_STATUS_OFF,
} from '../src/devices/mmio.js';

const KSEG1 = 0xA0000000 >>> 0;

describe('MMIO: RI / SI / PI compatibility', () => {
  it('RI SELECT reset default is 0x14 and RI mapping matches real offsets', () => {
    const bus = new Bus(new RDRAM());
    const riSelectAddr = (KSEG1 + RI_BASE + RI_SELECT_OFF) >>> 0;
    const riCurrentLoadAddr = (KSEG1 + RI_BASE + RI_CURRENT_LOAD_OFF) >>> 0;

    // Reset default
    const sel0 = bus.loadU32(riSelectAddr);
    expect(sel0 >>> 0).toBe(0x14);

    // Write/read SELECT
    bus.storeU32(riSelectAddr, 0x12345678 >>> 0);
    const sel1 = bus.loadU32(riSelectAddr);
    expect(sel1 >>> 0).toBe(0x12345678 >>> 0);

    // Write/read CURRENT_LOAD
    bus.storeU32(riCurrentLoadAddr, 0xC0FFEE00 >>> 0);
    const cur0 = bus.loadU32(riCurrentLoadAddr);
    expect(cur0 >>> 0).toBe(0xC0FFEE00 >>> 0);
  });

  it('SI sets 0x1000 latch on direct PIF RAM write and clears it on STATUS write', () => {
    const bus = new Bus(new RDRAM());
    const siStatusAddr = (KSEG1 + SI_BASE + SI_STATUS_OFF) >>> 0;

    // Initially zero
    const st0 = bus.loadU32(siStatusAddr);
    expect((st0 >>> 0) & 0x1000).toBe(0);

    // Direct PIF RAM byte write via KSEG1-mapped address: 0xA0000000 + 0x1FC007C0
    const pifVAddr = (KSEG1 + (0x1FC007C0 >>> 0)) >>> 0;
    bus.storeU8(pifVAddr, 0x42);

    const st1 = bus.loadU32(siStatusAddr);
    expect((st1 >>> 0) & 0x1000).toBe(0x1000);

    // Any write to SI_STATUS clears the 0x1000 latch (CEN64-compatible)
    bus.storeU32(siStatusAddr, 0);
    const st2 = bus.loadU32(siStatusAddr);
    expect((st2 >>> 0) & 0x1000).toBe(0);
  });

  it('SI sets 0x1000 latch on 64B WR kick and we can clear it via STATUS write', () => {
    const bus = new Bus(new RDRAM());
    const siStatusAddr = (KSEG1 + SI_BASE + SI_STATUS_OFF) >>> 0;

    // Program a DRAM address and kick WR64B
    const siDramAddr = (KSEG1 + SI_BASE + SI_DRAM_ADDR_OFF) >>> 0;
    const siWrKickAddr = (KSEG1 + SI_BASE + SI_PIF_ADDR_WR64B_OFF) >>> 0;
    bus.storeU32(siDramAddr, 0x00100000 >>> 0);
    bus.storeU32(siWrKickAddr, 0x00000000 >>> 0);

    const st1 = bus.loadU32(siStatusAddr);
    expect((st1 >>> 0) & 0x1000).toBe(0x1000);

    // Clear via STATUS write
    bus.storeU32(siStatusAddr, 0);
    const st2 = bus.loadU32(siStatusAddr);
    expect((st2 >>> 0) & 0x1000).toBe(0);
  });

  it('PI sets only DMA_BUSY (bit0) on RD_LEN/WR_LEN, not IO_BUSY (bit1)', () => {
    const bus = new Bus(new RDRAM());
    const piStatusAddr = (KSEG1 + PI_BASE + PI_STATUS_OFF) >>> 0;
    const piRdLenAddr = (KSEG1 + PI_BASE + PI_RD_LEN_OFF) >>> 0;

    // RD_LEN write starts DMA: expect bit0 set, bit1 clear
    bus.storeU32(piRdLenAddr, 0x00000100 >>> 0);
    const st1 = bus.loadU32(piStatusAddr);
    expect((st1 >>> 0) & 0x1).toBe(1);
    expect((st1 >>> 0) & 0x2).toBe(0);
  });
});

