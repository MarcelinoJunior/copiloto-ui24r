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

  it('preset: aplica alvos e limites, e pausa durante o fade', () => {
    const l = setup();
    let t = run(l, 'i1', -20, 0, 5);
    l.applyPreset({ i1: { sendDB: -2, targetDB: -22 } });
    l.holdForTransition('i1', t + 3000);
    l.tick(t);
    expect(snap(l, t).status).toBe('transicao');
    expect(snap(l, t).targetDB).toBe(-22);
    expect(snap(l, t).baseSendDB).toBe(-2);
    expect(l.exportPreset().i1).toEqual({ sendDB: -6, targetDB: -22 });
  });

  it('aprende com o operador mesmo com o modo desligado', () => {
    const l = setup();
    l.setMode('desligado');
    const t = run(l, 'i1', -20, 0, 5);
    l.captureTargets(t);
    l.onSend('i1', { ...SEND, db: -2 }, t);
    expect(snap(l, t).targetDB).toBeCloseTo(-22, 1);
    expect(snap(l, t).manualForSec).toBe(0);
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

/**
 * Culto de 15/11: JAQUE com o envio da live esquecido em -34 dB, 16 dB abaixo do MINISTRO
 * (peso = nível + envio). A voz soou "debaixo d'água" na transmissão.
 */
describe('voz sumida na live', () => {
  const levels: Record<string, number> = { i3: -22, i20: -16, i15: -16 };
  const sends: Record<string, number> = { i3: -12, i20: -34, i15: -45 };

  function church(mode: 'automatico' | 'observar' = 'automatico') {
    const l = new AuxLeveler(5, { ...DEFAULT_LEVELER, averagingSec: 4 });
    l.setMode(mode);
    l.ensureChannel('i3', 'MINISTRO');
    l.ensureChannel('i20', 'JAQUE');
    l.ensureChannel('i15', 'CAIXA');
    for (const [k, db] of Object.entries(sends)) l.onSend(k, { ...SEND, db }, 0);
    l.setVoices(['i3', 'i20']);
    return l;
  }

  /** Todos os canais tocando; aplica as ações como a mesa faria. */
  function play(l: AuxLeveler, fromMs: number, seconds: number) {
    let t = fromMs;
    const end = fromMs + seconds * 1000;
    while (t < end) {
      for (let i = 0; i < 10; i++) {
        t += 50;
        for (const [k, db] of Object.entries(levels)) l.onVu(k, vu(db), t);
      }
      for (const a of l.tick(t)) {
        l.markCommanded(a.key, a.toDB, t);
        l.onSend(a.key, { ...SEND, db: a.toDB }, t);
      }
    }
    return t;
  }

  const send = (l: AuxLeveler, key: string, t: number) => l.snapshot(t).find((c) => c.key === key)!.sendDB!;

  it('voz 16 dB abaixo da voz mais alta: ganha volume ideal e sobe além do limite normal', () => {
    const l = church();
    let t = play(l, 0, 8);
    expect(l.takeRescueNotices()).toHaveLength(0); // ainda não: precisa ficar baixa por 10 s
    t = play(l, t, 10);
    const notices = l.takeRescueNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: 'i20', refKey: 'i3', toTargetDB: -42 }); // MINISTRO -34 menos 8
    expect(notices[0].belowDB).toBeCloseTo(16, 0);
    t = play(l, t, 40);
    // -34 → ~-26 (+8 dB; para a <1 dB do alvo): passa dos +4 dB que o ajuste normal permitiria
    expect(send(l, 'i20', t)).toBeGreaterThan(-27.1);
    expect(send(l, 'i20', t)).toBeLessThanOrEqual(-26);
    expect(l.snapshot(t).find((c) => c.key === 'i20')!.rescued).toBe(true);
    // a caixa também está baixa, mas não é voz: não mexe
    expect(send(l, 'i15', t)).toBe(-45);
    expect(l.takeRescueNotices()).toHaveLength(0); // avisa uma vez só
  });

  it('em "Só sugerir": não mexe na mesa, só mostra quanto subiria', () => {
    const l = church('observar');
    const t = play(l, 0, 20);
    expect(l.takeRescueNotices()).toHaveLength(1);
    const j = l.snapshot(t).find((c) => c.key === 'i20')!;
    expect(j.sendDB).toBe(-34);
    expect(j.suggestedDeltaDB).toBeCloseTo(8, 0);
  });

  it('o operador mexeu na voz na live: a regra respeita por 10 minutos', () => {
    const l = church();
    let t = play(l, 0, 2);
    l.onSend('i20', { ...SEND, db: -33 }, t); // operador (sem markCommanded)
    t = play(l, t, 60);
    expect(l.takeRescueNotices()).toHaveLength(0);
    t = play(l, t, 600);
    expect(l.takeRescueNotices()).toHaveLength(1);
  });

  it('sem outra voz tocando (ou fora da live): nada muda', () => {
    const l = church();
    l.setVoices(['i20']);
    const t = play(l, 0, 30);
    expect(l.takeRescueNotices()).toHaveLength(0);
    expect(send(l, 'i20', t)).toBe(-34);
  });
});
