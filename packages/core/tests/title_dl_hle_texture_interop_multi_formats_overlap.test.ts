import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, COLORS_5551 } from './helpers/test_utils.ts';

// Overlapping interop: CI8 base row with CI4 (magenta), IA8 (varied alpha), and I4 (varied alpha)
// Draw order (bottom to top): CI4 -> IA8 -> I4. Verify per-pixel compositing at a 2x2 overlay region.

describe('DL HLE interop overlapping multi-formats over seam', () => {
  it('resolves per-pixel alpha in draw order across CI4, IA8, and I4', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xD360;

    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;
    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=44, y0=40, spacing=6;
    const xS = x0; const xM = xS + 32 + spacing; const x6 = xM + 32 + spacing; const x4 = x6 + 32 + spacing;

    function drawRow(atX: number, atY: number, bg: number) {
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
      ] as const;
    }

    // CI4 TLUT: 0 -> transparent(0), 1 -> magenta
    const tlut16 = new Uint16Array(16); tlut16[0] = 0; tlut16[1] = COLORS_5551.magenta;
    // 2x2 CI4 pattern: [1,0 / 0,1]
    const ci4 = new Uint8Array([0x10, 0x01]);

    // 2x2 IA8 bytes (per pixel): [F0,80 / 88,F0] => transparent, transparent, opaque gray, transparent
    const ia8 = new Uint8Array([0xF0, 0x80, 0x88, 0xF0]);

    // 2x2 I4 bytes: [0,F / F,0] => transparent, opaque white, opaque white, transparent
    const i4 = new Uint8Array([0x0F, 0xF0]);

    const tX = seamX(x6), tY = y0 + 1;

    const dl = [
      ...drawRow(xS, y0, COLORS_5551.blue),
      // Bottom overlay CI4 (magenta on diagonal)
      { op:'set_texture' as const, format:'CI4', width:2, height:2, data: ci4 },
      { op:'set_tlut' as const, tlut: tlut16 },
      { op:'draw_tex' as const, x: tX, y: tY, width: 2, height: 2 },
      // Middle overlay IA8 (some transparent)
      { op:'set_texture' as const, format:'IA8', width:2, height:2, data: ia8 },
      { op:'draw_tex' as const, x: tX, y: tY, width: 2, height: 2 },
      // Top overlay I4 (some transparent)
      { op:'set_texture' as const, format:'I4', width:2, height:2, data: i4 },
      { op:'draw_tex' as const, x: tX, y: tY, width: 2, height: 2 },
    ] as const;

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // Expectations at 2x2 block (x=tX..tX+1, y=tY..tY+1)
    // (0,0): I4 transparent -> IA8 transparent -> CI4 magenta
    expect(px(image, tX,   tY,   w)).toEqual([255,0,255,255]);
    // (1,0): I4 opaque white wins
    expect(px(image, tX+1, tY,   w)).toEqual([255,255,255,255]);
    // (0,1): I4 opaque white wins
    expect(px(image, tX,   tY+1, w)).toEqual([255,255,255,255]);
    // (1,1): I4 transparent -> IA8 transparent -> CI4 magenta
    expect(px(image, tX+1, tY+1, w)).toEqual([255,0,255,255]);
  });
});

