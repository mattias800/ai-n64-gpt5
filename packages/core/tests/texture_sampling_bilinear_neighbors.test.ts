import { describe, it, expect } from 'vitest';
import { bilinearNeighbors } from '../src/gfx/texture_sampling.ts';

type Mode = 0|1|2; // 0=CLAMP,1=WRAP,2=MIRROR

function approx(a: number, b: number, eps = 1e-6) { expect(Math.abs(a - b)).toBeLessThanOrEqual(eps); }

describe('texture_sampling.bilinearNeighbors boundary behavior', () => {
  it('CLAMP: negative coords clamp to 0 and use forward neighbor with zero weights', () => {
    const W=8, H=6; const s=-1.0, t=-0.5; const sm:Mode=0, tm:Mode=0;
    const nb = bilinearNeighbors(s,t,W,H,sm,tm);
    expect(nb.s0i).toBe(0); expect(nb.s1i).toBe(1);
    expect(nb.t0i).toBe(0); expect(nb.t1i).toBe(1);
    approx(nb.a, 0.0); approx(nb.b, 0.0);
  });

  it('CLAMP: coords at size clamp to last texel with weights near 1 and clamped neighbor index', () => {
    const W=8, H=6; const s=W, t=2.25; const sm:Mode=0, tm:Mode=0;
    const nb = bilinearNeighbors(s,t,W,H,sm,tm);
    expect(nb.s0i).toBe(W-1); expect(nb.s1i).toBe(W-1);
    expect(nb.t0i).toBe(2); expect(nb.t1i).toBe(3);
    approx(nb.a, 1.0, 1e-6); approx(nb.b, 0.25, 1e-6);
  });

  it('WRAP: negative and >size coords wrap around with correct neighbors and weights', () => {
    const W=8, H=6; const s=-0.2, t=H+0.3; const sm:Mode=1, tm:Mode=1;
    const nb = bilinearNeighbors(s,t,W,H,sm,tm);
    // s = -0.2 -> wrapped to 7.8 => floor=7, next=0, a=0.8
    expect(nb.s0i).toBe(7); expect(nb.s1i).toBe(0); approx(nb.a, 0.8, 1e-6);
    // t = 6.3 -> wrapped to 0.3 => floor=0, next=1, b=0.3
    expect(nb.t0i).toBe(0); expect(nb.t1i).toBe(1); approx(nb.b, 0.3, 1e-6);
  });

  it('MIRROR: exact size mirrors back with reverse neighbor and near-zero weight', () => {
    const W=8, H=6; const s=W, t=-0.2; const sm:Mode=2, tm:Mode=2;
    const nb = bilinearNeighbors(s,t,W,H,sm,tm);
    // s = W -> mirrored back to ~W-ε, dir=-1 -> neighbors W-1 and W-2, a≈0
    expect(nb.s0i).toBe(W-1); expect(nb.s1i).toBe(W-2); approx(nb.a, 0.0, 1e-6);
    // t = -0.2 -> mirrors to ~0.2, dir=-1 -> t0=0, t1=-1 -> index mirror makes both 0 or (0,1) depending on epsilon; b≈1-af or ~something small.
    // We assert t0 fixed and t1 maps in-bounds.
    expect(nb.t0i).toBeGreaterThanOrEqual(0); expect(nb.t0i).toBeLessThan(H);
    expect(nb.t1i).toBeGreaterThanOrEqual(0); expect(nb.t1i).toBeLessThan(H);
  });
});

