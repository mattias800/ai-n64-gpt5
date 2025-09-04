/**
 * Graphics Pipeline Coordinator
 * Manages the complete N64 graphics pipeline from display lists to final rendering
 */

import { Bus } from '../mem/bus.js';
import { EnhancedRDP } from '../devices/rdp_enhanced.js';
import { System } from '../system/system.js';

export interface GraphicsConfig {
  width: number;
  height: number;
  enableZBuffer: boolean;
  enableTextures: boolean;
  enableLighting: boolean;
  enableAntiAliasing: boolean;
}

export interface DisplayListCommand {
  opcode: number;
  params: number[];
}

export interface Vertex {
  x: number;
  y: number;
  z: number;
  w: number;
  s: number;
  t: number;
  r: number;
  g: number;
  b: number;
  a: number;
  nx: number;
  ny: number;
  nz: number;
}

export interface Matrix4x4 {
  m: number[][];
}

export class GraphicsPipeline {
  private rdp: EnhancedRDP;
  private config: GraphicsConfig;
  
  // Transformation matrices
  private modelViewMatrix: Matrix4x4;
  private projectionMatrix: Matrix4x4;
  private viewportMatrix: Matrix4x4;
  
  // Vertex buffer
  private vertexBuffer: Vertex[] = [];
  
  // Display list stack for nested calls
  private displayListStack: number[] = [];
  
  // Segment base addresses
  private segmentTable: number[] = new Array(16).fill(0);
  
  // Lighting state
  private lights: Array<{
    pos: { x: number; y: number; z: number };
    color: { r: number; g: number; b: number };
    attenuation: number;
  }> = [];
  
  constructor(rdp: EnhancedRDP, config: GraphicsConfig) {
    this.rdp = rdp;
    this.config = config;
    
    // Initialize matrices to identity
    this.modelViewMatrix = this.createIdentityMatrix();
    this.projectionMatrix = this.createIdentityMatrix();
    this.viewportMatrix = this.createViewportMatrix(config.width, config.height);
    
    // Initialize Z-buffer if enabled
    if (config.enableZBuffer) {
      this.rdp.initZBuffer(config.width, config.height);
    }
  }
  
  /**
   * Process a display list
   */
  processDisplayList(bus: Bus, address: number): void {
    const maxCommands = 1000; // Safety limit
    let commandCount = 0;
    let currentAddr = address;
    
    while (commandCount < maxCommands) {
      const word1 = bus.loadU32(currentAddr);
      const word2 = bus.loadU32(currentAddr + 4);
      
      const opcode = (word1 >> 24) & 0xFF;
      
      // Process command based on opcode
      const shouldContinue = this.processCommand(bus, opcode, word1, word2);
      
      if (!shouldContinue) break;
      
      currentAddr += 8;
      commandCount++;
    }
  }
  
  private processCommand(bus: Bus, opcode: number, word1: number, word2: number): boolean {
    switch (opcode) {
      case 0x00: // G_SPNOOP
        return true;
        
      case 0x01: // G_MTX
        return this.processMtx(bus, word1, word2);
        
      case 0x03: // G_MOVEMEM
        return this.processMoveMem(bus, word1, word2);
        
      case 0x04: // G_VTX
        return this.processVtx(bus, word1, word2);
        
      case 0x06: // G_DL
        return this.processDL(bus, word1, word2);
        
      case 0xB8: // G_ENDDL
        return false; // End display list
        
      case 0xB1: // G_TRI1
        return this.processTri1(word1, word2);
        
      case 0xB2: // G_TRI2
        return this.processTri2(bus, word1, word2);
        
      case 0xE6: // G_RDPSETOTHERMODE
        return this.processSetOtherMode(word1, word2);
        
      case 0xE7: // G_SETPRIMCOLOR
        return this.processSetPrimColor(word1, word2);
        
      case 0xE8: // G_SETENVCOLOR
        return this.processSetEnvColor(word1, word2);
        
      case 0xF0: // G_LOADTLUT
        return this.processLoadTLUT(bus, word1, word2);
        
      case 0xF3: // G_LOADBLOCK
        return this.processLoadBlock(bus, word1, word2);
        
      case 0xF5: // G_SETTILE
        return this.processSetTile(word1, word2);
        
      case 0xF6: // G_FILLRECT
        return this.processFillRect(word1, word2);
        
      case 0xF7: // G_SETFILLCOLOR
        return this.processSetFillColor(word1, word2);
        
      case 0xFD: // G_SETTIMG
        return this.processSetTImg(word1, word2);
        
      case 0xFF: // G_SETCIMG
        return this.processSetCImg(word1, word2);
        
      default:
        // Unknown opcode, skip
        return true;
    }
  }
  
  private processMtx(bus: Bus, word1: number, word2: number): boolean {
    const address = this.segmentedToPhysical(word2);
    const params = word1 & 0xFF;
    
    // Load matrix from memory
    const matrix = this.loadMatrix(bus, address);
    
    // Apply based on params
    if (params & 0x01) {
      // Projection matrix
      this.projectionMatrix = matrix;
    } else {
      // ModelView matrix
      if (params & 0x02) {
        // Load (replace)
        this.modelViewMatrix = matrix;
      } else {
        // Multiply
        this.modelViewMatrix = this.multiplyMatrices(this.modelViewMatrix, matrix);
      }
    }
    
    return true;
  }
  
