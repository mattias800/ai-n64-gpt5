import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedCI8GlyphQuads } from '../src/boot/title_logo_refined_ci8.ts';
import { px, dlSolid, seamX, seamY, seamSampleYs, COLORS_5551 } from './helpers/test_utils.ts';

// Draw refined-style SM64 glyph (SIX) using CI8 quads via DL texture state; verify seams and animation

describe('DL HLE refined SM64 glyph via CI8 quads', () => {
  it('renders 2x2 quads for SIX and verifies seams and center', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xC500;
    const { tlut, quads } = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);

    const x0=70, y0=60;
    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q00 }, { op:'draw_tex' as const, x: x0, y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q01 }, { op:'draw_tex' as const, x: seamX(x0), y: y0 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q10 }, { op:'draw_tex' as const, x: x0, y: seamY(y0) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q11 }, { op:'draw_tex' as const, x: seamX(x0), y: seamY(y0) },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // Vertical seam is green at top bar
    for (const y of seamSampleYs(y0, 0, 3)) expect(px(image, seamX(x0), y, w)).toEqual([0,255,0,255]);
    // Horizontal seam is green near left stroke
    expect(px(image, x0+7, seamY(y0), w)).toEqual([0,255,0,255]);
    // Center is background
    expect(px(image, seamX(x0), seamY(y0), w)).toEqual([0,0,255,255]);
  });

  it('animates SIX by +1px and verifies ack counts and pixel shift', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xC520;
    const { tlut, quads } = buildRefinedCI8GlyphQuads('SIX', COLORS_5551.green);

    const x0=80, y0=70;
    const frames = [
      { at: 2, commands: [
        dlSolid(COLORS_5551.blue),
        { op:'set_tlut' as const, tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q00 }, { op:'draw_tex' as const, x: x0, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q01 }, { op:'draw_tex' as const, x: seamX(x0), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q10 }, { op:'draw_tex' as const, x: x0, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q11 }, { op:'draw_tex' as const, x: seamX(x0), y: seamY(y0) },
      ]},
      { at: 5, commands: [
        dlSolid(COLORS_5551.red),
        { op:'set_tlut' as const, tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q00 }, { op:'draw_tex' as const, x: x0+1, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q01 }, { op:'draw_tex' as const, x: seamX(x0+1), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q10 }, { op:'draw_tex' as const, x: x0+1, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.Q11 }, { op:'draw_tex' as const, x: seamX(x0+1), y: seamY(y0) },
      ]},
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 10);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    expect(px(image, seamX(x0+1), y0+1, w)).toEqual([0,255,0,255]);
    const [r0,g0,b0,a0] = px(image, seamX(x0)-1, y0+8, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });
});

