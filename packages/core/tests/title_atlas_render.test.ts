import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo } from '../src/boot/title_logo_hle.js';
import { buildSM64LogoTiles } from '../src/boot/title_atlas.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// This test validates that transparent cutouts in the logo tiles correctly reveal the background gradient.
describe('SM64 logo atlas composition with transparent cross cutouts', () => {
  it('renders logo tiles and reveals gradient through transparent cross centers', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 256, h = 192, origin = 0x6000;
    const bgStart = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0; // red
    const bgEnd   = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0; // blue

    const tiles = buildSM64LogoTiles(w, h, { tileWidthFrac: 0.12, tileHeightFrac: 0.20, spacingFrac: 0.06 });
    const { image, res } = hleTitleRenderLogo(cpu, bus, sys, origin, w, h, bgStart, bgEnd, tiles);

    expect(res.viAcks).toBe(1);

    // For each tile, the center pixel should be from gradient (not the solid glyph color), i.e., not fully red/green/blue/yellow
    for (const t of tiles) {
      const cx = t.dstX + Math.floor(t.width / 2);
      const cy = t.dstY + Math.floor(t.height / 2);
      const [r,g,b,a] = px(image, cx, cy, w);
      expect(a).toBe(255);
      // Should be a blend between red and blue (purple-ish), so both r and b > 0
      expect(r).toBeGreaterThan(10);
      expect(b).toBeGreaterThan(10);
    }

    // Also sample a solid area inside first tile away from the cross to ensure the glyph color is applied
    const t0 = tiles[0]!;
    const gx = t0.dstX + 2;
    const gy = t0.dstY + 2;
    const [r0,g0,b0,a0] = px(image, gx, gy, w);
    // First tile is blue
    expect(r0).toBe(0);
    expect(g0).toBe(0);
    expect(b0).toBeGreaterThan(200);
    expect(a0).toBe(255);
  });
});

