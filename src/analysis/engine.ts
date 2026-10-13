import { analyzeNoise, type FeedbackAlert, FeedbackDetector, Persistence } from './detectors.js';
import { type EqAdvice, eqAdvice } from './eq-advice.js';
import { magnitudeSpectrumDb } from './fft.js';
import { type Identification, SourceIdentifier } from './identify.js';
import { type LoudnessReading, LoudnessMeter } from './loudness.js';
import { type ChannelRole, guessRole, type Moment, MomentClassifier } from './moment.js';
import { type RecordingInfo, MultitrackRecorder } from './recorder.js';
import { rtaBands, smoothBands } from './rta.js';
import type { EqState } from '../mixer/eq.js';

/**
 * Motor dos recursos avançados (só no modo Áudio USB): recebe os blocos PCM de todos os canais
 * e, a cada 200 ms, roda os detectores. Nada disso mexe no som: só observa.
 */

export interface AdvancedSettings {
  feedback: boolean;
  noise: boolean;
  rta: boolean;
  moment: {
    enabled: boolean;
    /** papel de cada canal (sem entrada = adivinhado pelo nome) */
    roles: Record<string, ChannelRole>;
    /** troca automática de preset por saída: { "7": { enabled, fala: presetId, musica: presetId } } */
    auto: Record<string, { enabled: boolean; fala?: string; musica?: string }>;
  };
  loudness: {
    enabled: boolean;
    /** 'usb' = dois canais do próprio USB (ex.: a live, se a mesa mandar); 'device' = outro dispositivo (Voicemeeter/OBS) */
    source: 'usb' | 'device';
    left: number;
    right: number;
    device?: string;
    target: number;
  };
  obs: { enabled: boolean; host: string; port: number; password?: string; input?: string };
}

export const DEFAULT_ADVANCED: AdvancedSettings = {
  feedback: true,
  noise: true,
  rta: true,
  moment: { enabled: false, roles: {}, auto: {} },
  loudness: { enabled: true, source: 'device', left: 23, right: 24, target: -14 },
  obs: { enabled: false, host: '127.0.0.1', port: 4455 },
};

export interface ChannelAlert {
  key: string;
  name: string;
  since: number;
}

export interface AnalysisSnapshot {
  feedback: (ChannelAlert & FeedbackAlert)[];
  hum: (ChannelAlert & { freqHz: number; aboveDb: number })[];
  hiss: (ChannelAlert & { levelDb: number })[];
  loudness?: LoudnessReading & { target: number; source: string };
  moment: { state: Moment; since: number; candidate?: Moment; roles: Record<string, ChannelRole> };
  recording?: RecordingInfo & { seconds: number };
  /** espectro em bandas do canal pedido (painel do canal) */
  rta: Record<string, number[]>;
  /** que som é cada canal (só canais que já tocaram o bastante) */
  identified: Record<string, Identification>;
}

const ANALYZE_EVERY_MS = 200;
const FFT_SIZE = 4096;

interface ChannelState {
  ring: Float32Array;
  filled: number;
  sumSquares: number;
  count: number;
  rmsDb: number;
  feedback: FeedbackDetector;
  fbAlert?: FeedbackAlert;
  fbSince?: number;
  hum: Persistence;
  hiss: Persistence;
  humInfo?: { freqHz: number; aboveDb: number };
  hissInfo?: { levelDb: number };
  bands?: number[];
  /** espectro médio (minutos) enquanto o canal toca, para as sugestões de EQ */
  longBands?: number[];
  ident: SourceIdentifier;
  blockSum: number;
  blockCount: number;
}

export class AnalysisEngine {
  private readonly ch: ChannelState[] = [];
  private names: string[] = [];
  private lastAnalysis = 0;
  private loudness?: LoudnessMeter;
  private readonly moment = new MomentClassifier();
  private readonly recorder: MultitrackRecorder;
  /** canais cujo espectro alguém está olhando (painel do canal) */
  readonly wantRta = new Set<string>();
  onMomentChange?: (m: Moment) => void;
  /** amostras por bloco de 50 ms (identificação de ataques/pausas) */
  private readonly blockFrames: number;

  constructor(
    private settings: AdvancedSettings,
    readonly channels: number,
    private readonly sampleRate = 48000,
  ) {
    this.blockFrames = Math.round(sampleRate * 0.05);
    for (let i = 0; i < channels; i++) {
      this.ch.push({
        ring: new Float32Array(FFT_SIZE),
        filled: 0,
        sumSquares: 0,
        count: 0,
        rmsDb: -100,
        feedback: new FeedbackDetector(sampleRate, FFT_SIZE),
        hum: new Persistence(2000),
        hiss: new Persistence(5000),
        ident: new SourceIdentifier(),
        blockSum: 0,
        blockCount: 0,
      });
    }
    this.recorder = new MultitrackRecorder(sampleRate);
    this.configure(settings);
  }

