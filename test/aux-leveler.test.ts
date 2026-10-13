import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELER, type LevelerConfig } from '../src/config.js';
import { AuxLeveler } from '../src/leveler/aux-leveler.js';
import { GatedLevel } from '../src/leveler/gated-level.js';
import type { SendInfo } from '../src/mixer/types.js';

const SEND: SendInfo = { db: -6, muted: false, postFader: false, postProc: true };

function vu(db: number) {
  return { pre: db, post: db, postFader: db };
}

/** Alimenta o nivelador com um nível constante e roda os ticks, aplicando as ações como a mesa faria. */
function run(l: AuxLeveler, key: string, levelDB: number, fromMs: number, seconds: number, tickMs = 500) {
  let t = fromMs;
  const end = fromMs + seconds * 1000;
  while (t < end) {
    for (let i = 0; i < tickMs / 50; i++) {
      t += 50;
      l.onVu(key, vu(levelDB), t);
    }
    for (const a of l.tick(t)) {
      l.markCommanded(a.key, a.toDB, t);
      l.onSend(a.key, { ...SEND, db: a.toDB }, t); // eco da mesa
    }
  }
  return t;
}

function setup(cfg: Partial<LevelerConfig> = {}) {
  const l = new AuxLeveler(7, { ...DEFAULT_LEVELER, ...cfg });
  l.setMode('automatico');
  l.ensureChannel('i1', 'Guitarra');
  l.onSend('i1', SEND, 0);
  return l;
}

const snap = (l: AuxLeveler, t: number) => l.snapshot(t).find((c) => c.key === 'i1')!;

describe('GatedLevel', () => {
  it('ignora silêncio entre frases', () => {
    const g = new GatedLevel(3, -50, 1.5);
    for (let t = 0; t < 5000; t += 50) g.update(-20, t);
    for (let t = 5000; t < 8000; t += 50) g.update(-80, t);
    expect(g.levelDB).toBeCloseTo(-20, 0);
    expect(g.isActive(8000)).toBe(false);
  });

  it('acompanha quando o nível sobe', () => {
    const g = new GatedLevel(3, -50, 1.5);
    for (let t = 0; t < 5000; t += 50) g.update(-20, t);
    for (let t = 5000; t < 20000; t += 50) g.update(-12, t);
    expect(g.levelDB).toBeCloseTo(-12, 0);
  });
});

describe('AuxLeveler', () => {
  it('captura a mixagem atual como alvo', () => {
    const l = setup();
    const t = run(l, 'i1', -20, 0, 5);
    expect(l.captureTargets(t)).toBe(1);
    expect(snap(l, t).targetDB).toBeCloseTo(-26, 0); // -20 de nível + -6 de envio
  });

  it('abaixa o envio quando o músico aumenta o volume', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    t = run(l, 'i1', -14, t, 30); // guitarrista subiu 6 dB
    const s = snap(l, t);
    expect(s.sendDB).toBeLessThan(-10);
    expect(s.contributionDB! - s.targetDB!).toBeLessThan(DEFAULT_LEVELER.deadbandDB);
  });

  it('abaixa devagar (respeita a velocidade máxima)', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    t = run(l, 'i1', -10, t, 4); // 4 s, sendo 2 s esperando o canal "firmar"
    expect(snap(l, t).sendDB).toBeGreaterThan(-6 - DEFAULT_LEVELER.cutRateDBps * 4 - 0.5);
  });

  it('nunca passa do limite de corte', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    t = run(l, 'i1', 0, t, 60); // subiu 20 dB
    const s = snap(l, t);
    expect(s.sendDB).toBeCloseTo(-6 - DEFAULT_LEVELER.maxCutDB, 1);
    expect(s.status).toBe('no-limite');
  });

  it('não mexe em canal em silêncio', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    t = run(l, 'i1', -80, t, 20);
    expect(snap(l, t).sendDB).toBe(-6);
    expect(snap(l, t).status).toBe('silencio');
  });

  it('no modo observar só sugere, não age', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    l.setMode('observar');
    t = run(l, 'i1', -14, t, 10);
    const s = snap(l, t);
    expect(s.sendDB).toBe(-6);
    expect(s.suggestedDeltaDB).toBeLessThan(-4);
  });

  it('respeita o operador: pausa o canal e aprende o novo alvo', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    const before = snap(l, t).targetDB!;
    const change = l.onSend('i1', { ...SEND, db: -3 }, t); // operador subiu 3 dB
    expect(change).toEqual({ fromDB: -6, toDB: -3 });
    t = run(l, 'i1', -20, t, 5);
    const s = snap(l, t);
    expect(s.status).toBe('manual');
    expect(s.sendDB).toBe(-3);
    expect(s.targetDB).toBeCloseTo(before + 3, 1);
  });

  it('não confunde o eco da mesa com o operador', () => {
    const l = setup();
    l.markCommanded('i1', -7, 1000);
    expect(l.onSend('i1', { ...SEND, db: -7.1 }, 1100)).toBeUndefined();
  });

  it('restaura a mixagem original', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    t = run(l, 'i1', -12, t, 20);
    const actions = l.restoreBase();
    expect(actions).toHaveLength(1);
    expect(actions[0].toDB).toBe(-6);
  });
});
