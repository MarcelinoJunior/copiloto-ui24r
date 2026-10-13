/**
 * Medidor de loudness (LUFS) segundo a ITU-R BS.1770-4 / EBU R128, para 48 kHz.
 *
 * - Momentâneo: últimos 400 ms
 * - Curto prazo: últimos 3 s
 * - Integrado: desde o início (ou desde o último "zerar"), com gate absoluto (-70 LUFS)
 *   e relativo (-10 LU), que é o número que YouTube/Instagram/Facebook usam. Alvo comum: -14 LUFS.
 */

// Filtro K (pré-filtro de prateleira + passa-altas RLB), coeficientes da norma para 48 kHz.
const SHELF = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const HIGHPASS = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private readonly c: typeof SHELF) {}
  process(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const SUB_BLOCK_SEC = 0.1; // 100 ms: blocos de 400 ms com 75% de sobreposição
const ABS_GATE = -70;
const MAX_BLOCKS = 6 * 3600 * 10; // 6 horas de culto

export interface LoudnessReading {
  momentary?: number;
  shortTerm?: number;
  integrated?: number;
  /** pico de amostra (dBFS) nos últimos 3 s */
  peakDb?: number;
}

export function loudnessFromMeanSquare(sumOfChannelMeanSquares: number): number {
  return sumOfChannelMeanSquares > 0 ? -0.691 + 10 * Math.log10(sumOfChannelMeanSquares) : -Infinity;
}

export class LoudnessMeter {
  private readonly filters: [Biquad, Biquad][];
  private readonly subLen: number;
  private subCount = 0;
  private subSums: number[];
  /** soma de quadrados por canal de cada sub-bloco de 100 ms (últimos 3 s) */
  private readonly subBlocks: number[][] = [];
  private readonly subPeaks: number[] = [];
  private subPeak = 0;
  /** loudness de cada bloco de 400 ms (para o integrado) */
  private blocks: number[] = [];

  constructor(
    private readonly channels: number,
    private readonly sampleRate = 48000,
  ) {
    this.filters = Array.from({ length: channels }, () => [new Biquad(SHELF), new Biquad(HIGHPASS)] as [Biquad, Biquad]);
    this.subLen = Math.round(sampleRate * SUB_BLOCK_SEC);
    this.subSums = new Array(channels).fill(0);
  }

  /** Recebe amostras por canal (mesmo tamanho), valores em -1..1. */
  push(channelSamples: ArrayLike<number>[]): void {
    const len = channelSamples[0]?.length ?? 0;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.channels; c++) {
        const x = channelSamples[c][i];
        const ax = Math.abs(x);
        if (ax > this.subPeak) this.subPeak = ax;
        const [f1, f2] = this.filters[c];
        const y = f2.process(f1.process(x));
        this.subSums[c] += y * y;
      }
      if (++this.subCount >= this.subLen) this.closeSubBlock();
    }
  }

  private closeSubBlock(): void {
    this.subBlocks.push(this.subSums.map((s) => s / this.subLen));
    this.subPeaks.push(this.subPeak);
    if (this.subBlocks.length > 30) {
      this.subBlocks.shift();
      this.subPeaks.shift();
    }
    this.subSums = new Array(this.channels).fill(0);
    this.subCount = 0;
    this.subPeak = 0;
    if (this.subBlocks.length >= 4) {
      const l = this.windowLoudness(4);
      if (Number.isFinite(l)) {
        this.blocks.push(l);
        if (this.blocks.length > MAX_BLOCKS) this.blocks = this.blocks.slice(-MAX_BLOCKS);
      }
    }
  }

  private windowLoudness(n: number): number {
    const recent = this.subBlocks.slice(-n);
    if (recent.length < n) return -Infinity;
    let total = 0;
    for (let c = 0; c < this.channels; c++) {
      let ms = 0;
      for (const b of recent) ms += b[c];
      total += ms / recent.length;
    }
    return loudnessFromMeanSquare(total);
  }

  /** Integrado com gate absoluto e relativo (BS.1770-4). */
  integrated(): number | undefined {
    const above = this.blocks.filter((l) => l > ABS_GATE);
    if (above.length === 0) return undefined;
    const meanPow = (list: number[]) => list.reduce((s, l) => s + Math.pow(10, (l + 0.691) / 10), 0) / list.length;
    const relGate = -0.691 + 10 * Math.log10(meanPow(above)) - 10;
    const gated = above.filter((l) => l > relGate);
    if (gated.length === 0) return undefined;
    return -0.691 + 10 * Math.log10(meanPow(gated));
  }

  reading(): LoudnessReading {
    const m = this.windowLoudness(4);
    const s = this.windowLoudness(30);
    const peak = Math.max(0, ...this.subPeaks);
    return {
      momentary: Number.isFinite(m) ? m : undefined,
      shortTerm: this.subBlocks.length >= 30 && Number.isFinite(s) ? s : undefined,
      integrated: this.integrated(),
      peakDb: peak > 0 ? 20 * Math.log10(peak) : undefined,
    };
  }

  reset(): void {
    this.blocks = [];
  }
}
