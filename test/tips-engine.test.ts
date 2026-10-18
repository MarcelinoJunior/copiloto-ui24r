import { describe, expect, it } from 'vitest';
import { AnalysisEngine, DEFAULT_ADVANCED } from '../src/analysis/engine.js';
import { BalanceTracker, ChannelStats, computeTips, TipHold } from '../src/tips.js';

function stats(values: number[]) {
  const s = new ChannelStats();
  values.forEach((v, i) => s.push(v, i * 50));
  return s.summary((values.length - 1) * 50);
}

describe('dicas', () => {
  it('clipando, baixo demais e ruído constante', () => {
    const tips = computeTips({
      now: 0,
      channels: [
        { key: 'i1', name: 'Pastor', summary: stats(Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? -0.5 : -12))) },
        { key: 'i2', name: 'Back 1', summary: stats(Array.from({ length: 100 }, () => -45)) },
        { key: 'i3', name: 'CH 3', summary: stats(Array.from({ length: 100 }, (_, i) => -55 + (i % 3))) },
        { key: 'i4', name: 'Baixo', summary: stats(Array.from({ length: 100 }, () => -18)) },
      ],
    });
    const ids = tips.map((t) => t.id);
    expect(ids).toContain('clip:i1');
    expect(ids).toContain('low:i2');
    expect(ids).toContain('noise:i3');
    expect(ids.some((id) => id.endsWith(':i4'))).toBe(false); // canal saudável não gera dica
    expect(tips[0].severity).toBe('alta'); // ordenado por gravidade
  });

  it('saída perto de clipar e OBS mutado com a live no ar', () => {
    const tips = computeTips({
      now: 1000,
      channels: [],
      bus: { bus: 7, label: 'AUX 7+8', mode: 'observar', outDB: -1.5, channels: [] },
      obs: { state: 'conectado', streaming: true, recording: false, input: 'Mesa', inputMuted: true, inputs: [], filters: [] },
    });
    expect(tips.map((t) => t.id)).toEqual(expect.arrayContaining(['out:7', 'obs-mute']));
  });
});

describe('motor de análise (blocos USB)', () => {
  it('acha microfonia num canal e zumbido em outro', () => {
    const engine = new AnalysisEngine(DEFAULT_ADVANCED, 2);
    engine.setNames(['Pastor', 'Violão']);
    const frames = 2400; // 50 ms
    let n = 0;
    for (let b = 0; b < 100; b++) {
      const block = Buffer.alloc(frames * 2 * 2);
      for (let f = 0; f < frames; f++, n++) {
        const t = n / 48000;
        const fb = Math.pow(10, (-45 + Math.min(37, t * 9)) / 20) * Math.sin(2 * Math.PI * 2500 * t);
        const hum = Math.pow(10, -42 / 20) * (Math.sin(2 * Math.PI * 60 * t) + 0.4 * Math.sin(2 * Math.PI * 120 * t) + 0.3 * Math.sin(2 * Math.PI * 180 * t));
        block.writeInt16LE(Math.round(fb * 32767), f * 4);
        block.writeInt16LE(Math.round(hum * 32767), f * 4 + 2);
      }
      engine.feed(block, 2, b * 50);
    }
    const snap = engine.snapshot();
    expect(snap.feedback.map((f) => f.key)).toEqual(['i1']);
    expect(Math.abs(snap.feedback[0].freqHz - 2500)).toBeLessThan(30);
    expect(snap.hum.map((h) => `${h.key}:${h.freqHz}`)).toEqual(['i2:60']);
  });

  it('o alerta some quando o canal fica em silêncio', () => {
    const engine = new AnalysisEngine(DEFAULT_ADVANCED, 1);
    engine.setNames(['CH 13']);
    const frames = 2400;
    let n = 0;
    const run = (blocks: number, withHum: boolean, t0: number) => {
      for (let b = 0; b < blocks; b++) {
        const block = Buffer.alloc(frames * 2);
        for (let f = 0; f < frames; f++, n++) {
          const t = n / 48000;
          const v = withHum ? Math.pow(10, -42 / 20) * (Math.sin(2 * Math.PI * 60 * t) + 0.4 * Math.sin(2 * Math.PI * 120 * t) + 0.3 * Math.sin(2 * Math.PI * 180 * t)) : 0;
          block.writeInt16LE(Math.round(v * 32767), f * 2);
        }
        engine.feed(block, 1, t0 + b * 50);
      }
    };
    run(80, true, 0);
    expect(engine.snapshot().hum).toHaveLength(1);
    run(40, false, 4000);
    expect(engine.snapshot().hum).toHaveLength(0);
  });
});

