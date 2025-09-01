import { describe, it, expect } from 'vitest';
import { runF3dTableFramesCore } from '../src/f3d_runner';
import { crc32Hex } from '../src/crc32';

describe('web f3d table core (gradient)', () => {
  it('produces deterministic CRCs for 2 frames', () => {
    const cfg = {
      video: { width: 192, height: 120, origin: 0xF000 },
      timing: { start: 2, interval: 3, frames: 2, spOffset: 1 },
      frames: [ [ { op: 'G_GRADIENT', bgStart: 0x001F, bgEnd: 0x07FF } ], [ { op: 'G_GRADIENT', bgStart: 0x001F, bgEnd: 0x07FF } ] ],
    };
    const res = runF3dTableFramesCore(cfg);
    expect(res.width).toBe(192);
    expect(res.height).toBe(120);
    expect(res.frames.length).toBe(2);
    const crcs = res.frames.map(f => crc32Hex(f));
    expect(crcs).toEqual(['99357c80', '99357c80']);
  });
});
