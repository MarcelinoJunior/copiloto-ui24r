import type { AppConfig } from './config.js';
import { AuxLeveler, type ChannelSnapshot, type Mode, type SendAction } from './leveler/aux-leveler.js';
import type { ConnectionState, MixerAdapter, MixerInfo } from './mixer/types.js';
import { SimulatorAdapter, type Scene } from './mixer/simulator.js';
import type { SessionLog } from './session-log.js';
import type { StateStore } from './state-store.js';
import { round1 } from './util/db.js';

export interface EventEntry {
  t: number;
  text: string;
}

export interface AppSnapshot {
  connection: ConnectionState;
  connectionDetail?: string;
  mixer?: MixerInfo;
  mode: Mode;
  deadbandDB: number;
  auxes: { aux: number; name: string; outDB?: number; channels: ChannelSnapshot[] }[];
  events: EventEntry[];
  sim?: { scene: Scene; offsets: Record<string, number> };
}

export type Command =
  | { type: 'setMode'; mode: Mode }
  | { type: 'capture'; aux?: number }
  | { type: 'restore' }
  | { type: 'setEnabled'; aux: number; key: string; enabled: boolean }
  | { type: 'nudgeTarget'; aux: number; key: string; delta: number }
  | { type: 'clearTarget'; aux: number; key: string }
  | { type: 'sim.scene'; scene: Scene }
  | { type: 'sim.source'; key: string; delta: number }
  | { type: 'sim.reset' }
  | { type: 'sim.operator'; aux: number; key: string; delta: number };

const MAX_EVENTS = 60;
const LEVEL_LOG_EVERY_MS = 2000;
const CONNECT_TIMEOUT_MS = 10000;
const RETRY_MS = 5000;

