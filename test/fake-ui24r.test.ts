import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { App, type ClientCtx } from '../src/app.js';
import type { User } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { ConnectionStore } from '../src/connection-store.js';
import { SimulatorAdapter } from '../src/mixer/simulator.js';
import { SoundcraftAdapter } from '../src/mixer/soundcraft-adapter.js';
import { PresetStore } from '../src/preset-store.js';
import { SessionLog } from '../src/session-log.js';
import { StateStore } from '../src/state-store.js';
import type { SendInfo } from '../src/mixer/types.js';

/**
 * "Ui24R falsa": um servidor WebSocket que fala o protocolo da mesa (mensagens "3:::SETD^chave^valor").
 * Testa o MESMO código que conversa com a mesa de verdade (SoundcraftAdapter + biblioteca),
 * sem precisar estar na igreja.
 */
class FakeUi24R {
  readonly wss: WebSocketServer;
  readonly received: string[] = [];
  readonly state = new Map<string, string>([
    ['SETS^model', 'ui24'],
    ['SETS^firmware', '3.3.8293-ui24'],
    ['SETS^i.0.name', 'Pastor'],
    ['SETS^i.1.name', 'Violão'],
    ['SETD^i.0.mix', '0.7'],
    ['SETD^i.0.mute', '0'],
    ['SETD^i.0.pan', '0.5'],
    ['SETD^i.0.aux.6.value', '0.5'],
    ['SETD^i.0.aux.6.mute', '0'],
    ['SETD^i.0.aux.6.post', '0'],
    ['SETD^i.0.aux.6.postproc', '1'],
    ['SETD^i.0.aux.8.value', '0.5'],
    ['SETD^i.0.aux.8.mute', '0'],
    ['SETD^a.6.stereoIndex', '0'],
    ['SETD^a.7.stereoIndex', '1'],
    ['SETD^hw.0.gain', '0.5'],
    ['SETD^hw.0.phantom', '0'],
    ['SETD^i.0.eq.b1.gain', '0.5'],
    ['SETD^i.0.eq.b1.freq', '0.3'],
    // controle de acesso (nome de chave ilustrativo: a mesa real será conferida com o diagnóstico)
    ['SETS^settings.access.masterpass', 'louvor123'],
  ]);
  /** true = mesa "trancada": recebe os comandos mas não aplica nem repassa */
  locked = false;

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => {
      // como a mesa faz: um "3:::" na frente de um lote de linhas
      ws.send(`3:::${[...this.state].map(([k, v]) => `${k}^${v}`).join('\n')}`);
      ws.on('message', (data) => this.onMessage(ws, String(data)));
    });
  }

  get address(): string {
    return `127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  private onMessage(from: WebSocket, raw: string): void {
    const msg = raw.startsWith('3:::') ? raw.slice(4) : raw;
    if (msg === 'ALIVE') return;
    this.received.push(msg);
    if (this.locked || !/^SET[DS]\^/.test(msg)) return;
    const [type, key, value] = msg.split('^');
    this.state.set(`${type}^${key}`, value);
    // a mesa avisa TODOS os aparelhos conectados (inclusive a página da mesa)
    for (const client of this.wss.clients) if (client !== from) client.send(`3:::${msg}`);
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await wait(25);
  }
}

let mesa: FakeUi24R;
let adapter: SoundcraftAdapter;

beforeAll(async () => {
  mesa = new FakeUi24R();
  await new Promise((r) => mesa.wss.once('listening', r));
  adapter = new SoundcraftAdapter(mesa.address);
});

afterAll(async () => {
  if (adapter) await Promise.race([adapter.disconnect(), wait(2000)]);
  await mesa?.close();
});

describe('mesa real pela rede (SoundcraftAdapter contra uma Ui24R falsa)', () => {
  it('conecta, lê modelo, firmware, nomes e o link estéreo AUX 7+8', async () => {
    const names = new Map<string, string>();
    adapter.onChannelName((k, n) => names.set(k, n));
    const info = await adapter.connect();
    expect(info.model).toBe('ui24');
    expect(info.firmware).toContain('3.3');
    expect(info.auxCount).toBe(10);
    expect(adapter.listChannels().filter((c) => c.kind === 'i')).toHaveLength(24);
    await until(() => names.get('i1') === 'Pastor');
    const buses = adapter.listBuses();
    expect(buses.find((b) => b.id === 7)?.linkedWith).toBe(8);
    expect(buses.find((b) => b.id === 8)?.linkedWith).toBe(7);
  });

  it('lê o envio do canal 1 para o AUX 7 e manda as mudanças com as chaves certas', async () => {
    let send: SendInfo | undefined;
    adapter.watchSend(7, 'i1', (s) => (send = s));
    await until(() => send);
    expect(Number.isFinite(send!.db)).toBe(true);
    expect(send!.muted).toBe(false);

    mesa.received.length = 0;
    adapter.setSendDB(7, 'i1', -10);
    adapter.setSendMute(7, 'i1', true);
    adapter.setGainDB('i1', 30);
    adapter.setEqRaw('i1', 'b1.gain', 0.6);
    await until(() => mesa.received.length >= 4);
    await wait(100);
    const keys = mesa.received.map((m) => m.split('^').slice(0, 2).join('^'));
    expect(keys).toContain('SETD^i.0.aux.6.value'); // AUX 7 = índice 6
    expect(keys).toContain('SETD^i.0.aux.7.value'); // par estéreo: a biblioteca manda no AUX 8 também
    expect(keys).toContain('SETD^i.0.aux.6.mute');
    expect(keys).toContain('SETD^hw.0.gain');
    expect(keys).toContain('SETD^i.0.eq.b1.gain');
  });

  it('EQ: só mostra o que a mesa informou', async () => {
    let raw: Record<string, number> = {};
    adapter.watchEq('i1', (r) => (raw = r));
    await until(() => raw['b1.freq'] !== undefined);
    expect(raw['b1.freq']).toBeCloseTo(0.3);
  });

  it('senha (Access): a conexão de controle não pede senha; o Copiloto só compara com o que a mesa informa', () => {
    const st = adapter.accessState();
    expect(st.found).toBe(true);
    expect(st.passwords).toContain('louvor123');
  });

  it('saúde: conta só o que CHEGA da mesa, não o que o Copiloto envia', async () => {
    let count = 0;
    adapter.onRawMessage(() => count++);
    mesa.locked = true; // a mesa não responde nada
    adapter.setSendDB(7, 'i1', -12);
    await wait(300);
    mesa.locked = false;
    expect(count).toBe(0);
  });

  it('teste de comando: mesa aceita → OK; mesa trancada → FALHOU (e o valor volta ao original)', async () => {
    const ok = await adapter.testWrite();
    expect(ok.ok).toBe(true);
    expect(ok.ms).toBeLessThan(3000);
    expect(Number(mesa.state.get('SETD^i.0.pan'))).toBeCloseTo(0.5, 6); // voltou

    mesa.locked = true;
    const blocked = await adapter.testWrite();
    mesa.locked = false;
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain('bloqueando');
  }, 15000);
});

describe('programa inteiro com a mesa real pela rede (Ui24R falsa)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copiloto-mesa-'));
  const admin: ClientCtx = { user: { id: 1, username: 'admin', role: 'admin', buses: [], prefs: {}, createdAt: 0 } as User, view: { bus: 7 } };
  let fake: FakeUi24R;
  let app: App;

  beforeAll(async () => {
    fake = new FakeUi24R();
    await new Promise((r) => fake.wss.once('listening', r));
    const profile = (n: string) => ({ store: new StateStore(join(dir, `e-${n}.json`)), presets: new PresetStore(join(dir, `p-${n}.json`)) });
    const connStore = new ConnectionStore(join(dir, 'conexao.json'));
    app = new App(
      { ...loadConfig(), streamAuxes: [7], safeBuses: undefined }, // a mesa falsa usa o par 7+8 como live
      {
        kind: 'mesa',
        ip: fake.address,
        create: (kind, ip) => (kind === 'simulador' ? new SimulatorAdapter() : new SoundcraftAdapter(ip)),
        profiles: { mesa: profile('mesa'), simulador: profile('sim') },
        dataDir: dir,
      },
      new SessionLog(join(dir, 'sessoes'), 'teste'),
      connStore,
    );
    await app.start();
  });

  afterAll(async () => {
    await Promise.race([app.stop(), wait(3000)]);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('conecta, monta a saída AUX 7+8 e começa em "Só sugerir" (não mexe sozinho)', async () => {
    const snap = await until(() => {
      const s = app.snapshotFor(admin);
      return s.connection === 'conectado' && s.bus ? s : undefined;
    }, 8000);
    expect(snap.source.kind).toBe('mesa');
    expect(snap.bus!.label).toBe('AUX 7+8');
    expect(snap.bus!.mode).toBe('observar');
    expect(snap.buses.some((b) => b.id === 8)).toBe(false); // o par aparece uma vez só
  });

  it('teste de comando roda sozinho ao conectar e dá OK', async () => {
    const wt = await until(() => app.snapshotFor(admin).access.writeTest, 10000);
    expect(wt.ok).toBe(true);
  }, 15000);

  it('flag "a mesa tem senha": confere com a senha que a mesa informa (sem mandar nada para a mesa)', async () => {
    const before = fake.received.length;
    expect(app.snapshotFor(admin).access.check).toBe('mesa-tem-senha'); // a mesa tem senha e a flag está desligada
    app.handle({ type: 'conn.access', enabled: true, password: 'errada' }, admin);
    expect(app.snapshotFor(admin).access.check).toBe('nao-confere');
    app.handle({ type: 'conn.access', enabled: true, password: 'louvor123' }, admin);
    const acc = app.snapshotFor(admin).access;
    expect(acc.check).toBe('confere');
    expect(JSON.stringify(acc)).not.toContain('louvor123'); // a senha nunca vai para a tela
    expect(fake.received.slice(before).some((m) => m.includes('louvor123'))).toBe(false); // nem para a mesa
    // fica guardada em data/conexao.json (fora do git) para a próxima vez
    expect(new ConnectionStore(join(dir, 'conexao.json')).loadAccess()).toEqual({ enabled: true, password: 'louvor123' });
  });

  it('fader do painel e mute chegam na mesa com as chaves do AUX 7 (e do par AUX 8)', async () => {
    fake.received.length = 0;
    app.handle({ type: 'setSend', bus: 7, key: 'i1', db: -6 }, admin);
    app.handle({ type: 'setMute', bus: 7, key: 'i1', muted: true }, admin);
    await until(() => fake.received.length >= 3);
    await wait(100);
    const keys = fake.received.map((m) => m.split('^')[1]);
    expect(keys).toEqual(expect.arrayContaining(['i.0.aux.6.value', 'i.0.aux.7.value', 'i.0.aux.6.mute']));
    app.handle({ type: 'setMute', bus: 7, key: 'i1', muted: false }, admin);
  });

  it('BYPASS (pânico): nada chega na mesa, nem pelo painel nem por dentro do programa; e sobrevive a reinício', async () => {
    const operador: ClientCtx = { user: { id: 2, username: 'op', role: 'operador', buses: [7], prefs: {}, createdAt: 0 } as User, view: { bus: 7 } };
    await wait(300);
    fake.received.length = 0;
    app.handle({ type: 'bypass', on: true }, operador); // qualquer pessoa pode ligar o pânico
    const snap = app.snapshotFor(admin);
    expect(snap.bypass.on).toBe(true);
    expect(snap.bypass.by).toBe('op');

    // pelo painel: recusado com explicação
    for (const cmd of [
      { type: 'setSend', bus: 7, key: 'i1', db: -3 },
      { type: 'setMute', bus: 7, key: 'i1', muted: true },
      { type: 'setEq', key: 'i1', param: 'b1.gain', value: 3 },
      { type: 'setGain', key: 'i1', db: 20 },
      { type: 'setBusMaster', bus: 7, db: -5 },
      { type: 'restore', bus: 7 },
      { type: 'conn.writeTest' },
    ] as const) {
      expect(() => app.handle(cmd as never, admin)).toThrow(/BYPASS/);
    }
    // por dentro: mesmo chamando a conexão direto, a trava descarta
    const internal = (app as unknown as { adapter: SoundcraftAdapter }).adapter;
    internal.setSendDB(7, 'i1', -20);
    internal.setSendMute(7, 'i1', true);
    internal.setGainDB('i1', 50);
    expect((await internal.testWrite()).detail).toContain('bypass');
    // o que não mexe na mesa continua valendo (monitorar, gravar o volume ideal, trocar de modo)
    app.handle({ type: 'capture', bus: 7 }, admin);
    app.handle({ type: 'setMode', bus: 7, mode: 'automatico' }, admin);
    await wait(1500); // ticks do ajuste automático rodando
    expect(fake.received).toEqual([]);
    expect(app.snapshotFor(admin).bypass.blocked).toBeGreaterThanOrEqual(4);

    // reinício: continua em bypass
    expect(new ConnectionStore(join(dir, 'conexao.json')).loadBypass().on).toBe(true);

    // desligar: volta a mandar
    app.handle({ type: 'setMode', bus: 7, mode: 'observar' }, admin);
    app.handle({ type: 'bypass', on: false }, admin);
    app.handle({ type: 'setSend', bus: 7, key: 'i1', db: -6 }, admin);
    await until(() => fake.received.some((m) => m.startsWith('SETD^i.0.aux.6.value')));
    expect(new ConnectionStore(join(dir, 'conexao.json')).loadBypass().on).toBe(false);
  });

  it('BYPASS com exceção no AUX 9 (fone): só os envios do AUX 9 chegam na mesa; o resto continua bloqueado', async () => {
    app.handle({ type: 'bypass', on: true }, admin);
    app.handle({ type: 'bypass.allow', bus: 9 }, admin);
    expect(app.snapshotFor(admin).bypass.allowLabels).toEqual(['AUX 9']);
    expect(() => app.handle({ type: 'bypass.allow', bus: 0 }, admin)).toThrow(/master/);
    await wait(300);
    fake.received.length = 0;

    app.handle({ type: 'setSend', bus: 9, key: 'i1', db: -8 }, admin); // liberado
    app.handle({ type: 'setMute', bus: 9, key: 'i1', muted: false }, admin); // liberado
    for (const cmd of [
      { type: 'setSend', bus: 7, key: 'i1', db: -3 }, // outra saída
      { type: 'setSend', bus: 0, key: 'i1', db: -3 }, // salão
      { type: 'setEq', key: 'i1', param: 'b1.gain', value: 3 }, // canal inteiro
      { type: 'setGain', key: 'i1', db: 20 },
    ] as const) {
      expect(() => app.handle(cmd as never, admin)).toThrow(/BYPASS/);
    }
    const internal = (app as unknown as { adapter: SoundcraftAdapter }).adapter;
    internal.setSendDB(7, 'i1', -20); // por dentro, outra saída: barrado
    internal.setFxSendDB(1, 'i1', -10); // envio para efeito (salão+live): barrado
    await until(() => fake.received.length >= 2);
    await wait(300);
    const keys = fake.received.map((m) => m.split('^')[1]);
    expect(keys.every((k) => k.startsWith('i.0.aux.8.'))).toBe(true); // AUX 9 = índice 8
    expect(keys).toContain('i.0.aux.8.value');

    // a exceção some quando o bypass é desligado e ligado de novo
    app.handle({ type: 'bypass', on: false }, admin);
    app.handle({ type: 'bypass', on: true }, admin);
    expect(app.snapshotFor(admin).bypass.allow).toEqual([]);
    expect(() => app.handle({ type: 'setSend', bus: 9, key: 'i1', db: -8 }, admin)).toThrow(/BYPASS/);
    app.handle({ type: 'bypass', on: false }, admin);
  });
});
