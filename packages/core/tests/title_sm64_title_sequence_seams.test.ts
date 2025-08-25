import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, COLORS_5551 } from './helpers/test_utils.ts';

// Verify multi-frame title sequence seam continuity and old/new seam exposure across frames

describe('SM64 title sequence: multi-frame seam verification', () => {
  it('renders 4 frames with small shifts and verifies final seam pixels and acks', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=240,h=160, origin=0xD3C0;

    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;
    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=52, y0=46, spacing=6;
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
      { at: 2, commands: drawRowXY(xS,   y0,   COLORS_5551.blue)    },
      { at: 4, commands: drawRowXY(xS+1, y0,   COLORS_5551.red)     },
      { at: 6, commands: drawRowXY(xS+1, y0+1, COLORS_5551.cyan)    },
      { at: 8, commands: drawRowXY(xS+2, y0+1, COLORS_5551.magenta) },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 16);
    expect(res.dpAcks).toBe(4); expect(res.viAcks).toBe(4);

    // Final SIX seam at x+2 should be green within bar thickness at y0+1+2
    expect(px(image, seamX(x6+2), y0+3, w)).toEqual([0,255,0,255]);

    // Old horizontal move from +1->+2: just left of old seam should be final background (magenta)
    const [rL,gL,bL,aL] = px(image, seamX(x6+1)-1, y0+8, w);
    expect(aL).toBe(255); expect(rL).toBeGreaterThan(200); expect(bL).toBeGreaterThan(200); expect(gL).toBeLessThan(80);

    // Old vertical move from y0 to y0+1: the old top-bar line at y0 should now be final background (magenta)
    const [rT,gT,bT,aT] = px(image, seamX(x6+1), y0, w);
    expect(aT).toBe(255); expect(rT).toBeGreaterThan(200); expect(bT).toBeGreaterThan(200); expect(gT).toBeLessThan(80);
  });
});

