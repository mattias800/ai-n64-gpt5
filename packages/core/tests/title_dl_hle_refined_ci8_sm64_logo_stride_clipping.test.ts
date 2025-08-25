import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, COLORS_5551 } from './helpers/test_utils.ts';

// Validate composed SM64 row under VI stride > width and clipped draws, ensuring seams remain continuous

describe('DL HLE SM64 row with non-standard stride and clipping', () => {
  it('preserves seam continuity with stride > width and negative x/y start', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=96,h=72, origin=0xCA00, stride=112;

    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;
    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=-3, y0=-2, spacing=4;
    const xS = x0;
    const xM = xS + 32 + spacing;
    const x6 = xM + 32 + spacing;
    const x4 = x6 + 32 + spacing;

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut: S.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q00 }, { op:'draw_tex' as const, x: xS, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q01 }, { op:'draw_tex' as const, x: seamX(xS), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q10 }, { op:'draw_tex' as const, x: xS, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q11 }, { op:'draw_tex' as const, x: seamX(xS), y: seamY(y0) },

      { op:'set_tlut' as const, tlut: M.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q00 }, { op:'draw_tex' as const, x: xM, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q01 }, { op:'draw_tex' as const, x: seamX(xM), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q10 }, { op:'draw_tex' as const, x: xM, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q11 }, { op:'draw_tex' as const, x: seamX(xM), y: seamY(y0) },

      { op:'set_tlut' as const, tlut: SIX.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q00 }, { op:'draw_tex' as const, x: x6, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q01 }, { op:'draw_tex' as const, x: seamX(x6), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q10 }, { op:'draw_tex' as const, x: x6, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q11 }, { op:'draw_tex' as const, x: seamX(x6), y: seamY(y0) },

      { op:'set_tlut' as const, tlut: FOUR.tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q00 }, { op:'draw_tex' as const, x: x4, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q01 }, { op:'draw_tex' as const, x: seamX(x4), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q10 }, { op:'draw_tex' as const, x: x4, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q11 }, { op:'draw_tex' as const, x: seamX(x4), y: seamY(y0) },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 4, 12, stride);

    // If inside framebuffer, SIX vertical seam should be green within bar thickness
    const sx = seamX(x6);
    if (sx >= 0 && sx < w) {
      const yA = y0+2; if (yA >= 0 && yA < h) expect(px(image, sx, yA, w)).toEqual([0,255,0,255]);
      // At local y=18 (seamY(y0)+2), SIX interior is hollow at x=16 -> expect background (blue)
      const yB = seamY(y0)+2; if (yB >= 0 && yB < h) expect(px(image, sx, yB, w)).toEqual([0,0,255,255]);
    }

    // Horizontal seam (M left stroke) check if visible
    const sy = seamY(y0);
    if (sy >= 0 && sy < h) {
      const xA = xM+1; if (xA >= 0 && xA < w) expect(px(image, xA, sy, w)).toEqual([255,0,0,255]);
    }
  });
});

