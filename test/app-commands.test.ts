import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App, type ClientCtx, CommandError } from '../src/app.js';
import type { User } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { ConnectionStore } from '../src/connection-store.js';
import { SimulatorAdapter } from '../src/mixer/simulator.js';
import { PresetStore } from '../src/preset-store.js';
import { SessionLog } from '../src/session-log.js';
import { StateStore } from '../src/state-store.js';

const dir = mkdtempSync(join(tmpdir(), 'copiloto-app-'));
let app: App;

const user = (role: User['role'], buses: number[]): User => ({ id: 1, username: role, role, buses, prefs: {}, createdAt: 0 });
const admin: ClientCtx = { user: user('admin', []), view: { bus: 7 } };
const operador: ClientCtx = { user: user('operador', [7]), view: { bus: 7 } };

async function until<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  const profile = () => ({ store: new StateStore(join(dir, `e-${Math.random()}.json`)), presets: new PresetStore(join(dir, `p-${Math.random()}.json`)) });
  app = new App(
    { ...loadConfig(), safeBuses: undefined }, // sem travas de risco: testa os comandos em si
    { kind: 'simulador', ip: 'simulador', create: () => new SimulatorAdapter(), profiles: { mesa: profile(), simulador: profile() }, dataDir: dir },
    new SessionLog(join(dir, 'sessoes'), 'teste'),
    new ConnectionStore(join(dir, 'conexao.json')),
  );
  await app.start();
  await until(() => app.snapshotFor(admin).connection === 'conectado' && app.snapshotFor(admin).bus);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('comandos novos: mute, EQ e volume ideal pelo tipo', () => {
  it('mute na saída vista aparece na faixa e pode ser desfeito', async () => {
    app.handle({ type: 'setMute', bus: 7, key: 'i3', muted: true }, operador);
    await until(() => app.snapshotFor(operador).bus?.channels.find((c) => c.key === 'i3')?.muted);
    app.handle({ type: 'setMute', bus: 7, key: 'i3', muted: false }, operador);
    await until(() => app.snapshotFor(operador).bus?.channels.find((c) => c.key === 'i3')?.muted === false || undefined);
  });

  it('EQ: operador sem master não mexe; admin mexe e a janela do canal mostra o valor', async () => {
    expect(() => app.handle({ type: 'setEq', key: 'i1', param: 'b2.gain', value: 6 }, operador)).toThrow(CommandError);
    app.handle({ type: 'setEq', key: 'i1', param: 'b2.gain', value: 6 }, admin);
    app.handle({ type: 'view', detail: 'i1' }, admin);
    const eq = await until(() => {
      const d = app.snapshotFor(admin).detail;
      return d?.eq && Math.abs(d.eq.bands[1].gainDB - 6) < 0.2 ? d.eq : undefined;
    });
    expect(eq.allowed).toBe(true);
    expect(app.snapshotFor(admin).detail?.identified?.type).toBe('voz'); // "Pastor", pelo nome
    expect(() => app.handle({ type: 'setEq', key: 'i1', param: 'b9.gain', value: 1 }, admin)).toThrow(CommandError);
  });

  it('volume ideal pelo tipo: voz principal é a referência e o bumbo fica 6 dB abaixo', async () => {
    app.handle({ type: 'sim.scene', scene: 'louvor' }, admin);
    const chans = await until(() => {
      const c = app.snapshotFor(operador).bus?.channels ?? [];
      const ready = ['i2', 'i9'].every((k) => c.find((x) => x.key === k)?.contributionDB !== undefined);
      return ready ? c : undefined;
    });
    expect(chans.length).toBeGreaterThan(0);
    app.handle({ type: 'suggestTargets', bus: 7 }, operador);
    const after = app.snapshotFor(operador).bus!.channels;
    const ministro = after.find((c) => c.key === 'i2')!; // "Ministro" = voz principal
    const bumbo = after.find((c) => c.key === 'i9')!;
    expect(ministro.targetDB).toBeDefined();
    expect(bumbo.targetDB).toBeCloseTo(ministro.targetDB! - 6, 1);
  });
});

describe('saídas testadas (safeBuses): o resto fica travado com aviso de risco', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'copiloto-risco-'));
  let app2: App;
  const ctx = (): ClientCtx => ({ user: user('admin', []), view: { bus: 7 } });

  beforeAll(async () => {
    const profile = () => ({ store: new StateStore(join(dir2, `e-${Math.random()}.json`)), presets: new PresetStore(join(dir2, `p-${Math.random()}.json`)) });
    app2 = new App(
      { ...loadConfig(), streamAuxes: [8], safeBuses: [8, 9] }, // "8" = o par 7+8 inteiro
      { kind: 'simulador', ip: 'simulador', create: () => new SimulatorAdapter(), profiles: { mesa: profile(), simulador: profile() }, dataDir: dir2 },
      new SessionLog(join(dir2, 'sessoes'), 'teste'),
      new ConnectionStore(join(dir2, 'conexao.json')),
    );
    await app2.start();
    const c = ctx();
    await until(() => app2.snapshotFor(c).connection === 'conectado' && app2.snapshotFor(c).bus);
  });

  afterAll(async () => {
    await app2.stop();
    rmSync(dir2, { recursive: true, force: true });
  });

  it('live e fone liberados; outro aux, master, EQ e ganho pedem "Liberar (risco)" (10 min, por pessoa)', () => {
    const a = ctx();
    app2.handle({ type: 'setSend', bus: 7, key: 'i1', db: -5 }, a); // live: ok
    app2.handle({ type: 'setMute', bus: 9, key: 'i1', muted: false }, a); // fone: ok
    expect(() => app2.handle({ type: 'setSend', bus: 1, key: 'i1', db: -5 }, a)).toThrow(/Liberar \(risco\)/);
    expect(() => app2.handle({ type: 'setSend', bus: 0, key: 'i1', db: -5 }, a)).toThrow(/Liberar \(risco\)/);
    expect(() => app2.handle({ type: 'setMode', bus: 1, mode: 'automatico' }, a)).toThrow(/Liberar/);
    app2.handle({ type: 'setMode', bus: 1, mode: 'observar' }, a); // só sugerir não mexe: liberado
    expect(() => app2.handle({ type: 'setGain', key: 'i1', db: 30 }, a)).toThrow(/canal inteiro/);
    expect(app2.snapshotFor(a).safety.safeLabels).toEqual(['AUX 7+8', 'AUX 9']);
    expect(app2.snapshotFor(a).safety.safeBuses).toEqual([7, 9]);

    app2.handle({ type: 'risk.ack', scope: 'bus:1' }, a);
    app2.handle({ type: 'setSend', bus: 1, key: 'i1', db: -5 }, a); // liberado com aviso
    expect(app2.snapshotFor(a).safety.acks.map((x) => x.scope)).toEqual(['bus:1']);
    const b = ctx(); // outra pessoa: continua travado para ela
    expect(() => app2.handle({ type: 'setSend', bus: 1, key: 'i1', db: -5 }, b)).toThrow(/Liberar/);
    app2.handle({ type: 'risk.release' }, a);
    expect(() => app2.handle({ type: 'setSend', bus: 1, key: 'i1', db: -5 }, a)).toThrow(/Liberar/);
  });
});
