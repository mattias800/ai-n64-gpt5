#!/bin/bash

echo "========================================="
echo "Running SM64 for 3 N64 seconds (180 frames)"
echo "========================================="
echo ""

# N64 specs:
# CPU: 93.75 MHz (93,750,000 cycles per second)
# VI: 60 Hz (60 frames per second)
# Cycles per frame: 93,750,000 / 60 = 1,562,500 cycles

# For 3 seconds of N64 time:
# Total cycles: 93,750,000 * 3 = 281,250,000 cycles
# Total frames: 60 * 3 = 180 frames

CYCLES_PER_FRAME=1562500
TOTAL_CYCLES=281250000
OUTPUT_DIR="out"

echo "N64 CPU frequency: 93.75 MHz"
echo "N64 frame rate: 60 Hz"
echo "Cycles per frame: $CYCLES_PER_FRAME"
echo "Running for: 3 N64 seconds"
echo "Total cycles: $TOTAL_CYCLES"
echo "Expected frames: 180"
echo "Output folder: $OUTPUT_DIR/"
echo ""

# Clean the output directory
rm -f $OUTPUT_DIR/*.png 2>/dev/null
rm -f $OUTPUT_DIR/*.log 2>/dev/null

echo "Starting emulation..."
echo ""

# Run the emulator
# --vi-interval sets how many cycles between VI interrupts (frames)
# --snapshot captures a frame at each VI interrupt
node packages/headless/dist/cli.js rom-boot-run ./mario64.z64 \
  --cycles $TOTAL_CYCLES \
  --ipl-hle \
  --jump-header \
  --vi-init \
  --vi-vblank \
  --vi-interval $CYCLES_PER_FRAME \
  --skip-reserved-at 0x8005c800 \
  --snapshot \
  --snap-dir $OUTPUT_DIR \
  --bridge \
  --timing-csv $OUTPUT_DIR/timing.csv \
  > $OUTPUT_DIR/run.json 2>$OUTPUT_DIR/error.log

echo ""
echo "Emulation complete!"
echo ""

# Count the results
FRAME_COUNT=$(ls $OUTPUT_DIR/snapshot_*.png 2>/dev/null | wc -l | tr -d ' ')
BRIDGE_COUNT=$(ls $OUTPUT_DIR/*_bridge*.png 2>/dev/null | wc -l | tr -d ' ')

echo "Results:"
echo "  Regular frames captured: $FRAME_COUNT"
echo "  Bridge frames (with graphics): $BRIDGE_COUNT"
echo ""

if [ "$FRAME_COUNT" -gt 0 ]; then
  echo "Frames saved in: $OUTPUT_DIR/"
  echo ""
  echo "Note: These are the first 3 seconds of N64 boot time."
  echo "The frames will likely be all black as SM64 is still"
  echo "initializing during this time."
  echo ""
  echo "To view the frames:"
  echo "  open $OUTPUT_DIR/"
  
  # Check the final status from the JSON
  if [ -f "$OUTPUT_DIR/run.json" ]; then
    echo ""
    echo "Emulator status:"
    cat $OUTPUT_DIR/run.json | jq -r '
      "  End PC: " + .endPC,
      "  PI DMAs: " + (.events.piDmas | tostring),
      "  SP starts: " + (.events.spStarts | tostring),
      "  VI origin: 0x" + (.vi.origin | tostring | ltrimstr("0x")),
      "  VI width: " + (.vi.width | tostring)
    ' 2>/dev/null || cat $OUTPUT_DIR/run.json | tail -5
  fi
else
  echo "No frames were captured. Check $OUTPUT_DIR/error.log for errors."
fi
