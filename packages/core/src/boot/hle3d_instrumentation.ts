export interface Hle3DStats {
  g_mtx: number;
  g_vtx: number;
  g_tri1: number;
  g_tri2: number;
  g_texrect: number;
  scissorSets: number;
  setImg: { CI4: number; CI8: number; RGBA16: number; OTHER: number };
  setCombine: Record<string, number>;
  setTexFilter: Record<string, number>;
}

const stats: Hle3DStats = {
  g_mtx: 0,
  g_vtx: 0,
  g_tri1: 0,
  g_tri2: 0,
  g_texrect: 0,
  scissorSets: 0,
  setImg: { CI4: 0, CI8: 0, RGBA16: 0, OTHER: 0 },
  setCombine: {},
  setTexFilter: {},
};

const inc = (obj: Record<string, number>, key: string): void => { obj[key] = ((obj[key] ?? 0) + 1) >>> 0; };

export const resetHle3DStats = (): void => {
  stats.g_mtx = 0; stats.g_vtx = 0; stats.g_tri1 = 0; stats.g_tri2 = 0; stats.g_texrect = 0; stats.scissorSets = 0;
  stats.setImg.CI4 = 0; stats.setImg.CI8 = 0; stats.setImg.RGBA16 = 0; stats.setImg.OTHER = 0;
  stats.setCombine = {}; stats.setTexFilter = {};
};

export const getHle3DStats = (): Readonly<Hle3DStats> => stats;

export const noteMtx = (): void => { stats.g_mtx = (stats.g_mtx + 1) >>> 0; };
export const noteVtx = (count: number): void => { stats.g_vtx = (stats.g_vtx + (count >>> 0)) >>> 0; };
export const noteTri1 = (): void => { stats.g_tri1 = (stats.g_tri1 + 1) >>> 0; };
export const noteTri2 = (): void => { stats.g_tri2 = (stats.g_tri2 + 1) >>> 0; };
export const noteTexRect = (): void => { stats.g_texrect = (stats.g_texrect + 1) >>> 0; };
export const noteScissor = (): void => { stats.scissorSets = (stats.scissorSets + 1) >>> 0; };

export const noteSetImg = (fmt: string | null): void => {
  const key = fmt === 'CI4' || fmt === 'CI8' || fmt === 'RGBA16' ? fmt : 'OTHER';
  stats.setImg[key] = ((stats.setImg[key as keyof typeof stats.setImg] ?? 0) + 1) >>> 0;
};

export const noteSetCombine = (mode: string): void => { inc(stats.setCombine, mode); };
export const noteSetTexFilter = (mode: string): void => { inc(stats.setTexFilter, mode); };