  private processVtx(bus: Bus, word1: number, word2: number): boolean {
    const numVerts = ((word1 >> 12) & 0xFFF) / 16;
    const startIndex = (word1 & 0xFFF) / 2;
    const address = this.segmentedToPhysical(word2);
    
    // Load vertices from memory
    for (let i = 0; i < numVerts; i++) {
      const vertAddr = address + i * 16;
      
      const x = bus.loadS16(vertAddr);
      const y = bus.loadS16(vertAddr + 2);
      const z = bus.loadS16(vertAddr + 4);
      const flag = bus.loadU16(vertAddr + 6);
      const s = bus.loadS16(vertAddr + 8);
      const t = bus.loadS16(vertAddr + 10);
      const r = bus.loadU8(vertAddr + 12);
      const g = bus.loadU8(vertAddr + 13);
      const b = bus.loadU8(vertAddr + 14);
      const a = bus.loadU8(vertAddr + 15);
      
      const vertex: Vertex = {
        x, y, z, w: 1,
        s: s / 32.0, t: t / 32.0,
        r, g, b, a,
        nx: 0, ny: 0, nz: 1
      };
      
      // Transform vertex
      const transformed = this.transformVertex(vertex);
      
      // Store in vertex buffer
      this.vertexBuffer[startIndex + i] = transformed;
    }
    
    return true;
  }
  
  private processTri1(word1: number, word2: number): boolean {
    const v0 = (word1 >> 16) & 0xFF;
    const v1 = (word1 >> 8) & 0xFF;
    const v2 = word1 & 0xFF;
    
    this.drawTriangle(v0 / 2, v1 / 2, v2 / 2);
    return true;
  }
  
  private processTri2(bus: Bus, word1: number, word2: number): boolean {
    // First triangle
    const v0 = (word1 >> 16) & 0xFF;
    const v1 = (word1 >> 8) & 0xFF;
    const v2 = word1 & 0xFF;
    
    // Second triangle
    const v3 = (word2 >> 16) & 0xFF;
    const v4 = (word2 >> 8) & 0xFF;
    const v5 = word2 & 0xFF;
    
    this.drawTriangle(v0 / 2, v1 / 2, v2 / 2);
    this.drawTriangle(v3 / 2, v4 / 2, v5 / 2);
    
    return true;
  }
  
  private processDL(bus: Bus, word1: number, word2: number): boolean {
    const push = (word1 & 0x00FF0000) !== 0;
    const address = this.segmentedToPhysical(word2);
    
    if (push) {
      // Save current address and jump to new display list
      this.displayListStack.push(address + 8);
    }
    
    // Process nested display list
    this.processDisplayList(bus, address);
    
    // Pop if we pushed
    if (push && this.displayListStack.length > 0) {
      const returnAddr = this.displayListStack.pop()!;
      // Continue from return address
      this.processDisplayList(bus, returnAddr);
    }
    
    return !push; // Continue if not pushing
  }
  
