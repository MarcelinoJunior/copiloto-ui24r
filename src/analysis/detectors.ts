/**
 * Detectores que olham o espectro de um canal ao longo do tempo:
 *
 * - Microfonia (feedback): um pico ESTREITO (muito acima dos vizinhos), quase sem harmônicos
 *   (microfonia é praticamente uma senoide pura), que fica parado na mesma frequência e se
 *   sustenta ou cresce. Voz e instrumentos têm harmônicos e variam (vibrato), então não disparam.
 * - Zumbido: energia forte em 60 Hz (ou 50 Hz) e harmônicos, típico de cabo/aterramento.
 * - Chiado: ruído largo e constante (espectro "plano") num canal sem ninguém tocando.
 */

export interface FeedbackAlert {
  freqHz: number;
  levelDb: number;
  /** há quanto tempo o pico está lá (s) */
  forSec: number;
  rising: boolean;
}

interface Candidate {
  bin: number;
  firstT: number;
  lastT: number;
  firstLevel: number;
  level: number;
  pnpr: number;
}

export interface FeedbackOptions {
  minFreq: number;
  maxFreq: number;
  /** pico precisa estar acima disso (dBFS) */
  minLevelDb: number;
  /** quanto o pico se destaca dos vizinhos (dB) */
  minPnpr: number;
  /** harmônicos precisam estar pelo menos isso abaixo do pico (dB) */
  harmonicMarginDb: number;
  /** tempo mínimo parado na mesma frequência (s) */
  minPersistSec: number;
  /** crescimento mínimo para confirmar (dB) — ou pnpr muito alto */
  minRiseDb: number;
}

export const FEEDBACK_DEFAULTS: FeedbackOptions = {
  minFreq: 100,
  maxFreq: 12000,
  minLevelDb: -50,
  minPnpr: 22,
  harmonicMarginDb: 18,
  minPersistSec: 1.0,
  minRiseDb: 3,
};

function neighborMean(spec: Float64Array, bin: number, near: number, far: number): number {
  let sum = 0;
  let n = 0;
  for (let d = near; d <= far; d++) {
    for (const k of [bin - d, bin + d]) {
      if (k > 0 && k < spec.length) {
        sum += spec[k];
        n++;
      }
    }
  }
  return n ? sum / n : -140;
}

function peakAround(spec: Float64Array, bin: number, radius = 2): number {
  let max = -Infinity;
  for (let k = Math.max(1, bin - radius); k <= Math.min(spec.length - 1, bin + radius); k++) max = Math.max(max, spec[k]);
  return max;
}

export class FeedbackDetector {
  private candidates: Candidate[] = [];

  constructor(
    private readonly sampleRate: number,
    private readonly fftSize: number,
    private readonly opts: FeedbackOptions = FEEDBACK_DEFAULTS,
  ) {}

  /** Analisa um espectro novo (dB por bin) no instante `t` (ms) e devolve a microfonia suspeita, se houver. */
  update(spec: Float64Array, t: number): FeedbackAlert | undefined {
    const binHz = this.sampleRate / this.fftSize;
    const lo = Math.ceil(this.opts.minFreq / binHz);
    const hi = Math.min(spec.length - 2, Math.floor(this.opts.maxFreq / binHz));

    // picos locais candidatos
    const found: { bin: number; level: number; pnpr: number }[] = [];
    for (let k = lo; k <= hi; k++) {
      const v = spec[k];
      if (v < this.opts.minLevelDb || v < spec[k - 1] || v < spec[k + 1]) continue;
      const pnpr = v - neighborMean(spec, k, 4, 16);
      if (pnpr < this.opts.minPnpr) continue;
      // senoide pura: 2ª e 3ª harmônicas (e meia frequência) bem abaixo
      const harmonics = [2, 3, 0.5]
        .map((m) => Math.round(k * m))
        .filter((h) => h > 1 && h < spec.length - 2)
        .map((h) => peakAround(spec, h));
      if (harmonics.some((h) => h > v - this.opts.harmonicMarginDb)) continue;
      if (this.isInHarmonicSeries(spec, k, v)) continue;
      found.push({ bin: k, level: v, pnpr });
    }
    found.sort((a, b) => b.level - a.level);

    // acompanha cada pico no tempo (mesma frequência ±2 bins)
    const next: Candidate[] = [];
    for (const f of found.slice(0, 5)) {
      const prev = this.candidates.find((c) => Math.abs(c.bin - f.bin) <= 2);
      next.push(
        prev
          ? { ...prev, bin: f.bin, lastT: t, level: f.level, pnpr: f.pnpr }
          : { bin: f.bin, firstT: t, lastT: t, firstLevel: f.level, level: f.level, pnpr: f.pnpr },
      );
    }
    // mantém por um instante quem sumiu (pode ter sido só um bloco)
    for (const c of this.candidates) {
      if (!next.some((n) => Math.abs(n.bin - c.bin) <= 2) && t - c.lastT < 400) next.push(c);
    }
    this.candidates = next;

    let best: FeedbackAlert | undefined;
    for (const c of this.candidates) {
      if (c.lastT !== t) continue;
      const forSec = (t - c.firstT) / 1000;
      const rise = c.level - c.firstLevel;
      const confirmed = forSec >= this.opts.minPersistSec && (rise >= this.opts.minRiseDb || c.pnpr >= this.opts.minPnpr + 10);
      if (!confirmed) continue;
      const alert = { freqHz: Math.round(c.bin * binHz), levelDb: Math.round(c.level), forSec: Math.round(forSec * 10) / 10, rising: rise >= this.opts.minRiseDb };
      if (!best || alert.levelDb > best.levelDb) best = alert;
    }
    return best;
  }

