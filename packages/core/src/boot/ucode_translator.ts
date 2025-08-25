export type UcCmd =
  | { op: 'Gradient'; bgStart: number; bgEnd: number }
  | { op: 'SetTLUT'; tlutAddr: number; count: number }
  | { op: 'SetCI4Palette'; palette: number }
  | { op: 'SetPrimColor'; color: number }
  | { op: 'SetEnvColor'; color: number }
  | { op: 'SetCombine'; mode: 'TEXEL0' | 'PRIM' | 'ENV' }
  | { op: 'SetTexAddrMode'; sMode: 'CLAMP' | 'WRAP' | 'MIRROR'; tMode: 'CLAMP' | 'WRAP' | 'MIRROR' }
  | { op: 'SetTexFilter'; mode: 'NEAREST' | 'BILINEAR' }
  | { op: 'SetBlend'; enable: boolean }
  | { op: 'SetBlendMode'; mode: 'OFF' | 'AVERAGE_50' | 'SRC_OVER_A1' }
  | { op: 'SetZEnable'; enable: boolean }
  | { op: 'SetZBuffer'; addr: number; width: number; height: number }
  | { op: 'ClearZ'; value: number }
  | { op: 'DrawCI8'; w: number; h: number; addr: number; x: number; y: number }
  | { op: 'DrawCI4'; w: number; h: number; addr: number; x: number; y: number }
  | { op: 'DrawPrimTri'; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
  | { op: 'DrawPrimTriZ'; x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; x3: number; y3: number; z3: number }
  | { op: 'DrawCI8Tri'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; x2: number; y2: number; s2: number; t2: number; x3: number; y3: number; s3: number; t3: number }
  | { op: 'DrawCI4Tri'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; x2: number; y2: number; s2: number; t2: number; x3: number; y3: number; s3: number; t3: number }
  | { op: 'DrawIA8Tri'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; x2: number; y2: number; s2: number; t2: number; x3: number; y3: number; s3: number; t3: number }
  | { op: 'DrawIA16Tri'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; x2: number; y2: number; s2: number; t2: number; x3: number; y3: number; s3: number; t3: number }
  | { op: 'DrawRGBA16Tri'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; x2: number; y2: number; s2: number; t2: number; x3: number; y3: number; s3: number; t3: number }
  | { op: 'DrawRGBA16TriZ'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; z1: number; x2: number; y2: number; s2: number; t2: number; z2: number; x3: number; y3: number; s3: number; t3: number; z3: number }
  | { op: 'DrawCI8TriPersp'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; q1: number; x2: number; y2: number; s2: number; t2: number; q2: number; x3: number; y3: number; s3: number; t3: number; q3: number }
  | { op: 'DrawCI4TriPersp'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; q1: number; x2: number; y2: number; s2: number; t2: number; q2: number; x3: number; y3: number; s3: number; t3: number; q3: number }
  | { op: 'DrawIA8TriPersp'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; q1: number; x2: number; y2: number; s2: number; t2: number; q2: number; x3: number; y3: number; s3: number; t3: number; q3: number }
  | { op: 'DrawIA16TriPersp'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; q1: number; x2: number; y2: number; s2: number; t2: number; q2: number; x3: number; y3: number; s3: number; t3: number; q3: number }
  | { op: 'DrawRGBA16TriPersp'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; q1: number; x2: number; y2: number; s2: number; t2: number; q2: number; x3: number; y3: number; s3: number; t3: number; q3: number }
  | { op: 'DrawRGBA16TriPerspZ'; addr: number; texW: number; texH: number; x1: number; y1: number; s1: number; t1: number; q1: number; z1: number; x2: number; y2: number; s2: number; t2: number; q2: number; z2: number; x3: number; y3: number; s3: number; t3: number; q3: number; z3: number }
  | { op: 'Sm64Slice'; spacing: number; offsetX: number }
  | { op: 'End' };

// Translate microcode-like commands into our RSP DL HLE opcodes.
export function ucToRspdlWords(cmds: UcCmd[], strideWords: number = 64): Uint32Array {
  const out: number[] = [];
  for (const c of cmds) {
    switch (c.op) {
      case 'Gradient':
        out.push(0x00000001, c.bgStart >>> 0, c.bgEnd >>> 0);
        break;
      case 'SetTLUT':
        out.push(0x00000020, c.tlutAddr >>> 0, (c.count >>> 0) & 0xffffffff);
        break;
      case 'SetCI4Palette':
        out.push(0x00000023, (c.palette >>> 0) & 0xffffffff);
        break;
      case 'SetPrimColor':
        out.push(0x00000030, c.color >>> 0);
        break;
      case 'SetEnvColor':
        out.push(0x00000031, c.color >>> 0);
        break;
      case 'SetCombine': {
        let mode = 0;
        if (c.mode === 'PRIM') mode = 1; else if (c.mode === 'ENV') mode = 2; else mode = 0; // TEXEL0
        out.push(0x00000032, mode >>> 0);
        break;
      }
      case 'SetTexAddrMode': {
        const enc = (v: 'CLAMP' | 'WRAP' | 'MIRROR') => v === 'WRAP' ? 1 : v === 'MIRROR' ? 2 : 0;
        const word = ((enc(c.tMode) & 0x3) << 2) | (enc(c.sMode) & 0x3);
        out.push(0x00000024, word >>> 0);
        break;
      }
      case 'SetTexFilter': {
        const word = c.mode === 'BILINEAR' ? 1 : 0;
        out.push(0x00000025, word >>> 0);
        break;
      }
      case 'SetBlend': {
        out.push(0x00000026, (c.enable ? 1 : 0) >>> 0);
        break;
      }
      case 'SetBlendMode': {
        const mode = c.mode === 'SRC_OVER_A1' ? 2 : c.mode === 'AVERAGE_50' ? 1 : 0;
        out.push(0x00000027, mode >>> 0);
        break;
      }
      case 'SetZEnable': {
        out.push(0x00000050, (c.enable ? 1 : 0) >>> 0);
        break;
      }
      case 'SetZBuffer': {
        out.push(0x00000051, c.addr >>> 0, c.width >>> 0, c.height >>> 0);
        break;
      }
      case 'ClearZ': {
        out.push(0x00000052, c.value >>> 0);
        break;
      }
      case 'DrawCI8':
        out.push(0x00000021, c.w >>> 0, c.h >>> 0, c.addr >>> 0, c.x | 0, c.y | 0);
        break;
      case 'DrawCI4':
        out.push(0x00000022, c.w >>> 0, c.h >>> 0, c.addr >>> 0, c.x | 0, c.y | 0);
        break;
      case 'DrawPrimTri':
        out.push(0x00000040, c.x1 | 0, c.y1 | 0, c.x2 | 0, c.y2 | 0, c.x3 | 0, c.y3 | 0);
        break;
      case 'DrawPrimTriZ':
        out.push(0x00000053,
          c.x1|0, c.y1|0, c.z1>>>0,
          c.x2|0, c.y2|0, c.z2>>>0,
          c.x3|0, c.y3|0, c.z3>>>0,
        );
        break;
      case 'DrawCI8Tri':
        out.push(
          0x00000041,
          c.addr >>> 0, c.texW >>> 0, c.texH >>> 0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0,
        );
        break;
      case 'DrawCI4Tri':
        out.push(
          0x00000042,
          c.addr >>> 0, c.texW >>> 0, c.texH >>> 0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0,
        );
        break;
      case 'DrawCI8TriPersp':
        out.push(
          0x00000043,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.q1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.q2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.q3>>>0,
        );
        break;
      case 'DrawIA8Tri':
        out.push(
          0x00000045,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0,
        );
        break;
      case 'DrawIA8TriPersp':
        out.push(
          0x00000046,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.q1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.q2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.q3>>>0,
        );
        break;
      case 'DrawIA16Tri':
        out.push(
          0x00000047,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0,
        );
        break;
      case 'DrawIA16TriPersp':
        out.push(
          0x00000048,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.q1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.q2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.q3>>>0,
        );
        break;
      case 'DrawRGBA16Tri':
        out.push(
          0x00000049,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0,
        );
        break;
      case 'DrawRGBA16TriZ':
        out.push(
          0x00000058,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.z1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.z2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.z3>>>0,
        );
        break;
      case 'DrawRGBA16TriPersp':
        out.push(
          0x0000004A,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.q1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.q2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.q3>>>0,
        );
        break;
      case 'DrawRGBA16TriPerspZ':
        out.push(
          0x0000005D,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.q1>>>0, c.z1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.q2>>>0, c.z2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.q3>>>0, c.z3>>>0,
        );
        break;
      case 'DrawCI4TriPersp':
        out.push(
          0x00000044,
          c.addr>>>0, c.texW>>>0, c.texH>>>0,
          c.x1|0, c.y1|0, c.s1|0, c.t1|0, c.q1>>>0,
          c.x2|0, c.y2|0, c.s2|0, c.t2|0, c.q2>>>0,
          c.x3|0, c.y3|0, c.s3|0, c.t3|0, c.q3>>>0,
        );
        break;
      case 'Sm64Slice':
        out.push(0x00000010, c.spacing >>> 0, c.offsetX | 0);
        break;
      case 'End':
        out.push(0x00000000);
        break;
    }
  }
  // Ensure an END terminator exists
  if (out.length === 0 || out[out.length - 1] !== 0x00000000) out.push(0x00000000);
  // Do not pad; caller provides strideWords to parser
  return Uint32Array.from(out);
}

export function writeUcAsRspdl(bus: { storeU32: (addr: number, val: number) => void }, dlAddr: number, cmds: UcCmd[], strideWords: number = 64): void {
  const words = ucToRspdlWords(cmds, strideWords);
  let addr = dlAddr >>> 0;
  for (let i = 0; i < words.length; i++) {
    bus.storeU32(addr, words[i]! >>> 0);
    addr = (addr + 4) >>> 0;
  }
}

