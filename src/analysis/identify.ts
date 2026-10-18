/**
 * "Que som é esse?" — identifica o tipo de fonte de um canal pelo áudio USB:
 * voz, bumbo, caixa, pratos, baixo ou instrumento harmônico (violão/guitarra/teclado).
 *
 * Usa médias (enquanto o canal toca) de:
 * - distribuição da energia por faixa de frequência e centroide espectral;
 * - "ruidosidade" (flatness) acima de 1 kHz;
 * - ataques por segundo e quanto o som cai logo depois (percussão: ataque forte e queda rápida);
 * - pausas típicas da voz (trechos curtos bem mais baixos que a média).
 * É uma estimativa: a tela mostra a confiança e o operador pode corrigir o papel do canal.
 */

export type SourceType = 'voz' | 'bumbo' | 'caixa' | 'pratos' | 'baixo' | 'harmonico' | 'desconhecido';

export const SOURCE_LABEL: Record<SourceType, string> = {
  voz: 'voz',
  bumbo: 'bumbo',
  caixa: 'caixa',
  pratos: 'pratos/overhead',
  baixo: 'baixo',
  harmonico: 'violão/guitarra/teclado',
  desconhecido: 'ainda não sei',
};

export interface Identification {
  type: SourceType;
  confidence: number; // 0..1
}

interface Features {
  sub: number; // < 120 Hz
  low: number; // 120–500 Hz
  mid: number; // 500–2k
  pres: number; // 2k–6k
  air: number; // > 6k
  centroid: number;
  flatness: number;
}

const BLOCK_HISTORY = 100; // blocos de 50 ms (~5 s)
const MIN_FRAMES = 12; // ~2,5 s de trechos tocando

export class SourceIdentifier {
  private feat?: Features;
  private frames = 0;
  /** última decisão tomada com o canal tocando (vale durante as pausas longas) */
  private last?: Identification;
  private readonly blockDb: number[] = [];

  /** Nível de cada bloco de 50 ms (dBFS RMS), para medir ataques e pausas. */
  pushBlock(rmsDb: number): void {
    this.blockDb.push(rmsDb);
    if (this.blockDb.length > BLOCK_HISTORY) this.blockDb.shift();
  }

  /** Espectro (dB por bin) de um trecho em que o canal está tocando. */
  pushSpectrum(spec: Float64Array, sampleRate: number, fftSize: number): void {
    const binHz = sampleRate / fftSize;
    let total = 0;
    const bands = { sub: 0, low: 0, mid: 0, pres: 0, air: 0 };
    let weighted = 0;
    let logSum = 0;
    let linSum = 0;
    let n = 0;
    for (let k = 1; k < spec.length; k++) {
      const f = k * binHz;
      if (f > 16000) break;
      const p = Math.pow(10, spec[k] / 10);
      total += p;
      weighted += p * f;
      if (f < 120) bands.sub += p;
      else if (f < 500) bands.low += p;
      else if (f < 2000) bands.mid += p;
      else if (f < 6000) bands.pres += p;
      else bands.air += p;
      if (f >= 1000) {
        logSum += Math.log(p + 1e-20);
        linSum += p;
        n++;
      }
    }
    if (total <= 0) return;
    const now: Features = {
      sub: bands.sub / total,
      low: bands.low / total,
      mid: bands.mid / total,
      pres: bands.pres / total,
      air: bands.air / total,
      centroid: weighted / total,
      flatness: n ? Math.exp(logSum / n) / (linSum / n) : 0,
    };
    if (!this.feat) this.feat = now;
    else {
      const a = 0.12;
      for (const k of Object.keys(now) as (keyof Features)[]) this.feat[k] += a * (now[k] - this.feat[k]);
    }
    this.frames++;
  }

  /** Ataques por segundo: blocos que sobem 9 dB ou mais em relação ao anterior. */
  private transientsPerSec(): number {
    let hits = 0;
    for (let i = 1; i < this.blockDb.length; i++) {
      if (this.blockDb[i] > -55 && this.blockDb[i] - this.blockDb[i - 1] >= 9) hits++;
    }
    return this.blockDb.length > 1 ? hits / (this.blockDb.length * 0.05) : 0;
  }

  /**
   * Queda média (dB) ~150 ms depois de cada ataque: percussão despenca (15–40 dB),
   * fala e canto sustentam a sílaba (poucos dB).
   */
  private decayAfterAttacks(): number {
    const b = this.blockDb;
    const drops: number[] = [];
    for (let i = 1; i + 3 < b.length; i++) {
      if (b[i] > -55 && b[i] - b[i - 1] >= 9) drops.push(Math.max(b[i], b[i + 1]) - b[i + 3]);
    }
    return drops.length ? drops.reduce((s, v) => s + v, 0) / drops.length : 0;
  }

