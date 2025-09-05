#!/usr/bin/env bash
set -euo pipefail

# cen64_trace.sh - Run CEN64 with SM64 and capture a CPU trace log for a fixed duration.
#
# Usage:
#   scripts/cen64_trace.sh --rom /abs/path/SM64.z64 --out tmp/cen64_trace.log [--seconds 10] [--cen64 /path/to/cen64]
#                          [--pif /abs/path/pifdata.bin] [--args "--trace --trace-file tmp/cen64_trace.log"]
#                          [--cwd /tmp]
#
# Notes:
# - This script does NOT assume specific CEN64 flags. Pass any required trace flags via --args.
# - If your CEN64 build requires a PIF ROM, supply it with --pif.
# - If CEN64 supports a built-in duration/quit flag, include it via --args; otherwise we will kill the process after --seconds.
# - On macOS, if `timeout` is unavailable, the script falls back to a portable sleep+kill watchdog.

ROM=""
OUT=""
SECONDS_LIMIT=10
CEN64_BIN="cen64"
CEN64_ARGS=""
PIF=""
WORKDIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rom) ROM="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --seconds) SECONDS_LIMIT="$2"; shift 2;;
    --cen64) CEN64_BIN="$2"; shift 2;;
    --args) CEN64_ARGS="$2"; shift 2;;
    --pif) PIF="$2"; shift 2;;
    --cwd) WORKDIR="$2"; shift 2;;
    -h|--help)
      grep -E "^#" "$0" | sed -e 's/^# \{0,1\}//'; exit 0;;
    *) echo "[cen64-trace] unknown option: $1"; exit 1;;
  esac
done

if [[ -z "$ROM" || -z "$OUT" ]]; then
  echo "[cen64-trace] required: --rom /abs/path/SM64.z64 --out tmp/cen64_trace.log" >&2
  exit 1
fi

# Ensure output directory exists
OUT_DIR=$(dirname "$OUT")
mkdir -p "$OUT_DIR"

CMD=("$CEN64_BIN")
if [[ -n "$CEN64_ARGS" ]]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=( $CEN64_ARGS )
  CMD+=("${EXTRA_ARGS[@]}")
fi
if [[ -n "$PIF" ]]; then
  CMD+=("$PIF")
fi
CMD+=("$ROM")

# If a working directory is provided, use it
if [[ -n "$WORKDIR" ]]; then
  mkdir -p "$WORKDIR"
  cd "$WORKDIR"
fi

# Prefer `timeout` if available
if command -v timeout >/dev/null 2>&1; then
  echo "[cen64-trace] running with timeout ${SECONDS_LIMIT}s: ${CMD[*]}" >&2
  # Use --foreground to ensure signals propagate properly if GNU timeout is available
  set +e
  timeout --foreground "${SECONDS_LIMIT}" "${CMD[@]}" >"$OUT" 2>&1
  STATUS=$?
  set -e
  if [[ $STATUS -eq 124 ]]; then
    echo "[cen64-trace] terminated after ${SECONDS_LIMIT}s (timeout)" >&2
  else
    echo "[cen64-trace] process exited with status $STATUS" >&2
  fi
else
  echo "[cen64-trace] running (watchdog ${SECONDS_LIMIT}s): ${CMD[*]}" >&2
  set +e
  "${CMD[@]}" >"$OUT" 2>&1 &
  PID=$!
  # Watchdog
  ( sleep "$SECONDS_LIMIT"; if kill -0 "$PID" >/dev/null 2>&1; then echo "[cen64-trace] killing PID $PID after ${SECONDS_LIMIT}s" >&2; kill -TERM "$PID" >/dev/null 2>&1; sleep 1; kill -KILL "$PID" >/dev/null 2>&1 || true; fi ) & WD=$!
  wait "$PID"
  STATUS=$?
  kill -TERM "$WD" >/dev/null 2>&1 || true
  set -e
  echo "[cen64-trace] process exited with status $STATUS" >&2
fi

echo "[cen64-trace] log written to $OUT" >&2

