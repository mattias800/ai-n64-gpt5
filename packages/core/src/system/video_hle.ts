import { Bus } from '../mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';

function writePixel5551(bus: Bus, origin: number, stride: number, x: number, y: number, p: number) {
  const addr = origin + (y * stride + x) * 2;
  const ram = bus.rdram.bytes;
  if (addr + 1 < ram.length) {
    ram[addr] = (p >>> 8) & 0xff;
    ram[addr + 1] = p & 0xff;
  }
}

// Compose multiple tiles using painter's algorithm (array order determines draw order).
export type Tile5551 = { dstX: number; dstY: number; width: number; height: number; pixels: Uint16Array };
export function viComposeTiles(bus: Bus, fbWidth: number, fbHeight: number, tiles: Tile5551[]): void {
  for (const t of tiles) {
    viBlitRGBA5551(bus, fbWidth, fbHeight, t.dstX, t.dstY, t.pixels, t.width, t.height);
  }
}

export function viDrawSolidRGBA5551(bus: Bus, width: number, height: number, color5551: number): void {
  const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
  const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      writePixel5551(bus, origin, stride, x, y, color5551 >>> 0);
    }
  }
}

export function viDrawHorizontalGradient(bus: Bus, width: number, height: number, startColor5551: number, endColor5551: number): void {
  const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
  const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
  const s = startColor5551 >>> 0;
  const e = endColor5551 >>> 0;
  const sr = (s >>> 11) & 0x1f, sg = (s >>> 6) & 0x1f, sb = (s >>> 1) & 0x1f, sa = s & 0x01;
  const er = (e >>> 11) & 0x1f, eg = (e >>> 6) & 0x1f, eb = (e >>> 1) & 0x1f, ea = e & 0x01;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = width > 1 ? x / (width - 1) : 0;
      const r = (sr + (er - sr) * t) | 0;
      const g = (sg + (eg - sg) * t) | 0;
      const b = (sb + (eb - sb) * t) | 0;
      const a = t < 0.5 ? sa : ea; // simple step for alpha
      const p = (((r & 0x1f) << 11) | ((g & 0x1f) << 6) | ((b & 0x1f) << 1) | (a & 0x1)) >>> 0;
      writePixel5551(bus, origin, stride, x, y, p);
    }
  }
}

// Blit a small RGBA5551 tile (provided as Uint16Array of length srcWidth*srcHeight)
// into the VI framebuffer at (dstX, dstY). Clipped to framebuffer bounds.
export function viBlitRGBA5551(
  bus: Bus,
  fbWidth: number,
  fbHeight: number,
  dstX: number,
  dstY: number,
  src: Uint16Array,
  srcWidth: number,
  srcHeight: number,
): void {
  const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
  const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
  for (let y = 0; y < srcHeight; y++) {
    const ty = dstY + y;
    if (ty < 0 || ty >= fbHeight) continue;
    for (let x = 0; x < srcWidth; x++) {
      const tx = dstX + x;
      if (tx < 0 || tx >= fbWidth) continue;
      const p = (src[y * srcWidth + x] ?? 0) >>> 0;
      // Respect source alpha (bit0): skip write when transparent
      if ((p & 0x1) !== 0) writePixel5551(bus, origin, stride, tx, ty, p);
    }
  }
}

// Addressing mode for pattern sampling
export type AddressMode = 'clamp' | 'wrap' | 'mirror';

function sampleIndex(idx: number, size: number, mode: AddressMode): number {
  if (size <= 0) return 0;
  switch (mode) {
    case 'wrap': {
      const m = idx % size; return m < 0 ? m + size : m;
    }
    case 'mirror': {
      const period = size * 2;
      let t = idx % period; if (t < 0) t += period;
      return t < size ? t : (period - 1 - t);
    }
    case 'clamp':
    default:
      if (idx < 0) return 0; if (idx >= size) return size - 1; return idx;
  }
}

// Blit a repeating/mirroring pattern over a destination rectangle using the provided addressing modes.
export function viBlitPatternRGBA5551(
  bus: Bus,
  fbWidth: number,
  fbHeight: number,
  dstX: number,
  dstY: number,
  drawWidth: number,
  drawHeight: number,
  src: Uint16Array,
  srcWidth: number,
  srcHeight: number,
  modeX: AddressMode,
  modeY: AddressMode,
): void {
  const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
  const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
  for (let y = 0; y < drawHeight; y++) {
    const ty = dstY + y; if (ty < 0 || ty >= fbHeight) continue;
    const sy = sampleIndex(y, srcHeight, modeY);
    for (let x = 0; x < drawWidth; x++) {
      const tx = dstX + x; if (tx < 0 || tx >= fbWidth) continue;
      const sx = sampleIndex(x, srcWidth, modeX);
      const p = (src[sy * srcWidth + sx] ?? 0) >>> 0;
      if ((p & 0x1) !== 0) writePixel5551(bus, origin, stride, tx, ty, p);
    }
  }
}

// Draw vertical and horizontal seam overlay lines at the provided positions.
// This is intended only for debugging; it draws on top of existing framebuffer contents.
export function viDrawSeamOverlay(
  bus: Bus,
  fbWidth: number,
  fbHeight: number,
  verticalXs: number[],
  horizontalYs: number[],
  color5551: number = (((31 & 0x1f) << 11) | ((0 & 0x1f) << 6) | ((31 & 0x1f) << 1) | 1) >>> 0, // magenta
): void {
  const origin = bus.loadU32(VI_BASE + VI_ORIGIN_OFF) >>> 0;
  const stride = bus.loadU32(VI_BASE + VI_WIDTH_OFF) >>> 0;
  // Vertical lines
  for (const x of verticalXs) {
    const vx = x | 0; if (vx < 0 || vx >= fbWidth) continue;
    for (let y = 0; y < fbHeight; y++) writePixel5551(bus, origin, stride, vx, y, color5551);
  }
  // Horizontal lines
  for (const y of horizontalYs) {
    const hy = y | 0; if (hy < 0 || hy >= fbHeight) continue;
    for (let x = 0; x < fbWidth; x++) writePixel5551(bus, origin, stride, x, hy, color5551);
  }
}