  configure(settings: AdvancedSettings): void {
    const loudChanged =
      !this.loudness || settings.loudness.enabled !== this.settings.loudness.enabled || settings.loudness.source !== this.settings.loudness.source;
    this.settings = settings;
    if (loudChanged) this.loudness = settings.loudness.enabled ? new LoudnessMeter(2, this.sampleRate) : undefined;
  }

  setNames(names: string[]): void {
    this.names = names;
  }

  private key(i: number): string {
    return `i${i + 1}`;
  }

  /** Bloco PCM 16 bits intercalado vindo do USB. */
  feed(block: Buffer, channels: number, now = Date.now()): void {
    const frames = Math.floor(block.length / (channels * 2));
    const n = Math.min(channels, this.ch.length);
    const useUsbLoudness = this.loudness && this.settings.loudness.source === 'usb';
    const left = useUsbLoudness ? new Float64Array(frames) : undefined;
    const right = useUsbLoudness ? new Float64Array(frames) : undefined;
    const li = this.settings.loudness.left - 1;
    const ri = this.settings.loudness.right - 1;

    for (let c = 0; c < n; c++) {
      const st = this.ch[c];
      // desliza o buffer e coloca as amostras novas no fim
      const keep = Math.max(0, FFT_SIZE - frames);
      if (keep > 0) st.ring.copyWithin(0, FFT_SIZE - keep);
      const start = Math.max(0, frames - FFT_SIZE);
      for (let f = start; f < frames; f++) {
        const v = block.readInt16LE((f * channels + c) * 2) / 32768;
        st.ring[keep + (f - start)] = v;
        st.sumSquares += v * v;
        st.count++;
        st.blockSum += v * v;
        if (++st.blockCount >= this.blockFrames) {
          st.ident.pushBlock(Math.max(-100, 10 * Math.log10(st.blockSum / st.blockCount + 1e-12)));
          st.blockSum = 0;
          st.blockCount = 0;
        }
        if (c === li && left) left[f] = v;
        if (c === ri && right) right[f] = v;
      }
      st.filled = Math.min(FFT_SIZE, st.filled + frames);
    }
    if (left && right) this.loudness!.push([left, right]);
    this.recorder.write(block, channels);
    if (now - this.lastAnalysis >= ANALYZE_EVERY_MS) {
      this.lastAnalysis = now;
      this.analyze(now);
    }
  }

