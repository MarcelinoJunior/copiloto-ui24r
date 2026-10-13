import type { AppConfig } from './config.js';
import type { ConnectionStore } from './connection-store.js';
import { ConnectionHealth, type HealthSnapshot, isValidHost } from './health.js';
import { AuxLeveler, type ChannelSnapshot, type Mode, type SendAction } from './leveler/aux-leveler.js';
import { FxFollower, type FxSnapshot } from './leveler/fx-follower.js';
import {
  type BusInfo,
  type ConnectionState,
  type MixerAdapter,
  type MixerInfo,
  type Unsubscribe,
  MASTER_BUS,
  busLabel,
  primaryBus,
} from './mixer/types.js';
import { SimulatorAdapter, type Scene } from './mixer/simulator.js';
import type { PresetStore } from './preset-store.js';
import type { SessionLog } from './session-log.js';
import type { PersistedState, StateStore } from './state-store.js';
import { round1 } from './util/db.js';

export interface EventEntry {
  t: number;
  text: string;
  /** eventos com a mesma chave em sequência são agrupados (ex.: arrastar um fader) */
  mergeKey?: string;
}

export interface BusChoice {
  id: number;
  label: string;
  name: string;
  stereo: boolean;
  selected: boolean;
}

export interface ControlledBus {
  bus: number;
  label: string;
  name: string;
  stereo: boolean;
  outDB?: number;
  masterDB?: number;
  channels: ChannelSnapshot[];
  fx: FxSnapshot[];
}

export interface AppSnapshot {
  connection: ConnectionState;
  connectionDetail?: string;
  mixer?: MixerInfo;
  mode: Mode;
  deadbandDB: number;
  buses: BusChoice[];
  controlled: ControlledBus[];
  /** efeitos da mesa e se o retorno deles vai para o salão (master) */
  fxInfo: { key: string; name: string; inRoom: boolean }[];
  /** envio de cada canal para cada efeito: fxSends[canal][efeito] (null = -∞) */
  fxSends: Record<string, Record<string, number | null>>;
  presets: { id: string; name: string; savedAt: number }[];
  activePresetId?: string;
  events: EventEntry[];
  sim?: { scene: Scene; offsets: Record<string, number> };
  health: HealthSnapshot;
}

export interface MixerTarget {
  kind: 'mesa' | 'simulador';
  ip: string;
  /** cria o adaptador para um endereço (o simulador ignora o endereço) */
  create: (ip: string) => MixerAdapter;
}

/** dB vindo do painel: null representa -∞ (JSON não tem -Infinity). */
type WireDB = number | null;

export type Command =
  | { type: 'setMode'; mode: Mode }
  | { type: 'setBuses'; buses: number[] }
  | { type: 'capture'; bus?: number }
  | { type: 'restore' }
  | { type: 'setEnabled'; bus: number; key: string; enabled: boolean }
  | { type: 'nudgeTarget'; bus: number; key: string; delta: number }
  | { type: 'clearTarget'; bus: number; key: string }
  | { type: 'setSend'; bus: number; key: string; db: WireDB }
  | { type: 'setBusMaster'; bus: number; db: WireDB }
  | { type: 'setFxSend'; fx: string; key: string; db: WireDB }
  | { type: 'setFxFollow'; bus: number; key: string; follow: boolean }
  | { type: 'preset.save'; name: string; id?: string }
  | { type: 'preset.load'; id: string }
  | { type: 'preset.delete'; id: string }
  | { type: 'sim.scene'; scene: Scene }
  | { type: 'sim.source'; key: string; delta: number }
  | { type: 'sim.reset' }
  | { type: 'conn.test'; ip: string }
  | { type: 'conn.setIp'; ip: string }
  | { type: 'conn.reconnect' };

interface BusController {
  bus: number;
  leveler: AuxLeveler;
  follower: FxFollower;
  unsubs: Unsubscribe[];
  masterDB?: number;
}

