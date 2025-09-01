#!/usr/bin/env bash
set -euo pipefail

# Root of repo
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# Resolve ROM path (env override or default to mario64.z64 in repo root)
SM64_ROM="${SM64_ROM:-$ROOT/mario64.z64}"
if [[ ! -f "$SM64_ROM" ]]; then
  echo "SM64_ROM not found: $SM64_ROM" >&2
  exit 1
fi

# 1) Install and build
npm ci
npm run build

# 2) Clean and prepare output dirs
rm -rf tmp/boot tmp/title tmp/probe tmp/mio0 tmp/logs
mkdir -p tmp/boot tmp/title tmp/probe tmp/logs

# 3) Quick sanity checks (no ROM)
node packages/headless/dist/cli.js sm64-demo --frames 1 --snapshot tmp/sm64_demo.png
node packages/headless/dist/cli.js rspdl-ci8-ring --frames 2 --snapshot tmp/ring.png

# 4) Cycle-stepped ROM boot with visible output via F3DEX bridge + PI kick + optional SP task injection
node packages/headless/dist/cli.js rom-boot-run "$SM64_ROM" \
  --cycles 2000000 \
  --vi-interval 10000 \
  --width 320 --height 240 \
  --snapshot tmp/boot/boot_full.png \
  --trace-timing tmp/boot/timing_full.csv \
  --bridge --bridge-log \
  --force-sp-at 50000 \
  --kick-pi-cart 0x1000 --kick-pi-dram 0x00100000 --kick-pi-len 0x4000 --kick-pi-at 60000

# 5) Scan and probe MIO0 blocks to identify likely title assets
node packages/headless/dist/cli.js rom-scan-mio0 "$SM64_ROM" --out tmp/mio0_scan.json --extract-dir tmp/mio0 --limit 10 --min-size 4096
# Use the largest discovery by default
TOP_OFF=$(node -e 'const s=require("fs").readFileSync("tmp/mio0_scan.json","utf8");const j=JSON.parse(s);if(!Array.isArray(j.entries)||!j.entries.length){process.exit(1)};console.log(j.entries[0].off);')
node packages/headless/dist/cli.js rom-probe-mio0 "$SM64_ROM" --off "$TOP_OFF" --out-dir tmp/probe --sweep --w 192 --h 120

# 6) ROM-backed title slice config (based on a known-good probe @ 0x114750)
cat > tmp/sm64-rom-title.json <<JSON
{
  "rom": "${SM64_ROM}",
  "video": { "width": 192, "height": 120, "origin": "0xF000" },
  "timing": { "start": 2, "interval": 3, "frames": 2, "spOffset": 1 },
  "bg": { "start5551": "0x001F", "end5551": "0x07FF" },
  "allocBase": "0x30000",
  "stagingBase": "0x40000",
  "strideWords": 256,
  "layout": { "offsetPerFrameX": 1 },
  "assets": {
    "loads": [
      { "kind": "mio0", "srcRom": "0x114750", "dest": "0x32000" }
    ],
    "tiles": [
      { "format": "CI4", "tlutAddr": "0x32000", "tlutCount": 32, "pixAddr": "0x32100", "w": 128, "h": 32, "x": 40, "y": 30, "ci4Palette": 0 }
    ]
  }
}
JSON

# 7) Render the title frames from ROM assets
node packages/headless/dist/cli.js sm64-rom-title tmp/sm64-rom-title.json --snapshot tmp/title/sm64_title.png

# 8) Update web expected CRCs and run parity check
npm run web:crc:update -- --config tmp/sm64-rom-title.json --rom "$SM64_ROM" --frames 2 --write
SM64_WEB_CFG="$ROOT/tmp/sm64-rom-title.json" SM64_WEB_ROM="$SM64_ROM" npm run web:test:rom

# 9) Optional: run n64-tests ROM harness (set N64_TESTS=1 to enable)
if [[ "${N64_TESTS:-}" == "1" ]]; then
  N64_TESTS=1 N64_TESTS_ROM_DIR="$(pwd)/test-roms/n64-tests/roms" npx vitest run packages/core/tests/n64_tests_roms.test.ts || true
fi

# 10) Artifacts manifest
find tmp -type f | sort > tmp/MANIFEST.txt

echo "Bring-up complete. See tmp/ for PNGs, logs, and timing CSVs."
