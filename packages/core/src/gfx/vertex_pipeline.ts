export interface Mat4 { m: readonly number[]; }
export interface Vec3 { x: number; y: number; z: number; }
export interface Viewport { x: number; y: number; width: number; height: number; }
export interface ClipCoord { x: number; y: number; z: number; w: number; }
export interface ScreenVertex { x: number; y: number; z: number; invW: number; }

const mat4 = (arr: readonly number[]): Mat4 => ({ m: arr.slice(0, 16) });

const mulMat4 = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array<number>(16).fill(0);
  const am = a.m, bm = b.m;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = am[r * 4 + 0]! * bm[0 * 4 + c]! + am[r * 4 + 1]! * bm[1 * 4 + c]! + am[r * 4 + 2]! * bm[2 * 4 + c]! + am[r * 4 + 3]! * bm[3 * 4 + c]!;
    }
  }
  return { m: out };
};

const mulMat4Vec4 = (m: Mat4, x: number, y: number, z: number, w: number): ClipCoord => {
  const a = m.m;
  const rx = a[0]! * x + a[1]! * y + a[2]! * z + a[3]! * w;
  const ry = a[4]! * x + a[5]! * y + a[6]! * z + a[7]! * w;
  const rz = a[8]! * x + a[9]! * y + a[10]! * z + a[11]! * w;
  const rw = a[12]! * x + a[13]! * y + a[14]! * z + a[15]! * w;
  return { x: rx, y: ry, z: rz, w: rw };
};

export const makeMat4 = (arr16: readonly number[]): Mat4 => mat4(arr16);

export const mvpMultiply = (modelView: Mat4, projection: Mat4): Mat4 => mulMat4(projection, modelView);

export const transformToClip = (mvp: Mat4, v: Vec3): ClipCoord => mulMat4Vec4(mvp, v.x, v.y, v.z, 1.0);

export const clipToScreen = (c: ClipCoord, vp: Viewport): ScreenVertex => {
  const invW = c.w !== 0 ? (1.0 / c.w) : 0.0;
  const ndcX = c.x * invW;
  const ndcY = c.y * invW;
  const ndcZ = c.z * invW;
  const sx = vp.x + (ndcX * 0.5 + 0.5) * vp.width;
  const sy = vp.y + (-(ndcY) * 0.5 + 0.5) * vp.height; // N64 origin at top-left
  // Map depth to 0..65535 for Z-buffer (simple linear mapping for now)
  const z = Math.max(0, Math.min(1, (ndcZ * 0.5 + 0.5))) * 65535.0;
  return { x: Math.round(sx) | 0, y: Math.round(sy) | 0, z: Math.round(z) | 0, invW };
};

