import type { AppConfig } from './config.js';
import { AuxLeveler, type ChannelSnapshot, type Mode, type SendAction } from './leveler/aux-leveler.js';
import { FxFollower, type FxSnapshot } from './leveler/fx-follower.js';
import type { ConnectionState, MixerAdapter, MixerInfo } from './mixer/types.js';
import { SimulatorAdapter, type Scene } from './mixer/simulator.js';
import type { PresetStore } from './preset-store.js';
import type { SessionLog } from './session-log.js';
import type { StateStore } from './state-store.js';
import { round1 } from './util/db.js';

export interface EventEntry {
  t: number;
  text: string;
  /** eventos com a mesma chave em sequência são agrupados (ex.: arrastar um fader) */
  mergeKey?: string;
}

export interface AppSnapshot {
  connection: ConnectionState;
  connectionDetail?: string;
  mixer?: MixerInfo;
  mode: Mode;
  deadbandDB: number;
  auxes: {
    aux: number;
    name: string;
    outDB?: number;
    masterDB?: number;
    channels: ChannelSnapshot[];
    fx: FxSnapshot[];
  }[];
  presets: { id: string; name: string; savedAt: number }[];
  activePresetId?: string;
  events: EventEntry[];
  sim?: { scene: Scene; offsets: Record<string, number> };
}

/** dB vindo do painel: null representa -∞ (JSON não tem -Infinity). */
type WireDB = number | null;

export type Command =
  | { type: 'setMode'; mode: Mode }
  | { type: 'capture'; aux?: number }
  | { type: 'restore' }
  | { type: 'setEnabled'; aux: number; key: string; enabled: boolean }
  | { type: 'nudgeTarget'; aux: number; key: string; delta: number }
  | { type: 'clearTarget'; aux: number; key: string }
  | { type: 'setSend'; aux: number; key: string; db: WireDB }
  | { type: 'setAuxMaster'; aux: number; db: WireDB }
  | { type: 'setFxFollow'; aux: number; key: string; follow: boolean }
  | { type: 'preset.save'; name: string; id?: string }
  | { type: 'preset.load'; id: string }
  | { type: 'preset.delete'; id: string }
  | { type: 'sim.scene'; scene: Scene }
  | { type: 'sim.source'; key: string; delta: number }
  | { type: 'sim.reset' }
  | { type: 'sim.operator'; aux: number; key: string; delta: number };

interface Fade {
  aux: number;
  key: string;
  fromDB: number;
  toDB: number;
  start: number;
  durationMs: number;
}

const MAX_EVENTS = 60;
const EVENT_MERGE_MS = 4000;
const LEVEL_LOG_EVERY_MS = 2000;
const CONNECT_TIMEOUT_MS = 10000;
const RETRY_MS = 5000;
const FADE_STEP_MS = 100;

