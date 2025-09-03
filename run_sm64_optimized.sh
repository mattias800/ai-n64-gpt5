#!/bin/bash

# Run SM64 with optimized settings to try to get actual game rendering
# Uses all the options that have shown promise in previous runs

echo "Running Super Mario 64 with optimized settings..."
echo "This will attempt to boot the game and capture actual rendered frames."
echo ""

# Clean up previous runs
rm -rf /tmp/sm64_run
mkdir -p /tmp/sm64_run

# Run with very high cycle count and all helpers enabled
echo "Starting emulation with 1 billion cycles..."
pnpm -s tsx packages/headless/src/cli.ts rom-boot-run ./mario64.z64 \
  --cycles 1000000000 \
  --vi-interval 625000 \
  --ipl-hle \
  --jump-header \
  --fastboot-hle \
  --vi-vblank \
  --vector-autoreturn \
  --vi-init \
  --bridge \
  --bridge-test \
  --bridge-log \
  --discover \
  --snapshot /tmp/sm64_run/frame.png \
  --trace-timing /tmp/sm64_run/timing.csv \
  --output /tmp/sm64_run/output.json \
  2>&1 | tee /tmp/sm64_run/run.log

echo ""
echo "Run complete. Checking results..."

# Check if we got any frames
FRAME_COUNT=$(ls /tmp/sm64_run/frame*.png 2>/dev/null | wc -l)
echo "Generated $FRAME_COUNT frame snapshots"

# Check if we got any bridge snapshots
BRIDGE_COUNT=$(ls /tmp/sm64_run/*bridge*.png 2>/dev/null | wc -l)
echo "Generated $BRIDGE_COUNT bridge snapshots"

# Check file sizes to see if we got real content
if [ $FRAME_COUNT -gt 0 ]; then
  echo ""
  echo "Frame file sizes:"
  ls -lh /tmp/sm64_run/*.png | head -5
  
  # Find frames with larger file sizes (indicating actual content)
  echo ""
  echo "Frames with content (>1KB):"
  find /tmp/sm64_run -name "*.png" -size +1k -ls | head -10
fi

echo ""
echo "Summary saved to: /tmp/sm64_run/"
echo "Check /tmp/sm64_run/frame*.png for visual output"
