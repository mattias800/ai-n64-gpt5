import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDLSequence, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { buildRing32Atlas16 } from '../src/boot/title_logo_real_atlas.ts';
import { px, seamX, seamY, seamSampleYs, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Property-like test: random small offsets and verify seam continuity and shift-in/out on ±1, ±2 moves

describe('DL HLE seam continuity under small offsets', () => {
  it('ring seams remain continuous and pixels shift correctly for small +dx moves', () => {
    const w=160,h=120, origin=0xBC00;
    const atlas: TileAtlas = buildRing32Atlas16(COLORS_5551.green);

    // Try a few deterministic offsets to avoid flakiness
    const trials = [ {x: 40, y: 40, dx: 1}, {x: 41, y: 42, dx: 2}, {x: 35, y: 38, dx: 1} ];

    for (const t of trials) {
      const rdram = new RDRAM(1<<18);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const frames = [
        { at: 2, commands: [ dlSolid(COLORS_5551.blue),
                             { op:'draw_tile' as const, id:'RING00', x: t.x, y: t.y },
                             { op:'draw_tile' as const, id:'RING01', x: seamX(t.x), y: t.y },
                             { op:'draw_tile' as const, id:'RING10', x: t.x, y: seamX(t.y) },
                             { op:'draw_tile' as const, id:'RING11', x: seamX(t.x), y: seamX(t.y) }, ] },
        { at: 5, commands: [ dlSolid(COLORS_5551.red),
                             { op:'draw_tile' as const, id:'RING00', x: t.x + t.dx, y: t.y },
                             { op:'draw_tile' as const, id:'RING01', x: seamX(t.x + t.dx), y: t.y },
                             { op:'draw_tile' as const, id:'RING10', x: t.x + t.dx, y: seamX(t.y) },
                             { op:'draw_tile' as const, id:'RING11', x: seamX(t.x + t.dx), y: seamX(t.y) }, ] },
      ];

      const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, atlas, 10);
      expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

      // New seam should be green near top edge
      const newSx = seamX(t.x + t.dx);
      for (const y of seamSampleYs(t.y, 2, 2)) expect(px(image, newSx, y, w)).toEqual([0,255,0,255]);

      // A pixel just left of old seam should be red background (avoid ring thickness)
      const [r0,g0,b0,a0] = px(image, seamX(t.x)-1, t.y+8, w);
      expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
    }
  });

  it('ring seams remain continuous for small +dy moves (vertical shift)', () => {
    const w=160,h=120, origin=0xBD00;
    const atlas: TileAtlas = buildRing32Atlas16(COLORS_5551.green);

    const trials = [ {x: 44, y: 36, dy: 1}, {x: 46, y: 34, dy: 2} ];

    for (const t of trials) {
      const rdram = new RDRAM(1<<18);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const frames = [
        { at: 2, commands: [ dlSolid(COLORS_5551.blue),
                             { op:'draw_tile' as const, id:'RING00', x: t.x, y: t.y },
                             { op:'draw_tile' as const, id:'RING01', x: seamX(t.x), y: t.y },
                             { op:'draw_tile' as const, id:'RING10', x: t.x, y: seamY(t.y) },
                             { op:'draw_tile' as const, id:'RING11', x: seamX(t.x), y: seamY(t.y) }, ] },
        { at: 5, commands: [ dlSolid(COLORS_5551.red),
                             { op:'draw_tile' as const, id:'RING00', x: t.x, y: t.y + t.dy },
                             { op:'draw_tile' as const, id:'RING01', x: seamX(t.x), y: t.y + t.dy },
                             { op:'draw_tile' as const, id:'RING10', x: t.x, y: seamY(t.y + t.dy) },
                             { op:'draw_tile' as const, id:'RING11', x: seamX(t.x), y: seamY(t.y + t.dy) }, ] },
      ];

      const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, atlas, 10);
      expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

      // New horizontal seam should be green at x near left stroke (x+3) on new y seam
      const newSy = seamY(t.y + t.dy);
      expect(px(image, t.x + 3, newSy, w)).toEqual([0,255,0,255]);
    }
  });
});
