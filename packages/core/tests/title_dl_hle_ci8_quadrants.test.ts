import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildCI8Ring32Indices, sliceCI8Indices16 } from '../src/boot/title_logo_ci8_indices.ts';
import { px, dlSolid, seamX, seamY, seamSampleYs, COLORS_5551 } from './helpers/test_utils.ts';

// Use DL set_tlut + set_texture + draw_tex to render CI8 ring quadrants and verify seams and center background

describe('DL HLE texture path with CI8 ring quadrants', () => {
  it('renders 2x2 CI8 quadrants and verifies seams and center', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=160,h=120, origin=0xC400;
    const { indices, tlut } = buildCI8Ring32Indices(COLORS_5551.green);
    const quads = sliceCI8Indices16(indices);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR00 }, { op:'draw_tex' as const, x: 60, y: 40 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR01 }, { op:'draw_tex' as const, x: seamX(60), y: 40 },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR10 }, { op:'draw_tex' as const, x: 60, y: seamY(40) },
      { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR11 }, { op:'draw_tex' as const, x: seamX(60), y: seamY(40) },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);
    expect(res.dpAcks).toBe(1); expect(res.viAcks).toBe(1);

    // Verify seams are green
    for (const y of seamSampleYs(40, 2, 2)) expect(px(image, seamX(60), y, w)).toEqual([0,255,0,255]);
    expect(px(image, 60+3, seamY(40), w)).toEqual([0,255,0,255]);

    // Center is background (solid blue)
    expect(px(image, seamX(60), seamY(40), w)).toEqual([0,0,255,255]);
  });

  it('animates quadrants by +1px and verifies acks and pixel shift', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=160,h=120, origin=0xC450;
    const { indices, tlut } = buildCI8Ring32Indices(COLORS_5551.green);
    const quads = sliceCI8Indices16(indices);

    const x0=70, y0=50;
    const frames = [
      { at: 2, commands: [
        dlSolid(COLORS_5551.blue),
        { op:'set_tlut' as const, tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR00 }, { op:'draw_tex' as const, x: x0, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR01 }, { op:'draw_tex' as const, x: seamX(x0), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR10 }, { op:'draw_tex' as const, x: x0, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR11 }, { op:'draw_tex' as const, x: seamX(x0), y: seamY(y0) },
      ]},
      { at: 5, commands: [
        dlSolid(COLORS_5551.red),
        { op:'set_tlut' as const, tlut },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR00 }, { op:'draw_tex' as const, x: x0+1, y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR01 }, { op:'draw_tex' as const, x: seamX(x0+1), y: y0 },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR10 }, { op:'draw_tex' as const, x: x0+1, y: seamY(y0) },
        { op:'set_texture' as const, format:'CI8', width:16, height:16, data: quads.CIR11 }, { op:'draw_tex' as const, x: seamX(x0+1), y: seamY(y0) },
      ]},
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {}, 10);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // New vertical seam is green just below top edge; old seam location shows red background at a safe y
    expect(px(image, seamX(x0+1), y0+2, w)).toEqual([0,255,0,255]);
    const [r0,g0,b0,a0] = px(image, seamX(x0), y0+8, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });
});

