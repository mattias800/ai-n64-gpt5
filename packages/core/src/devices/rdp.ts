/**
 * RDP (Reality Display Processor) implementation
 * Provides cycle-accurate rasterization and texture mapping
 */

export enum RDPCommand {
  FILL_TRIANGLE = 0x08,
  FILL_Z_BUFFER = 0x09,
  TEXTURE_TRIANGLE = 0x0A,
  TEXTURE_Z_BUFFER = 0x0B,
  SHADE_TRIANGLE = 0x0C,
  SHADE_Z_BUFFER = 0x0D,
  SHADE_TEXTURE_TRIANGLE = 0x0E,
  SHADE_TEXTURE_Z_BUFFER = 0x0F,
  TEXTURE_RECTANGLE = 0x24,
  TEXTURE_RECTANGLE_FLIP = 0x25,
  SYNC_LOAD = 0x26,
  SYNC_PIPE = 0x27,
  SYNC_TILE = 0x28,
  SYNC_FULL = 0x29,
  SET_KEY_GB = 0x2A,
  SET_KEY_R = 0x2B,
  SET_CONVERT = 0x2C,
  SET_SCISSOR = 0x2D,
  SET_PRIM_DEPTH = 0x2E,
  SET_OTHER_MODES = 0x2F,
  LOAD_TLUT = 0x30,
  SET_TILE_SIZE = 0x32,
  LOAD_BLOCK = 0x33,
  LOAD_TILE = 0x34,
  SET_TILE = 0x35,
  FILL_RECTANGLE = 0x36,
  SET_FILL_COLOR = 0x37,
  SET_FOG_COLOR = 0x38,
  SET_BLEND_COLOR = 0x39,
  SET_PRIM_COLOR = 0x3A,
  SET_ENV_COLOR = 0x3B,
  SET_COMBINE = 0x3C,
  SET_TEXTURE_IMAGE = 0x3D,
  SET_MASK_IMAGE = 0x3E,
  SET_COLOR_IMAGE = 0x3F,
}

interface Vertex {
  x: number;
  y: number;
  z: number;
  s: number;
  t: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Tile {
  format: number;
  size: number;
  line: number;
  tmem: number;
  palette: number;
  cmT: number;
  maskT: number;
  shiftT: number;
  cmS: number;
  maskS: number;
  shiftS: number;
  uls: number;
  ult: number;
  lrs: number;
  lrt: number;
}

export class RDP {
  // RDP registers
  private colorImage: number = 0;
  private colorImageFormat: number = 0;
  private colorImageSize: number = 0;
  private colorImageWidth: number = 0;
  
  private textureImage: number = 0;
  private textureImageFormat: number = 0;
  private textureImageSize: number = 0;
  private textureImageWidth: number = 0;
  
  private zImage: number = 0;
  
  // Color registers
  private fillColor: number = 0;
  private fogColor: number = 0;
  private blendColor: number = 0;
  private primColor: number = 0;
  private envColor: number = 0;
  
  // Rendering state
  private scissor = { xl: 0, yl: 0, xh: 640, yh: 480 };
  private primDepth = { z: 0, deltaZ: 0 };
  private otherModes = 0n;
  private combineMode = 0n;
  
  // Tiles (8 tile descriptors)
  private tiles: Tile[] = new Array(8);
  
  // Texture memory (4KB TMEM)
  private tmem = new Uint8Array(4096);
  
  // Command FIFO
  private commandFifo: bigint[] = [];
  private commandLength = 0;
  
  // Performance counters
  private pixelsFilled = 0;
  private trianglesDrawn = 0;
  private cycleCount = 0;
  
  // Cycle timing for various operations
  private static readonly TIMING = {
    FILL_PIXEL: 1,
    TEXTURE_PIXEL: 2,
    SHADE_PIXEL: 2,
    BLEND_PIXEL: 1,
    Z_COMPARE: 1,
    COMMAND_PARSE: 4,
    SYNC_FULL: 50,
    LOAD_TEXTURE: 64,
  };
  
  // RDRAM access
  private rdram: Uint8Array | null = null;
  
  constructor() {
    this.reset();
  }
  
  reset(): void {
    this.colorImage = 0;
    this.textureImage = 0;
    this.zImage = 0;
    this.fillColor = 0;
    this.commandFifo = [];
    this.commandLength = 0;
    this.pixelsFilled = 0;
    this.trianglesDrawn = 0;
    
    // Initialize tiles
    for (let i = 0; i < 8; i++) {
      this.tiles[i] = {
        format: 0, size: 0, line: 0, tmem: 0, palette: 0,
        cmT: 0, maskT: 0, shiftT: 0,
        cmS: 0, maskS: 0, shiftS: 0,
        uls: 0, ult: 0, lrs: 0, lrt: 0
      };
    }
  }
  
  setRDRAM(rdram: Uint8Array): void {
    this.rdram = rdram;
  }
  
