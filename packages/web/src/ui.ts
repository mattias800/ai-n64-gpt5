import type { Sm64TitleConfig } from './types';

const toNum = (v: unknown, d: number = 0): number => {
  if (typeof v === 'number') return (v >>> 0);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
    const n = Number(s); return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
  }
  return (d >>> 0);
};

export const readFileAsArrayBuffer = (file: File): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(fr.error);
  fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
  fr.readAsArrayBuffer(file);
});

export const readFileAsText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(fr.error);
  fr.onload = () => resolve(String(fr.result));
  fr.readAsText(file);
});

export const fetchSampleConfig = async (): Promise<unknown> => {
  const res = await fetch('/samples/sm64-rom-title.sample.json');
  if (!res.ok) throw new Error(`Failed to fetch sample: ${res.status}`);
  return res.json();
};

export const normalizeConfig = (raw: unknown): Sm64TitleConfig => {
  const obj = (raw && typeof raw === 'object') ? (raw as any) : {};
  const video = {
    width: toNum(obj.video?.width, 192),
    height: toNum(obj.video?.height, 120),
    origin: toNum(obj.video?.origin, 0xF000),
  };
  const timing = {
    start: toNum(obj.timing?.start, 2),
    interval: toNum(obj.timing?.interval, 3),
    frames: toNum(obj.timing?.frames, 2),
    spOffset: toNum(obj.timing?.spOffset, 1),
  };
  const bg = obj.bg ? { start5551: toNum(obj.bg.start5551), end5551: toNum(obj.bg.end5551) } : undefined;
  const allocBase = obj.allocBase !== undefined ? toNum(obj.allocBase) : undefined;
  const stagingBase = obj.stagingBase !== undefined ? toNum(obj.stagingBase) : undefined;
  const strideWords = obj.strideWords !== undefined ? toNum(obj.strideWords) : undefined;
  const layout = obj.layout ? { offsetPerFrameX: toNum(obj.layout.offsetPerFrameX, 1) } : undefined;

  const loadsRaw: any[] = Array.isArray(obj.assets?.loads) ? obj.assets.loads : [];
  const loads = loadsRaw.map((L) => ({
    kind: String(L.kind || L.type || 'rom') as 'rom' | 'mio0',
    srcRom: toNum(L.srcRom),
    dest: toNum(L.dest),
    length: L.length !== undefined ? toNum(L.length) : undefined,
  }));

  const tilesRaw: any[] = Array.isArray(obj.assets?.tiles) ? obj.assets.tiles : [];
  const tiles = tilesRaw.map((t) => ({
    format: String(t.format || 'CI8') as 'CI8' | 'CI4',
    tlutAddr: toNum(t.tlutAddr),
    tlutCount: t.tlutCount !== undefined ? toNum(t.tlutCount) : undefined,
    pixAddr: toNum(t.pixAddr),
    w: toNum(t.w), h: toNum(t.h), x: toNum(t.x), y: toNum(t.y),
    ci4Palette: t.ci4Palette !== undefined ? toNum(t.ci4Palette) : undefined,
  }));

  const expectedCrc32: string[] | undefined = Array.isArray(obj.expectedCrc32) ? obj.expectedCrc32.map((s: any) => String(s)) : undefined;

  return {
    video, timing, bg, allocBase, stagingBase, strideWords, layout,
    assets: { loads, tiles }, expectedCrc32,
  };
};
