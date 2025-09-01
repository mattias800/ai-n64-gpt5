#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { runSm64TitleFramesCore } from './sm64_title_runner.js';
import { normalizeConfig } from './ui.js';
import type { Sm64TitleConfig } from './types.js';

const args = process.argv.slice(2);
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = (i + 1 < args.length) ? args[i + 1] : undefined;
  const val = (next && !next.startsWith('--')) ? args[++i]! : '1';
  opts[key] = val;
}

const parseNum = (v: string | undefined, d: number): number => {
  if (!v) return d >>> 0; const s = v.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
  const n = Number(s); return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
};

const romPath = opts['rom'];
const cfgPath = opts['config'];
const frames = parseNum(opts['frames'], 2);
const writeBack = Object.prototype.hasOwnProperty.call(opts, 'write') || opts['write'] === '1' || opts['write'] === 'true';

if (!cfgPath) {
  // eslint-disable-next-line no-console
  console.error('Usage: node dist/gen_expected_crc.js --config path.json [--rom path.z64] [--frames N] [--write]');
  process.exit(1);
}

const toAbs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

let romBytes: Uint8Array;
if (romPath) {
  romBytes = new Uint8Array(readFileSync(toAbs(romPath)));
} else {
  romBytes = new Uint8Array(8 * 1024 * 1024);
}

const raw = JSON.parse(readFileSync(toAbs(cfgPath), 'utf8')) as unknown;
const cfg = normalizeConfig(raw);

const run = await runSm64TitleFramesCore(romBytes, cfg, frames);
const outCfg: any = JSON.parse(JSON.stringify(raw));
(outCfg as any).expectedCrc32 = run.crc32Hex;

if (writeBack) {
  writeFileSync(toAbs(cfgPath), JSON.stringify(outCfg, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[updated] ${cfgPath}`);
} else {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(outCfg, null, 2));
}