/** Liga a mesa (real ou simulada), os niveladores, os efeitos, os presets e o log do culto. */
export class App {
  private readonly levelers: AuxLeveler[];
  private readonly followers: FxFollower[];
  private readonly auxMaster = new Map<number, number>();
  private mode: Mode;
  private connection: ConnectionState = 'conectando';
  private connectionDetail?: string;
  private mixer?: MixerInfo;
  private readonly events: EventEntry[] = [];
  private readonly fades = new Map<string, Fade>();
  private activePresetId?: string;
  private wired = false;
  private dirty = false;
  private lastLevelLog = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly adapter: MixerAdapter,
    private readonly store: StateStore,
    private readonly presets: PresetStore,
    private readonly log: SessionLog,
  ) {
    this.mode = cfg.initialMode;
    this.levelers = cfg.streamAuxes.map((aux) => new AuxLeveler(aux, cfg.leveler));
    this.followers = cfg.streamAuxes.map((aux) => new FxFollower(aux, cfg.leveler));
    this.setModeAll(this.mode);
    adapter.onStatus((state, detail) => {
      if (state !== this.connection) this.event(`Mesa: ${state}${detail ? ` (${detail})` : ''}`);
      this.connection = state;
      this.connectionDetail = detail;
    });
  }

  async start(): Promise<void> {
    this.log.write('inicio', { mode: this.mode, auxes: this.cfg.streamAuxes, leveler: this.cfg.leveler });
    this.timers.push(setInterval(() => this.tick(), this.cfg.leveler.tickMs));
    this.timers.push(setInterval(() => this.runFades(), FADE_STEP_MS));
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
    this.activePresetId = persisted.activePresetId;
    const channels = this.adapter.listChannels();
    const fxReturns = this.adapter.listFxReturns();

    this.levelers.forEach((leveler, idx) => {
      const aux = leveler.aux;
      const follower = this.followers[idx];
      const saved = persisted.auxes[String(aux)] ?? {};
      const savedFollow = persisted.fxFollow?.[String(aux)] ?? {};

      for (const ch of channels) {
        leveler.ensureChannel(ch.key, ch.name, saved[ch.key]);
        this.adapter.watchSend(aux, ch.key, (info) => {
          const change = leveler.onSend(ch.key, info, Date.now());
          if (change) this.operatorMoved(aux, ch.key, leveler.channelName(ch.key), change);
        });
      }

      for (const fx of fxReturns) {
        follower.ensureReturn(fx.key, fx.name, savedFollow[fx.key] ?? true);
        this.adapter.watchSend(aux, fx.key, (info) => {
          const change = follower.onSend(fx.key, info, Date.now());
          if (change) this.operatorMoved(aux, fx.key, fx.name, change);
        });
        for (const ch of channels) {
          this.adapter.watchFxSend(fx.number, ch.key, (db) => follower.onFxSend(fx.key, ch.key, db));
        }
      }

      this.adapter.watchAuxMaster(aux, (db) => this.auxMaster.set(aux, db));
    });

    this.adapter.onChannelName((key, name) => {
      this.levelers.forEach((l) => l.setName(key, name));
      this.followers.forEach((f) => f.setName(key, name));
    });

    this.adapter.onVu((frame) => {
      this.levelers.forEach((leveler, idx) => {
        const follower = this.followers[idx];
        for (const [key, vu] of frame.channels) {
          if (key.startsWith('f')) follower.onVu(key, vu.post);
          else leveler.onVu(key, vu, frame.t);
        }
        leveler.auxOutDB = frame.auxOut.get(leveler.aux);
      });
    });
  }

  private operatorMoved(aux: number, key: string, name: string, change: { fromDB: number; toDB: number }): void {
    this.dirty = true;
    this.fades.delete(`${aux}:${key}`); // o operador manda: cancela fade em andamento
    this.event(`Operador: ${name} (aux ${aux}) → ${fmt(change.toDB)} dB`, `op:${aux}:${key}`);
    this.log.write('operador', { aux, key, ...change });
  }

  private tick(): void {
    if (!this.wired) return;
    const now = Date.now();
    this.levelers.forEach((leveler, idx) => {
      this.apply(leveler.tick(now));
      this.apply(this.followers[idx].tick(now, leveler.offsets(now)));
    });

    if (now - this.lastLevelLog >= LEVEL_LOG_EVERY_MS) {
      this.lastLevelLog = now;
      this.levelers.forEach((leveler, idx) => {
        const active = leveler
          .snapshot(now)
          .filter((c) => c.status !== 'silencio' && c.status !== 'sem-envio' && c.status !== 'desabilitado')
          .map((c) => [c.key, c.levelDB, c.sendDB, c.targetDB, c.status]);
        const fx = this.followers[idx].snapshot().map((f) => [f.key, f.sendDB, f.followDeltaDB, f.status]);
        this.log.write('niveis', { aux: leveler.aux, mode: this.mode, out: leveler.auxOutDB, ch: active, fx });
      });
    }
  }

  /** Manda envios para a mesa marcando-os como nossos (para o eco não parecer o operador). */
  private apply(actions: SendAction[]): void {
    const now = Date.now();
    for (const a of actions) {
      this.markCommanded(a.aux, a.key, a.toDB, now);
      this.adapter.setSendDB(a.aux, a.key, a.toDB);
      if (a.reason !== 'preset') this.log.write('envio', { ...a });
    }
  }

  private markCommanded(aux: number, key: string, db: number, now: number): void {
    const idx = this.levelers.findIndex((l) => l.aux === aux);
    if (idx < 0) return;
    if (key.startsWith('f')) this.followers[idx].markCommanded(key, db, now);
    else this.levelers[idx].markCommanded(key, db, now);
  }

  private runFades(): void {
    if (this.fades.size === 0) return;
    const now = Date.now();
    const actions: SendAction[] = [];
    for (const [id, f] of this.fades) {
      const progress = Math.min(1, (now - f.start) / f.durationMs);
      let db: number;
      if (progress >= 1) db = f.toDB;
      else if (!Number.isFinite(f.fromDB) || !Number.isFinite(f.toDB)) continue; // abre/fecha no fim do fade
      else db = round1(f.fromDB + (f.toDB - f.fromDB) * easeInOut(progress));
      actions.push({ aux: f.aux, key: f.key, fromDB: f.fromDB, toDB: db, reason: 'preset' });
      if (progress >= 1) this.fades.delete(id);
    }
    this.apply(actions);
  }

  handle(cmd: Command): void {
    const now = Date.now();
    const auxIdx = 'aux' in cmd && cmd.aux !== undefined ? this.levelers.findIndex((l) => l.aux === cmd.aux) : -1;
    const leveler = auxIdx >= 0 ? this.levelers[auxIdx] : undefined;
    const follower = auxIdx >= 0 ? this.followers[auxIdx] : undefined;

    switch (cmd.type) {
      case 'setMode':
        if (!['desligado', 'observar', 'automatico'].includes(cmd.mode)) return;
        this.mode = cmd.mode;
        this.setModeAll(cmd.mode);
        this.event(`Modo: ${cmd.mode}`);
        this.log.write('modo', { mode: cmd.mode });
        break;
      case 'capture': {
        this.levelers.forEach((l, idx) => {
          if (cmd.aux !== undefined && l.aux !== cmd.aux) return;
          const n = l.captureTargets(now);
          this.followers[idx].resetReferences();
          this.event(`Mixagem atual do aux ${l.aux} gravada como alvo (${n} canais)`);
          this.log.write('captura', { aux: l.aux, canais: n, alvos: l.exportPersisted() });
        });
        this.dirty = true;
        break;
      }
      case 'restore':
        for (const l of this.levelers) {
          const actions = l.restoreBase();
          this.apply(actions);
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
      case 'setSend':
        // Fader do painel = operador mexendo: NÃO marcamos como nosso, então o nivelador
        // trata como intervenção (pausa o canal e aprende o novo alvo).
        if (leveler) this.adapter.setSendDB(cmd.aux, cmd.key, fromWire(cmd.db));
        break;
      case 'setAuxMaster':
        if (leveler) {
          this.adapter.setAuxMasterDB(cmd.aux, fromWire(cmd.db));
          this.event(`Volume geral da live (aux ${cmd.aux}) → ${fmt(fromWire(cmd.db))} dB`, `master:${cmd.aux}`);
        }
        break;
      case 'setFxFollow':
        follower?.setFollow(cmd.key, cmd.follow);
        this.dirty = true;
        break;
      case 'preset.save':
        this.savePreset(cmd.name, cmd.id);
        break;
      case 'preset.load':
        this.loadPreset(cmd.id);
        break;
      case 'preset.delete': {
        const p = this.presets.get(cmd.id);
        if (!p) return;
        this.presets.delete(cmd.id);
        if (this.activePresetId === cmd.id) this.activePresetId = undefined;
        this.dirty = true;
        this.event(`Preset "${p.name}" apagado`);
        break;
      }
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

  private savePreset(name: string, id?: string): void {
    const cleanName = String(name ?? '').trim().slice(0, 40);
    if (!cleanName) return;
    const auxes: Record<string, { channels: ReturnType<AuxLeveler['exportPreset']>; fx: Record<string, number | null> }> = {};
    this.levelers.forEach((l, idx) => {
      auxes[String(l.aux)] = { channels: l.exportPreset(), fx: this.followers[idx].exportSends() };
    });
    const preset = this.presets.save({ id, name: cleanName, savedAt: Date.now(), auxes });
    // A mixagem salva vira a referência dos efeitos (eles param de compensar a partir daqui).
    this.followers.forEach((f) => f.resetReferences());
    this.levelers.forEach((l) => l.resetReferences());
    this.activePresetId = preset.id;
    this.dirty = true;
    this.event(`Preset "${preset.name}" ${id ? 'atualizado' : 'salvo'}`);
    this.log.write('preset-salvo', { id: preset.id, name: preset.name });
  }

  private loadPreset(id: string): void {
    const preset = this.presets.get(id);
    if (!preset) return;
    const now = Date.now();
    const durationMs = Math.max(0, this.cfg.leveler.presetFadeSec * 1000);
    const until = now + durationMs + 1500;

    this.levelers.forEach((leveler, idx) => {
      const data = preset.auxes[String(leveler.aux)];
      if (!data) return;
      const follower = this.followers[idx];
      const current = new Map(leveler.snapshot(now).map((c) => [c.key, c.sendDB ?? Number.NEGATIVE_INFINITY]));
      const currentFx = new Map(follower.snapshot().map((f) => [f.key, f.sendDB ?? Number.NEGATIVE_INFINITY]));

      for (const [key, p] of Object.entries(data.channels)) {
        leveler.holdForTransition(key, until);
        this.startFade(leveler.aux, key, current.get(key), p.sendDB, now, durationMs);
      }
      for (const [key, db] of Object.entries(data.fx)) {
        follower.holdForTransition(key, until);
        this.startFade(leveler.aux, key, currentFx.get(key), db, now, durationMs);
      }
      leveler.applyPreset(data.channels);
      follower.resetReferences(data.fx);
    });

    this.activePresetId = preset.id;
    this.dirty = true;
    this.event(`Preset "${preset.name}" carregado (fade de ${this.cfg.leveler.presetFadeSec} s)`);
    this.log.write('preset', { id: preset.id, name: preset.name });
  }

  private startFade(aux: number, key: string, from: number | undefined, to: number | null, now: number, durationMs: number): void {
    const fromDB = from ?? Number.NEGATIVE_INFINITY;
    const toDB = to ?? Number.NEGATIVE_INFINITY;
    if (fromDB === toDB || (Number.isFinite(fromDB) && Number.isFinite(toDB) && Math.abs(fromDB - toDB) < 0.05)) return;
    this.fades.set(`${aux}:${key}`, { aux, key, fromDB, toDB, start: now, durationMs: Math.max(1, durationMs) });
  }

  snapshot(): AppSnapshot {
    const now = Date.now();
    return {
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      mixer: this.mixer,
      mode: this.mode,
      deadbandDB: this.cfg.leveler.deadbandDB,
      auxes: this.levelers.map((l, idx) => {
        const master = this.auxMaster.get(l.aux);
        return {
          aux: l.aux,
          name: this.adapter.auxName(l.aux),
          outDB: l.auxOutDB === undefined ? undefined : round1(l.auxOutDB),
          masterDB: master === undefined || !Number.isFinite(master) ? undefined : round1(master),
          channels: l.snapshot(now),
          fx: this.followers[idx].snapshot(),
        };
      }),
      presets: this.presets.list().map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt })),
      activePresetId: this.activePresetId,
      events: this.events.slice(-MAX_EVENTS).reverse(),
      sim: this.sim()?.simState(),
    };
  }

  private setModeAll(mode: Mode): void {
    this.levelers.forEach((l) => l.setMode(mode));
    this.followers.forEach((f) => f.setMode(mode));
  }

  private sim(): SimulatorAdapter | undefined {
    return this.adapter instanceof SimulatorAdapter ? this.adapter : undefined;
  }

  private event(text: string, mergeKey?: string): void {
    const now = Date.now();
    const last = this.events[this.events.length - 1];
    if (mergeKey && last?.mergeKey === mergeKey && now - last.t < EVENT_MERGE_MS) {
      last.t = now;
      last.text = text;
      return;
    }
    this.events.push({ t: now, text, mergeKey });
    if (this.events.length > MAX_EVENTS * 2) this.events.splice(0, MAX_EVENTS);
    console.log(`[${new Date(now).toLocaleTimeString('pt-BR')}] ${text}`);
  }

  private persistIfDirty(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.store.save({
      auxes: Object.fromEntries(this.levelers.map((l) => [String(l.aux), l.exportPersisted()])),
      fxFollow: Object.fromEntries(this.followers.map((f) => [String(f.aux), f.exportFollow()])),
      activePresetId: this.activePresetId,
    });
  }
}

function fromWire(db: WireDB): number {
  return typeof db === 'number' && Number.isFinite(db) ? Math.max(-80, Math.min(10, db)) : Number.NEGATIVE_INFINITY;
}

function fmt(db: number): string {
  return Number.isFinite(db) ? db.toFixed(1) : '-∞';
}

function clampDelta(delta: number): number {
  return Number.isFinite(delta) ? Math.max(-12, Math.min(12, delta)) : 0;
}

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
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
