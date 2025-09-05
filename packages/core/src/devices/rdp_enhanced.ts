/**
 * Enhanced RDP (Reality Display Processor) implementation
 * Provides triangle rasterization, texture mapping, and shading
 */

import { RDP, RDPCommand } from './rdp.js';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Vec2 {
  x: number;
  y: number;
}

interface VertexShaded {
  pos: Vec3;
  color: { r: number; g: number; b: number; a: number };
  texCoord: Vec2;
  depth: number;
}

interface Edge {
  x: number;
  xStep: number;
  z: number;
  zStep: number;
  r: number;
  rStep: number;
  g: number;
  gStep: number;
  b: number;
  bStep: number;
  a: number;
  aStep: number;
  s: number;
  sStep: number;
  t: number;
  tStep: number;
}

export class EnhancedRDP extends RDP {
  private zbuffer: Uint16Array | null = null;
  private zbufferWidth = 0;
  private zbufferHeight = 0;
  
  // Texture cache
  private textureCache: Map<number, Uint16Array> = new Map();
  
  // Viewport settings
  private viewport = { x: 0, y: 0, width: 640, height: 480 };
  
  constructor() {
    super();
  }
  
  /**
   * Initialize Z-buffer
   */
  initZBuffer(width: number, height: number): void {
    this.zbufferWidth = width;
    this.zbufferHeight = height;
    this.zbuffer = new Uint16Array(width * height);
    // Initialize with max depth
    this.zbuffer.fill(0xFFFF);
  }
  
  /**
   * Clear Z-buffer
   */
  clearZBuffer(): void {
    if (this.zbuffer) {
      this.zbuffer.fill(0xFFFF);
    }
  }
  
  /**
   * Rasterize a shaded triangle with texture mapping
   */
  rasterizeTriangle(v0: VertexShaded, v1: VertexShaded, v2: VertexShaded): void {
    // Sort vertices by Y coordinate
    if (v1.pos.y < v0.pos.y) [v0, v1] = [v1, v0];
    if (v2.pos.y < v1.pos.y) {
      [v1, v2] = [v2, v1];
      if (v1.pos.y < v0.pos.y) [v0, v1] = [v1, v0];
    }
    
    const y0 = Math.floor(v0.pos.y);
    const y1 = Math.floor(v1.pos.y);
    const y2 = Math.floor(v2.pos.y);
    
    // Skip degenerate triangles
    if (y0 === y2) return;
    
    // Calculate edge slopes
    const dx02 = (v2.pos.x - v0.pos.x) / (v2.pos.y - v0.pos.y);
    const dx01 = (v1.pos.x - v0.pos.x) / Math.max(1, v1.pos.y - v0.pos.y);
    const dx12 = (v2.pos.x - v1.pos.x) / Math.max(1, v2.pos.y - v1.pos.y);
    
    // Setup edge interpolants
    const setupEdge = (v0: VertexShaded, v1: VertexShaded, dy: number): Partial<Edge> => {
      const invDy = dy > 0 ? 1 / dy : 0;
      return {
        xStep: (v1.pos.x - v0.pos.x) * invDy,
        zStep: (v1.depth - v0.depth) * invDy,
        rStep: (v1.color.r - v0.color.r) * invDy,
        gStep: (v1.color.g - v0.color.g) * invDy,
        bStep: (v1.color.b - v0.color.b) * invDy,
        aStep: (v1.color.a - v0.color.a) * invDy,
        sStep: (v1.texCoord.x - v0.texCoord.x) * invDy,
        tStep: (v1.texCoord.y - v0.texCoord.y) * invDy,
      };
    };
    
    // Rasterize upper part of triangle
    if (y0 < y1) {
      this.rasterizeTrianglePart(
        y0, y1,
        v0.pos.x, dx02, v0.pos.x, dx01,
        v0, v2, v0, v1
      );
    }
    
    // Rasterize lower part of triangle
    if (y1 < y2) {
      this.rasterizeTrianglePart(
        y1, y2,
        v0.pos.x + dx02 * (y1 - y0), dx02,
        v1.pos.x, dx12,
        v0, v2, v1, v2
      );
    }
  }
  
