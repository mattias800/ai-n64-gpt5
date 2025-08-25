import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY, MI_BASE, MI_INTR_MASK_OFF } from '../src/devices/mmio.js';

function makeZ64(initialPC: number): Uint8Array {
  const rom = new Uint8Array(0x200);
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40; // magic
  rom[8] = (initialPC >>> 24) & 0xff;
  rom[9] = (initialPC >>> 16) & 0xff;
  rom[10] = (initialPC >>> 8) & 0xff;
  rom[11] = (initialPC >>> 0) & 0xff;
  // Put a recognizable pattern at 0x100..0x10F
  for (let i = 0; i < 0x10; i++) rom[0x100 + i] = (0xA0 + i) & 0xff;
  return rom;
}

describe('PI DMA ROM->RDRAM copy', () => {
  it('copies bytes from ROM (cart space) to RDRAM and raises MI interrupt', () => {
    const rdram = new RDRAM(0x1000);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    // Stash ROM in bus/PI
    const rom = makeZ64(0);
    bus.setROM(rom);

    // Enable MI mask for PI
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 4);

    // Set PI addresses: copy 16 bytes from cart 0x100 to dram 0x200
    bus.storeU32(PI_BASE + PI_DRAM_ADDR_OFF, 0x200);
    bus.storeU32(PI_BASE + PI_CART_ADDR_OFF, 0x100);

    // Write RD_LEN of 0x0F (length-1 semantics -> 16 bytes). This should start DMA and copy bytes.
    bus.storeU32(PI_BASE + PI_RD_LEN_OFF, 0x0F);

    // PI status busy should be set until completion
    expect(((bus.loadU32(PI_BASE + PI_STATUS_OFF) & PI_STATUS_DMA_BUSY) !== 0)).toBe(true);

    // Now complete the DMA, which should clear busy and raise MI pending
    bus.pi.completeDMA();
    expect(((bus.loadU32(PI_BASE + PI_STATUS_OFF) & PI_STATUS_DMA_BUSY) !== 0)).toBe(false);

    // MI pending should have PI bit set
    expect(((bus.loadU32(MI_BASE + 0x08) >>> 0) & (1 << 4)) !== 0).toBe(true);

    // Verify copied bytes
    for (let i = 0; i < 0x10; i++) {
      expect(rdram.bytes[0x200 + i]).toBe(rom[0x100 + i]);
    }
  });
});