/** Liga a mesa (real ou simulada), os niveladores, a persistência e o log do culto. */
export class App {
  private readonly levelers: AuxLeveler[];
  private mode: Mode;
  private connection: ConnectionState = 'conectando';
  private connectionDetail?: string;
  private mixer?: MixerInfo;
  private readonly events: EventEntry[] = [];
  private wired = false;
  private dirty = false;
  private lastLevelLog = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly adapter: MixerAdapter,
    private readonly store: StateStore,
    private readonly log: SessionLog,
  ) {
    this.mode = cfg.initialMode;
    this.levelers = cfg.streamAuxes.map((aux) => new AuxLeveler(aux, cfg.leveler));
    this.levelers.forEach((l) => l.setMode(this.mode));
    adapter.onStatus((state, detail) => {
      if (state !== this.connection) this.event(`Mesa: ${state}${detail ? ` (${detail})` : ''}`);
      this.connection = state;
      this.connectionDetail = detail;
    });
  }

  async start(): Promise<void> {
    this.log.write('inicio', { mode: this.mode, auxes: this.cfg.streamAuxes, leveler: this.cfg.leveler });
    this.timers.push(setInterval(() => this.tick(), this.cfg.leveler.tickMs));
    this.timers.push(setInterval(() => this.persistIfDirty(), 5000));
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.persistIfDirty();
    this.log.write('fim', {});
    await this.adapter.disconnect().catch(() => undefined);
    await this.log.close();
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.connection = 'conectando';
        const info = await withTimeout(this.adapter.connect(), CONNECT_TIMEOUT_MS);
        this.mixer = info;
        this.connection = 'conectado';
        this.event(`Conectado: ${info.model} em ${info.address} (firmware ${info.firmware})`);
        this.log.write('mesa', { ...info });
        this.wire();
        return;
      } catch (err) {
        this.connection = 'erro';
        this.connectionDetail = err instanceof Error ? err.message : String(err);
        this.event(`Não consegui conectar na mesa (${this.connectionDetail}). Tentando de novo em 5 s…`);
        await this.adapter.disconnect().catch(() => undefined);
        await sleep(RETRY_MS);
      }
    }
  }

  /** Assina VU e envios. Feito uma vez só: a biblioteca mantém as assinaturas entre reconexões. */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    const persisted = this.store.load();

    for (const leveler of this.levelers) {
      const saved = persisted.auxes[String(leveler.aux)] ?? {};
      for (const ch of this.adapter.listChannels()) {
        leveler.ensureChannel(ch.key, ch.name, saved[ch.key]);
        this.adapter.watchSend(leveler.aux, ch.key, (info) => {
          const change = leveler.onSend(ch.key, info, Date.now());
          if (!change) return;
          this.dirty = true;
          const name = leveler.channelName(ch.key);
          this.event(`Operador mexeu em ${name} (aux ${leveler.aux}): ${fmt(change.fromDB)} → ${fmt(change.toDB)} dB`);
          this.log.write('operador', { aux: leveler.aux, key: ch.key, ...change });
        });
      }
    }

    this.adapter.onChannelName((key, name) => this.levelers.forEach((l) => l.setName(key, name)));

    this.adapter.onVu((frame) => {
      for (const leveler of this.levelers) {
        for (const [key, vu] of frame.channels) leveler.onVu(key, vu, frame.t);
        leveler.auxOutDB = frame.auxOut.get(leveler.aux);
      }
    });
  }

  private tick(): void {
    if (!this.wired) return;
    const now = Date.now();
    for (const leveler of this.levelers) this.apply(leveler, leveler.tick(now), now);

    if (now - this.lastLevelLog >= LEVEL_LOG_EVERY_MS) {
      this.lastLevelLog = now;
      for (const leveler of this.levelers) {
        const active = leveler
          .snapshot(now)
          .filter((c) => c.status !== 'silencio' && c.status !== 'sem-envio' && c.status !== 'desabilitado')
          .map((c) => [c.key, c.levelDB, c.sendDB, c.targetDB, c.status]);
        this.log.write('niveis', { aux: leveler.aux, mode: this.mode, out: leveler.auxOutDB, ch: active });
      }
    }
  }

  private apply(leveler: AuxLeveler, actions: SendAction[], now: number): void {
    for (const a of actions) {
      // Marca antes de enviar: a mesa (e o simulador) podem devolver o eco na hora.
      leveler.markCommanded(a.key, a.toDB, now);
      this.adapter.setSendDB(a.aux, a.key, a.toDB);
      this.log.write('envio', { ...a });
    }
  }

  handle(cmd: Command): void {
    const now = Date.now();
    const leveler = 'aux' in cmd && cmd.aux !== undefined ? this.levelers.find((l) => l.aux === cmd.aux) : undefined;

    switch (cmd.type) {
      case 'setMode':
        if (!['desligado', 'observar', 'automatico'].includes(cmd.mode)) return;
        this.mode = cmd.mode;
        this.levelers.forEach((l) => l.setMode(cmd.mode));
        this.event(`Modo: ${cmd.mode}`);
        this.log.write('modo', { mode: cmd.mode });
        break;
      case 'capture': {
        const targets = cmd.aux === undefined ? this.levelers : this.levelers.filter((l) => l.aux === cmd.aux);
        for (const l of targets) {
          const n = l.captureTargets(now);
          this.event(`Mixagem atual do aux ${l.aux} gravada como alvo (${n} canais)`);
          this.log.write('captura', { aux: l.aux, canais: n, alvos: l.exportPersisted() });
        }
        this.dirty = true;
        break;
      }
      case 'restore':
        for (const l of this.levelers) {
          const actions = l.restoreBase();
          this.apply(l, actions, now);
          this.event(`Envios do aux ${l.aux} voltaram para a mixagem original (${actions.length} canais)`);
        }
        break;
      case 'setEnabled':
        leveler?.setEnabled(cmd.key, cmd.enabled);
        this.dirty = true;
        break;
      case 'nudgeTarget':
        leveler?.nudgeTarget(cmd.key, clampDelta(cmd.delta));
        this.dirty = true;
        break;
      case 'clearTarget':
        leveler?.setTarget(cmd.key, undefined);
        this.dirty = true;
        break;
      case 'sim.scene':
        this.sim()?.setScene(cmd.scene);
        this.event(`[simulador] Momento: ${cmd.scene}`);
        break;
      case 'sim.source':
        this.sim()?.changeSource(cmd.key, clampDelta(cmd.delta));
        this.event(`[simulador] ${cmd.key}: fonte ${cmd.delta > 0 ? '+' : ''}${cmd.delta} dB`);
        break;
      case 'sim.reset':
        this.sim()?.resetSources();
        break;
      case 'sim.operator': {
        // simula o operador mexendo no envio direto na mesa (não passa pelo nivelador)
        const sim = this.sim();
        const ch = leveler?.snapshot(now).find((c) => c.key === cmd.key);
        if (sim && ch?.sendDB !== undefined) sim.setSendDB(cmd.aux, cmd.key, ch.sendDB + clampDelta(cmd.delta));
        break;
      }
    }
  }

  snapshot(): AppSnapshot {
    const now = Date.now();
    return {
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      mixer: this.mixer,
      mode: this.mode,
      deadbandDB: this.cfg.leveler.deadbandDB,
      auxes: this.levelers.map((l) => ({
        aux: l.aux,
        name: this.adapter.auxName(l.aux),
        outDB: l.auxOutDB === undefined ? undefined : round1(l.auxOutDB),
        channels: l.snapshot(now),
      })),
      events: this.events.slice(-MAX_EVENTS).reverse(),
      sim: this.sim()?.simState(),
    };
  }

  private sim(): SimulatorAdapter | undefined {
    return this.adapter instanceof SimulatorAdapter ? this.adapter : undefined;
  }

  private event(text: string): void {
    this.events.push({ t: Date.now(), text });
    if (this.events.length > MAX_EVENTS * 2) this.events.splice(0, MAX_EVENTS);
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${text}`);
  }

  private persistIfDirty(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const state = { auxes: Object.fromEntries(this.levelers.map((l) => [String(l.aux), l.exportPersisted()])) };
    this.store.save(state);
  }
}

function fmt(db: number): string {
  return Number.isFinite(db) ? db.toFixed(1) : '-∞';
}

function clampDelta(delta: number): number {
  return Number.isFinite(delta) ? Math.max(-12, Math.min(12, delta)) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sem resposta em ${ms / 1000} s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
