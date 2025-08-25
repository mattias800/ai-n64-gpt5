import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo } from '../src/boot/title_logo_hle.js';
import { buildMosaicMARIOGlyphs } from '../src/boot/title_logo_mosaic.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// MARIO mosaic smoke test with key pixel assertions
// Verifies M left stroke, A crossbar and slopes, R left stroke, I center stroke and caps, O ring, and gaps.
describe('MARIO mosaic builder: key strokes and gaps', () => {
  it('renders MARIO with expected strokes and gaps', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 160, h = 96, origin = 0xA000;
    const bg = ((0 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0; // opaque black

    const tiles = buildMosaicMARIOGlyphs(w, h, { tileSize: 8, spacing: 4 });
    const { image, res } = hleTitleRenderLogo(cpu, bus, sys, origin, w, h, bg, bg, tiles);

    expect(res.viAcks).toBe(1);

    const gw = 16, gh = 16, spacing = 4;
    const totalW = gw * 5 + spacing * 4;
    const startX = Math.floor((w - totalW) / 2);
    const startY = Math.floor(h * 0.25);

    const red = [255,0,0,255] as const;

    // M left stroke
    for (let dy = 0; dy < gh; dy++) expect(px(image, startX + 0, startY + dy, w)).toEqual(red);

    // A crossbar and a slope point
    const aX0 = startX + gw + spacing;
    const crossY = startY + Math.floor(gh * 0.6);
    expect(px(image, aX0 + Math.floor(gw/2), crossY, w)).toEqual(red);
    // A left slope near top
    expect(px(image, aX0 + Math.max(0, Math.floor(gw/2) - 2), startY + 2, w)).toEqual(red);

    // R left stroke
    const rX0 = startX + gw + spacing + gw + spacing;
    for (let dy = 0; dy < gh; dy++) expect(px(image, rX0 + 0, startY + dy, w)).toEqual(red);

    // I center stroke and top cap
    const iX0 = rX0 + gw + spacing;
    const iMidX = iX0 + Math.floor(gw/2);
    for (let dy = 0; dy < gh; dy++) expect(px(image, iMidX, startY + dy, w)).toEqual(red);
    // top cap span
    expect(px(image, iMidX - 2, startY + 0, w)).toEqual(red);
    expect(px(image, iMidX + 2, startY + 0, w)).toEqual(red);

    // O ring: corners and edges
    const oX0 = iX0 + gw + spacing;
    // top-left corner of O ring
    expect(px(image, oX0 + 0, startY + 0, w)).toEqual(red);
    // top edge mid
    expect(px(image, oX0 + Math.floor(gw/2), startY + 0, w)).toEqual(red);
    // left edge mid
    expect(px(image, oX0 + 0, startY + Math.floor(gh/2), w)).toEqual(red);
    // interior should be background (hollow) at center
    const [r,g,b,a] = px(image, oX0 + Math.floor(gw/2), startY + Math.floor(gh/2), w);
    expect([r,g,b,a]).toEqual([0,0,0,255]);

    // Gaps between glyphs should be background in the mid row
    const gapY = startY + Math.floor(gh / 2);
    const gap1 = startX + gw + Math.floor(spacing / 2);
    const gap2 = startX + gw + spacing + gw + Math.floor(spacing / 2);
    const gap3 = rX0 + gw + Math.floor(spacing / 2);
    const gap4 = iX0 + gw + Math.floor(spacing / 2);
    expect(px(image, gap1, gapY, w)).toEqual([0,0,0,255]);
    expect(px(image, gap2, gapY, w)).toEqual([0,0,0,255]);
    expect(px(image, gap3, gapY, w)).toEqual([0,0,0,255]);
    expect(px(image, gap4, gapY, w)).toEqual([0,0,0,255]);
  });
});

