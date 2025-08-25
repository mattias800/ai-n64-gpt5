import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, COLORS_5551 } from './helpers/test_utils.ts';

// Property-like deterministic diagonal shift tests for composed SM64 row

describe('DL HLE composed SM64 row diagonal shifts', () => {
  it('seam continuity for diagonal shifts (+1,+1) and (+2,+2)', () => {
    const w=200,h=140, origin=0xCC00;

    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;
    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    function drawRowXY(atX: number, atY: number, bg: number) {
      return [
        dlSolid(bg),
        { op:'set_tlut' as const, tlut: S.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q00 }, { op:'draw_tex' as const, x: atX, y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q10 }, { op:'draw_tex' as const, x: atX, y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: S.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: M.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q00 }, { op:'draw_tex' as const, x: atX + 38, y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + 38), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q10 }, { op:'draw_tex' as const, x: atX + 38, y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: M.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + 38), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: SIX.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q00 }, { op:'draw_tex' as const, x: atX + 76, y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + 76), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q10 }, { op:'draw_tex' as const, x: atX + 76, y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: SIX.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + 76), y: seamY(atY) },

        { op:'set_tlut' as const, tlut: FOUR.tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q00 }, { op:'draw_tex' as const, x: atX + 114, y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q01 }, { op:'draw_tex' as const, x: seamX(atX + 114), y: atY },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q10 }, { op:'draw_tex' as const, x: atX + 114, y: seamY(atY) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: FOUR.quads.Q11 }, { op:'draw_tex' as const, x: seamX(atX + 114), y: seamY(atY) },
      ];
    }

    const cases = [
      { x: 44, y: 40, dx: 1, dy: 1 },
      { x: 46, y: 42, dx: 2, dy: 2 },
    ];

    for (const c of cases) {
      const rdram = new RDRAM(1<<19);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const frames = [
        { at: 3, commands: drawRowXY(c.x, c.y, COLORS_5551.blue) },
        { at: 7, commands: drawRowXY(c.x + c.dx, c.y + c.dy, COLORS_5551.red) },
      ];

      const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 16);
      expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

      // Verify new seam for SIX at x+dx is green within bar thickness
      const newSx = seamX(c.x + 76 + c.dx) - 76 + (c.x + 76 + c.dx); // simplifies to seamX(c.x + 76 + c.dx)
      expect(px(image, seamX(c.x + 76 + c.dx), c.y + c.dy + 2, w)).toEqual([0,255,0,255]);

      // Old seam left of SIX should show red background on an interior sample
      const [r0,g0,b0,a0] = px(image, seamX(c.x + 76) - 1, c.y + 8, w);
      expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);

      // Old top-bar line for SIX at previous y should show red background
      const [r1,g1,b1,a1] = px(image, seamX(c.x + 76), c.y, w);
      expect(a1).toBe(255); expect(r1).toBeGreaterThan(200); expect(g1).toBeLessThan(50); expect(b1).toBeLessThan(50);
    }
  });
});

