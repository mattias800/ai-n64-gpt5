# Cycle-Accuracy Roadmap for @n64/core

This document outlines a pragmatic path toward cycle-accurate emulation across CPU, RSP, RDP, and the N64 peripheral devices, while keeping current discovery workflows productive.

Guiding principles
- Determinism first: a single-source-of-truth event scheduler with explicit priorities/order guarantees.
- Latency budgets modeled in cycles for each device transaction; prefer table-driven tunables with comments and references.
- Small, verifiable steps: introduce timing in thin layers guarded by feature flags; maintain fast paths for headless tooling.
- Cross-check against hardware captures, public test ROMs, and golden logs where available.

Phases and milestones

1) Scheduler, clocks, and ordering hygiene
- Audit System scheduler to ensure single monotonic cycle counter drives all devices; record origin and units.
- Document event ordering when multiple events are co-scheduled at the same cycle (e.g., VI vblank vs PI DMA completion).
- Introduce explicit clock domains (CPU, RSP, DP, VI, PI, SI, AI) with ratios; add helpers for converting between domains.
- Add trace markers (begin/end) for each scheduled device event; include device, cycle, and causal link (who scheduled).

2) CPU baseline timing sanity
- Implement instruction timing table (approx. first), including load-delay/branch-delay effects; maintain a feature flag `cpu.timing`.
- Validate against micro-bench test ROMs (simple loops, memory access patterns) and ensure determinism across runs.

3) Bus/memory arbitration and latencies
- Add configurable DRAM access latency and simple bus arbitration between CPU, RSP, PI, and DP; start with fixed latencies, then refine.
- Model PI DMA latency as function of length and bus contention; schedule completion accordingly.

4) RSP microcode step timing (LLE-friendly envelope)
- Start with per-DMA and per-opcode timing envelopes; if LLE is not feasible now, keep HLE but schedule ‘work packets’ with realistic cycles.
- Add microcode profile presets (e.g., Fast3D, F3DEX) with empirically tuned cycle costs.

5) RDP pipeline timing
- Introduce DP command FIFO timing: schedule increments based on command cost; emulate status bits and busy flags at cycle granularity.
- Model TLUT, texture load, and rectangle ops with cycle budgets; gate DP_INTR accordingly.

6) VI timing model
- Adopt accurate line timing (NTSC/PAL), pixel clock derivations, and vblank cadence; link VI interrupt cycle to line counters.
- Ensure framebuffer origin/width changes take effect at correct raster boundaries; add tests for tear-free swaps.

7) MI/interrupt controller behavior
- Precisely model MI_INTR_MASK, pending bits, and acknowledge race conditions; ensure write-then-read sequences match hardware.
- Add stress tests that toggle mask/ack while devices assert interrupts within small cycle windows.

8) Peripherals (SI/AI/Controller/PIF)
- SI 64B transfers: schedule read/write windows with realistic latency and collision behavior with CPU accesses.
- AI DAC timing envelope (optional for headless) with sample-accurate scheduling and underflow behavior.

9) Validation harness
- Create timing-tests/ with micro ROMs or synthetic drivers to assert:
  - PI DMA completes after N cycles
  - VI frames at expected cadence (CRC of frames over time)
  - DP busy/idle timing around command batches
  - RSP DMA size vs cycles
- Add CLI flags to rom-boot-run for compact timing logs suitable for comparison against baselines.

10) External cross-checks
- Compare with known-good logs from hardware captures or mature emulators (where license allows); tune latencies in small increments.

Tooling and flags to add
- `--timing-profile <name>`: selects a preset for device latencies (dev, fast, realistic, hw-tuned).
- `--trace-timing`: compact CSV-like output for device events (device, cyc, evt, details...).
- `--deterministic` (default): disables any random timing jitter; add `--timing-jitter` for debugging races.

Risks and mitigations
- Performance regressions: keep timing as optional layers; avoid penalizing discovery workflows.
- HLE vs LLE gaps: where LLE is not yet practical, approximate with calibrated envelopes; clearly document assumptions.

Initial action items (short-term)
- Add compact timing trace toggles to rom-boot-run.
- Introduce a device-latency config object with defaults and a single preset selector.
- Add unit tests for PI DMA completion timing and VI cadence.
- Produce a baseline timing log for mario64.z64 first 5M cycles; archive as golden for regression checks.

Ownership and iteration
- Maintain timing tables and presets near the device implementations in @n64/core (with links to this doc).
- Track deltas via CI by diffing timing logs on PRs where timing or scheduler code changes.

