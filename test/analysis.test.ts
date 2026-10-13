import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeNoise, FeedbackDetector } from '../src/analysis/detectors.js';
import { magnitudeSpectrumDb } from '../src/analysis/fft.js';
import { LoudnessMeter } from '../src/analysis/loudness.js';
import { guessRole, MomentClassifier } from '../src/analysis/moment.js';
import { MultitrackRecorder } from '../src/analysis/recorder.js';
import { RTA_CENTERS, rtaBands } from '../src/analysis/rta.js';

const SR = 48000;
const N = 4096;

/** Gera um bloco de N amostras a partir de uma função do tempo (s). */
function block(fn: (t: number) => number, offset = 0, n = N): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fn((offset + i) / SR);
  return out;
}

let seed = 1;
function noise(): number {
  // pseudo-aleatório determinístico (testes estáveis)
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
}

const db = (a: number) => Math.pow(10, a / 20);

describe('FFT', () => {
  it('uma senoide de -20 dBFS aparece com ~-20 dB no bin certo', () => {
    const f = 1000;
    const spec = magnitudeSpectrumDb(block((t) => db(-20) * Math.sin(2 * Math.PI * f * t)));
    const bin = Math.round((f * N) / SR);
    let peak = 0;
    for (let k = 1; k < spec.length; k++) if (spec[k] > spec[peak]) peak = k;
    expect(Math.abs(peak - bin)).toBeLessThanOrEqual(1);
    expect(spec[peak]).toBeGreaterThan(-21.6); // perda de "scalloping" da janela de Hann ≤ 1,5 dB
    expect(spec[peak]).toBeLessThan(-19.5);
  });

  it('RTA: a energia cai na banda de 1 kHz', () => {
    const spec = magnitudeSpectrumDb(block((t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t)));
    const bands = rtaBands(spec, SR, N);
    const loudest = bands.indexOf(Math.max(...bands));
    expect(RTA_CENTERS[loudest]).toBe(1000);
  });
});

describe('microfonia', () => {
  it('detecta um tom puro parado em ~2,5 kHz que cresce', () => {
    const det = new FeedbackDetector(SR, N);
    let alert;
    for (let step = 0; step < 15; step++) {
      const amp = db(-40 + step * 2); // sobe 2 dB a cada 200 ms
      const spec = magnitudeSpectrumDb(block((t) => amp * Math.sin(2 * Math.PI * 2500 * t) + 0.001 * noise(), step * 9600));
      alert = det.update(spec, step * 200) ?? alert;
    }
    expect(alert).toBeDefined();
    expect(Math.abs(alert!.freqHz - 2500)).toBeLessThan(30);
    expect(alert!.rising).toBe(true);
  });

  it('não dispara com voz/instrumento (tom cheio de harmônicos)', () => {
    const det = new FeedbackDetector(SR, N);
    let alert;
    for (let step = 0; step < 15; step++) {
      const vib = 1 + 0.01 * Math.sin(step); // vibrato leve
      const spec = magnitudeSpectrumDb(
        block((t) => {
          let s = 0;
          for (let h = 1; h <= 8; h++) s += (0.3 / h) * Math.sin(2 * Math.PI * 220 * vib * h * t);
          return s;
        }, step * 9600),
      );
      alert = det.update(spec, step * 200) ?? alert;
    }
    expect(alert).toBeUndefined();
  });

  it('não dispara com ruído', () => {
    const det = new FeedbackDetector(SR, N);
    let alert;
    for (let step = 0; step < 15; step++) alert = det.update(magnitudeSpectrumDb(block(() => 0.1 * noise())), step * 200) ?? alert;
    expect(alert).toBeUndefined();
  });
});

describe('ruído', () => {
  it('reconhece zumbido de 60 Hz com harmônicos', () => {
    const spec = magnitudeSpectrumDb(
      block((t) => db(-40) * Math.sin(2 * Math.PI * 60 * t) + db(-50) * Math.sin(2 * Math.PI * 120 * t) + db(-52) * Math.sin(2 * Math.PI * 180 * t) + 0.0003 * noise()),
    );
    expect(analyzeNoise(spec, -42, SR, N).hum?.freqHz).toBe(60);
  });

  it('reconhece chiado (ruído largo baixo)', () => {
    const spec = magnitudeSpectrumDb(block(() => db(-50) * noise()));
    const r = analyzeNoise(spec, -55, SR, N);
    expect(r.hiss).toBeDefined();
    expect(r.hum).toBeUndefined();
  });

  it('silêncio limpo não gera alerta', () => {
    const spec = magnitudeSpectrumDb(block(() => 0));
    expect(analyzeNoise(spec, -100, SR, N)).toEqual({});
  });
});

