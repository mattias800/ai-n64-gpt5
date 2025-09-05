#!/bin/bash

echo "========================================="
echo "Running SM64 for 3 N64 seconds (180 frames)"
echo "========================================="
echo ""

# N64 specs:
# CPU: 93.75 MHz
# VI: 60 Hz 
# Cycles per frame: 1,562,500

CYCLES_PER_FRAME=1562500
TOTAL_CYCLES=281250000
OUTPUT_DIR="out"

echo "Settings:"
echo "  N64 CPU: 93.75 MHz"
echo "  N64 framerate: 60 Hz"  
echo "  Cycles per frame: $(printf "%'d" $CYCLES_PER_FRAME)"
echo "  Total cycles: $(printf "%'d" $TOTAL_CYCLES)"
echo "  Expected frames: 180"
echo "  Output: $OUTPUT_DIR/frame_*.png"
echo ""

# Clean output directory
rm -f $OUTPUT_DIR/*.png 2>/dev/null
rm -f $OUTPUT_DIR/*.log 2>/dev/null
rm -f $OUTPUT_DIR/*.json 2>/dev/null
rm -f $OUTPUT_DIR/*.csv 2>/dev/null

echo "Starting emulation..."
echo "This will take a while as we're emulating 281 million CPU cycles!"
echo ""

# Run emulator for exactly 3 N64 seconds
node packages/headless/dist/cli.js rom-boot-run ./mario64.z64 \
  --cycles $TOTAL_CYCLES \
  --ipl-hle \
  --jump-header \
  --vi-init \
  --vi-vblank \
  --vi-interval $CYCLES_PER_FRAME \
  --skip-reserved-at 0x8005c800 \
  --snapshot $OUTPUT_DIR/frame.png \
  --bridge \
  --timing-csv $OUTPUT_DIR/timing.csv \
  2>&1 | tee $OUTPUT_DIR/output.log | grep -E "(\[snapshot\]|\[bridge\]|endPC|frames)" &

PID=$!

# Monitor progress
PREV_COUNT=0
while kill -0 $PID 2>/dev/null; do
  COUNT=$(ls $OUTPUT_DIR/frame_*.png 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COUNT" -ne "$PREV_COUNT" ]; then
    echo "Progress: $COUNT frames generated..."
    PREV_COUNT=$COUNT
  fi
  sleep 2
done

wait $PID

echo ""
echo "Emulation complete!"
echo ""

# Count results
FRAME_COUNT=$(ls $OUTPUT_DIR/frame_*.png 2>/dev/null | wc -l | tr -d ' ')
BRIDGE_COUNT=$(ls $OUTPUT_DIR/*_bridge*.png 2>/dev/null | wc -l | tr -d ' ')

echo "Results:"
echo "  Frames captured: $FRAME_COUNT / 180"
echo "  Bridge frames: $BRIDGE_COUNT"
echo ""

if [ "$FRAME_COUNT" -gt 0 ]; then
  # Check file sizes to see if frames are blank
  FIRST_SIZE=$(stat -f%z "$OUTPUT_DIR/frame_f0.png" 2>/dev/null || echo 0)
  LAST_SIZE=$(stat -f%z "$OUTPUT_DIR/frame_f$((FRAME_COUNT-1)).png" 2>/dev/null || echo 0)
  
  echo "Frame info:"
  echo "  First frame size: $FIRST_SIZE bytes"
  echo "  Last frame size: $LAST_SIZE bytes"
  
  if [ "$FIRST_SIZE" -lt 1000 ]; then
    echo "  (Small file sizes indicate black/empty frames - game still initializing)"
  fi
  
  echo ""
  echo "View frames with:"
  echo "  open $OUTPUT_DIR/"
  echo ""
  echo "To create a video from frames (requires ffmpeg):"
  echo "  ffmpeg -r 60 -i $OUTPUT_DIR/frame_f%d.png -c:v libx264 -pix_fmt yuv420p sm64_3sec.mp4"
else
  echo "No frames captured. The emulation may need more time."
fi

# Extract final status
if [ -f "$OUTPUT_DIR/output.log" ]; then
  echo ""
  echo "Final emulator state:"
  grep "endPC" $OUTPUT_DIR/output.log | tail -1 || echo "  (Status not found)"
fi
