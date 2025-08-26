# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

Repository overview
- Monorepo using Node.js + TypeScript workspaces. Packages:
  - @n64/core: Core Nintendo 64 emulator library (CPU, memory bus + devices, HLE boot/loaders, graphics utilities, scheduling, and display-list pipelines).
  - @n64/headless: Node CLI for running emulator pipelines headlessly and producing snapshots.
  - @n64/web: Stubs for WebGL/WebAudio adapters (future browser rendering hooks).
- Build: TypeScript project references (root tsconfig.json references each package, shared options in tsconfig.base.json).
- Tests: Vitest (root vitest.config.ts), Node environment, tests under packages/**/tests.

Common commands
Note: npm workspaces are configured. If you use pnpm, replace “npm …” with “pnpm -w …”.
- Install dependencies (all workspaces):
  npm ci
- Build all packages (project references):
  npm run build
- Type-check only:
  npm run typecheck
- Clean incremental build state:
  npm run clean
- Run the full test suite:
  npm test
- Test in watch mode:
  npm run test:watch
- Run a single test file (two equivalent ways):
  npx vitest run packages/core/tests/cpu_basic.test.ts
  npm test -- packages/core/tests/cpu_basic.test.ts

Test helpers and env toggles
- Optional PPM snapshots from tests (writes to disk only when enabled):
  TEST_SNAPSHOT=1 npx vitest run packages/core/tests/title_dl_hle_draw_tex_formats.test.ts
- Optional ASCII neighborhood dumps around a pixel on assertion failures:
  TEST_DEBUG_DUMP=1 npx vitest run
- Optional ROM-backed title slice test: set SM64_ROM_JSON to a JSON config path to enable; test is skipped when unset.

Using the headless CLI (after build)
The CLI binary name is n64-headless; in this workspace you can execute the transpiled entry directly:
- Super Mario 64 title demo (single frame, optional snapshot):
  node packages/headless/dist/cli.js sm64-demo --frames 1 --snapshot tmp/sm64_1f.png
- Run a CI8 ring sample that builds RSP DLs in memory and schedules SP→DP:
  node packages/headless/dist/cli.js rspdl-ci8-ring --frames 2 --snapshot tmp/ring.png
- Run a config-driven microcode (UC) script (JSON):
  node packages/headless/dist/cli.js uc-run path/to/config.json --snapshot tmp/uc.png
- Run an F3D JSON program by translating to UC, then scheduling:
  node packages/headless/dist/cli.js f3d-run path/to/config.json --snapshot tmp/f3d.png
- Run a table-of-DLs program for F3D/F3DEX (JSON provides per-frame DL addresses):
  node packages/headless/dist/cli.js f3d-run-table path/to/config.json --snapshot tmp/f3d_table.png
  node packages/headless/dist/cli.js f3dex-run-table path/to/config.json --snapshot tmp/f3dex_table.png
- ROM-backed runners (load assets from a ROM via PI DMA and/or MIO0):
  node packages/headless/dist/cli.js f3dex-rom-run path/to/config.json --snapshot tmp/rom.png
  node packages/headless/dist/cli.js sm64-rom-title packages/headless/samples/sm64-rom-title.sample.json --snapshot tmp/sm64_title.png
Notes:
- Snapshot format is inferred from the output extension (.png uses pngjs; otherwise PPM P6 is written).
- Many commands accept timing (start/interval/frames), framebuffer (width/height/origin), and per-frame layout options via JSON.

High-level architecture (big picture)
- CPU execution model (packages/core/src/cpu):
  - Implements a MIPS-like pipeline with CP0 (exceptions/interrupts), precise branch-delay semantics, and ERET handling.
  - Interrupts checked at instruction boundaries and before committing delayed branches; exceptions capture EPC/BD correctly.
- Memory and devices (packages/core/src/mem + devices/mmio):
  - RDRAM byte array with big-endian 16/32-bit accessors; virtual→physical mapping for KSEG0/KSEG1.
  - Bus maps MI, SP, DP, VI, AI, PI, SI MMIO regions; PI and SI can DMA to RDRAM. ROM is presented to PI via bus.setROM().
- System scheduler and frame loop (packages/core/src/system):
  - Discrete-cycle scheduler (scheduleAt/scheduleEvery) drives device callbacks; CPU steps once per cycle.
  - Frame loop (runFrameLoop) demonstrates deterministic MI pending inspection and acks (DP/VI/SP/AI/SI) and CP0 timer re-arm.
- Video HLE (packages/core/src/system/video_hle.ts):
  - Draw solids/gradients and blit RGBA5551 tiles/patterns into the VI framebuffer (origin/width from VI). Optional seam overlays for debugging.
- Graphics utilities (packages/core/src/gfx):
  - Decoders for CI8/CI4/I8/IA8/IA16 to RGBA5551 for parity/golden tests and atlas generation.
- Boot/asset loading (packages/core/src/boot):
  - hleBoot normalizes ROM byte order and seeds initial PC; hlePiLoadSegments performs deterministic PI DMA copies (with MI acks).
  - MIO0 decompression is provided for ROM assets.
- Display-list and HLE pipelines (packages/core/src/boot/*):
  - Helpers to build/write RSP DL words into RDRAM, schedule SP→DP processing, and compose frames (scheduleRSPDLFramesAndRun, scheduleF3DEXFromTableAndRun, etc.).
  - Translators from F3D/F3DEX to an internal UC-like instruction set (f3dToUc/translateF3DEXToUc, writeUcAsRspdl, ucToRspdlWords).
- Headless CLI (packages/headless/src/cli.ts):
  - Thin command-layer over core: constructs Bus/CPU/System, loads assets (ROM, TLUTs, blobs), builds per-frame DLs, schedules frames, and writes PNG/PPM snapshots.
- Web adapters (packages/web/src):
  - Minimal stubs for GL/Audio adapters; intended for future browser rendering paths.

Testing layout
- Vitest includes packages/**/tests/**/*.test.ts (Node env). The @n64/core suite contains parity/golden and integration tests for CPU timing, MMIO semantics, DL pipelines, and video composition.
- Test utilities (packages/core/tests/helpers/test_utils.ts) provide snapshotting and seam neighborhood debugging controlled by env vars (see toggles above).