  private rasterizeTrianglePart(
    yStart: number, yEnd: number,
    xLeft: number, dxLeft: number,
    xRight: number, dxRight: number,
    vLeft0: VertexShaded, vLeft1: VertexShaded,
    vRight0: VertexShaded, vRight1: VertexShaded
  ): void {
    const yClipStart = Math.max(yStart, this.viewport.y);
    const yClipEnd = Math.min(yEnd, this.viewport.y + this.viewport.height);
    
    for (let y = yClipStart; y < yClipEnd; y++) {
      const yRel = y - yStart;
      const x0 = Math.floor(xLeft + dxLeft * yRel);
      const x1 = Math.floor(xRight + dxRight * yRel);
      
      if (x0 !== x1) {
        this.rasterizeScanline(y, x0, x1, vLeft0, vLeft1, vRight0, vRight1, yRel / (yEnd - yStart));
      }
    }
  }
  
  private rasterizeScanline(
    y: number,
    x0: number, x1: number,
    vLeft0: VertexShaded, vLeft1: VertexShaded,
    vRight0: VertexShaded, vRight1: VertexShaded,
    tY: number
  ): void {
    if (x0 > x1) {
      [x0, x1] = [x1, x0];
      [vLeft0, vLeft1] = [vRight0, vRight1];
      [vRight0, vRight1] = [vLeft0, vLeft1];
    }
    
    const xClipStart = Math.max(x0, this.viewport.x);
    const xClipEnd = Math.min(x1, this.viewport.x + this.viewport.width);
    
    if (xClipStart >= xClipEnd) return;
    
    const dx = x1 - x0;
    const invDx = dx > 0 ? 1 / dx : 0;
    
    // Interpolate across scanline
    for (let x = xClipStart; x < xClipEnd; x++) {
      const tX = (x - x0) * invDx;
      
      // Interpolate vertex attributes
      const depth = this.lerp(
        this.lerp(vLeft0.depth, vLeft1.depth, tY),
        this.lerp(vRight0.depth, vRight1.depth, tY),
        tX
      );
      
      // Z-test
      if (this.zbuffer && this.performZTest(x, y, depth)) {
        // Interpolate color
        const r = this.lerp(
          this.lerp(vLeft0.color.r, vLeft1.color.r, tY),
          this.lerp(vRight0.color.r, vRight1.color.r, tY),
          tX
        );
        const g = this.lerp(
          this.lerp(vLeft0.color.g, vLeft1.color.g, tY),
          this.lerp(vRight0.color.g, vRight1.color.g, tY),
          tX
        );
        const b = this.lerp(
          this.lerp(vLeft0.color.b, vLeft1.color.b, tY),
          this.lerp(vRight0.color.b, vRight1.color.b, tY),
          tX
        );
        const a = this.lerp(
          this.lerp(vLeft0.color.a, vLeft1.color.a, tY),
          this.lerp(vRight0.color.a, vRight1.color.a, tY),
          tX
        );
        
        // Interpolate texture coordinates
        const s = this.lerp(
          this.lerp(vLeft0.texCoord.x, vLeft1.texCoord.x, tY),
          this.lerp(vRight0.texCoord.x, vRight1.texCoord.x, tY),
          tX
        );
        const t = this.lerp(
          this.lerp(vLeft0.texCoord.y, vLeft1.texCoord.y, tY),
          this.lerp(vRight0.texCoord.y, vRight1.texCoord.y, tY),
          tX
        );
        
        // Sample texture (if available)
        let texColor = { r: 255, g: 255, b: 255, a: 255 };
        const textureAddr = this.getTextureImage();
        if (textureAddr && this.textureCache.has(textureAddr)) {
          texColor = this.sampleTexture(textureAddr, s, t);
        }
        
        // Combine texture and vertex color
        const finalR = Math.floor((r * texColor.r) / 255);
        const finalG = Math.floor((g * texColor.g) / 255);
        const finalB = Math.floor((b * texColor.b) / 255);
        const finalA = Math.floor((a * texColor.a) / 255);
        
        // Convert to 16-bit RGB5551
        const color = this.packRGB5551(finalR, finalG, finalB, finalA);
        
        // Write pixel
        this.writePixelDirect(x, y, color);
        
        // Update Z-buffer
        this.updateZBuffer(x, y, depth);
      }
    }
  }
  
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }
  
  private performZTest(x: number, y: number, depth: number): boolean {
    if (!this.zbuffer) return true;
    
    const index = y * this.zbufferWidth + x;
    if (index >= 0 && index < this.zbuffer.length) {
      const depthU16 = Math.floor(depth * 0xFFFF);
      return depthU16 < (this.zbuffer[index] ?? 0xFFFF);
    }
    return false;
  }
  
  private updateZBuffer(x: number, y: number, depth: number): void {
    if (!this.zbuffer) return;
    
    const index = y * this.zbufferWidth + x;
    if (index >= 0 && index < this.zbuffer.length) {
      this.zbuffer[index] = Math.floor(depth * 0xFFFF);
    }
  }
  
  private sampleTexture(addr: number, s: number, t: number): { r: number; g: number; b: number; a: number } {
    // Simple nearest neighbor sampling for now
    const texture = this.textureCache.get(addr);
    if (!texture) return { r: 255, g: 255, b: 255, a: 255 };
    
    // Assume texture dimensions (would come from tile descriptor)
    const width = 32;  // Default texture width
    const height = 32; // Default texture height
    
    const u = Math.floor(s * width) & (width - 1);
    const v = Math.floor(t * height) & (height - 1);
    
    const pixel = texture[v * width + u] || 0;
    return this.unpackRGB5551(pixel);
  }
  
  private packRGB5551(r: number, g: number, b: number, a: number): number {
    const r5 = (r >> 3) & 0x1F;
    const g5 = (g >> 3) & 0x1F;
    const b5 = (b >> 3) & 0x1F;
    const a1 = a > 127 ? 1 : 0;
    return (r5 << 11) | (g5 << 6) | (b5 << 1) | a1;
  }
  
  private unpackRGB5551(color: number): { r: number; g: number; b: number; a: number } {
    const r5 = (color >> 11) & 0x1F;
    const g5 = (color >> 6) & 0x1F;
    const b5 = (color >> 1) & 0x1F;
    const a1 = color & 1;
    
    // Expand to 8-bit
    return {
      r: (r5 << 3) | (r5 >> 2),
      g: (g5 << 3) | (g5 >> 2),
      b: (b5 << 3) | (b5 >> 2),
      a: a1 ? 255 : 0
    };
  }
  
  private writePixelDirect(x: number, y: number, color: number): void {
    const rdram = this.getRDRAM();
    if (!rdram) return;
    
    const colorImage = this.getColorImage();
    const width = this.getColorImageWidth();
    const bpp = this.getColorImageBytesPerPixelLocal();
    
    if (bpp === 2) {
      const offset = colorImage + (y * width + x) * 2;
      if (offset + 1 < rdram.length) {
        rdram[offset] = (color >> 8) & 0xFF;
        rdram[offset + 1] = color & 0xFF;
      }
    }
  }
  
  // Getters for parent class private fields
  private getRDRAM(): Uint8Array | null {
    return (this as any).rdram;
  }
  
  private getColorImage(): number {
    return (this as any).colorImage;
  }
  
  private getColorImageWidth(): number {
    return (this as any).colorImageWidth;
  }
  
  private getColorImageBytesPerPixelLocal(): number {
    const size = (this as any).colorImageSize ?? 2;
    switch (size) {
      case 0: return 0; // 4-bit
      case 1: return 1; // 8-bit
      case 2: return 2; // 16-bit
      case 3: return 4; // 32-bit
      default: return 2;
    }
  }
  
  private getTextureImage(): number {
    return (this as any).textureImage;
  }
  
  /**
   * Load texture into cache
   */
  loadTexture(addr: number, width: number, height: number, format: number): void {
    const rdram = this.getRDRAM();
    if (!rdram) return;
    
    const texture = new Uint16Array(width * height);
    
    // Load based on format (simplified - only 16-bit for now)
    if (format === 2) { // 16-bit RGBA
      for (let i = 0; i < width * height; i++) {
        const offset = addr + i * 2;
        if (offset + 1 < rdram.length) {
          texture[i] = ((rdram[offset] ?? 0) << 8) | (rdram[offset + 1] ?? 0);
        }
      }
      this.textureCache.set(addr, texture);
    }
  }
  
  /**
   * Clear texture cache
   */
  clearTextureCache(): void {
    this.textureCache.clear();
  }
}
