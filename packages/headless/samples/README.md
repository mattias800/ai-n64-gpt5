# SM64 ROM title runner (f3dex-rom-run / sm64-rom-title)

This directory contains a sample JSON config and instructions for running the new ROM-backed title slice pipelines.

Two CLI commands are relevant:
- f3dex-rom-run: executes a table of F3DEX display list addresses (no asset building), useful when you already have a table in DRAM.
- sm64-rom-title: loads assets from a ROM using PI DMA and/or MIO0 decompression, then builds a per-frame F3DEX DL table to draw CI8/CI4 tiles. Great for simple ROM-driven title slice tests.

Common flags
- --snapshot <path>: Writes per-frame PNG/PPM snapshots as <base>_f0.png, <base>_f1.png, etc.

Sample usage
- node packages/headless/dist/cli.js sm64-rom-title packages/headless/samples/sm64-rom-title.sample.json --snapshot tmp/sm64_title.png

Config schema (sm64-rom-title)
{
  "rom": "path/to/SM64.z64",
  "video": { "width": 192, "height": 120, "origin": "0xF000" },
  "timing": { "start": 2, "interval": 3, "frames": 2, "spOffset": 1 },
  "bg": { "start5551": "0x001F", "end5551": "0x07FF" },
  "allocBase": "0x30000",
  "stagingBase": "0x40000",
  "strideWords": 256,
  "layout": { "offsetPerFrameX": 1 },
  "assets": {
    "loads": [
      { "kind": "rom",  "srcRom": "0x00100000", "dest": "0x31000", "length": "0x00001000" },
      { "kind": "mio0", "srcRom": "0x00200000", "dest": "0x32000" }
    ],
    "tiles": [
      { "format": "CI8", "tlutAddr": "0x31000", "tlutCount": 256, "pixAddr": "0x32000", "w": 64, "h": 32, "x": 40, "y": 30 }
    ]
  }
}

Notes
- The values above are placeholders. You must supply correct ROM offsets and DRAM destinations for your target assets and tiles.
- For CI4 textures, optionally include "ci4Palette": 0..15 to set the palette nibble.
- For MIO0 assets, srcRom must point to the start of a valid MIO0 block in the ROM; it will be decompressed into RDRAM at dest.

Optional test harness
- Set SM64_ROM_JSON to the absolute path of a config JSON. The optional test will execute a short run and skip if the env var is unset.