interface Fade {
  bus: number;
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
/** Retorno de efeito acima disso no master = o efeito toca no salão. */
const IN_ROOM_THRESHOLD_DB = -60;

/** Liga a mesa (real ou simulada), os niveladores, os efeitos, os presets e o log do culto. */
export class App {
  private readonly controllers = new Map<number, BusController>();
  private persisted: PersistedState = { auxes: {} };
  private mode: Mode;
  private connection: ConnectionState = 'conectando';
  private connectionDetail?: string;
  private mixer?: MixerInfo;
  private readonly events: EventEntry[] = [];
  private readonly fades = new Map<string, Fade>();
  /** `${fxKey}:${channelKey}` -> dB */
  private readonly fxSends = new Map<string, number>();
  private readonly fxInRoom = new Map<string, boolean>();
  private outLevels = new Map<number, number>();
  private activePresetId?: string;
  private wired = false;
  private dirty = false;
  private lastLevelLog = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private adapter: MixerAdapter;
  private ip: string;
  /** muda a cada troca de endereço; laços de conexão antigos param sozinhos */
  private generation = 0;
  private readonly health: ConnectionHealth;

  constructor(
    private readonly cfg: AppConfig,
    private readonly target: MixerTarget,
    private readonly store: StateStore,
    private readonly presets: PresetStore,
    private readonly log: SessionLog,
    private readonly connStore: ConnectionStore,
  ) {
    this.mode = cfg.initialMode;
    this.ip = target.ip;
    this.health = new ConnectionHealth(
      { kind: target.kind, ip: target.ip },
      target.kind === 'simulador' ? async () => Math.round((1 + Math.random() * 4) * 10) / 10 : undefined,
    );
    this.adapter = this.attach(target.create(target.ip));
  }

  private attach(adapter: MixerAdapter): MixerAdapter {
    adapter.onStatus((state, detail) => {
      if (adapter !== this.adapter) return; // adaptador antigo (endereço trocado)
      if (state !== this.connection) this.event(`Mesa: ${state}${detail ? ` (${detail})` : ''}`);
      this.connection = state;
      this.connectionDetail = detail;
      this.health.onState(state, detail);
    });
    adapter.onRawMessage(() => {
      if (adapter === this.adapter) this.health.onMessage();
    });
    return adapter;
  }

  async start(): Promise<void> {
    this.log.write('inicio', { mode: this.mode, leveler: this.cfg.leveler });
    this.timers.push(setInterval(() => this.tick(), this.cfg.leveler.tickMs));
    this.timers.push(setInterval(() => this.runFades(), FADE_STEP_MS));
    this.timers.push(setInterval(() => this.persistIfDirty(), 5000));
    this.health.start();
    void this.connectLoop(this.generation);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.health.stop();
    this.persistIfDirty();
    this.log.write('fim', {});
    await safeDisconnect(this.adapter);
    await this.log.close();
  }

  private async connectLoop(gen: number): Promise<void> {
    while (!this.stopped && gen === this.generation) {
      try {
        this.setConnection('conectando');
        const info = await withTimeout(this.adapter.connect(), CONNECT_TIMEOUT_MS);
        if (gen !== this.generation) return;
        this.mixer = info;
        this.setConnection('conectado');
        this.event(`Conectado: ${info.model} em ${info.address} (firmware ${info.firmware})`);
        this.log.write('mesa', { ...info });
        this.wire();
        return;
      } catch (err) {
        if (gen !== this.generation) return;
        const detail = err instanceof Error ? err.message : String(err);
        this.setConnection('erro', detail);
        this.event(`Não consegui conectar na mesa em ${this.ip} (${detail}). Tentando de novo em 5 s…`);
        await safeDisconnect(this.adapter);
        await sleep(RETRY_MS);
      }
    }
  }

  private setConnection(state: ConnectionState, detail?: string): void {
    this.connection = state;
    this.connectionDetail = detail;
    this.health.onState(state, detail);
  }

  /** Troca o endereço da mesa: desliga tudo da conexão antiga e conecta no novo. */
  private async switchMixer(ip: string): Promise<void> {
    this.persistIfDirty();
    this.generation++;
    for (const c of this.controllers.values()) c.unsubs.forEach((u) => u());
    this.controllers.clear();
    this.fades.clear();
    this.fxSends.clear();
    this.fxInRoom.clear();
    this.outLevels = new Map();
    this.wired = false;
    this.mixer = undefined;
    const old = this.adapter;
    this.ip = ip;
    this.adapter = this.attach(this.target.create(ip));
    this.health.setTarget({ kind: this.target.kind, ip });
    this.log.write('endereco', { ip });
    void this.connectLoop(this.generation);
    // Desligar uma conexão que está tentando reconectar pode nunca terminar: não esperamos por ela.
    await safeDisconnect(old);
  }

