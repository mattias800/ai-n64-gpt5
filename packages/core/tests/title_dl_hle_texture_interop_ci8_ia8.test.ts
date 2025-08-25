import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, COLORS_5551, dumpSeamNeighborhood } from './helpers/test_utils.ts';

// Interop test: CI8 composed row overlaid with IA8 pattern, verifying alpha handling and seam preservation.

describe('DL HLE texture interop: CI8 base with IA8 overlay', () => {
  it('overlays IA8 2x2 pattern across a seam; opaque replaces, transparent preserves underlying', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xD2A0;

    const yellow = ((31<<11)|(31<<6)|(0<<1)|1)>>>0;
    const S = buildRefinedCI8GlyphQuads('S', COLORS_5551.blue);
    const M = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const SIX = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);
    const FOUR = buildRefinedCI8GlyphQuads('FOUR', yellow);

    const x0=44, y0=40, spacing=6;
    const xS = x0;
    const xM = xS + 32 + spacing;
    const x6 = xM + 32 + spacing;
    const x4 = x6 + 32 + spacing;

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

    // 2x2 IA8: [FF,F0 / F0,FF] where FF is opaque white, F0 is transparent white
    const ia8 = new Uint8Array([0xFF, 0xF0, 0xF0, 0xFF]);

    const frames = [
      { at: 3, commands: drawRow(xS, y0, COLORS_5551.blue) },
      { at: 7, commands: [
        // Redraw row on a different background, then overlay IA8 to validate transparency over seams
        dlSolid(COLORS_5551.red),
        ...drawRow(xS, y0, COLORS_5551.red),
        { op:'set_texture' as const, format:'IA8', width:2, height:2, data: ia8 },
        { op:'draw_tex' as const, x: seamX(x6), y: y0+1, width: 2, height: 2 },
      ] as const },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 16);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // Top-left of overlay: opaque white replaces seam pixel
    expect(px(image, seamX(x6), y0+1, w)).toEqual([255,255,255,255]);
    // Optional debug around seam (enable by TEST_DEBUG_DUMP=1)
    dumpSeamNeighborhood(image, w, seamX(x6), y0+1, 2);
    // Top-right of overlay: transparent -> underlying should remain (green top bar)
    expect(px(image, seamX(x6)+1, y0+1, w)).toEqual([0,255,0,255]);
    // Bottom-left of overlay: transparent -> underlying should remain (green at y0+2 seam bar)
    expect(px(image, seamX(x6), y0+2, w)).toEqual([0,255,0,255]);
    // Bottom-right of overlay: opaque white
    expect(px(image, seamX(x6)+1, y0+2, w)).toEqual([255,255,255,255]);
  });
});