describe('equilíbrio de volumes (pelo VU)', () => {
  const ch = (key: string, name: string, contributionDB: number) => ({
    key,
    name,
    enabled: true,
    status: 'ok' as const,
    rawDB: -20,
    levelDB: -20,
    sendDB: contributionDB + 20,
    muted: false,
    contributionDB,
    suggestedDeltaDB: 0,
    manualForSec: 0,
  });
  const types = { i1: 'voz', i2: 'harmonico', i3: 'baixo', i4: 'bumbo', i5: 'harmonico' } as const;

  it('voz abaixo da banda vira "voz encoberta"; instrumento muito alto vira dica', () => {
    const bus = {
      bus: 7,
      label: 'AUX 7+8',
      mode: 'observar' as const,
      channels: [ch('i1', 'Voz Pastor', -22), ch('i2', 'Violão', -20), ch('i3', 'Baixo', -21), ch('i4', 'Bumbo', -4), ch('i5', 'Teclado', -21)],
    };
    const ids = computeTips({ now: 0, channels: [], bus, types: { ...types } }).map((t) => t.id);
    expect(ids).toContain('bal-voz:7');
    expect(ids).toContain('bal-alto:7:i4');
    expect(ids).not.toContain('bal-alto:7:i1');
  });

  it('mixagem equilibrada (voz na frente) não gera dica de equilíbrio', () => {
    const bus = {
      bus: 7,
      label: 'AUX 7+8',
      mode: 'observar' as const,
      channels: [ch('i1', 'Voz', -14), ch('i2', 'Violão', -20), ch('i3', 'Baixo', -20), ch('i4', 'Bumbo', -21), ch('i5', 'Teclado', -22)],
    };
    const ids = computeTips({ now: 0, channels: [], bus, types: { ...types } }).map((t) => t.id);
    expect(ids.filter((id) => id.startsWith('bal-'))).toEqual([]);
  });

  it('canal mutado não entra na conta', () => {
    const muted = { ...ch('i4', 'Bumbo', -2), muted: true };
    const bus = { bus: 7, label: 'AUX 7', mode: 'observar' as const, channels: [ch('i1', 'Voz', -14), ch('i2', 'Violão', -20), ch('i3', 'Baixo', -20), muted] };
    const ids = computeTips({ now: 0, channels: [], bus, types: { ...types } }).map((t) => t.id);
    expect(ids).not.toContain('bal-alto:7:i4');
  });
});

describe('equilíbrio avaliado num período (sem dica por pico de bumbo)', () => {
  const snap = (key: string, name: string, contributionDB: number) => ({
    key,
    name,
    enabled: true,
    status: 'ok' as const,
    rawDB: -20,
    levelDB: -20,
    sendDB: 0,
    muted: false,
    contributionDB,
    suggestedDeltaDB: 0,
    manualForSec: 0,
  });
  const types = { i1: 'voz', i2: 'harmonico', i3: 'baixo', i17: 'bumbo', i9: 'desconhecido' } as const;

  /** 60 s de mixagem: bumbo com picos que oscilam de -20 a -2, voz acima da banda. */
  function run(bumbo: (t: number) => number) {
    const tracker = new BalanceTracker();
    const hold = new TipHold();
    let shown: string[] = [];
    for (let t = 0; t <= 60_000; t += 500) {
      const chans = [snap('i1', 'MINISTRO', -14), snap('i2', 'VIOLAO', -20), snap('i3', 'BAIXO', -20), snap('i17', 'BUMBO', bumbo(t)), snap('i9', 'TALK BACK', -45)];
      tracker.update(5, chans, t);
      const bus = { bus: 5, label: 'AUX 5+6', mode: 'observar' as const, channels: tracker.view(5, chans, t) };
      shown = hold.filter(computeTips({ now: t, channels: [], bus, types: { ...types } }), t).map((x) => x.id);
    }
    return shown;
  }

  it('bumbo com picos (às vezes muito acima) não vira dica; talk back não entra na conta', () => {
    const ids = run((t) => ((t / 500) % 4 === 0 ? -2 : -20)); // um pico forte a cada 2 s
    expect(ids.filter((id) => id.startsWith('bal-'))).toEqual([]);
  });

  it('bumbo alto o tempo todo vira dica, mas só depois de ~20 s persistente', () => {
    expect(run(() => 0)).toContain('bal-alto:5:i17');
    const tracker = new BalanceTracker();
    const hold = new TipHold();
    let early: string[] = [];
    for (let t = 0; t <= 25_000; t += 500) {
      const chans = [snap('i1', 'MINISTRO', -14), snap('i2', 'VIOLAO', -20), snap('i3', 'BAIXO', -20), snap('i17', 'BUMBO', 0)];
      tracker.update(5, chans, t);
      const bus = { bus: 5, label: 'AUX 5+6', mode: 'observar' as const, channels: tracker.view(5, chans, t) };
      early = hold.filter(computeTips({ now: t, channels: [], bus, types: { ...types } }), t).map((x) => x.id);
    }
    expect(early).not.toContain('bal-alto:5:i17'); // 15 s de aquecimento + 20 s de persistência
  });
});