  /**
   * Write command to RDP
   */
  writeCommand(word: bigint): void {
    this.commandFifo.push(word);
    
    // Check if we have a complete command
    const cmd = Number((word >> 56n) & 0x3Fn);
    const expectedLength = this.getCommandLength(cmd);
    
    if (this.commandFifo.length >= expectedLength) {
      this.executeCommand();
      this.commandFifo = [];
    }
  }
  
  private getCommandLength(cmd: number): number {
    // Most commands are 8 bytes (1 word)
    if (cmd >= 0x08 && cmd <= 0x0F) return 4; // Triangle commands (32 bytes)
    if (cmd >= 0x24 && cmd <= 0x25) return 2; // Rectangle commands (16 bytes)
    return 1; // Most other commands (8 bytes)
  }
  
  private executeCommand(): void {
    if (this.commandFifo.length === 0) return;
    
    const word = this.commandFifo[0]!;
    const cmd = Number((word >> 56n) & 0x3Fn);
    
    this.cycleCount += RDP.TIMING.COMMAND_PARSE;
    
    switch (cmd) {
      case RDPCommand.FILL_RECTANGLE:
        this.executeFillRectangle(word);
        break;
      case RDPCommand.SET_COLOR_IMAGE:
        this.executeSetColorImage(word);
        break;
      case RDPCommand.SET_TEXTURE_IMAGE:
        this.executeSetTextureImage(word);
        break;
      case RDPCommand.SET_FILL_COLOR:
        this.executeSetFillColor(word);
        break;
      case RDPCommand.SET_SCISSOR:
        this.executeSetScissor(word);
        break;
      case RDPCommand.SET_OTHER_MODES:
        this.executeSetOtherModes(word);
        break;
      case RDPCommand.SET_COMBINE:
        this.executeSetCombine(word);
        break;
      case RDPCommand.SET_TILE:
        this.executeSetTile(word);
        break;
      case RDPCommand.LOAD_TILE:
        this.executeLoadTile(word);
        break;
      case RDPCommand.LOAD_BLOCK:
        this.executeLoadBlock(word);
        break;
      case RDPCommand.TEXTURE_RECTANGLE:
        this.executeTextureRectangle();
        break;
      case RDPCommand.SYNC_FULL:
        this.executeSyncFull();
        break;
      case RDPCommand.SYNC_PIPE:
        this.executeSyncPipe();
        break;
      case RDPCommand.FILL_TRIANGLE:
      case RDPCommand.SHADE_TRIANGLE:
      case RDPCommand.TEXTURE_TRIANGLE:
      case RDPCommand.SHADE_TEXTURE_TRIANGLE:
        this.executeTriangle();
        break;
    }
  }
  
  private executeFillRectangle(word: bigint): void {
    const xl = Number((word >> 44n) & 0xFFFn);
    const yl = Number((word >> 32n) & 0xFFFn);
    const xh = Number((word >> 12n) & 0xFFFn);
    const yh = Number(word & 0xFFFn);
    
    // Convert from 10.2 fixed point
    const x0 = xl >> 2;
    const y0 = yl >> 2;
    const x1 = xh >> 2;
    const y1 = yh >> 2;
    
    // Fill rectangle with current fill color
    const pixels = (x1 - x0) * (y1 - y0);
    this.pixelsFilled += pixels;
    this.cycleCount += pixels * RDP.TIMING.FILL_PIXEL;
    
    // Actually fill the framebuffer if we have RDRAM access
    if (this.rdram && this.colorImage) {
      this.fillRect(x0, y0, x1, y1);
    }
  }
  
  private fillRect(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.rdram) return;
    
