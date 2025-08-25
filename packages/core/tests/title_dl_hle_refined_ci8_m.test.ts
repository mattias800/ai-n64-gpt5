import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, seamSampleYs, COLORS_5551 } from './helpers/test_utils.ts';

// Refined CI8 M glyph seams and animation

describe('DL HLE refined CI8 M glyph', () => {
  it('renders M and verifies horizontal seam', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=180,h=140, origin=0xC740;
    const { tlut, quads } = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const x0=60, y0=50;

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q00 }, { op:'draw_tex' as const, x: x0, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q01 }, { op:'draw_tex' as const, x: seamX(x0), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q10 }, { op:'draw_tex' as const, x: x0, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q11 }, { op:'draw_tex' as const, x: seamX(x0), y: seamY(y0) },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);
    expect(px(image, x0+1, seamY(y0), w)).toEqual([255,0,0,255]);
  });

  it('animates M by +1px; verifies seam shift', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=180,h=140, origin=0xC760;
    const { tlut, quads } = buildRefinedCI8GlyphQuads('M', COLORS_5551.red);
    const x0=68, y0=58;

    const frames = [
      { at: 2, commands: [ dlSolid(COLORS_5551.blue), { op:'set_tlut' as const, tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q00 }, { op:'draw_tex' as const, x: x0, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q01 }, { op:'draw_tex' as const, x: seamX(x0), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q10 }, { op:'draw_tex' as const, x: x0, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q11 }, { op:'draw_tex' as const, x: seamX(x0), y: seamY(y0) }, ] },
      { at: 5, commands: [ dlSolid(COLORS_5551.red), { op:'set_tlut' as const, tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q00 }, { op:'draw_tex' as const, x: x0+1, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q01 }, { op:'draw_tex' as const, x: seamX(x0+1), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q10 }, { op:'draw_tex' as const, x: x0+1, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q11 }, { op:'draw_tex' as const, x: seamX(x0+1), y: seamY(y0) }, ] },
    ];

    const { image } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 10);
    expect(px(image, x0+2, seamY(y0), w)).toEqual([255,0,0,255]);
  });
});

