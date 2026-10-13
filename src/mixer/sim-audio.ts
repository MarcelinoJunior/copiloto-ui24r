import type { AudioSource, UsbCaptureState } from '../levels/usb-audio.js';
import { pcmBlockLevels } from '../levels/usb-audio.js';
import type { SimulatorAdapter } from './simulator.js';

/**
 * "USB simulado": gera áudio de verdade para cada canal do simulador, para testar em casa
 * os recursos que precisam do áudio USB (microfonia, ruído, espectro, fala × música,
 * loudness e gravação). Também dá para INJETAR microfonia e zumbido num canal.
 *
 * Tipos de som: fala (ruído filtrado com sílabas), canto (nota com harmônicos, vibrato e sílabas),
 * instrumento (acorde; "Baixo" toca grave), percussão ("Bumbo" grave batido, "Caixa" ruído com
 * corpo nos contratempos, "Overhead" agudo chiado). Assim a identificação do som tem o que ouvir.
 */

const SR = 48000;
const BLOCK_MS = 50;
const FRAMES = (SR * BLOCK_MS) / 1000;
const TAU = 2 * Math.PI;

const CHORD = [1, 1.26, 1.5]; // acorde maior (fundamental, terça, quinta)

/** Peso de cada harmônico da voz (1/h × formantes em ~500, 1500 e 2600 Hz). */
function speechWeights(f0: number): number[] {
  const out: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const hz = h * f0;
    const formant = 1 / (1 + ((hz - 500) / 180) ** 2) + 0.6 / (1 + ((hz - 1500) / 250) ** 2) + 0.3 / (1 + ((hz - 2600) / 350) ** 2);
    out.push(formant / h);
  }
  return out;
}

interface Injection {
  kind: 'microfonia' | 'zumbido';
  startT: number;
  freq: number;
}

export class SimulatedAudio implements AudioSource {
  state: UsbCaptureState = 'parado';
  lastError?: string;
  lastLevelsAt?: number;
  private timer?: NodeJS.Timeout;
  private sampleIndex = 0;
  private readonly phases = new Map<string, number[]>();
  private readonly lp = new Map<string, number>();
  private seed = 12345;
  readonly injections = new Map<string, Injection>();

  constructor(
    private readonly sim: SimulatorAdapter,
    readonly channels: number,
    private readonly onLevels: (levels: number[]) => void,
    private readonly onBlock?: (block: Buffer, channels: number) => void,
  ) {}

  start(): void {
    this.state = 'capturando';
    this.timer = setInterval(() => this.step(), BLOCK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.state = 'parado';
  }

  /** Microfonia: tom puro que cresce de -45 a -8 dBFS em ~4 s. Zumbido: 60 Hz + harmônicos. */
  inject(key: string, kind: Injection['kind']): void {
    const freq = kind === 'zumbido' ? 60 : [1250, 2500, 3150, 800][Math.floor(Math.random() * 4)];
    this.injections.set(key, { kind, startT: Date.now(), freq });
  }

  clearInjections(key?: string): void {
    if (key) this.injections.delete(key);
    else this.injections.clear();
  }

  private noise(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed / 2147483647) * 2 - 1;
  }

