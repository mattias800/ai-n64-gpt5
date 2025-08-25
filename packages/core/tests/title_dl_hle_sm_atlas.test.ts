import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { buildSMLogoAtlas16 } from '../src/boot/title_logo_atlas_sm.ts';
import { expectedGradientRGBA } from './helpers/test_utils.ts';

function px(out: Uint8Array, x: number, y: number, w: number) { const i=(y*w+x)*4; return [out[i],out[i+1],out[i+2],out[i+3]] as const; }

describe('DL HLE with SM logo atlas (16x16 S and M)', () => {
  it('composes S and M over gradient at DP completion; verifies key pixels', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=160,h=120, origin=0xA200;
    const blue  = ((0<<11)|(0<<6)|(31<<1)|1)>>>0;
    const cyan  = ((0<<11)|(31<<6)|(31<<1)|1)>>>0;

    const atlas: TileAtlas = buildSMLogoAtlas16();
    const dl = [
      { op:'gradient' as const, start5551: blue, end5551: cyan },
      { op:'draw_tile' as const, id:'S', x: 40, y: 40 },
      { op:'draw_tile' as const, id:'M', x: 40+16+6, y: 40 },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 4, 10);
    expect(res.dpAcks).toBe(1); expect(res.viAcks).toBe(1);

    // Verify S top/middle/bottom bars are blue
    expect(px(image, 40+4, 40+0, w)).toEqual([0,0,255,255]);
    expect(px(image, 40+6, 40+Math.floor(16/2)-1, w)).toEqual([0,0,255,255]);
    expect(px(image, 40+8, 40+15, w)).toEqual([0,0,255,255]);

    // Verify M left vertical and a diagonal are red
    const mx=40+16+6;
    expect(px(image, mx+0, 40+5, w)).toEqual([255,0,0,255]);
    expect(px(image, mx+4, 40+4, w)).toEqual([255,0,0,255]);

    // Gap between S and M shows gradient; compute expected color at gapX
    const gapX = 40+16+3; const gapY = 40+8;
    const [r,g,b,a] = px(image, gapX, gapY, w);
    const exp = expectedGradientRGBA(w, blue, cyan, gapX);
    expect([r,g,b,a]).toEqual(exp);
  });

  it('two-frame DL sequence animates M by +1px and maintains ack counts', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=160,h=120, origin=0xA400;
    const blue  = ((0<<11)|(0<<6)|(31<<1)|1)>>>0;
    const red   = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;

    const atlas: TileAtlas = buildSMLogoAtlas16();
    const frames = [
      { at: 3, commands: [ { op:'gradient' as const, start5551: blue, end5551: blue }, { op:'draw_tile' as const, id:'M', x: 60, y: 50 } ] },
      { at: 6, commands: [ { op:'gradient' as const, start5551: red,  end5551: red  }, { op:'draw_tile' as const, id:'M', x: 61, y: 50 } ] },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, atlas, 10);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // Final frame: M at x=61; pixel at (61,51) is red, old (60,51) is red background
    expect(px(image, 61, 51, w)).toEqual([255,0,0,255]);
    const [r0,g0,b0,a0] = px(image, 60, 51, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });
});
