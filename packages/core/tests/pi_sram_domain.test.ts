import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_WR_LEN_OFF, CART_SRAM_BASE } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r8(bus: Bus, addr: number) { return bus.loadU8(addr >>> 0) & 0xff; }

function makeSRAM(size = 0x8000, fill = 0x00): Uint8Array {
  const sram = new Uint8Array(size);
  sram.fill(fill & 0xff);
  return sram;
}

describe('PI SRAM cart domain', () => {
  it('writes to SRAM via WR_LEN and reads back via RD_LEN', () => {
    const rdram = new RDRAM(0x400);
    const bus = new Bus(rdram);
    const sram = makeSRAM(0x8000, 0);
    bus.setSRAM(sram);

    // Prepare data in RDRAM at 0x100..0x10F
    for (let i = 0; i < 16; i++) bus.storeU8(0x100 + i, 0xC0 + i);

    // Write 16 bytes from RDRAM->SRAM at cart 0x08000020
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x100);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, (CART_SRAM_BASE + 0x20) >>> 0);
    w32(bus, PI_BASE + PI_WR_LEN_OFF, 0x0F);
    bus.pi.completeDMA();

    for (let i = 0; i < 16; i++) expect(sram[0x20 + i]).toBe(0xC0 + i);

    // Now read it back into RDRAM at 0x200
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x200);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, (CART_SRAM_BASE + 0x20) >>> 0);
    w32(bus, PI_BASE + PI_RD_LEN_OFF, 0x0F);
    bus.pi.completeDMA();

    for (let i = 0; i < 16; i++) expect(r8(bus, 0x200 + i)).toBe(0xC0 + i);
  });
});