  /** Assinaturas globais (uma vez só) e depois as saídas escolhidas. */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.persisted = this.store.load();
    this.activePresetId = this.persisted.activePresetId;
    const channels = this.adapter.listChannels();

    for (const fx of this.adapter.listFxReturns()) {
      for (const ch of channels) {
        this.adapter.watchFxSend(fx.number, ch.key, (db) => {
          this.fxSends.set(`${fx.key}:${ch.key}`, db);
          for (const c of this.controllers.values()) c.follower.onFxSend(fx.key, ch.key, db);
        });
      }
      this.adapter.watchSend(MASTER_BUS, fx.key, (info) =>
        this.fxInRoom.set(fx.key, !info.muted && Number.isFinite(info.db) && info.db > IN_ROOM_THRESHOLD_DB),
      );
    }

    const adapter = this.adapter;
    adapter.onChannelName((key, name) => {
      if (adapter !== this.adapter) return;
      for (const c of this.controllers.values()) {
        c.leveler.setName(key, name);
        c.follower.setName(key, name);
      }
    });

    adapter.onVu((frame) => {
      if (adapter !== this.adapter) return;
      this.health.onVu();
      this.outLevels = frame.busOut;
      for (const c of this.controllers.values()) {
        for (const [key, vu] of frame.channels) {
          if (key.startsWith('f')) c.follower.onVu(key, vu.post);
          else c.leveler.onVu(key, vu, frame.t);
        }
        c.leveler.outDB = frame.busOut.get(c.bus);
      }
    });

    this.selectBuses(this.persisted.buses ?? this.cfg.streamAuxes, false);
  }

  // ---------- escolha das saídas controladas ----------

  private busInfo(id: number): BusInfo | undefined {
    return this.adapter.listBuses().find((b) => b.id === id);
  }

  /** Normaliza a escolha: par estéreo vira o aux "dono" (7 em 7+8), matrizes ficam de fora. */
  private normalizeBuses(ids: number[]): number[] {
    const out = new Set<number>();
    for (const id of ids) {
      const info = this.busInfo(id);
      if (!info || info.isMatrix) continue;
      out.add(primaryBus(info));
    }
    return [...out].sort((a, b) => a - b);
  }

  private selectBuses(ids: number[], announce = true): void {
    const wanted = new Set(this.normalizeBuses(ids));
    for (const [bus, c] of this.controllers) {
      if (wanted.has(bus)) continue;
      this.persistController(c);
      c.unsubs.forEach((u) => u());
      this.controllers.delete(bus);
      for (const [id, f] of this.fades) if (f.bus === bus) this.fades.delete(id);
      if (announce) this.event(`Parei de controlar ${this.labelOf(bus)}`);
    }
    for (const bus of wanted) {
      if (this.controllers.has(bus)) continue;
      this.addController(bus);
      if (announce) {
        this.event(
          bus === MASTER_BUS
            ? 'Controlando o MASTER: atenção, isso muda o som do SALÃO'
            : `Controlando ${this.labelOf(bus)} (${this.adapter.busName(bus)})`,
        );
      }
    }
    this.persisted.buses = [...wanted];
    this.dirty = true;
    this.log.write('saidas', { buses: [...wanted] });
  }

  private addController(bus: number): void {
    const leveler = new AuxLeveler(bus, this.cfg.leveler);
    const follower = new FxFollower(bus, this.cfg.leveler);
    leveler.setMode(this.mode);
    follower.setMode(this.mode);
    const c: BusController = { bus, leveler, follower, unsubs: [] };
    this.controllers.set(bus, c);

    const saved = this.persisted.auxes[String(bus)] ?? {};
    const savedFollow = this.persisted.fxFollow?.[String(bus)] ?? {};

    for (const ch of this.adapter.listChannels()) {
      leveler.ensureChannel(ch.key, ch.name, saved[ch.key]);
      c.unsubs.push(
        this.adapter.watchSend(bus, ch.key, (info) => {
          const change = leveler.onSend(ch.key, info, Date.now());
          if (change) this.operatorMoved(bus, ch.key, leveler.channelName(ch.key), change);
        }),
      );
    }
    for (const fx of this.adapter.listFxReturns()) {
      follower.ensureReturn(fx.key, fx.name, savedFollow[fx.key] ?? true);
      for (const ch of this.adapter.listChannels()) {
        const db = this.fxSends.get(`${fx.key}:${ch.key}`);
        if (db !== undefined) follower.onFxSend(fx.key, ch.key, db);
      }
      c.unsubs.push(
        this.adapter.watchSend(bus, fx.key, (info) => {
          const change = follower.onSend(fx.key, info, Date.now());
          if (change) this.operatorMoved(bus, fx.key, fx.name, change);
        }),
      );
    }
    c.unsubs.push(this.adapter.watchBusMaster(bus, (db) => (c.masterDB = db)));
  }