  private processFillRect(word1: number, word2: number): boolean {
    const xl = (word2 >> 12) & 0xFFF;
    const yl = word2 & 0xFFF;
    const xh = (word1 >> 12) & 0xFFF;
    const yh = word1 & 0xFFF;
    
    // Forward to RDP
    const command = BigInt(0x36) << 56n |
                    BigInt(xh) << 44n |
                    BigInt(yh) << 32n |
                    BigInt(xl) << 12n |
                    BigInt(yl);
    
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processSetFillColor(word1: number, word2: number): boolean {
    const command = BigInt(0x37) << 56n | BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processSetCImg(word1: number, word2: number): boolean {
    const command = BigInt(0x3F) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processSetTImg(word1: number, word2: number): boolean {
    const command = BigInt(0x3D) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processMoveMem(bus: Bus, word1: number, word2: number): boolean {
    // Handle various move memory operations (lights, matrices, etc.)
    return true;
  }
  
  private processSetOtherMode(word1: number, word2: number): boolean {
    const command = BigInt(0x2F) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processSetPrimColor(word1: number, word2: number): boolean {
    const command = BigInt(0x3A) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processSetEnvColor(word1: number, word2: number): boolean {
    const command = BigInt(0x3B) << 56n | BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processLoadTLUT(bus: Bus, word1: number, word2: number): boolean {
    const command = BigInt(0x30) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processLoadBlock(bus: Bus, word1: number, word2: number): boolean {
    const command = BigInt(0x33) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private processSetTile(word1: number, word2: number): boolean {
    const command = BigInt(0x35) << 56n |
                    BigInt(word1 & 0x00FFFFFF) << 32n |
                    BigInt(word2);
    this.rdp.writeCommand(command);
    return true;
  }
  
  private drawTriangle(i0: number, i1: number, i2: number): void {
    const v0 = this.vertexBuffer[i0];
    const v1 = this.vertexBuffer[i1];
    const v2 = this.vertexBuffer[i2];
    
    if (!v0 || !v1 || !v2) return;
    
    // Prepare vertices for rasterization
    const rv0 = {
      pos: { x: v0.x, y: v0.y, z: v0.z },
      color: { r: v0.r, g: v0.g, b: v0.b, a: v0.a },
      texCoord: { x: v0.s, y: v0.t },
      depth: v0.z / 65536.0
    };
    
    const rv1 = {
      pos: { x: v1.x, y: v1.y, z: v1.z },
      color: { r: v1.r, g: v1.g, b: v1.b, a: v1.a },
      texCoord: { x: v1.s, y: v1.t },
      depth: v1.z / 65536.0
    };
    
    const rv2 = {
      pos: { x: v2.x, y: v2.y, z: v2.z },
      color: { r: v2.r, g: v2.g, b: v2.b, a: v2.a },
      texCoord: { x: v2.s, y: v2.t },
      depth: v2.z / 65536.0
    };
    
    // Rasterize triangle
    this.rdp.rasterizeTriangle(rv0, rv1, rv2);
  }
  
  private transformVertex(vertex: Vertex): Vertex {
    // Apply modelview transformation
    const mvPos = this.transformPoint(
      this.modelViewMatrix,
      { x: vertex.x, y: vertex.y, z: vertex.z, w: vertex.w }
    );
    
    // Apply projection transformation
    const projPos = this.transformPoint(this.projectionMatrix, mvPos);
    
    // Perspective divide
    if (projPos.w !== 0) {
      projPos.x /= projPos.w;
      projPos.y /= projPos.w;
      projPos.z /= projPos.w;
    }
    
    // Apply viewport transformation
    const screenPos = this.transformPoint(this.viewportMatrix, projPos);
    
    return {
      ...vertex,
      x: screenPos.x,
      y: screenPos.y,
      z: screenPos.z,
      w: screenPos.w
    };
  }
  
  private transformPoint(matrix: Matrix4x4, point: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number; w: number } {
    return {
      x: matrix.m[0][0] * point.x + matrix.m[0][1] * point.y + matrix.m[0][2] * point.z + matrix.m[0][3] * point.w,
      y: matrix.m[1][0] * point.x + matrix.m[1][1] * point.y + matrix.m[1][2] * point.z + matrix.m[1][3] * point.w,
      z: matrix.m[2][0] * point.x + matrix.m[2][1] * point.y + matrix.m[2][2] * point.z + matrix.m[2][3] * point.w,
      w: matrix.m[3][0] * point.x + matrix.m[3][1] * point.y + matrix.m[3][2] * point.z + matrix.m[3][3] * point.w
    };
  }
  
  private createIdentityMatrix(): Matrix4x4 {
    return {
      m: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
      ]
    };
  }
  
  private createViewportMatrix(width: number, height: number): Matrix4x4 {
    const w2 = width / 2;
    const h2 = height / 2;
    return {
      m: [
        [w2, 0, 0, w2],
        [0, -h2, 0, h2],
        [0, 0, 0.5, 0.5],
        [0, 0, 0, 1]
      ]
    };
  }
  
  private multiplyMatrices(a: Matrix4x4, b: Matrix4x4): Matrix4x4 {
    const result: Matrix4x4 = { m: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] };
    
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          result.m[i][j] += a.m[i][k] * b.m[k][j];
        }
      }
    }
    
    return result;
  }
  
  private loadMatrix(bus: Bus, address: number): Matrix4x4 {
    const matrix: Matrix4x4 = { m: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] };
    
    // N64 matrices are stored in fixed-point format
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const intPart = bus.loadS16(address + (i * 8 + j * 2) * 2);
        const fracPart = bus.loadU16(address + (i * 8 + j * 2) * 2 + 2);
        matrix.m[i][j] = intPart + fracPart / 65536.0;
      }
    }
    
    return matrix;
  }
  
  private segmentedToPhysical(segAddr: number): number {
    const segment = (segAddr >> 24) & 0x0F;
    const offset = segAddr & 0x00FFFFFF;
    return this.segmentTable[segment] + offset;
  }
  
  /**
   * Set segment base address
   */
  setSegment(segment: number, base: number): void {
    if (segment >= 0 && segment < 16) {
      this.segmentTable[segment] = base;
    }
  }
  
  /**
   * Clear framebuffer and Z-buffer
   */
  clearBuffers(): void {
    if (this.config.enableZBuffer) {
      this.rdp.clearZBuffer();
    }
    // Additional clearing can be done here
  }
  
  /**
   * Get current configuration
   */
  getConfig(): GraphicsConfig {
    return this.config;
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<GraphicsConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (config.width !== undefined || config.height !== undefined) {
      this.viewportMatrix = this.createViewportMatrix(this.config.width, this.config.height);
      
      if (this.config.enableZBuffer) {
        this.rdp.initZBuffer(this.config.width, this.config.height);
      }
    }
  }
}
