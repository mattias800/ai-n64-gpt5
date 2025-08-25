import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo } from '../src/boot/title_logo_hle.js';
import { buildMosaicMARGlyphs } from '../src/boot/title_logo_mosaic.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('MAR mosaic builder: seams, crossbar, and gaps', () => {
  it('renders M, A, R with continuous strokes across tile seams and proper gaps between glyphs', () => {
    const rdram = new RDRAM(1 << 17);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 96, h = 64, origin = 0x9000;
    const bg = ((0 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0; // opaque black

    const tiles = buildMosaicMARGlyphs(w, h, { tileSize: 8, spacing: 4 });
    const { image, res } = hleTitleRenderLogo(cpu, bus, sys, origin, w, h, bg, bg, tiles);

    expect(res.viAcks).toBe(1);

    // Compute approximate positions used by builder for sampling
    const gw = 16, gh = 16, spacing = 4;
    const totalW = gw * 3 + spacing * 2;
    const startX = Math.floor((w - totalW) / 2);
    const startY = Math.floor(h * 0.25);

    const red = [255,0,0,255] as const;

    // M: left stroke at x = startX + 0 across full 16px
    for (let dy = 0; dy < gh; dy++) expect(px(image, startX + 0, startY + dy, w)).toEqual(red);

    // A: crossbar at around 60% of glyph height
    const aX0 = startX + gw + spacing; // start of A
    const crossY = startY + Math.floor(gh * 0.6);
    // Sample across a mid span inside A (avoid extremes)
    for (let dx = 2; dx < gw - 2; dx++) expect(px(image, aX0 + dx, crossY, w)).toEqual(red);

    // R: left stroke at its start x
    const rX0 = startX + gw + spacing + gw + spacing;
    for (let dy = 0; dy < gh; dy++) expect(px(image, rX0 + 0, startY + dy, w)).toEqual(red);

    // Gaps between glyphs should remain black at center Y between glyphs
    const gapY = startY + Math.floor(gh / 2);
    const gap1X = startX + gw + Math.floor(spacing / 2);
    const gap2X = startX + gw + spacing + gw + Math.floor(spacing / 2);
    expect(px(image, gap1X, gapY, w)).toEqual([0,0,0,255]);
    expect(px(image, gap2X, gapY, w)).toEqual([0,0,0,255]);
  });
});

