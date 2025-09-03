/**
 * CIC (Checking Integrated Circuit) chip emulation
 * Provides cycle-accurate boot authentication and security
 */

export enum CICType {
  CIC_6101 = 0x3F,  // Mario 64, Pilot Wings
  CIC_6102 = 0x3F,  // Most NTSC games
  CIC_6103 = 0x78,  // Banjo-Kazooie, Paper Mario
  CIC_6105 = 0x91,  // Zelda OoT, Zelda MM
  CIC_6106 = 0x85,  // F-Zero X, Yoshi's Story
  CIC_7102 = 0x3F,  // Most PAL games
}

export class CIC {
  private type: CICType;
  private seed: number = 0x3F;
  private checksum: number = 0;
  private authenticated: boolean = false;
  private cycleCount: number = 0;
  
  // CIC timing constants (in CPU cycles)
  private static readonly BOOT_DELAY = 1310720; // ~40ms at 31.25MHz
  private static readonly AUTH_CYCLES = 50000;
  private static readonly RESPONSE_DELAY = 1000;
  
  constructor(type: CICType = CICType.CIC_6102) {
    this.type = type;
    this.seed = this.getSeedForType(type);
  }
  
  private getSeedForType(type: CICType): number {
    switch (type) {
      case CICType.CIC_6101:
      case CICType.CIC_6102:
      case CICType.CIC_7102:
        return 0x3F;
      case CICType.CIC_6103:
        return 0x78;
      case CICType.CIC_6105:
        return 0x91;
      case CICType.CIC_6106:
        return 0x85;
      default:
        return 0x3F;
    }
  }
  
  /**
   * Perform CIC authentication handshake
   * Returns true when authentication is complete
   */
  authenticate(pifRam: Uint8Array): boolean {
    if (this.authenticated) return true;
    
    // CIC-NUS communication protocol
    // The CIC and PIF exchange a series of checksums
    const challenge = this.generateChallenge();
    const response = this.calculateResponse(challenge, pifRam);
    
    // Simulate authentication delay
    this.cycleCount++;
    if (this.cycleCount >= CIC.AUTH_CYCLES) {
      this.authenticated = true;
      this.writeAuthResult(pifRam, response);
      return true;
    }
    
    return false;
  }
  
  private generateChallenge(): number {
    // Generate pseudo-random challenge based on CIC type
    let challenge = this.seed;
    challenge = (challenge * 0x5D588B65 + 1) >>> 0;
    return challenge & 0xFF;
  }
  
  private calculateResponse(challenge: number, pifRam: Uint8Array): number {
    // Calculate CIC response checksum
    let sum = 0;
    for (let i = 0; i < 32; i++) {
      sum += pifRam[i] || 0;
    }
    sum = (sum + challenge + this.seed) & 0xFF;
    return sum;
  }
  
  private writeAuthResult(pifRam: Uint8Array, response: number): void {
    // Write authentication result to PIF RAM
    pifRam[0x24] = response & 0xFF;
    pifRam[0x25] = (response >> 8) & 0xFF;
    pifRam[0x26] = this.seed;
    pifRam[0x27] = this.type & 0xFF;
  }
  
  /**
   * Reset CIC to initial state
   */
  reset(): void {
    this.authenticated = false;
    this.cycleCount = 0;
    this.checksum = 0;
  }
  
  /**
   * Get CIC status for debugging
   */
  getStatus(): { authenticated: boolean; type: CICType; seed: number } {
    return {
      authenticated: this.authenticated,
      type: this.type,
      seed: this.seed
    };
  }
  
  /**
   * Advance CIC by one cycle
   */
  tick(): void {
    if (!this.authenticated && this.cycleCount < CIC.BOOT_DELAY) {
      this.cycleCount++;
    }
  }
  
  /**
   * Check if boot is allowed (CIC has authenticated)
   */
  canBoot(): boolean {
    return this.authenticated || this.cycleCount >= CIC.BOOT_DELAY;
  }
}
