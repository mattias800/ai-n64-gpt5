import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDLSequence, TileAtlas } from '../src/boot/title_dl_hle.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

function solid(w: number, h: number, c: number): Uint16Array { const t=new Uint16Array(w*h); t.fill(c>>>0); return t; }

describe('DL sequence: two frames with different gradients/tiles; DP/VI acks counted', () => {
  it('executes two DLs at different cycles and reflects last frame in scanout', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=128,h=96, origin=0x9100;
    const blue  = ((0<<11)|(0<<6)|(31<<1)|1)>>>0;
    const green = ((0<<11)|(31<<6)|(0<<1)|1)>>>0;
    const red   = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    const yellow= ((31<<11)|(31<<6)|(0<<1)|1)>>>0;

    const atlas: TileAtlas = {
      R: { width: 6, height: 6, pixels: solid(6,6, red) },
      Y: { width: 6, height: 6, pixels: solid(6,6, yellow) },
    };

    const frames = [
      { at: 2, commands: [ { op:'gradient' as const, start5551: blue, end5551: green }, { op:'draw_tile' as const, id:'R', x: 8, y: 8 } ] },
      { at: 5, commands: [ { op:'gradient' as const, start5551: red,  end5551: red },   { op:'draw_tile' as const, id:'Y', x: 16, y: 16 } ] },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, atlas, 8);

    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);

    // Final frame has red background; left edge mid pixel should be red
    const [r,g,b,a] = px(image, 0, Math.floor(h/2), w);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(200); expect(g).toBeLessThan(50); expect(b).toBeLessThan(50);
    // Yellow tile present at (16,16)
    expect(px(image, 16, 16, w)).toEqual([255,255,0,255]);
  });
});
