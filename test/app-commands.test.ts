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
    loadConfig(),
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
