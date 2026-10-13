import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELER } from '../src/config.js';
import type { ChannelOffset } from '../src/leveler/aux-leveler.js';
import { FxFollower } from '../src/leveler/fx-follower.js';
import type { SendInfo } from '../src/mixer/types.js';

const SEND: SendInfo = { db: -6, muted: false, postFader: false, postProc: true };

function setup() {
  const f = new FxFollower(7, DEFAULT_LEVELER);
  f.setMode('automatico');
  f.ensureReturn('f1', 'Reverb Voz');
  f.onSend('f1', SEND, 0);
  return f;
}

const off = (key: string, offsetDB: number, levelDB = -20, recent = true): ChannelOffset => ({ key, offsetDB, levelDB, recent });

/** Roda ticks aplicando as ações como a mesa faria. */
function run(f: FxFollower, offsets: ChannelOffset[], fromMs: number, seconds: number) {
  let t = fromMs;
  for (; t < fromMs + seconds * 1000; t += 500) {
    for (const a of f.tick(t, offsets)) {
      f.markCommanded(a.key, a.toDB, t);
      f.onSend(a.key, { ...SEND, db: a.toDB }, t);
    }
  }
  return t;
}

const snap = (f: FxFollower) => f.snapshot().find((s) => s.key === 'f1')!;

describe('FxFollower', () => {
  it('reverb desce junto quando o único canal que alimenta desce', () => {
    const f = setup();
    f.onFxSend('f1', 'i1', -12);
    run(f, [off('i1', -4)], 0, 10);
    expect(snap(f).sendDB).toBeCloseTo(-10, 1);
  });

  it('com vários canais, desce proporcionalmente', () => {
    const f = setup();
    for (const k of ['i1', 'i2', 'i3']) f.onFxSend('f1', k, -12);
    const delta = f.followDelta('f1', [off('i1', -6), off('i2', 0), off('i3', 0)])!;
    expect(delta).toBeLessThan(-0.5);
    expect(delta).toBeGreaterThan(-2);
  });

  it('canal fechado na live tira a reverb dele da live', () => {
    const f = setup();
    f.onFxSend('f1', 'i1', -12);
    const delta = f.followDelta('f1', [off('i1', Number.NEGATIVE_INFINITY)])!;
    expect(delta).toBeLessThanOrEqual(-79);
  });

  it('ignora canais que não alimentam o efeito ou estão parados há tempo', () => {
    const f = setup();
    f.onFxSend('f1', 'i1', -12);
    expect(f.followDelta('f1', [off('i1', 0), off('i9', -10)])).toBeCloseTo(0, 5);
    expect(f.followDelta('f1', [off('i1', -10, -20, false)])).toBeUndefined();
  });

  it('respeita o operador: novo nível do retorno vira referência', () => {
    const f = setup();
    f.onFxSend('f1', 'i1', -12);
    let t = run(f, [off('i1', -4)], 0, 10); // retorno foi para -10
    expect(f.onSend('f1', { ...SEND, db: -3 }, t)).toEqual({ fromDB: -10, toDB: -3 });
    t = run(f, [off('i1', -4)], t, 5);
    expect(snap(f).sendDB).toBeCloseTo(-3, 1); // não brigou com o operador
  });

  it('no modo observar não mexe', () => {
    const f = setup();
    f.setMode('observar');
    f.onFxSend('f1', 'i1', -12);
    run(f, [off('i1', -4)], 0, 10);
    expect(snap(f).sendDB).toBe(-6);
    expect(snap(f).suggestedDeltaDB).toBeCloseTo(-4, 1);
  });
});