  private step(): void {
    const now = Date.now();
    const profile = this.sim.audioProfile().slice(0, this.channels);
    const block = Buffer.alloc(FRAMES * this.channels * 2);
    const t0 = this.sampleIndex / SR;

    for (const ch of profile) {
      const inj = this.injections.get(ch.key);
      if (inj && inj.kind === 'microfonia' && now - inj.startT > 15000) this.injections.delete(ch.key);
      const amp = ch.preDb > -79 ? Math.pow(10, ch.preDb / 20) : 0;
      const quiet = ch.preDb < -70;
      if (amp === 0 && !inj) continue;
      const phases = this.phases.get(ch.key) ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let lp = this.lp.get(ch.key) ?? 0;
      const f0 = 110 + ch.index * 23;
      const name = ch.name.toLowerCase();
      // fala: pesos dos formantes calculados uma vez por bloco (a entonação muda devagar)
      const f0v = 115 + 15 * Math.sin(TAU * 0.4 * t0) + ch.index * 7;
      const formants = ch.behavior === 'fala' ? speechWeights(f0v) : undefined;
      const voice = /baix|bass/.test(name) ? 'baixo' : /bumbo|kick/.test(name) ? 'bumbo' : /caixa|snare/.test(name) ? 'caixa' : /over|prato/.test(name) ? 'pratos' : '';
      const fbAmp = inj?.kind === 'microfonia' ? Math.pow(10, Math.min(-8, -45 + ((now - inj.startT) / 1000) * 9) / 20) : 0;

      for (let i = 0; i < FRAMES; i++) {
        const t = t0 + i / SR;
        let v = 0;
        if (quiet) {
          v = amp * this.noise(); // canal parado: só o chiado de fundo (barato)
        } else if (amp > 0) {
          if (ch.behavior === 'fala') {
            // voz falada: pulso glotal (~120 Hz, entonação variando) com formantes, sílabas e pausas entre palavras
            phases[0] += (TAU * f0v) / SR;
            let voiced = 0;
            for (let h = 0; h < formants!.length; h++) voiced += Math.sin(phases[0] * (h + 1)) * formants![h];
            lp += 0.5 * (this.noise() - lp); // um pouco de sopro (consoantes)
            const syllable = Math.pow(Math.abs(Math.sin(TAU * 2.7 * t)), 0.6);
            const word = (t % 1.7) < 1.35 ? 1 : 0.03;
            v = (2.2 * voiced + 0.25 * lp) * syllable * word;
          } else if (ch.behavior === 'canto') {
            const vib = 1 + 0.012 * Math.sin(TAU * 5 * t);
            phases[0] += (TAU * f0 * 2 * vib) / SR;
            for (let h = 1; h <= 6; h++) v += Math.sin(phases[0] * h) / (h * 1.6);
            v *= 0.6 * (0.25 + 0.75 * Math.abs(Math.sin(TAU * 2.2 * t))); // sílabas
          } else if (voice === 'baixo') {
            const note = [55, 73.4, 61.7, 82.4][Math.floor(t / 2) % 4]; // muda a nota a cada 2 s
            phases[0] += (TAU * note) / SR;
            v = 1.3 * (Math.sin(phases[0]) + 0.5 * Math.sin(phases[0] * 2) + 0.25 * Math.sin(phases[0] * 3));
          } else if (ch.behavior === 'instrumento') {
            for (let j = 0; j < 3; j++) {
              phases[j] += (TAU * f0 * CHORD[j]) / SR;
              for (let h = 1; h <= 4; h++) v += Math.sin(phases[j] * h) / (h * 3);
            }
          } else if (voice === 'bumbo') {
            const ph = (t * 2) % 1; // 120 bpm, no tempo
            phases[0] += (TAU * (55 + 60 * Math.exp(-ph * 40))) / SR;
            v = 2.2 * Math.exp(-ph * 14) * Math.sin(phases[0]);
          } else if (voice === 'caixa') {
            const ph = (t * 2 + 0.5) % 1; // contratempo
            v = 1.6 * Math.exp(-ph * 16) * (this.noise() + 0.6 * Math.sin(TAU * 200 * t));
          } else if (voice === 'pratos') {
            const n = this.noise();
            const ph = (t * 4) % 1;
            v = 1.4 * (n - lp) * Math.exp(-ph * 3); // ruído "aberto" (só agudos)
            lp = n;
          } else {
            const beat = (t * 2) % 1; // 120 bpm
            v = this.noise() * Math.exp(-beat * 18);
          }
          v *= amp;
        }
        if (fbAmp > 0) {
          phases[10] += (TAU * inj!.freq) / SR;
          v += fbAmp * Math.sin(phases[10]);
        }
        if (inj?.kind === 'zumbido') {
          const hum = Math.pow(10, -42 / 20);
          v += hum * (Math.sin(TAU * 60 * t) + 0.4 * Math.sin(TAU * 120 * t) + 0.3 * Math.sin(TAU * 180 * t));
        }
        const s = Math.max(-1, Math.min(1, v));
        block.writeInt16LE(Math.round(s * 32767), (i * this.channels + ch.index) * 2);
      }
      this.phases.set(ch.key, phases.map((p) => p % (TAU * 1000)));
      this.lp.set(ch.key, lp);
    }

    this.sampleIndex += FRAMES;
    this.lastLevelsAt = now;
    this.onLevels(pcmBlockLevels(block, this.channels));
    this.onBlock?.(block, this.channels);
  }
}
