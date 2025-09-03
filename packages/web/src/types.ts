export interface VideoCfg { width: number; height: number; origin: number; }
export interface TimingCfg { start: number; interval: number; frames: number; spOffset: number; }
export interface BgCfg { start5551: number; end5551: number; }

export type TileFormat = 'CI8' | 'CI4';
export interface TileItem {
  format: TileFormat;
  tlutAddr: number;
  tlutCount?: number;
  pixAddr: number;
  w: number;
  h: number;
  x: number;
  y: number;
  ci4Palette?: number;
}

export type LoadKind = 'rom' | 'mio0';
export interface LoadItem {
  kind: LoadKind;
  srcRom: number;
  dest: number;
  length?: number; // required when kind==='rom'
}

export interface LayoutCfg { offsetPerFrameX?: number; }

export interface AssetsCfg {
  loads?: LoadItem[];
  tiles?: TileItem[];
}

export interface Sm64TitleConfig {
  video: VideoCfg;
  timing: TimingCfg;
  bg?: BgCfg;
  allocBase?: number;
  stagingBase?: number;
  strideWords?: number;
  layout?: LayoutCfg;
  assets?: AssetsCfg;
  expectedCrc32?: string[]; // optional per-frame expected CRC32 hex (8 chars)
}

export interface RunnerResult { frameImages: ImageData[]; crc32Hex: string[]; }

// F3DEX table-run config (as produced by headless discover)
export interface F3dexCfg { strideWords?: number; bgStart?: number; bgEnd?: number }
export interface PiLoad { cartAddr: number; dramAddr: number; length: number }
export interface FrameDl { dlWords?: Array<number | string> }
export interface F3dexRunConfig {
  video: VideoCfg; timing: TimingCfg; f3dex?: F3dexCfg; piLoads?: PiLoad[]; frames?: FrameDl[];
}