  /**
   * O pico é o n-ésimo harmônico de uma nota (voz/instrumento)? Testa fundamentais f/n e procura
   * picos fortes nos harmônicos vizinhos da mesma série (f·(n−1)/n e f·(n+1)/n).
   * Microfonia é uma senoide sozinha: não tem "irmãos" na série.
   */
  private isInHarmonicSeries(spec: Float64Array, bin: number, level: number): boolean {
    for (let n = 2; n <= 10; n++) {
      const f0 = bin / n;
      if (f0 < 2) break;
      const below = peakAround(spec, Math.round(f0 * (n - 1)), 1);
      const above = Math.round(f0 * (n + 1)) < spec.length - 1 ? peakAround(spec, Math.round(f0 * (n + 1)), 1) : -Infinity;
      const strong = (x: number) => x > level - this.opts.harmonicMarginDb && x - neighborMean(spec, Math.round(f0 * (n - 1)), 4, 16) > 10;
      if (strong(below) || strong(above)) return true;
    }
    return false;
  }

  reset(): void {
    this.candidates = [];
  }
}

export interface NoiseReport {
  /** zumbido de rede elétrica detectado (50 ou 60 Hz) */
  hum?: { freqHz: 50 | 60; aboveDb: number };
  /** chiado/ruído largo constante */
  hiss?: { levelDb: number };
}

function bandMax(spec: Float64Array, freq: number, binHz: number, tolHz: number): number {
  const lo = Math.max(1, Math.floor((freq - tolHz) / binHz));
  const hi = Math.min(spec.length - 1, Math.ceil((freq + tolHz) / binHz));
  let m = -Infinity;
  for (let k = lo; k <= hi; k++) m = Math.max(m, spec[k]);
  return m;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Analisa um espectro de um canal SEM música/fala forte (canal parado ou baixo) em busca de
 * zumbido (50/60 Hz + harmônicos) e chiado (ruído largo). Chame só quando o canal estiver quieto.
 */
export function analyzeNoise(spec: Float64Array, rmsDb: number, sampleRate: number, fftSize: number): NoiseReport {
  const binHz = sampleRate / fftSize;
  const report: NoiseReport = {};
  // referência: mediana entre 30 Hz e 1 kHz
  const ref: number[] = [];
  for (let k = Math.ceil(30 / binHz); k <= Math.floor(1000 / binHz); k++) ref.push(spec[k]);
  const floor = median(ref);

  for (const base of [60, 50] as const) {
    const fundamental = bandMax(spec, base, binHz, 3);
    const h2 = bandMax(spec, base * 2, binHz, 4);
    const h3 = bandMax(spec, base * 3, binHz, 5);
    const above = fundamental - floor;
    const harmonicsAbove = Math.max(h2, h3) - floor;
    if (fundamental > -90 && above >= 18 && harmonicsAbove >= 8) {
      report.hum = { freqHz: base, aboveDb: Math.round(above) };
      break;
    }
  }

  // chiado: espectro plano (flatness alta) entre 1 e 15 kHz, com nível audível
  if (rmsDb > -72 && rmsDb < -35) {
    let logSum = 0;
    let linSum = 0;
    let n = 0;
    for (let k = Math.ceil(1000 / binHz); k <= Math.floor(15000 / binHz) && k < spec.length; k++) {
      const p = Math.pow(10, spec[k] / 10);
      logSum += Math.log(p + 1e-20);
      linSum += p;
      n++;
    }
    const flatness = n ? Math.exp(logSum / n) / (linSum / n) : 0;
    if (flatness > 0.4) report.hiss = { levelDb: Math.round(rmsDb) };
  }
  return report;
}

/** Exige que uma condição se mantenha por um tempo antes de virar alerta (evita alarme falso). */
export class Persistence {
  private since?: number;
  constructor(private readonly minMs: number) {}
  update(active: boolean, t: number): boolean {
    if (!active) {
      this.since = undefined;
      return false;
    }
    this.since ??= t;
    return t - this.since >= this.minMs;
  }
  forSec(t: number): number {
    return this.since === undefined ? 0 : (t - this.since) / 1000;
  }
}