  private labelOf(bus: number): string {
    return busLabel(this.busInfo(bus), bus);
  }

  // ---------- ciclo ----------

  private operatorMoved(bus: number, key: string, name: string, change: { fromDB: number; toDB: number }): void {
    this.dirty = true;
    this.fades.delete(`${bus}:${key}`); // o operador manda: cancela fade em andamento
    this.event(`Operador: ${name} → ${this.labelOf(bus)} ${fmt(change.toDB)} dB`, `op:${bus}:${key}`);
    this.log.write('operador', { bus, key, ...change });
  }

  private tick(): void {
    if (!this.wired) return;
    const now = Date.now();
    for (const c of this.controllers.values()) {
      this.apply(c.leveler.tick(now));
      this.apply(c.follower.tick(now, c.leveler.offsets(now)));
    }

    if (now - this.lastLevelLog >= LEVEL_LOG_EVERY_MS) {
      this.lastLevelLog = now;
      for (const c of this.controllers.values()) {
        const active = c.leveler
          .snapshot(now)
          .filter((s) => s.status !== 'silencio' && s.status !== 'sem-envio' && s.status !== 'desabilitado')
          .map((s) => [s.key, s.levelDB, s.sendDB, s.targetDB, s.status]);
        const fx = c.follower.snapshot().map((f) => [f.key, f.sendDB, f.followDeltaDB, f.status]);
        this.log.write('niveis', { bus: c.bus, mode: this.mode, out: c.leveler.outDB, ch: active, fx });
      }
    }
  }

