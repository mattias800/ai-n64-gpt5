import type { Mat4, Vec3, Viewport, ClipCoord, ScreenVertex } from './vertex_pipeline.js';
import { transformToClip, clipToScreen } from './vertex_pipeline.js';

export type Tri3 = { a: Vec3; b: Vec3; c: Vec3 };
export type TriClip = { a: ClipCoord; b: ClipCoord; c: ClipCoord };
export type TriScreen = { a: ScreenVertex; b: ScreenVertex; c: ScreenVertex };

const outcode = (v: ClipCoord): number => {
  // Frustum planes in clip space: -w <= x,y,z <= w
  const w = v.w;
  let code = 0;
  if (v.x < -w) code |= 1 << 0; // left
  if (v.x > +w) code |= 1 << 1; // right
  if (v.y < -w) code |= 1 << 2; // bottom
  if (v.y > +w) code |= 1 << 3; // top
  if (v.z < -w) code |= 1 << 4; // near
  if (v.z > +w) code |= 1 << 5; // far
  return code >>> 0;
};

export const toClipTri = (mvp: Mat4, tri: Tri3): TriClip => ({
  a: transformToClip(mvp, tri.a),
  b: transformToClip(mvp, tri.b),
  c: transformToClip(mvp, tri.c),
});

export const triviallyRejects = (t: TriClip): boolean => {
  const ca = outcode(t.a), cb = outcode(t.b), cc = outcode(t.c);
  // If all three share any outside bit, reject
  return ((ca & cb & cc) !== 0);
};

export const clipToScreenTri = (t: TriClip, vp: Viewport): TriScreen => ({
  a: clipToScreen(t.a, vp),
  b: clipToScreen(t.b, vp),
  c: clipToScreen(t.c, vp),
});