  /** Proporção de blocos bem abaixo da média (pausas de fala/respiração). */
  private pauseRatio(): number {
    const active = this.blockDb.filter((v) => v > -70);
    if (active.length < 20) return 0;
    const mean = active.reduce((s, v) => s + v, 0) / active.length;
    return this.blockDb.filter((v) => v < mean - 10).length / this.blockDb.length;
  }

  /** Variação de volume entre blocos tocando (dB): fala oscila (sílabas), instrumento sustentado não. */
  private modulationDb(): number {
    const active = this.blockDb.filter((v) => v > -60);
    if (active.length < 10) return 0;
    const mean = active.reduce((s, v) => s + v, 0) / active.length;
    return Math.sqrt(active.reduce((s, v) => s + (v - mean) ** 2, 0) / active.length);
  }

  identify(): Identification {
    const f = this.feat;
    if (!f || this.frames < MIN_FRAMES) return { type: 'desconhecido', confidence: 0 };
    // canal calado há um tempo (pregador pausou, música parou): mantém o que já sabia
    const active = this.blockDb.filter((v) => v > -60).length;
    if (active < 40 && this.last) return this.last;
    return (this.last = this.decide(f));
  }

  private decide(f: Features): Identification {
    const tr = this.transientsPerSec();
    const pauses = this.pauseRatio();
    const lowEnd = f.sub + f.low;
    // percussão = muitos ataques E queda rápida depois deles
    const percussive = tr >= 0.8 && this.decayAfterAttacks() >= 12;

    if (f.sub > 0.45 && percussive && f.centroid < 400) return { type: 'bumbo', confidence: Math.min(1, f.sub + 0.2) };
    // baixo: fundamentais abaixo de ~120 Hz e som sustentado
    if (f.sub > 0.3 && lowEnd > 0.6 && tr < 0.8 && f.centroid < 450) return { type: 'baixo', confidence: Math.min(1, lowEnd) };
    if (f.pres + f.air > 0.55 && f.centroid > 3500) return { type: 'pratos', confidence: Math.min(1, f.pres + f.air) };
    if (percussive && f.flatness > 0.25 && f.centroid > 400 && f.centroid < 5000) {
      return { type: 'caixa', confidence: Math.min(1, 0.5 + f.flatness) };
    }
    const mod = this.modulationDb();
    if ((pauses > 0.12 || mod > 2.2) && f.sub < 0.2 && f.centroid > 250 && f.centroid < 3500) {
      return { type: 'voz', confidence: Math.min(1, 0.4 + pauses + mod / 20) };
    }
    return { type: 'harmonico', confidence: 0.5 };
  }

  reset(): void {
    this.feat = undefined;
    this.last = undefined;
    this.frames = 0;
    this.blockDb.length = 0;
  }
}

/**
 * Tipo de som pelo NOME do canal (vale também no modo VU, sem áudio USB).
 * Ex.: "BUMBO", "Kick", "Cx", "OH L", "Baixo", "Violão", "Voz Pastor".
 */
export function typeFromName(name: string): SourceType {
  const n = name.toLowerCase();
  if (isUtilityName(name)) return 'desconhecido'; // "TALK BACK" não é back vocal
  if (/bumbo|kick|\bbd\b/.test(n)) return 'bumbo';
  if (/caixa|snare|\bcx\b|\bsn\b/.test(n)) return 'caixa';
  if (/over|\boh\b|prato|chimbal|hi-?hat|\bhh\b|ride|crash/.test(n)) return 'pratos';
  if (/baix|bass/.test(n)) return 'baixo';
  if (/voz|vocal|\bvox\b|back|minist|cantor|canto|coral|pastor|prega|palestr|fala|locu|\bmc\b|apresent|lider|solo/.test(n)) return 'voz';
  if (/viol|guit|gtr|tecl|key|piano|synth|pad|sax|trompe|flaut|cord|acord|sanfon/.test(n)) return 'harmonico';
  return 'desconhecido';
}

/** Canal de serviço (talk back, click, guia): fica fora das contas de equilíbrio da mixagem. */
export function isUtilityName(name: string): boolean {
  return /talk\s*-?\s*back|\btb\b|\bclick\b|metr[oô]nomo|\bguia\b|\bcue\b/i.test(name);
}

/** Voz principal pelo nome (pastor, ministro, solo...). */
export function isLeadVoiceName(name: string): boolean {
  return /pastor|prega|minist|principal|lead|solo|palestr|lider/.test(name.toLowerCase());
}

/**
 * Volume ideal sugerido por tipo, relativo à voz principal (dB).
 * Regra prática para live de igreja: a palavra/voz principal na frente, banda apoiando.
 */
export const TYPE_OFFSET_DB: Record<Exclude<SourceType, 'desconhecido'>, number> = {
  voz: -5, // outras vozes (backs)
  bumbo: -6,
  caixa: -7,
  pratos: -12,
  baixo: -6,
  harmonico: -8,
};
