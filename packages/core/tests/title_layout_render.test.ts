import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo } from '../src/boot/title_logo_hle.js';
import { buildSimpleSM64TitleTiles } from '../src/boot/title_layout.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('Simple SM64 title layout render', () => {
  it('renders four colored glyph rectangles over gradient and takes one VI interrupt', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 320, h = 240, origin = 0x4000;
    const bgStart = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0; // blue
    const bgEnd   = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0; // cyan

    const tiles = buildSimpleSM64TitleTiles(w, h);
    const { image, res } = hleTitleRenderLogo(cpu, bus, sys, origin, w, h, bgStart, bgEnd, tiles);

    expect(res.viAcks).toBe(1);
    expect(image.length).toBe(w * h * 4);

    // Sample centers of each glyph block based on the builder's math
    const sCx = Math.floor(w*0.10 + (w*0.18)/2);
    const mCx = Math.floor(w*0.30 + (w*0.18)/2);
    const sixCx = Math.floor(w*0.50 + (w*0.15)/2);
    const fourCx = Math.floor(w*0.67 + (w*0.15)/2);
    const cy = Math.floor(h*0.20 + (h*0.25)/2);

    // Blue S
    expect(px(image, sCx, cy, w)).toEqual([0,0,255,255]);
    // Red M
    const [rM,gM,bM,aM] = px(image, mCx, cy, w);
    expect(rM).toBeGreaterThan(200); expect(gM).toBe(0); expect(bM).toBe(0); expect(aM).toBe(255);
    // Green 6
    const [r6,g6,b6,a6] = px(image, sixCx, cy, w);
    expect(r6).toBe(0); expect(g6).toBeGreaterThan(200); expect(b6).toBe(0); expect(a6).toBe(255);
    // Yellow 4
    const [r4,g4,b4,a4] = px(image, fourCx, cy, w);
    expect(r4).toBeGreaterThan(200); expect(g4).toBeGreaterThan(200); expect(b4).toBe(0); expect(a4).toBe(255);

    // Background left edge still blue-ish
    const [r0,g0,b0,a0] = px(image, 0, Math.floor(h/2), w);
    expect(r0).toBe(0); expect(g0).toBe(0); expect(b0).toBeGreaterThan(200); expect(a0).toBe(255);
  });
});

