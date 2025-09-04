#!/bin/bash

# Run SM64 with enough cycles to reach title screen
# This will take a while but should eventually show the Mario head

echo "Running Super Mario 64 to reach title screen..."
echo "This will take several minutes. Please be patient."

# Create output directory
mkdir -p /tmp/sm64_title_screen

# Run with a very high cycle count
# - ipl-hle: Use high-level IPL emulation
# - jump-header: Jump directly to game entry point
# - vi-init: Initialize video interface
# - vi-vblank: Generate vblank interrupts
# - skip-reserved-at: Skip reserved instruction that causes issues
# - bridge: Enable graphics bridge for rendering
# - bridge-log: Log bridge activity
# - snap-dir: Save snapshots to directory
# - timing-csv: Save timing information

node packages/headless/dist/cli.js rom-boot-run ./mario64.z64 \
  --cycles 10000000000 \
  --ipl-hle \
  --jump-header \
  --vi-init \
  --vi-vblank \
  --skip-reserved-at 0x8005c800 \
  --bridge \
  --bridge-log \
  --snap-dir /tmp/sm64_title_screen \
  --timing-csv /tmp/sm64_title_screen/timing.csv \
  2>/dev/null | tee /tmp/sm64_title_screen/output.json | \
  jq -r '
    if .events.spStarts > 0 then
      "SP starts: \(.events.spStarts)"
    else empty end,
    if .events.piDmas > 0 then
      "PI DMAs: \(.events.piDmas)"
    else empty end,
    if .frames > 0 then
      "Frames rendered: \(.frames)"
    else empty end
  '

echo ""
echo "Run complete. Checking for rendered frames..."

# Check if any snapshots were generated
if ls /tmp/sm64_title_screen/*.png 1> /dev/null 2>&1; then
    echo "Success! Snapshots generated:"
    ls -la /tmp/sm64_title_screen/*.png | tail -5
    echo ""
    echo "View the latest snapshot with:"
    echo "open /tmp/sm64_title_screen/snapshot_*.png"
else
    echo "No snapshots generated yet. The game may need more cycles."
fi

# Check if any bridge snapshots were generated
if ls /tmp/sm64_title_screen/*_bridge*.png 1> /dev/null 2>&1; then
    echo ""
    echo "Bridge snapshots generated:"
    ls -la /tmp/sm64_title_screen/*_bridge*.png | tail -5
fi
