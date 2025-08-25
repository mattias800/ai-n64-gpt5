// Test utilities for pixel sampling and seam calculations

export type RGBA = readonly [number, number, number, number];

// Read RGBA8888 pixel at (x,y) from scanout buffer with given width
export function px(out: Uint8Array, x: number, y: number, w: number): RGBA {
  const i = (y * w + x) * 4;
  return [out[i], out[i + 1], out[i + 2], out[i + 3]] as const;
}

// Compute CRC32 (IEEE 802.3) of a byte buffer; returns 8-char lowercase hex
export function crc32(data: Uint8Array): string {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < data.length; i++) {
    let c = (crc ^ data[i]!) & 0xFF;
    for (let k = 0; k < 8; k++) {
      const mask = -(c & 1);
      c = (c >>> 1) ^ (0xEDB88320 & mask);
    }
    crc = (crc >>> 8) ^ c;
  }
  crc = (~crc) >>> 0;
  return (crc >>> 0).toString(16).padStart(8, '0');
}

// RGBA5551 helpers
export function rgba5551(r5: number, g5: number, b5: number, a1: number): number {
  return (((r5 & 0x1f) << 11) | ((g5 & 0x1f) << 6) | ((b5 & 0x1f) << 1) | (a1 & 0x01)) >>> 0;
}

export const COLORS_5551 = {
  red: rgba5551(31, 0, 0, 1),
  green: rgba5551(0, 31, 0, 1),
  blue: rgba5551(0, 0, 31, 1),
  cyan: rgba5551(0, 31, 31, 1),
  magenta: rgba5551(31, 0, 31, 1),
  white: rgba5551(31, 31, 31, 1),
  black: rgba5551(0, 0, 0, 1),
} as const;

// Convert RGBA5551 integer to RGBA8888 tuple like viScanout does
export function decode5551To8888(p: number): RGBA {
  const r5 = (p >>> 11) & 0x1f;
  const g5 = (p >>> 6) & 0x1f;
  const b5 = (p >>> 1) & 0x1f;
  const a1 = p & 0x1;
  const r = (r5 * 255 / 31) | 0;
  const g = (g5 * 255 / 31) | 0;
  const b = (b5 * 255 / 31) | 0;
  const a = a1 ? 255 : 0;
  return [r, g, b, a];
}

// Compute expected RGBA8888 at x for a horizontal gradient of given width and endpoints in 5551
export function expectedGradientRGBA(width: number, start5551: number, end5551: number, x: number): RGBA {
  const s = start5551 >>> 0; const e = end5551 >>> 0;
  const sr = (s >>> 11) & 0x1f, sg = (s >>> 6) & 0x1f, sb = (s >>> 1) & 0x1f, sa = s & 0x01;
  const er = (e >>> 11) & 0x1f, eg = (e >>> 6) & 0x1f, eb = (e >>> 1) & 0x1f, ea = e & 0x01;
  const t = width > 1 ? (x / (width - 1)) : 0;
  const r5 = (sr + (er - sr) * t) | 0;
  const g5 = (sg + (eg - sg) * t) | 0;
  const b5 = (sb + (eb - sb) * t) | 0;
  const a1 = t < 0.5 ? sa : ea;
  const p = (((r5 & 0x1f) << 11) | ((g5 & 0x1f) << 6) | ((b5 & 0x1f) << 1) | (a1 & 0x01)) >>> 0;
  return decode5551To8888(p);
}

// Seam helpers for 2x2 tiling of 16x16 tiles (32x32 glyphs)
export function seamX(xOrigin: number, tileSize = 16): number { return (xOrigin | 0) + (tileSize | 0); }
export function seamY(yOrigin: number, tileSize = 16): number { return (yOrigin | 0) + (tileSize | 0); }

// Safe Y sample positions slightly below the top edge to avoid background artifacts
export function seamSampleYs(yOrigin: number, startOffset = 2, count = 3): number[] {
  const ys: number[] = [];
  for (let i = 0; i < count; i++) ys.push((yOrigin | 0) + (startOffset | 0) + i);
  return ys;
}

// Build a DL command that produces a solid background color using the gradient op
export function dlSolid(color5551: number) {
  return { op: 'gradient' as const, start5551: color5551 >>> 0, end5551: color5551 >>> 0 };
}

// Optional debug dump of a neighborhood around (cx,cy). Controlled by env var TEST_DEBUG_DUMP.
export function dumpSeamNeighborhood(out: Uint8Array, w: number, cx: number, cy: number, radius = 2, envVar = 'TEST_DEBUG_DUMP') {
  const flag = (process.env && (process.env as any)[envVar]);
  if (!flag || flag === '0' || String(flag).toLowerCase() === 'false') return;
  const rows: string[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    const cols: string[] = [];
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0) { cols.push(' '); continue; }
      const [r,g,b,a] = px(out, x, y, w);
      let ch = '?';
      if (a === 255) {
        if (r > 200 && g < 60 && b < 60) ch = 'R';
        else if (g > 200 && r < 60 && b < 60) ch = 'G';
        else if (b > 200 && r < 60 && g < 60) ch = 'B';
        else if (r > 200 && b > 200 && g < 60) ch = 'M';
        else if (r > 230 && g > 230 && b > 230) ch = 'W';
        else ch = '.';
      } else {
        ch = '_';
      }
      cols.push(ch);
    }
    rows.push(cols.join(''));
  }
  // eslint-disable-next-line no-console
  console.log(`[debug ${cx},${cy}, r=${radius}]\n` + rows.join('\n'));
}

// Assert pixel equals expected, dump neighborhood and throw on mismatch
export function assertPxEq(out: Uint8Array, w: number, x: number, y: number, expected: RGBA, label?: string) {
  const got = px(out, x, y, w);
  const ok = got[0]===expected[0] && got[1]===expected[1] && got[2]===expected[2] && got[3]===expected[3];
  if (!ok) {
    dumpSeamNeighborhood(out, w, x, y, 2);
    throw new Error(`Pixel mismatch${label?` (${label})`:''} at (${x},${y}): got [${got.join(',')}] expected [${expected.join(',')}]`);
  }
}

// Optionally write a PPM snapshot of the framebuffer when TEST_SNAPSHOT is truthy
export function maybeWritePPM(out: Uint8Array, w: number, h: number, filePath: string, envVar = 'TEST_SNAPSHOT') {
  const flag = (process.env && (process.env as any)[envVar]);
  if (!flag || flag === '0' || String(flag).toLowerCase() === 'false') return;
  try {
    // Use require to avoid top-level await in test environment
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
    const data = Buffer.alloc(w * h * 3);
    for (let i = 0, di = 0; i < out.length; i += 4) {
      data[di++] = out[i];     // R
      data[di++] = out[i + 1]; // G
      data[di++] = out[i + 2]; // B
    }
    const buf = Buffer.concat([header, data]);
    fs.writeFileSync(filePath, buf);
    // eslint-disable-next-line no-console
    console.log(`[snapshot] wrote ${filePath}`);
  } catch (e) {
    // ignored on environments without fs
  }
}
