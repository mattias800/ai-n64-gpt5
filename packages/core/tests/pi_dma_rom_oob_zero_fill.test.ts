import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

// Ensure PI ROM reads past end of ROM produce zero bytes in RDRAM and do not crash

describe('PI DMA ROM out-of-bounds read zero-fills RDRAM and is safe', () => {
  it('copies available ROM bytes then zero-fills remainder when cartAddr+len exceeds ROM size', () => {
    const rdram = new RDRAM(0x100);
    const bus = new Bus(rdram);
    const rom = new Uint8Array(0x20);
    for (let i = 0; i < rom.length; i++) rom[i] = (i & 0xff);
    bus.setROM(rom);

    // Program a DMA of 0x30 bytes starting near end of ROM so last 0x10 bytes overrun
    const cartAddr = 0x10; // 0x10..0x2F (0x20..0x2F are OOB)
    const dramAddr = 0x40;
    const len = 0x30; // bytes, program length-1

    w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, dramAddr);
    w32(bus, PI_BASE + PI_CART_ADDR_OFF, cartAddr);
    w32(bus, PI_BASE + PI_RD_LEN_OFF, (len - 1) >>> 0);
    bus.pi.completeDMA();
    // Ack PI pending
    w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);

    // First 0x10 bytes should be from ROM[0x10..0x1F]
    for (let i = 0; i < 0x10; i++) expect(rdram.bytes[dramAddr + i]).toBe(rom[cartAddr + i]);
    // Next 0x20 bytes should be zero-filled (cart OOB)
    for (let i = 0x10; i < 0x30; i++) expect(rdram.bytes[dramAddr + i]).toBe(0);
  });
});

