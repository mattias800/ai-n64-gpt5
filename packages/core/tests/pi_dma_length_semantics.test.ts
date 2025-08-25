import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

function makeROM(size = 0x200): Uint8Array {
  const rom = new Uint8Array(size);
  for (let i = 0; i < size; i++) rom[i] = (i & 0xff);
  return rom;
}

describe('PI DMA length-1 semantics and clamping', () => {
  it('copies exactly len bytes (len-1 programmed) including len=1 and clamps to RDRAM bounds', () => {
    const rdram = new RDRAM(0x100);
    const bus = new Bus(rdram);
    const rom = makeROM(0x200);
    bus.setROM(rom);

    // Helper to run a single DMA and immediately complete it
    function dma(cartAddr: number, dramAddr: number, len: number) {
      w32(bus, PI_BASE + PI_CART_ADDR_OFF, cartAddr >>> 0);
      w32(bus, PI_BASE + PI_DRAM_ADDR_OFF, dramAddr >>> 0);
      // Program length-1 value
      w32(bus, PI_BASE + PI_RD_LEN_OFF, (len - 1) >>> 0);
      // Complete to clear busy
      bus.pi.completeDMA();
      // Ack PI pending if any
      w32(bus, PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    }

    // Case 1: len=1 copies one byte
    dma(0x00, 0x00, 1);
    expect(rdram.bytes[0x00]).toBe(rom[0x00]);

    // Case 2: len=4 copies 4 bytes
    rdram.bytes.fill(0);
    dma(0x10, 0x20, 4);
    for (let i = 0; i < 4; i++) expect(rdram.bytes[0x20 + i]).toBe(rom[0x10 + i]);

    // Case 3: zero edge (programming len-1 as 0 means len=1) — already covered by len=1 above

    // Case 4: clamp to RDRAM bounds when dramAddr+len exceeds size
    rdram.bytes.fill(0);
    dma(0x40, 0xFE, 8); // 0xFE..0x105 -> only 0xFE..0xFF will be written (2 bytes)
    expect(rdram.bytes[0xFE]).toBe(rom[0x40]);
    expect(rdram.bytes[0xFF]).toBe(rom[0x41]);
  });
});

