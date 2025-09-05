#!/bin/bash

echo "Monitoring SM64 emulation progress..."
echo "=================================="

while true; do
  # Check if process is still running
  if ! ps -p $(cat /tmp/sm64_pid.txt 2>/dev/null) > /dev/null 2>&1; then
    echo "Process has stopped."
    break
  fi
  
  # Check for snapshots
  PNG_COUNT=$(ls -la /tmp/sm64_mario_head/*.png 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PNG_COUNT" -gt 0 ]; then
    echo "$(date): Found $PNG_COUNT snapshots!"
    ls -la /tmp/sm64_mario_head/*.png | tail -3
    echo "SUCCESS! Mario head should be visible in the snapshots."
    echo "View with: open /tmp/sm64_mario_head/*.png"
    break
  fi
  
  # Check for bridge snapshots
  BRIDGE_COUNT=$(ls -la /tmp/sm64_mario_head/*bridge*.png 2>/dev/null | wc -l | tr -d ' ')
  if [ "$BRIDGE_COUNT" -gt 0 ]; then
    echo "$(date): Found $BRIDGE_COUNT bridge snapshots!"
    ls -la /tmp/sm64_mario_head/*bridge*.png | tail -3
  fi
  
  # Show CPU usage
  CPU=$(ps aux | grep -E "node.*mario64" | grep -v grep | awk '{print $3}')
  MEM=$(ps aux | grep -E "node.*mario64" | grep -v grep | awk '{print $4}')
  if [ ! -z "$CPU" ]; then
    echo "$(date): CPU: ${CPU}%, MEM: ${MEM}%"
  fi
  
  sleep 30
done

echo ""
echo "Final check:"
if [ -f /tmp/sm64_mario_head.log ]; then
  echo "Log output:"
  tail -20 /tmp/sm64_mario_head.log
fi
