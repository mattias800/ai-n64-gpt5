#!/usr/bin/env node

/*
Run CEN64 with a ROM for a bounded duration, capturing output to a log file.

Usage:
  node scripts/run_cen64_trace.js \
    --pif /abs/path/PIF.rom \
    --rom /abs/path/game.z64 \
    --seconds 10 \
    --log tmp/cen64_trace.log [--profile] [--extra "-controller num=1"]

Notes:
- CEN64 does not expose a per-instruction CPU trace flag via CLI. This script
  captures stdout/stderr to a log file and can enable -profile if requested.
- Requires rosetta/x86_64 since cen64 was built as x86_64.
*/

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = {
    pif: process.env.PIF_ROM || '',
    rom: '',
    seconds: 10,
    log: 'tmp/cen64_trace.log',
    headless: true,
    noaudio: true,
    novideo: true,
    profile: false,
    extra: '',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = i + 1 < args.length ? args[i + 1] : undefined;
    const eat = () => { i++; return next; };

    if (a === '--pif' && next) out.pif = eat();
    else if (a === '--rom' && next) out.rom = eat();
    else if ((a === '--seconds' || a === '--secs') && next) out.seconds = Math.max(1, Number(eat())|0);
    else if (a === '--log' && next) out.log = eat();
    else if (a === '--profile') out.profile = true;
    else if (a === '--ui') out.headless = false;
    else if (a === '--audio') out.noaudio = false;
    else if (a === '--video') out.novideo = false;
    else if (a === '--extra' && next) out.extra = eat();
    else if (a === '--help' || a === '-h') usage(0);
  }

  if (!out.pif || !out.rom) usage(1);
  return out;
};

const usage = (code) => {
  const u = `Usage: node scripts/run_cen64_trace.js --pif /abs/PIF.rom --rom /abs/game.z64 --seconds 10 --log tmp/cen64_trace.log [--profile] [--extra "..."]\n`;
  process.stderr.write(u);
  process.exit(code);
};

const ensureDir = async (filePath) => {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
};

(async () => {
  const opts = parseArgs();

  const repoRoot = path.resolve(__dirname, '..');
  const cen64Bin = path.resolve(repoRoot, 'third_party/cen64/build_x64/cen64');

  if (!fs.existsSync(cen64Bin)) {
    console.error(`cen64 binary not found at ${cen64Bin}. Build it first.`);
    process.exit(2);
  }
  if (!fs.existsSync(opts.pif)) {
    console.error(`PIF ROM not found: ${opts.pif}`);
    process.exit(3);
  }
  if (!fs.existsSync(opts.rom)) {
    console.error(`Cart ROM not found: ${opts.rom}`);
    process.exit(4);
  }

  await ensureDir(opts.log);
  const logStream = fs.createWriteStream(opts.log, { flags: 'w' });

  // Construct cen64 args
  const cenArgs = [];
  if (opts.headless) cenArgs.push('-headless');
  if (opts.noaudio) cenArgs.push('-noaudio');
  if (opts.novideo) cenArgs.push('-novideo');
  if (opts.profile) cenArgs.push('-profile');

  if (opts.extra && opts.extra.trim().length) {
    // Split extra by whitespace, respecting basic quoted strings
    const extraParts = opts.extra.match(/([^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    cenArgs.push(...extraParts);
  }

  // Required positional args: PIF first, then Cart ROM (optional but we require here)
  cenArgs.push(opts.pif);
  cenArgs.push(opts.rom);

  // Run under Rosetta to match x86_64 binary
  const cmd = '/usr/bin/arch';
  const cmdArgs = ['-x86_64', cen64Bin, ...cenArgs];

  console.log(`Spawning: ${cmd} ${cmdArgs.map(a => (a.includes(' ') ? '"'+a+'"' : a)).join(' ')}`);
  console.log(`Logging to: ${path.resolve(opts.log)}`);

  const child = spawn(cmd, cmdArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // create its own process group so we can kill group
  });

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  let exited = false;
  const cleanup = (code, signal) => {
    if (exited) return;
    exited = true;
    try { logStream.end(); } catch {}
    console.log(`cen64 exited code=${code} signal=${signal ?? ''}`);
  };

  child.on('exit', (code, signal) => cleanup(code, signal));
  child.on('error', (err) => {
    console.error('Failed to start cen64:', err);
    try { logStream.end(); } catch {}
    process.exit(5);
  });

  const deadlineMs = Math.max(1, opts.seconds) * 1000;
  const gentleMs = 1500; // grace after SIGINT
  const forceMs = 3000;  // grace after SIGTERM

  setTimeout(() => {
    if (exited) return;
    // Send signals to the whole process group
    try {
      process.kill(-child.pid, 'SIGINT');
    } catch {}

    setTimeout(() => {
      if (exited) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}

      setTimeout(() => {
        if (exited) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, forceMs);
    }, gentleMs);
  }, deadlineMs);
})();

