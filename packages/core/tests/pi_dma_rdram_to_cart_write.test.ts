import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_WR_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, PI_STATUS_IO_BUSY, MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

function makeROM(size = 0x200, fill = 0x00): Uint8Array {
  const rom = new Uint8Array(size);
  rom.fill(fill & 0xff);
  return rom;
}

describe('PI WR_LEN RDRAM->cart write-back', () => {
  it('copies bytes from RDRAM to ROM buffer at raw cart offsets and 0x10000000-based addresses; preserves busy/MI semantics', () => {
    const rdram = new RDRAM(0x200);
    const bus = new Bus(rdram);
    const rom = makeROM(0x200, 0x55);
    bus.setROM(rom);
    // Enable ROM write-back path for this test
    bus.pi.setAllowROMWrites(true);

    // Enable MI mask for PI to observe MI pending on completion
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, 1 << 4);

    // Case 1: raw cart offsets
    for (let i = 0; i < 16; i++) rdram.bytes[0x20 + i] = (0xA0 + i) & 0xff;
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x20);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, 0x10);
    w32(bus, PI_BASE + PI_WR_LEN_OFF, 0x0F); // len-1 -> 16 bytes

    // Busy flags should set immediately
    let st = r32(bus, PI_BASE + PI_STATUS_OFF);
    expect((st & PI_STATUS_DMA_BUSY) !== 0).toBe(true);
    expect((st & PI_STATUS_IO_BUSY) !== 0).toBe(true);

    // Complete DMA -> clears busy and raises MI pending
    bus.pi.completeDMA();
    st = r32(bus, PI_BASE + PI_STATUS_OFF);
    expect((st & (PI_STATUS_DMA_BUSY | PI_STATUS_IO_BUSY)) === 0).toBe(true);
    const MI_INTR = (MI_BASE + 0x08) >>> 0;
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(true);

    // Verify ROM written back at [0x10..0x1F]
    for (let i = 0; i < 16; i++) expect(rom[0x10 + i]).toBe(rdram.bytes[0x20 + i]);

    // Ack MI pending via PI STATUS DMA_BUSY bit
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    expect((r32(bus, MI_INTR) & (1 << 4)) !== 0).toBe(false);

    // Case 2: 0x1000_0000-based CART_ADDR alias
    for (let i = 0; i < 16; i++) rdram.bytes[0x40 + i] = (0xB0 + i) & 0xff;
    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, 0x40);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, 0x10000050 >>> 0); // maps to ROM offset 0x50
    w32(bus, PI_BASE + PI_WR_LEN_OFF, 0x0F);

    // Complete and check
    bus.pi.completeDMA();
    for (let i = 0; i < 16; i++) expect(rom[0x50 + i]).toBe(rdram.bytes[0x40 + i]);
  });
});
