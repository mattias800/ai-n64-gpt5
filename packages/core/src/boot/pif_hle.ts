import { Bus } from '../mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY } from '../devices/mmio.js';

function writeBlock64(bytes: Uint8Array, off: number, block: Uint8Array) {
  for (let i = 0; i < 64; i++) bytes[off + i] = block[i] ?? 0;
}

export function hlePifControllerStatus(bus: Bus, dramAddr: number) {
  const base = dramAddr >>> 0;
  const blk = new Uint8Array(64);
  blk.fill(0);
  blk[0] = 0x10; // controller status
  writeBlock64(bus.rdram.bytes, base, blk);

  // Kick write (DRAM -> PIF), MI pending asserted by SI
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickWrite64B();
  // Ack busy and MI
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  // Kick read (PIF -> DRAM)
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickRead64B();
  // Ack busy and MI
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  const present = (bus.rdram.bytes[base + 1] ?? 0) === 0x01;
  const pak = bus.rdram.bytes[base + 2] ?? 0;
  const reserved = bus.rdram.bytes[base + 3] ?? 0;
  return { present, pak, reserved };
}

function toS8(v: number): number { return (v << 24) >> 24; }

// Port-specific status helper
export function hlePifControllerStatusPort(bus: Bus, dramAddr: number, port: number) {
  const base = dramAddr >>> 0;
  const blk = new Uint8Array(64);
  blk.fill(0);
  blk[0] = 0x10; // controller status
  blk[63] = (port & 0x03) >>> 0; // select port
  writeBlock64(bus.rdram.bytes, base, blk);

  // Kick write (DRAM -> PIF)
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickWrite64B();
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  // Kick read (PIF -> DRAM)
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickRead64B();
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  const present = (bus.rdram.bytes[base + 1] ?? 0) === 0x01;
  const pak = bus.rdram.bytes[base + 2] ?? 0;
  const reserved = bus.rdram.bytes[base + 3] ?? 0;
  return { present, pak, reserved };
}

// Port-specific read controller state helper
export function hlePifReadControllerStatePort(bus: Bus, dramAddr: number, port: number) {
  const base = dramAddr >>> 0;
  const blk = new Uint8Array(64);
  blk.fill(0);
  blk[0] = 0x11; // controller state
  blk[63] = (port & 0x03) >>> 0;
  writeBlock64(bus.rdram.bytes, base, blk);

  // Kick write
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickWrite64B();
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  // Kick read back
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickRead64B();
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  const status = bus.rdram.bytes[base + 1] ?? 0;
  const buttons = ((((bus.rdram.bytes[base + 2] ?? 0) << 8) | (bus.rdram.bytes[base + 3] ?? 0)) >>> 0);
  const stickX = toS8(bus.rdram.bytes[base + 4] ?? 0);
  const stickY = toS8(bus.rdram.bytes[base + 5] ?? 0);
  return { status, buttons, stickX, stickY };
}

export function hlePifReadControllerState(bus: Bus, dramAddr: number) {
  const base = dramAddr >>> 0;
  const blk = new Uint8Array(64);
  blk.fill(0);
  blk[0] = 0x11; // controller state
  // port id defaults to 0 in blk[63]
  writeBlock64(bus.rdram.bytes, base, blk);

  // Kick write
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickWrite64B();
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  // Kick read back
  bus.storeU32(SI_BASE + 0x00, base);
  bus.si.kickRead64B();
  bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

  const status = bus.rdram.bytes[base + 1] ?? 0;
  const buttons = ((((bus.rdram.bytes[base + 2] ?? 0) << 8) | (bus.rdram.bytes[base + 3] ?? 0)) >>> 0);
  const stickX = toS8(bus.rdram.bytes[base + 4] ?? 0);
  const stickY = toS8(bus.rdram.bytes[base + 5] ?? 0);
  return { status, buttons, stickX, stickY };
}