  /** Manda envios para a mesa marcando-os como nossos (para o eco não parecer o operador). */
  private apply(actions: SendAction[]): void {
    const now = Date.now();
    for (const a of actions) {
      const c = this.controllers.get(a.bus);
      if (!c) continue;
      if (a.key.startsWith('f')) c.follower.markCommanded(a.key, a.toDB, now);
      else c.leveler.markCommanded(a.key, a.toDB, now);
      this.adapter.setSendDB(a.bus, a.key, a.toDB);
      if (a.reason !== 'preset') this.log.write('envio', { ...a });
    }
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
      actions.push({ bus: f.bus, key: f.key, fromDB: f.fromDB, toDB: db, reason: 'preset' });
      if (progress >= 1) this.fades.delete(id);
    }
    this.apply(actions);
  }

  // ---------- comandos do painel ----------

  handle(cmd: Command): void {
    const now = Date.now();
    const c = 'bus' in cmd && cmd.bus !== undefined ? this.controllers.get(cmd.bus) : undefined;

    switch (cmd.type) {
      case 'setMode':
        if (!['desligado', 'observar', 'automatico'].includes(cmd.mode)) return;
        this.mode = cmd.mode;
        for (const x of this.controllers.values()) {
          x.leveler.setMode(cmd.mode);
          x.follower.setMode(cmd.mode);
        }
        this.event(`Modo: ${cmd.mode}`);
        this.log.write('modo', { mode: cmd.mode });
        break;
      case 'setBuses':
        if (Array.isArray(cmd.buses)) this.selectBuses(cmd.buses.filter((b) => Number.isInteger(b)));
        break;
      case 'capture':
        for (const x of this.controllers.values()) {
          if (cmd.bus !== undefined && x.bus !== cmd.bus) continue;
          const n = x.leveler.captureTargets(now);
          x.follower.resetReferences();
          this.event(`Mixagem atual de ${this.labelOf(x.bus)} gravada como alvo (${n} canais)`);
          this.log.write('captura', { bus: x.bus, canais: n, alvos: x.leveler.exportPersisted() });
        }
        this.dirty = true;
        break;
      case 'restore':
        for (const x of this.controllers.values()) {
          const actions = x.leveler.restoreBase();
          this.apply(actions);
          this.event(`${this.labelOf(x.bus)}: envios voltaram para a mixagem original (${actions.length} canais)`);
        }
        break;
      case 'setEnabled':
        c?.leveler.setEnabled(cmd.key, cmd.enabled);
        this.dirty = true;
        break;
      case 'nudgeTarget':
        c?.leveler.nudgeTarget(cmd.key, clampDelta(cmd.delta));
        this.dirty = true;
        break;
      case 'clearTarget':
        c?.leveler.setTarget(cmd.key, undefined);
        this.dirty = true;
        break;
      case 'setSend':
        // Fader do painel = operador mexendo: NÃO marcamos como nosso, então o nivelador
        // trata como intervenção (pausa o canal e aprende o novo alvo).
        if (c) this.adapter.setSendDB(cmd.bus, cmd.key, fromWire(cmd.db));
        break;
      case 'setBusMaster':
        if (c) {
          this.adapter.setBusMasterDB(cmd.bus, fromWire(cmd.db));
          this.event(`Volume geral de ${this.labelOf(cmd.bus)} → ${fmt(fromWire(cmd.db))} dB`, `master:${cmd.bus}`);
        }
        break;
      case 'setFxSend': {
        const fx = this.adapter.listFxReturns().find((f) => f.key === cmd.fx);
        const ch = this.adapter.listChannels().find((x) => x.key === cmd.key);
        if (!fx || !ch) return;
        const db = fromWire(cmd.db);
        this.adapter.setFxSendDB(fx.number, ch.key, db);
        const where = this.fxInRoom.get(fx.key) ? 'salão + live' : 'só live';
        this.event(`Efeito: ${ch.name} → ${fx.name} ${fmt(db)} dB (${where})`, `fx:${fx.key}:${ch.key}`);
        this.log.write('efeito', { fx: fx.key, key: ch.key, db: Number.isFinite(db) ? db : null });
        break;
      }
      case 'setFxFollow':
        c?.follower.setFollow(cmd.key, cmd.follow);
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
      case 'conn.test': {
        const ip = String(cmd.ip ?? '').trim();
        if (!isValidHost(ip)) {
          this.event(`Endereço inválido: "${ip}"`);
          return;
        }
        if (this.target.kind === 'simulador') {
          this.event('No simulador não há rede para testar. Rode "npm start" para usar a mesa de verdade.');
          return;
        }
        void this.health.test(ip);
        break;
      }
      case 'conn.setIp': {
        const ip = String(cmd.ip ?? '').trim();
        if (!isValidHost(ip)) {
          this.event(`Endereço inválido: "${ip}"`);
          return;
        }
        if (this.target.kind === 'simulador') {
          this.event('No simulador o endereço não é usado. Rode "npm start" para usar a mesa de verdade.');
          return;
        }
        this.connStore.saveIp(ip);
        this.event(`Endereço da mesa alterado para ${ip}. Conectando…`);
        void this.switchMixer(ip);
        break;
      }
      case 'conn.reconnect':
        this.event(`Reconectando em ${this.ip}…`);
        void this.switchMixer(this.ip);
        break;
    }
  }

  // ---------- presets ----------

  private savePreset(name: string, id?: string): void {
    const cleanName = String(name ?? '').trim().slice(0, 40);
    if (!cleanName || this.controllers.size === 0) return;
    const existing = id ? this.presets.get(id) : undefined;
    // mantém no preset as saídas que não estão sendo controladas agora
    const auxes = { ...(existing?.auxes ?? {}) };
    for (const c of this.controllers.values()) {
      auxes[String(c.bus)] = { channels: c.leveler.exportPreset(), fx: c.follower.exportSends() };
      // a mixagem salva vira a referência dos efeitos (eles param de compensar a partir daqui)
      c.leveler.resetReferences();
      c.follower.resetReferences();
    }
    const preset = this.presets.save({ id, name: cleanName, savedAt: Date.now(), auxes });
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
    let applied = 0;

    for (const c of this.controllers.values()) {
      const data = preset.auxes[String(c.bus)];
      if (!data) continue;
      applied++;
      const current = new Map(c.leveler.snapshot(now).map((s) => [s.key, s.sendDB ?? Number.NEGATIVE_INFINITY]));
      const currentFx = new Map(c.follower.snapshot().map((f) => [f.key, f.sendDB ?? Number.NEGATIVE_INFINITY]));
      for (const [key, p] of Object.entries(data.channels)) {
        c.leveler.holdForTransition(key, until);
        this.startFade(c.bus, key, current.get(key), p.sendDB, now, durationMs);
      }
      for (const [key, db] of Object.entries(data.fx)) {
        c.follower.holdForTransition(key, until);
        this.startFade(c.bus, key, currentFx.get(key), db, now, durationMs);
      }
      c.leveler.applyPreset(data.channels);
      c.follower.resetReferences(data.fx);
    }

    if (applied === 0) {
      this.event(`Preset "${preset.name}" não tem dados para as saídas controladas agora`);
      return;
    }
    this.activePresetId = preset.id;
    this.dirty = true;
    this.event(`Preset "${preset.name}" carregado (fade de ${this.cfg.leveler.presetFadeSec} s)`);
    this.log.write('preset', { id: preset.id, name: preset.name });
  }

  private startFade(bus: number, key: string, from: number | undefined, to: number | null, now: number, durationMs: number): void {
    const fromDB = from ?? Number.NEGATIVE_INFINITY;
    const toDB = to ?? Number.NEGATIVE_INFINITY;
    if (fromDB === toDB || (Number.isFinite(fromDB) && Number.isFinite(toDB) && Math.abs(fromDB - toDB) < 0.05)) return;
    this.fades.set(`${bus}:${key}`, { bus, key, fromDB, toDB, start: now, durationMs: Math.max(1, durationMs) });
  }

  // ---------- estado para o painel ----------

  snapshot(): AppSnapshot {
    const now = Date.now();
    const buses = this.wired ? this.adapter.listBuses() : [];
    const choices: BusChoice[] = buses
      .filter((b) => !b.isMatrix && (b.linkedWith === undefined || b.id === primaryBus(b)))
      .map((b) => ({
        id: b.id,
        label: busLabel(b, b.id),
        name: b.name,
        stereo: b.linkedWith !== undefined,
        selected: this.controllers.has(b.id),
      }));

    const fxReturns = this.wired ? this.adapter.listFxReturns() : [];
    const fxSends: Record<string, Record<string, number | null>> = {};
    for (const [id, db] of this.fxSends) {
      const [fx, ch] = id.split(':');
      (fxSends[ch] ??= {})[fx] = Number.isFinite(db) ? round1(db) : null;
    }

    return {
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      mixer: this.mixer,
      mode: this.mode,
      deadbandDB: this.cfg.leveler.deadbandDB,
      buses: choices,
      controlled: [...this.controllers.values()]
        .sort((a, b) => a.bus - b.bus)
        .map((c) => {
          const info = buses.find((b) => b.id === c.bus);
          const out = this.outLevels.get(c.bus);
          return {
            bus: c.bus,
            label: busLabel(info, c.bus),
            name: this.adapter.busName(c.bus),
            stereo: info?.linkedWith !== undefined,
            outDB: out === undefined ? undefined : round1(out),
            masterDB: c.masterDB === undefined || !Number.isFinite(c.masterDB) ? undefined : round1(c.masterDB),
            channels: c.leveler.snapshot(now),
            fx: c.follower.snapshot(),
          };
        }),
      fxInfo: fxReturns.map((f) => ({ key: f.key, name: f.name, inRoom: this.fxInRoom.get(f.key) ?? false })),
      fxSends,
      presets: this.presets.list().map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt })),
      activePresetId: this.activePresetId,
      events: this.events.slice(-MAX_EVENTS).reverse(),
      sim: this.sim()?.simState(),
      health: this.health.snapshot(),
    };
  }

  // ---------- internos ----------

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

  private persistController(c: BusController): void {
    this.persisted.auxes[String(c.bus)] = c.leveler.exportPersisted();
    (this.persisted.fxFollow ??= {})[String(c.bus)] = c.follower.exportFollow();
  }

  private persistIfDirty(): void {
    if (!this.dirty || !this.wired) return;
    this.dirty = false;
    for (const c of this.controllers.values()) this.persistController(c);
    this.persisted.activePresetId = this.activePresetId;
    this.store.save(this.persisted);
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

/** Desliga um adaptador sem travar o programa se a mesa não responder. */
function safeDisconnect(adapter: MixerAdapter): Promise<void> {
  return withTimeout(adapter.disconnect(), 3000).catch(() => undefined);
}
