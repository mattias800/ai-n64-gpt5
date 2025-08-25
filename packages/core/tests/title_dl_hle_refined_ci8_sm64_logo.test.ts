import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, seamSampleYs, COLORS_5551, assertPxEq } from './helpers/test_utils.ts';

// Compose S, M, 6, 4 glyphs using CI8 quads; verify seams, gaps, and +1 animation

describe('DL HLE refined CI8 SM64 logo composition', () => {
  it('renders S M 6 4 row; verifies seams and gaps', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=240,h=160, origin=0xC600;
    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;

    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=40, y0=50, spacing=6;
    const xS = x0;
    const xM = xS + 32 + spacing;
    const x6 = xM + 32 + spacing;
    const x4 = x6 + 32 + spacing;

    const dl = [
      dlSolid(COLORS_5551.blue),
      // S
      { op:'set_tlut' as const, tlut: S.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q00 }, { op:'draw_tex' as const, x: xS, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q01 }, { op:'draw_tex' as const, x: seamX(xS), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q10 }, { op:'draw_tex' as const, x: xS, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q11 }, { op:'draw_tex' as const, x: seamX(xS), y: seamY(y0) },
      // M
      { op:'set_tlut' as const, tlut: M.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q00 }, { op:'draw_tex' as const, x: xM, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q01 }, { op:'draw_tex' as const, x: seamX(xM), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q10 }, { op:'draw_tex' as const, x: xM, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q11 }, { op:'draw_tex' as const, x: seamX(xM), y: seamY(y0) },
      // 6
      { op:'set_tlut' as const, tlut: SIX.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q00 }, { op:'draw_tex' as const, x: x6, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q01 }, { op:'draw_tex' as const, x: seamX(x6), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q10 }, { op:'draw_tex' as const, x: x6, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q11 }, { op:'draw_tex' as const, x: seamX(x6), y: seamY(y0) },
      // 4
      { op:'set_tlut' as const, tlut: FOUR.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q00 }, { op:'draw_tex' as const, x: x4, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q01 }, { op:'draw_tex' as const, x: seamX(x4), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q10 }, { op:'draw_tex' as const, x: x4, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q11 }, { op:'draw_tex' as const, x: seamX(x4), y: seamY(y0) },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 4, 12);

    // S vertical seam (top bar) should be blue
    for (const y of seamSampleYs(y0, 0, 2)) assertPxEq(image, w, seamX(xS), y, [0,0,255,255], 'S vertical seam');
    // M horizontal seam (left stroke) should be red
    assertPxEq(image, w, xM+1, seamY(y0), [255,0,0,255], 'M left stroke');
    // 6 vertical seam top bar is green (sample within thickness)
    for (const y of seamSampleYs(y0, 1, 2)) assertPxEq(image, w, seamX(x6), y, [0,255,0,255], '6 vertical seam');

    // Gap between S and M should show background (solid blue here)
    const gapX = xS + 32 + Math.floor(spacing/2);
    assertPxEq(image, w, gapX, y0+8, [0,0,255,255], 'S-M gap background');
  });

  it('animates the row by +1px and verifies DP/VI acks and pixel shift', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=240,h=160, origin=0xC620;
    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;

    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=50, y0=60, spacing=6;
    const xS = x0;
    const xM = xS + 32 + spacing;
    const x6 = xM + 32 + spacing;
    const x4 = x6 + 32 + spacing;

    function drawRow(atX: number, bg: number) {
      return [
        dlSolid(bg),
        { op:'set_tlut' as const, tlut: S.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q00 }, { op:'draw_tex' as const, x: atX, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q10 }, { op:'draw_tex' as const, x: atX, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX), y: seamY(y0) },

        { op:'set_tlut' as const, tlut: M.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q00 }, { op:'draw_tex' as const, x: atX + (xM-xS), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (xM-xS)), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q10 }, { op:'draw_tex' as const, x: atX + (xM-xS), y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (xM-xS)), y: seamY(y0) },

        { op:'set_tlut' as const, tlut: SIX.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q00 }, { op:'draw_tex' as const, x: atX + (x6-xS), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (x6-xS)), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q10 }, { op:'draw_tex' as const, x: atX + (x6-xS), y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (x6-xS)), y: seamY(y0) },

        { op:'set_tlut' as const, tlut: FOUR.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q00 }, { op:'draw_tex' as const, x: atX + (x4-xS), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (x4-xS)), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q10 }, { op:'draw_tex' as const, x: atX + (x4-xS), y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (x4-xS)), y: seamY(y0) },
      ];
    }

    const frames = [
      { at: 3, commands: drawRow(xS, COLORS_5551.blue) },
      { at: 7, commands: drawRow(xS+1, COLORS_5551.red) },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 16);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // New SIX seam at x+1
    expect(px(image, seamX(x6+1), y0+1, w)).toEqual([0,255,0,255]);
    // Old SIX seam left should be red background where not covered
    const [r0,g0,b0,a0] = px(image, seamX(x6)-1, y0+8, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });

  it('animates the row by +1px in Y and verifies DP/VI acks and vertical pixel shift', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=240,h=160, origin=0xC640;
    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;

    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=50, y0=60, spacing=6;
    const xS = x0;
    const xM = xS + 32 + spacing;
    const x6 = xM + 32 + spacing;
    const x4 = x6 + 32 + spacing;

    function drawRowXY(atX: number, atY: number, bg: number) {
      return [
        dlSolid(bg),
        { op:'set_tlut' as const, tlut: S.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q00 }, { op:'draw_tex' as const, x: atX, y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q10 }, { op:'draw_tex' as const, x: atX, y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: M.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q00 }, { op:'draw_tex' as const, x: atX + (xM-xS), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (xM-xS)), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q10 }, { op:'draw_tex' as const, x: atX + (xM-xS), y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (xM-xS)), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: SIX.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q00 }, { op:'draw_tex' as const, x: atX + (x6-xS), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (x6-xS)), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q10 }, { op:'draw_tex' as const, x: atX + (x6-xS), y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (x6-xS)), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: FOUR.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q00 }, { op:'draw_tex' as const, x: atX + (x4-xS), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (x4-xS)), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q10 }, { op:'draw_tex' as const, x: atX + (x4-xS), y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (x4-xS)), y: seamY(atY) },
      ];
    }

    const frames = [
      { at: 3, commands: drawRowXY(xS, y0, COLORS_5551.blue) },
      { at: 7, commands: drawRowXY(xS, y0+1, COLORS_5551.red) },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 16);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // SIX vertical seam new top bar is at y0+2 after +1 move; old top bar at y0 should now be red background
    expect(px(image, seamX(x6), y0+2, w)).toEqual([0,255,0,255]);
    const [r0,g0,b0,a0] = px(image, seamX(x6), y0, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });

  it('animates the row by +1px in both X and Y and verifies DP/VI acks and diagonal pixel shift', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=240,h=160, origin=0xC660;
    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;

    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=48, y0=58, spacing=6;
    const xS = x0;
    const xM = xS + 32 + spacing;
    const x6 = xM + 32 + spacing;
    const x4 = x6 + 32 + spacing;

    function drawRowXY(atX: number, atY: number, bg: number) {
      return [
        dlSolid(bg),
        { op:'set_tlut' as const, tlut: S.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q00 }, { op:'draw_tex' as const, x: atX, y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q10 }, { op:'draw_tex' as const, x: atX, y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: M.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q00 }, { op:'draw_tex' as const, x: atX + (xM-xS), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (xM-xS)), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q10 }, { op:'draw_tex' as const, x: atX + (xM-xS), y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (xM-xS)), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: SIX.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q00 }, { op:'draw_tex' as const, x: atX + (x6-xS), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (x6-xS)), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q10 }, { op:'draw_tex' as const, x: atX + (x6-xS), y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (x6-xS)), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: FOUR.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q00 }, { op:'draw_tex' as const, x: atX + (x4-xS), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + (x4-xS)), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q10 }, { op:'draw_tex' as const, x: atX + (x4-xS), y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + (x4-xS)), y: seamY(atY) },
      ];
    }

    const frames = [
      { at: 3, commands: drawRowXY(xS, y0, COLORS_5551.blue) },
      { at: 7, commands: drawRowXY(xS+1, y0+1, COLORS_5551.red) },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 16);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // New SIX seam at x+1 and y+1: sample inside the vertical bar thickness
    expect(px(image, seamX(x6+1), y0+2, w)).toEqual([0,255,0,255]);
    // Old SIX seam positions should now show red background where not covered
    const [r0,g0,b0,a0] = px(image, seamX(x6)-1, y0+8, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
    const [r1,g1,b1,a1] = px(image, seamX(x6), y0, w);
    expect(a1).toBe(255); expect(r1).toBeGreaterThan(200); expect(g1).toBeLessThan(50); expect(b1).toBeLessThan(50);
  });
});

