import { Bus } from '../mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';

// Convert a framebuffer in RDRAM from RGBA5551 to RGBA8888.
// width/height are in pixels; VI_WIDTH is the stride used between rows.
export function viScanout(bus: Bus, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
  const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
  const rdram = bus.rdram.bytes;
  // Each pixel is 2 bytes (big-endian in RDRAM). We'll read as two bytes per pixel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIndex = origin + (y * stride + x) * 2;
      const hi = rdram[srcIndex] ?? 0;
      const lo = rdram[srcIndex + 1] ?? 0;
      const p = ((hi << 8) | lo) >>> 0; // RGBA5551
      const r5 = (p >>> 11) & 0x1f;
      const g5 = (p >>> 6) & 0x1f;
      const b5 = (p >>> 1) & 0x1f;
      const a1 = (p >>> 0) & 0x01;
      const r = (r5 * 255 / 31) | 0;
      const g = (g5 * 255 / 31) | 0;
      const b = (b5 * 255 / 31) | 0;
      const a = a1 ? 255 : 0;
      const di = (y * width + x) * 4;
      out[di + 0] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
  }
  return out;
}

