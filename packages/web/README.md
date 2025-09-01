N64 Web Demo (SM64 Title)

Quick start
- Install deps at repo root: npm ci
- Build core/headless/web: npm run build
- Start dev server: npm run web:dev
- Open http://localhost:5173, choose your SM64 ROM (.z64/.n64/.v64) and optionally a config JSON (defaults to /samples/sm64-rom-title.sample.json). Click Run.

Notes
- The demo mirrors the headless sm64-rom-title flow. It performs ROM-backed PI loads and optional MIO0 decompression, builds an F3DEX display list per frame for provided tiles, schedules SP→DP, and renders frames to a canvas.
- Per-frame CRC32s are shown. If your config includes expectedCrc32, PASS/FAIL is shown for each frame.
- To regenerate expected CRCs for your ROM/config outside the browser, run:
  node packages/headless/dist/cli.js sm64-rom-title packages/headless/samples/sm64-rom-title.sample.json --frames 2

Troubleshooting
- If imports from @n64/core fail during dev, make sure you’ve run npm run build first so dist artifacts exist, or keep the provided Vite tsconfig-paths plugin which resolves to ../core/src during dev.
- If you see blank frames, ensure VI origin/width in the config match the framebuffer region you expect; the sample uses origin 0xF000 and width=192.
