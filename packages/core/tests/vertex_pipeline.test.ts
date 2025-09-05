import { describe, it, expect } from 'vitest';
import { makeMat4, mvpMultiply, transformToClip, clipToScreen } from '../src/gfx/vertex_pipeline.ts';
import { toClipTri, triviallyRejects, clipToScreenTri } from '../src/gfx/tri_project.ts';

describe('vertex pipeline basics', () => {
  const identity = makeMat4([
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    0,0,0,1,
  ]);
  const vp = { x: 0, y: 0, width: 192, height: 120 };

  it('maps NDC (identity mvp) to screen space', () => {
    const vClip = transformToClip(identity, { x: 0, y: 0, z: 0 });
    const vs = clipToScreen(vClip, vp);
    expect(vs.x).toBeCloseTo(96, 0);
    expect(vs.y).toBeCloseTo(60, 0);
    expect(vs.z).toBeGreaterThanOrEqual(0);
    expect(vs.z).toBeLessThanOrEqual(65535);
  });

  it('trivially rejects triangle fully to the left of frustum', () => {
    const tri = { a: { x: -3, y: 0, z: 0 }, b: { x: -2, y: 1, z: 0 }, c: { x: -2, y: -1, z: 0 } };
    const tClip = toClipTri(identity, tri);
    expect(triviallyRejects(tClip)).toBe(true);
  });

  it('accepts triangle inside frustum and maps to screen', () => {
    const tri = { a: { x: -0.5, y: -0.5, z: 0 }, b: { x: 0.5, y: -0.5, z: 0 }, c: { x: 0, y: 0.5, z: 0 } };
    const tClip = toClipTri(identity, tri);
    expect(triviallyRejects(tClip)).toBe(false);
    const tScr = clipToScreenTri(tClip, vp);
    // screen coords should be within viewport bounds
    for (const v of [tScr.a, tScr.b, tScr.c]) {
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.x).toBeLessThanOrEqual(vp.width - 1);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeLessThanOrEqual(vp.height - 1);
    }
    // x centroid near middle
    const cx = Math.round((tScr.a.x + tScr.b.x + tScr.c.x) / 3);
    expect(cx).toBeCloseTo(96, 2);
  });
});

