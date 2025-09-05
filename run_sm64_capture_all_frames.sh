#!/bin/bash

echo "==============================================="
echo "Starting Super Mario 64 - Capturing EVERY frame"
echo "==============================================="
echo ""
echo "This will generate a PNG for every VI vblank (60 fps)"
echo "Output directory: ~/Desktop/sm64_all_frames/"
echo ""

# Create output directory
OUTPUT_DIR=~/Desktop/sm64_all_frames
mkdir -p $OUTPUT_DIR
rm -f $OUTPUT_DIR/*.png 2>/dev/null  # Clean up old frames

# Calculate cycles for VI interrupts
# N64 CPU: 93.75 MHz
# VI: 60 Hz (NTSC)
# Cycles per frame: 93,750,000 / 60 = 1,562,500
# But the emulator uses a default of 10,000 cycles per VI interrupt for faster testing
# We'll use --vi-interval to set it correctly

echo "Starting emulation at $(date)"
echo "Press Ctrl+C to stop"
echo ""
echo "Frames will appear in: $OUTPUT_DIR"
echo "Watch progress with: ls -la $OUTPUT_DIR/*.png | wc -l"
echo ""

# Run the emulator
# --vi-interval 1562500 would be realistic but very slow
# Using 10000 for faster progress (will generate more frames)
node packages/headless/dist/cli.js rom-boot-run ./mario64.z64 \
  --cycles 100000000000 \
  --ipl-hle \
  --jump-header \
  --vi-init \
  --vi-vblank \
  --vi-interval 10000 \
  --skip-reserved-at 0x8005c800 \
  --snapshot \
  --snap-dir $OUTPUT_DIR \
  --bridge \
  --bridge-log \
  --timing-csv $OUTPUT_DIR/timing.csv \
  > $OUTPUT_DIR/run.log 2>&1 &

PID=$!
echo "Process started with PID: $PID"
echo ""

# Save PID for later
echo $PID > $OUTPUT_DIR/pid.txt

# Monitor script
cat << 'MONITOR' > $OUTPUT_DIR/monitor.sh
#!/bin/bash
OUTPUT_DIR=~/Desktop/sm64_all_frames
while true; do
  if ! ps -p $(cat $OUTPUT_DIR/pid.txt 2>/dev/null) > /dev/null 2>&1; then
    echo "Process stopped."
    break
  fi
  
  FRAME_COUNT=$(ls -la $OUTPUT_DIR/snapshot_*.png 2>/dev/null | wc -l | tr -d ' ')
  BRIDGE_COUNT=$(ls -la $OUTPUT_DIR/*_bridge*.png 2>/dev/null | wc -l | tr -d ' ')
  
  echo "$(date '+%H:%M:%S'): Frames: $FRAME_COUNT regular, $BRIDGE_COUNT bridge"
  
  # Check if we have actual rendered content (non-black frames)
  if [ "$BRIDGE_COUNT" -gt 0 ]; then
    echo "  Bridge frames detected! Game is rendering graphics!"
    LATEST=$(ls -t $OUTPUT_DIR/*_bridge*.png 2>/dev/null | head -1)
    if [ ! -z "$LATEST" ]; then
      echo "  Latest: $(basename $LATEST)"
    fi
  fi
  
  sleep 10
done

echo ""
echo "Final statistics:"
echo "Total frames captured: $(ls -la $OUTPUT_DIR/snapshot_*.png 2>/dev/null | wc -l | tr -d ' ')"
echo "Bridge frames (with graphics): $(ls -la $OUTPUT_DIR/*_bridge*.png 2>/dev/null | wc -l | tr -d ' ')"
MONITOR

chmod +x $OUTPUT_DIR/monitor.sh

echo "Monitor the progress with:"
echo "  $OUTPUT_DIR/monitor.sh"
echo ""
echo "Stop the emulation with:"
echo "  kill $PID"
echo ""
echo "View frames as they're generated:"
echo "  open $OUTPUT_DIR"
echo ""
echo "The first frames will be black (during initialization)."
echo "Once SM64 starts rendering, you'll see the Nintendo logo,"
echo "then eventually the Mario head on the title screen!"
echo ""
echo "Starting monitoring..."
sleep 2
$OUTPUT_DIR/monitor.sh
