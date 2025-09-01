import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_WR_LEN_OFF, CART_SRAM_BASE } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r8(bus: Bus, addr: number) { return bus.loadU8(addr >>> 0) & 0xff; }

function makeBuf(size = 0x20000, fill = 0x00): Uint8Array {
  const a = new Uint8Array(size);
  a.fill(fill & 0xff);
  return a;
}

describe('PI FlashRAM cart domain (stub)', () => {
  it('writes to FlashRAM via WR_LEN and reads back via RD_LEN', () => {
    const rdram = new RDRAM(0x1000);
    const bus = new Bus(rdram);
    const flash = makeBuf(0x20000, 0);
    bus.setFlashRAM(flash);

    // Prepare data in RDRAM at 0x100..0x10F
    for (let i = 0; i < 16; i++) bus.storeU8(0x100 + i, 0xA0 + i);

    // Write 16 bytes from RDRAM->Flash at cart 0x08000040
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x100);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, (CART_SRAM_BASE + 0x40) >>> 0);
    w32(bus, PI_BASE + PI_WR_LEN_OFF, 0x0F);
    bus.pi.completeDMA();

    for (let i = 0; i < 16; i++) expect(flash[0x40 + i]).toBe(0xA0 + i);

    // Now read it back into RDRAM at 0x200
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x200);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, (CART_SRAM_BASE + 0x40) >>> 0);
    w32(bus, PI_BASE + PI_RD_LEN_OFF, 0x0F);
    bus.pi.completeDMA();

    for (let i = 0; i < 16; i++) expect(r8(bus, 0x200 + i)).toBe(0xA0 + i);
  });
});