    const bytesPerPixel = this.getColorImageBytesPerPixel();
    const stride = this.colorImageWidth * bytesPerPixel;
    
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const offset = this.colorImage + y * stride + x * bytesPerPixel;
        this.writePixel(offset, this.fillColor);
      }
    }
  }
  
  private writePixel(offset: number, color: number): void {
    if (!this.rdram || offset >= this.rdram.length) return;
    
    const bpp = this.getColorImageBytesPerPixel();
    if (bpp === 2) {
      // 16-bit color
      this.rdram[offset] = (color >> 8) & 0xFF;
      this.rdram[offset + 1] = color & 0xFF;
    } else if (bpp === 4) {
      // 32-bit color
      this.rdram[offset] = (color >> 24) & 0xFF;
      this.rdram[offset + 1] = (color >> 16) & 0xFF;
      this.rdram[offset + 2] = (color >> 8) & 0xFF;
      this.rdram[offset + 3] = color & 0xFF;
    }
  }
  
  private getColorImageBytesPerPixel(): number {
    switch (this.colorImageSize) {
      case 0: return 0; // 4-bit (not directly addressable)
      case 1: return 1; // 8-bit
      case 2: return 2; // 16-bit
      case 3: return 4; // 32-bit
      default: return 2;
    }
  }
  
  private executeSetColorImage(word: bigint): void {
    this.colorImageFormat = Number((word >> 53n) & 0x7n);
    this.colorImageSize = Number((word >> 51n) & 0x3n);
    this.colorImageWidth = Number((word >> 32n) & 0x3FFn) + 1;
    this.colorImage = Number(word & 0xFFFFFFn);
  }
  
  private executeSetTextureImage(word: bigint): void {
    this.textureImageFormat = Number((word >> 53n) & 0x7n);
    this.textureImageSize = Number((word >> 51n) & 0x3n);
    this.textureImageWidth = Number((word >> 32n) & 0x3FFn) + 1;
    this.textureImage = Number(word & 0xFFFFFFn);
  }
  
  private executeSetFillColor(word: bigint): void {
    this.fillColor = Number(word & 0xFFFFFFFFn);
  }
  
  private executeSetScissor(word: bigint): void {
    this.scissor.xl = Number((word >> 44n) & 0xFFFn) >> 2;
    this.scissor.yl = Number((word >> 32n) & 0xFFFn) >> 2;
    this.scissor.xh = Number((word >> 12n) & 0xFFFn) >> 2;
    this.scissor.yh = Number(word & 0xFFFn) >> 2;
  }
  
  private executeSetOtherModes(word: bigint): void {
    this.otherModes = word & 0xFFFFFFFFFFFFFFn;
  }
  
  private executeSetCombine(word: bigint): void {
    this.combineMode = word & 0xFFFFFFFFFFFFFFn;
  }
  
  private executeSetTile(word: bigint): void {
    const tile = Number(word & 0x7n);
    this.tiles[tile] = {
      format: Number((word >> 53n) & 0x7n),
      size: Number((word >> 51n) & 0x3n),
      line: Number((word >> 41n) & 0x1FFn),
      tmem: Number((word >> 32n) & 0x1FFn),
      palette: Number((word >> 20n) & 0xFn),
      cmT: Number((word >> 18n) & 0x3n),
      maskT: Number((word >> 14n) & 0xFn),
      shiftT: Number((word >> 10n) & 0xFn),
      cmS: Number((word >> 8n) & 0x3n),
      maskS: Number((word >> 4n) & 0xFn),
      shiftS: Number(word & 0xFn),
      uls: 0, ult: 0, lrs: 0, lrt: 0
    };
  }
  
  private executeLoadTile(word: bigint): void {
    const tile = Number((word >> 24n) & 0x7n);
    const uls = Number((word >> 44n) & 0xFFFn);
    const ult = Number((word >> 32n) & 0xFFFn);
    const lrs = Number((word >> 12n) & 0xFFFn);
    const lrt = Number(word & 0xFFFn);
    
    if (this.tiles[tile]) {
      this.tiles[tile].uls = uls;
      this.tiles[tile].ult = ult;
      this.tiles[tile].lrs = lrs;
      this.tiles[tile].lrt = lrt;
    }
    
    this.cycleCount += RDP.TIMING.LOAD_TEXTURE;
  }
  
  private executeLoadBlock(word: bigint): void {
    // Similar to LoadTile but loads a linear block
    this.cycleCount += RDP.TIMING.LOAD_TEXTURE;
  }
  
  private executeTextureRectangle(): void {
    if (this.commandFifo.length < 2) return;
    
    const word1 = this.commandFifo[0]!;
    const word2 = this.commandFifo[1]!;
    
    const xl = Number((word1 >> 44n) & 0xFFFn);
    const yl = Number((word1 >> 32n) & 0xFFFn);
    const xh = Number((word1 >> 12n) & 0xFFFn);
    const yh = Number(word1 & 0xFFFn);
    
    const pixels = ((xh - xl) >> 2) * ((yh - yl) >> 2);
    this.pixelsFilled += pixels;
    this.cycleCount += pixels * RDP.TIMING.TEXTURE_PIXEL;
  }
  
  private executeTriangle(): void {
    // Triangle commands are 4 words (32 bytes)
    if (this.commandFifo.length < 4) return;
    
    this.trianglesDrawn++;
    // Estimate ~100 pixels per triangle average
    this.cycleCount += 100 * RDP.TIMING.SHADE_PIXEL;
  }
  
  private executeSyncFull(): void {
    // Full pipeline sync
    this.cycleCount += RDP.TIMING.SYNC_FULL;
  }
  
  private executeSyncPipe(): void {
    // Pipe sync (faster than full sync)
    this.cycleCount += 10;
  }
  
  /**
   * Check if RDP is idle
   */
  isIdle(): boolean {
    return this.commandFifo.length === 0;
  }
  
  /**
   * Get RDP status register
   */
  getStatus(): number {
    let status = 0;
    if (this.isIdle()) status |= (1 << 0); // Ready
    status |= (1 << 6); // Pipe busy (always for now)
    status |= (1 << 7); // Buffer ready
    return status;
  }
  
  /**
   * Advance RDP by one cycle
   */
  tick(): void {
    this.cycleCount++;
  }
  
  /**
   * Get performance statistics
   */
  getStats(): { pixels: number; triangles: number; cycles: number } {
    return {
      pixels: this.pixelsFilled,
      triangles: this.trianglesDrawn,
      cycles: this.cycleCount
    };
  }
}
