# Test debugging utilities

This package includes a couple of opt-in debugging helpers for tests that render framebuffers.

- TEST_SNAPSHOT: when truthy, tests that call maybeWritePPM(...) will write an RGB PPM file to disk for manual inspection.
- TEST_DEBUG_DUMP: when truthy, tests that call dumpSeamNeighborhood(...) will print a small ASCII neighborhood around a pixel to the console.

Usage

1) Write a PPM snapshot from a test

```ts path=null start=null
import { maybeWritePPM } from './helpers/test_utils';

// ... after you have `image: Uint8Array` and its dimensions w/h
maybeWritePPM(image, w, h, 'tmp/snapshots/example.ppm');
```

Run with snapshots enabled:

```bash path=null start=null
TEST_SNAPSHOT=1 npx vitest run packages/core/tests/title_dl_hle_draw_tex_formats.test.ts
```

2) Print a debug neighborhood

```ts path=null start=null
import { dumpSeamNeighborhood } from './helpers/test_utils';

dumpSeamNeighborhood(image, w, x, y, 2); // prints a 5x5 neighborhood around (x,y)
```

Run with dumps enabled:

```bash path=null start=null
TEST_DEBUG_DUMP=1 npx vitest run
```

Notes

- maybeWritePPM writes P6 binary PPM files containing only RGB data; the alpha channel is not stored.
- Output files are ignored by VCS via .gitignore (tmp/snapshots and *.ppm).
- These helpers are no-ops unless their respective env vars are set (truthy and not "0"/"false").