  /** Bloco estéreo de um dispositivo separado (ex.: saída do Voicemeeter/OBS) para o loudness. */
  feedLoudnessDevice(block: Buffer, channels: number): void {
    if (!this.loudness || this.settings.loudness.source !== 'device') return;
    const frames = Math.floor(block.length / (channels * 2));
    const l = new Float64Array(frames);
    const r = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      l[f] = block.readInt16LE(f * channels * 2) / 32768;
      r[f] = channels > 1 ? block.readInt16LE((f * channels + 1) * 2) / 32768 : l[f];
    }
    this.loudness.push([l, r]);
  }

  private analyze(now: number): void {
    const activity = [];
    for (let c = 0; c < this.ch.length; c++) {
      const st = this.ch[c];
      const key = this.key(c);
      st.rmsDb = st.count ? Math.max(-100, 10 * Math.log10(st.sumSquares / st.count + 1e-12)) : -100;
      st.sumSquares = 0;
      st.count = 0;
      const role = this.roleOf(c);
      activity.push({ key, role, rmsDb: st.rmsDb });
      if (st.filled < FFT_SIZE) continue;

      const wantsRta = this.settings.rta && this.wantRta.has(key);
      const wantsFeedback = this.settings.feedback && st.rmsDb > -60;
      const wantsNoise = this.settings.noise && st.rmsDb > -78 && st.rmsDb < -30;
      const playing = st.rmsDb > -55; // tocando de verdade: alimenta a identificação e o espectro médio
      if (!wantsRta && !wantsFeedback && !wantsNoise && !playing) {
        // canal parado: nada a analisar, e os alertas antigos deixam de valer
        st.fbAlert = undefined;
        st.humInfo = undefined;
        st.hissInfo = undefined;
        st.hum.update(false, now);
        st.hiss.update(false, now);
        continue;
      }
      const spec = magnitudeSpectrumDb(st.ring);

      if (wantsRta || playing) {
        const bands = rtaBands(spec, this.sampleRate, FFT_SIZE);
        if (wantsRta) st.bands = smoothBands(st.bands, bands);
        if (playing) {
          st.ident.pushSpectrum(spec, this.sampleRate, FFT_SIZE);
          // média lenta em dB, relativa ao nível do canal (assim mudar o volume não muda a "cara" do som)
          const rel = bands.map((b) => b - st.rmsDb);
          st.longBands = st.longBands ? st.longBands.map((v, i) => v + 0.03 * (rel[i] - v)) : rel;
        }
      }
      if (this.settings.feedback) {
        const fb = wantsFeedback ? st.feedback.update(spec, now) : undefined;
        if (fb && !st.fbAlert) st.fbSince = now;
        st.fbAlert = fb;
      }
      if (this.settings.noise) {
        const report = wantsNoise ? analyzeNoise(spec, st.rmsDb, this.sampleRate, FFT_SIZE) : {};
        st.humInfo = st.hum.update(Boolean(report.hum), now) ? report.hum : undefined;
        st.hissInfo = st.hiss.update(Boolean(report.hiss), now) ? report.hiss : undefined;
      }
    }

    if (this.settings.moment.enabled) {
      const changed = this.moment.update(activity, now);
      if (changed) this.onMomentChange?.(changed);
    }
  }

  startRecording(baseDir: string): RecordingInfo {
    const names = Array.from({ length: this.channels }, (_, i) => this.names[i] ?? `CH ${i + 1}`);
    return this.recorder.start(baseDir, names);
  }

  stopRecording(): RecordingInfo | undefined {
    return this.recorder.stop();
  }

  resetLoudness(): void {
    this.loudness?.reset();
  }

  /**
   * Papel do canal: o escolhido na tela Análise; senão pelo nome; senão pelo som identificado
   * (instrumento identificado vira "instrumento"; voz fica "auto", porque fala e canto se parecem).
   */
  private roleOf(c: number): ChannelRole {
    const key = this.key(c);
    const set = this.settings.moment.roles[key];
    if (set) return set;
    const byName = guessRole(this.names[c] ?? '');
    if (byName !== 'auto') return byName;
    const id = this.ch[c]?.ident.identify();
    if (id && id.type !== 'voz' && id.type !== 'desconhecido') return 'instrumento';
    return 'auto';
  }

  /** Papel de cada canal (definido ou adivinhado). */
  roles(): Record<string, ChannelRole> {
    const out: Record<string, ChannelRole> = {};
    for (let c = 0; c < this.channels; c++) out[this.key(c)] = this.roleOf(c);
    return out;
  }

  /** Que som é o canal ("iN"). */
  identification(key: string): Identification | undefined {
    const st = this.ch[Number(key.slice(1)) - 1];
    if (!st || !key.startsWith('i')) return undefined;
    const id = st.ident.identify();
    return id.type === 'desconhecido' ? undefined : id;
  }

  /** Sugestões de EQ para o canal, pelo espectro médio e pelo tipo de som. */
  eqAdviceFor(key: string, eq?: EqState): EqAdvice[] {
    const st = this.ch[Number(key.slice(1)) - 1];
    const id = this.identification(key);
    if (!st?.longBands || !id) return [];
    return eqAdvice(id.type, st.longBands, eq);
  }

  /** Esquece o que foi aprendido dos canais (troca de mesa/dispositivo). */
  resetLearning(): void {
    for (const st of this.ch) {
      st.ident.reset();
      st.longBands = undefined;
    }
  }

  snapshot(rtaKeys: Iterable<string> = []): AnalysisSnapshot {
    const now = Date.now();
    const name = (i: number) => this.names[i] ?? `CH ${i + 1}`;
    const out: AnalysisSnapshot = {
      feedback: [],
      hum: [],
      hiss: [],
      moment: { state: this.moment.state, since: this.moment.since, candidate: this.moment.candidate?.moment, roles: this.roles() },
      rta: {},
      identified: {},
    };
    this.ch.forEach((st, i) => {
      const key = this.key(i);
      if (st.fbAlert) out.feedback.push({ key, name: name(i), since: st.fbSince ?? now, ...st.fbAlert });
      if (st.humInfo) out.hum.push({ key, name: name(i), since: now - st.hum.forSec(now) * 1000, ...st.humInfo });
      if (st.hissInfo) out.hiss.push({ key, name: name(i), since: now - st.hiss.forSec(now) * 1000, ...st.hissInfo });
      const id = st.ident.identify();
      if (id.type !== 'desconhecido') out.identified[key] = { type: id.type, confidence: Math.round(id.confidence * 100) / 100 };
    });
    for (const key of rtaKeys) {
      const i = Number(key.slice(1)) - 1;
      const bands = this.ch[i]?.bands;
      if (bands) out.rta[key] = bands.map((b) => Math.round(b * 10) / 10);
    }
    if (this.loudness) {
      out.loudness = { ...this.loudness.reading(), target: this.settings.loudness.target, source: this.settings.loudness.source };
    }
    if (this.recorder.info) out.recording = { ...this.recorder.info, seconds: Math.round((now - this.recorder.info.startedAt) / 1000) };
    return out;
  }

  stop(): void {
    this.recorder.stop();
  }
}
