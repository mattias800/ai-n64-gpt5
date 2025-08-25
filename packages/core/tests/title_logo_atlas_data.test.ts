import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo } from '../src/boot/title_logo_hle.js';
import { buildTitleAtlasSlice } from '../src/boot/title_logo_atlas_data.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// Compose two pre-baked 16x16 stripe tiles with transparent cross cutouts over a gradient and assert stripe colors and transparency.
describe('Pre-baked stripe tiles atlas slice', () => {
  it('renders stripe colors correctly and shows background through transparent cross', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 128, h = 96, origin = 0xB000;
    const bgStart = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0; // green
    const bgEnd   = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0; // blue

    const tiles = buildTitleAtlasSlice(w, h, { spacing: 6 });
    const { image, res } = hleTitleRenderLogo(cpu, bus, sys, origin, w, h, bgStart, bgEnd, tiles);

    expect(res.viAcks).toBe(1);

    const a = tiles[0]!; const b = tiles[1]!;
    const cy = a.dstY + Math.floor(a.height / 2);
    const cxA = a.dstX + Math.floor(a.width / 2);
    const cxB = b.dstX + Math.floor(b.width / 2);

    // Transparent cross centers should reveal gradient (green/blue blend)
    let [r,g,bv,alpha] = px(image, cxA, cy, w);
    expect(alpha).toBe(255);
    expect(g).toBeGreaterThan(10); expect(bv).toBeGreaterThan(10);
    ;([r,g,bv,alpha] = px(image, cxB, cy, w));
    expect(alpha).toBe(255);
    expect(g).toBeGreaterThan(10); expect(bv).toBeGreaterThan(10);

    // Stripe colors: sample a few rows in tile A stripes
    const rowR = a.dstY + 0;     // RED
    const rowG = a.dstY + 1;     // GREEN
    const rowB = a.dstY + 2;     // BLUE
    const rowY = a.dstY + 3;     // YELLOW
    const sampleX = a.dstX + 2;
    expect(px(image, sampleX, rowR, w)).toEqual([255,0,0,255]);
    expect(px(image, sampleX, rowG, w)).toEqual([0,255,0,255]);
    expect(px(image, sampleX, rowB, w)).toEqual([0,0,255,255]);
    // yellow ~ red+green (high r and g)
    const [ry,gy,by,ay] = px(image, sampleX, rowY, w);
    expect(ry).toBeGreaterThan(200); expect(gy).toBeGreaterThan(200); expect(by).toBe(0); expect(ay).toBe(255);
  });
});