describe('loudness (LUFS)', () => {
  it('senoide de 1 kHz a -20 dBFS nos dois canais ≈ -20 LUFS', () => {
    const meter = new LoudnessMeter(2, SR);
    const amp = db(-20);
    for (let s = 0; s < 6; s++) {
      const l = new Float64Array(SR);
      for (let i = 0; i < SR; i++) l[i] = amp * Math.sin((2 * Math.PI * 997 * (s * SR + i)) / SR);
      meter.push([l, l]);
    }
    const r = meter.reading();
    expect(r.integrated!).toBeCloseTo(-20, 0);
    expect(r.shortTerm!).toBeCloseTo(-20, 0);
    expect(r.peakDb!).toBeCloseTo(-20, 0);
  });

  it('silêncio não conta para o integrado (gate absoluto)', () => {
    const meter = new LoudnessMeter(2, SR);
    const z = new Float64Array(SR * 3);
    meter.push([z, z]);
    expect(meter.reading().integrated).toBeUndefined();
  });
});

describe('fala × música', () => {
  it('papéis pelo nome do canal', () => {
    expect(guessRole('Pastor')).toBe('fala');
    expect(guessRole('Back 1')).toBe('canto');
    expect(guessRole('Guitarra')).toBe('instrumento');
    expect(guessRole('CH 13')).toBe('auto');
  });

  it('banda tocando vira "música" e só o pastor vira "fala", com histerese', () => {
    const cls = new MomentClassifier(2000);
    let t = 0;
    let changed;
    for (let i = 0; i < 20; i++, t += 200) {
      changed =
        cls.update(
          [
            { key: 'i1', role: 'fala', rmsDb: -80 },
            { key: 'i6', role: 'instrumento', rmsDb: -20 },
          ],
          t,
        ) ?? changed;
    }
    expect(changed).toBe('musica');
    let next;
    for (let i = 0; i < 5; i++, t += 200) {
      next = cls.update([{ key: 'i1', role: 'fala', rmsDb: -20 }, { key: 'i6', role: 'instrumento', rmsDb: -80 }], t) ?? next;
    }
    expect(next).toBeUndefined(); // 1 s ainda não basta
    for (let i = 0; i < 30; i++, t += 200) {
      next = cls.update([{ key: 'i1', role: 'fala', rmsDb: -20 }, { key: 'i6', role: 'instrumento', rmsDb: -80 }], t) ?? next;
    }
    expect(next).toBe('fala');
  });
});

describe('fala × música com fundo musical', () => {
  it('pregação com teclado de fundo continua sendo "fala"', () => {
    const cls = new MomentClassifier(2000);
    let t = 0;
    let changed;
    // louvor: banda forte, pastor calado
    for (let i = 0; i < 30; i++, t += 200) {
      changed = cls.update([
        { key: 'i1', role: 'fala', rmsDb: -80 },
        { key: 'i6', role: 'instrumento', rmsDb: -20 },
        { key: 'i8', role: 'instrumento', rmsDb: -24 },
      ], t) ?? changed;
    }
    expect(changed).toBe('musica');
    // pregação: pastor falando (com pausas), teclado baixinho de fundo
    for (let i = 0; i < 40; i++, t += 200) {
      changed = cls.update([
        { key: 'i1', role: 'fala', rmsDb: i % 5 === 4 ? -70 : -22 },
        { key: 'i6', role: 'instrumento', rmsDb: -80 },
        { key: 'i8', role: 'instrumento', rmsDb: -30 },
      ], t) ?? changed;
    }
    expect(changed).toBe('fala');
  });
});

describe('gravação multipista', () => {
  it('grava um WAV por canal com cabeçalho correto', () => {
    const base = join(tmpdir(), `copiloto-rec-${Date.now()}`);
    const rec = new MultitrackRecorder(SR);
    const info = rec.start(base, ['Pastor', 'Guitarra']);
    const frames = 480;
    const buf = Buffer.alloc(frames * 2 * 2);
    for (let f = 0; f < frames; f++) {
      buf.writeInt16LE(1000, f * 4);
      buf.writeInt16LE(-2000, f * 4 + 2);
    }
    rec.write(buf, 2);
    rec.stop();
    const wav = readFileSync(join(info.dir, '02-Guitarra.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(frames * 2); // bytes de dados
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readInt16LE(44)).toBe(-2000);
    rmSync(base, { recursive: true, force: true });
  });
});
