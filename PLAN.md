# N64 Emulator in TypeScript — Plan and Verification Strategy

Scope and philosophy
- Prioritize correctness and determinism over speed.
- Test-driven development at every layer; each subsystem ships with unit tests, properties/invariants, and integration tests with golden outputs.
- Use a headless Node test harness until “SM64-ready” criteria are met; no manual browser testing before that.
- Favor HLE where it increases verifiability while retaining SM64 fidelity:
  - CPU (R4300i + COP0 + TLB): LLE (accurate interpreter).
  - RSP microcode: HLE for SM64’s common F3DZEX/F3DEX2 graphics and audio microcode.
  - RDP: start with a correct software rasterizer sufficient for SM64; map to WebGL later via an adapter.
  - AI/VI/PI/SI/MI registers and DMA: accurate-enough LLE semantics with deterministic tests.

Determinism guarantees
- No time-based scheduling; explicit cycle stepping.
- Fixed seeds; avoid floating point where possible (prefer fixed-point in audio).
- Abstract IO; adapters for WebGL/WebAudio later, driven from deterministic IR.
- Handle ROM byte orders; normalize to internal big-endian.

Verification plan by subsystem
- CPU (MIPS III R4300i)
  - Unit tests per instruction group: arithmetic, logical, shifts, branches (incl. delay slots), loads/stores, sign/zero-ext, traps/exceptions, COP0, TLB.
  - Property tests: metamorphic checks (e.g., add/sub inverses, rotate consistency, alignment faults).
  - Micro-integration: hand-assembled programs that self-report via a memory “mailbox.”
  - Acceptance: instruction suite passes; precise PC/register traces match curated expectations.
- Memory/Bus/MMU
  - Tests for RDRAM regions, KSEG0/KSEG1 mapping, TLB refill/miss/invalid behaviors.
  - PI/SI DMA tests with deterministic latencies and correct interrupt side effects.
  - Acceptance: read/write/atomic semantics and exceptions match spec for tested addresses.
- PIF/CIC/Boot
  - HLE boot: parse ROM header, determine CIC, init CPU/MI/RDRAM to post-IPL known-good state.
  - Tests: headers map to expected initial PC/status; multiple common CICs verified.
- RSP HLE (graphics/audio microcode for SM64)
  - Translator for F3DZEX/F3DEX2 to an internal graphics IR; audio microcode -> audio IR.
  - Unit tests: decode of GBI commands (gsSPVertex, gsSP1Triangle, gsDPSetCombine, etc.) to exact IR; audio sequence -> mixer graph.
  - Acceptance: coverage for GBI used by SM64; IR snapshot hashes stable.
- RDP (software rasterizer first)
  - Triangle rasterization, coverage, depth, fill, blender/combiner subset used by SM64.
  - Golden image tests: synthetic display lists (color tri, textured tri, z-test cases) compared via exact pixel CRCs.
  - Acceptance: golden frames byte-for-byte exact for test patterns.
- VI (video interface)
  - Buffer fetch, region/crop, gamma/dither toggles; tests for input framebuffer -> output buffer transforms.
  - Acceptance: deterministic transforms; CRCs match goldens.
- AI (audio interface)
  - Deterministic fixed-point mixing from audio IR.
  - Golden waveform tests: sequence -> PCM buffers; exact hashes or tight tolerance where necessary.
  - Acceptance: golden waveforms match for test sequences.
- Controller/Input
  - Deterministic scripted input for headless tests.
  - Acceptance: predictable advancement of state machines.
- Integration harness (headless)
  - Node CLI runner to load a ROM, run for N cycles or N VI frames, capture logs (CPU traces, IR streams, VI framebuffers, audio PCM), and compare against goldens.
  - Acceptance: repeatable pass/fail, zero nondeterminism.

SM64-specific verification without a browser
- Differential testing against a reference emulator (preferred if available)
  - CLI that generates golden frames and audio via a trusted emulator (e.g., ares, mupen64plus) for specific frame counts and scripted inputs.
  - Compare per-VI frame CRCs and audio PCM hashes across our implementation and the reference.
  - Pass criteria (“SM64-ready”):
    - First 120 boot/title frames: VI frame CRCs match exactly.
    - Early gameplay (e.g., 300 frames to Castle Grounds): frame CRCs match; audio hashes match bit-exactly or within a tight bound if the reference isn’t bit-exact.
- If no reference emulator is available
  - Use golden IR traces and PNG/WAV artifacts captured once from a trusted run; compare IR sequences, framebuffers, and audio buffers.

Project structure
- packages/core
  - cpu/: interpreter, decoder, cop0, tlb, exceptions
  - mem/: rdram, pif, mmio, bus
  - devices/: mi, pi, si, ai, vi
  - rsp/: HLE decoders for SM64 GBI/audio microcode
  - rdp/: software rasterizer + combiner/blender
  - ir/: graphics IR, audio IR
  - utils/: bit ops, endianness, logging, CRC
  - types/: typed registers, enums
- packages/headless
  - runner/: deterministic CLI (load → run → dump → compare)
  - goldens/: frames, audio, IR traces
  - tests/: unit, property, integration tests (vitest)
- packages/web (later)
  - gl/: WebGL adapter driven by graphics IR
  - audio/: WebAudio adapter driven by audio IR
  - ui/: minimal harness for canvas+audio context (after SM64-ready)

Tooling and CI
- Node 20+, TypeScript strict, Vitest, ESLint, Prettier.
- PNG/WAV writers for golden artifacts.
- CI runs unit tests and golden checks; optional SM64 regression if ROM path + goldens provided via env vars.
- Deterministic seeds for fuzz/property tests.

Milestones and acceptance gates
1) CPU and MMU base
   - ≥95% coverage of used opcodes; TLB/exception tests pass; mailbox microprograms pass.
2) DMA and devices (PI, SI, MI)
   - DMA + interrupts verified deterministically.
3) RSP HLE translators (graphics/audio)
   - Decode coverage for SM64; IR snapshots stable.
4) RDP software rasterizer
   - Synthetic display list golden frames exact.
5) VI and AI
   - Framebuffer post-process and audio mixing goldens pass.
6) Headless SM64 smoke (with provided ROM + goldens)
   - First 120 frames: VI CRCs match; audio hashes match.
7) Extended SM64 run
   - 300 frames into gameplay with scripted inputs: all checks pass; no exceptions.

Risks and choices
- HLE RSP/RDP chosen for verifiability on SM64; IR enables later WebGL mapping.
- TLB complexity contained to subset used by SM64 initially; still spec-correct where exercised.
- Audio exactness via fixed-point to enable bit-exact tests.
- Endianness: normalize ROM to big-endian; tests for .z64/.n64/.v64.

Next steps
- Scaffold monorepo with strict TypeScript and Vitest.
- Implement CPU core and basic memory/bus with tests.
- Add device stubs, then RSP HLE decoders with IR snapshot tests.
- Add minimal software RDP with golden images.
- Wire optional SM64 differential test harness.

