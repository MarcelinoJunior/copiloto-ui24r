import { canUseBus, type User } from './auth.js';
import type { AppConfig } from './config.js';
import type { ConnectionStore } from './connection-store.js';
import { ConnectionHealth, type HealthSnapshot, isValidHost } from './health.js';
import { AuxLeveler, type ChannelSnapshot, type Mode, type SendAction } from './leveler/aux-leveler.js';
import { FxFollower, type FxSnapshot } from './leveler/fx-follower.js';
import { detectUsbAudio, UsbAudioCapture, type UsbDetection } from './levels/usb-audio.js';
import { SimulatorAdapter, type Scene } from './mixer/simulator.js';
import {
  type BusInfo,
  type ChannelVu,
  type ConnectionState,
  type MixerAdapter,
  type MixerInfo,
  type Unsubscribe,
  MASTER_BUS,
  busLabel,
  primaryBus,
} from './mixer/types.js';
import type { PresetStore } from './preset-store.js';
import type { SessionLog } from './session-log.js';
import type { PersistedState, StateStore } from './state-store.js';
import { FLOOR_DB, round1 } from './util/db.js';

export type SourceKind = 'mesa' | 'simulador';

/** Mesa real e simulador guardam alvos, saídas e presets separados. */
export interface Profile {
  store: StateStore;
  presets: PresetStore;
}

export interface MixerTarget {
  kind: SourceKind;
  /** IP da mesa real (guardado mesmo quando está no simulador) */
  ip: string;
  create: (kind: SourceKind, ip: string) => MixerAdapter;
  profiles: Record<SourceKind, Profile>;
}

/** O que cada pessoa conectada está olhando (cada uma vê a sua saída). */
export interface ClientView {
  bus?: number;
  /** canal aberto no painel do canal */
  detail?: string;
}

export interface ClientCtx {
  user: User;
  view: ClientView;
}

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
  mode: Mode;
}

export interface ViewedBus {
  bus: number;
  label: string;
  name: string;
  stereo: boolean;
  mode: Mode;
  outDB?: number;
  masterDB?: number;
  channels: ChannelSnapshot[];
  fx: FxSnapshot[];
}

/** Painel do canal: todos os volumes daquele canal. */
export interface ChannelDetail {
  key: string;
  name: string;
  /** fader do canal no master (som do salão) */
  master: { db: number | null; allowed: boolean };
  /** envio do canal para a saída que a pessoa está vendo (se for um aux) */
  busSend?: { bus: number; label: string; db: number | null };
  fx: { key: string; name: string; db: number | null; inRoom: boolean; allowed: boolean }[];
  /** outros auxes liberados para a pessoa */
  otherAuxes: { bus: number; label: string; name: string; db: number | null }[];
  levelDB?: number;
  enabled: boolean;
  targetDB?: number;
  status: string;
}

export interface LevelSourceInfo {
  kind: 'vu' | 'usb';
  device?: string;
  channels: number;
  usbState?: string;
  usbError?: string;
  usbAgeMs?: number;
  detection?: UsbDetection;
}

export interface AppSnapshot {
  connection: ConnectionState;
  connectionDetail?: string;
  mixer?: MixerInfo;
  source: { kind: SourceKind; ip: string };
  user: { username: string; role: string };
  deadbandDB: number;
  buses: BusChoice[];
  bus?: ViewedBus;
  detail?: ChannelDetail;
  presets: { id: string; name: string; savedAt: number }[];
  activePresetId?: string;
  events: EventEntry[];
  sim?: { scene: Scene; offsets: Record<string, number> };
  health: HealthSnapshot;
  levelSource: LevelSourceInfo;
}

/** dB vindo do painel: null representa -∞ (JSON não tem -Infinity). */
type WireDB = number | null;

export type Command =
  | { type: 'view'; bus?: number; detail?: string | null }
  | { type: 'setMode'; bus: number; mode: Mode }
  | { type: 'capture'; bus: number }
  | { type: 'restore'; bus: number }
  | { type: 'setEnabled'; bus: number; key: string; enabled: boolean }
  | { type: 'nudgeTarget'; bus: number; key: string; delta: number }
  | { type: 'clearTarget'; bus: number; key: string }
  | { type: 'setSend'; bus: number; key: string; db: WireDB }
  | { type: 'setBusMaster'; bus: number; db: WireDB }
  | { type: 'setFxSend'; fx: string; key: string; db: WireDB }
  | { type: 'setFxFollow'; bus: number; key: string; follow: boolean }
  | { type: 'preset.save'; bus: number; name: string; id?: string }
  | { type: 'preset.load'; bus: number; id: string }
  | { type: 'preset.delete'; id: string }
  | { type: 'sim.scene'; scene: Scene }
  | { type: 'sim.source'; key: string; delta: number }
  | { type: 'sim.reset' }
  | { type: 'conn.test'; ip: string }
  | { type: 'conn.setIp'; ip: string }
  | { type: 'conn.useSim' }
  | { type: 'conn.reconnect' }
  | { type: 'level.detect' }
  | { type: 'level.useVu' }
  | { type: 'level.useUsb'; device: string; channels: number };

/** Erro de comando: vira mensagem para quem pediu. */
export class CommandError extends Error {}

interface BusController {
  bus: number;
  leveler: AuxLeveler;
  follower: FxFollower;
  unsubs: Unsubscribe[];
  masterDB?: number;
  mode: Mode;
}

interface Fade {
  bus: number;
  key: string;
  fromDB: number;
  toDB: number;
  start: number;
  durationMs: number;
}

const MAX_EVENTS = 80;
const EVENT_MERGE_MS = 4000;
const LEVEL_LOG_EVERY_MS = 2000;
const CONNECT_TIMEOUT_MS = 10000;
const RETRY_MS = 5000;
const FADE_STEP_MS = 100;
const ACTOR_MEMORY_MS = 3000;
const USB_STALE_MS = 500;
/** Retorno de efeito acima disso no master = o efeito toca no salão. */
const IN_ROOM_THRESHOLD_DB = -60;
const MODES: Mode[] = ['desligado', 'observar', 'automatico'];

/** Liga a mesa (real ou simulada), os niveladores de TODAS as saídas, efeitos, presets, permissões e o log. */
export class App {
  private readonly controllers = new Map<number, BusController>();
  private persisted: PersistedState = { auxes: {} };
  private connection: ConnectionState = 'conectando';
  private connectionDetail?: string;
  private mixer?: MixerInfo;
  private readonly events: EventEntry[] = [];
  private readonly fades = new Map<string, Fade>();
  /** `${fxKey}:${channelKey}` -> dB */
  private readonly fxSends = new Map<string, number>();
  private readonly fxInRoom = new Map<string, boolean>();
  /** quem mexeu num fader pelo painel há pouco (para o log dizer quem foi) */
  private readonly actors = new Map<string, { name: string; t: number }>();
  private outLevels = new Map<number, number>();
  private wired = false;
  private dirty = false;
  private lastLevelLog = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private adapter: MixerAdapter;
  private kind: SourceKind;
  private ip: string;
  private store: StateStore;
  private presets: PresetStore;
  /** muda a cada troca de mesa; laços de conexão antigos param sozinhos */
  private generation = 0;
  private readonly health: ConnectionHealth;
  private levelSource: { kind: 'vu' | 'usb'; device?: string; channels: number } = { kind: 'vu', channels: 24 };
  private usbCapture?: UsbAudioCapture;
  private usbLevels?: number[];
  private usbDetection?: UsbDetection;

  constructor(
    private readonly cfg: AppConfig,
    private readonly target: MixerTarget,
    private readonly log: SessionLog,
    private readonly connStore: ConnectionStore,
  ) {
    this.kind = target.kind;
    this.ip = target.ip;
    this.store = target.profiles[this.kind].store;
    this.presets = target.profiles[this.kind].presets;
    this.health = new ConnectionHealth({ kind: this.kind, ip: this.ip });
    this.adapter = this.attach(target.create(this.kind, this.ip));
  }

  // ---------- ciclo de vida e conexão ----------

  private attach(adapter: MixerAdapter): MixerAdapter {
    adapter.onStatus((state, detail) => {
      if (adapter !== this.adapter) return; // adaptador antigo (mesa trocada)
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
    this.log.write('inicio', { leveler: this.cfg.leveler });
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
    this.usbCapture?.stop();
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
        this.event(`Não consegui conectar na mesa real em ${this.ip} (${detail}). Tentando de novo em 5 s…`);
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

  /** Troca de mesa (outro IP, ou mesa real ↔ simulador): desliga tudo da antiga e conecta na nova. */
  private async switchMixer(kind: SourceKind, ip: string): Promise<void> {
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
    this.kind = kind;
    this.ip = ip;
    this.store = this.target.profiles[kind].store;
    this.presets = this.target.profiles[kind].presets;
    this.adapter = this.attach(this.target.create(kind, ip));
    this.health.setTarget({ kind, ip });
    this.log.write('fonte', { kind, ip });
    void this.connectLoop(this.generation);
    // Desligar uma conexão que está tentando reconectar pode nunca terminar: não esperamos por ela.
    await safeDisconnect(old);
  }

  /** Assinaturas globais e um controlador para CADA saída (master + auxes). */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.persisted = this.store.load();
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
      const channelsVu = this.levelsFromSource(frame.channels);
      for (const c of this.controllers.values()) {
        for (const [key, vu] of channelsVu) {
          if (key.startsWith('f')) c.follower.onVu(key, vu.post);
          else c.leveler.onVu(key, vu, frame.t);
        }
        c.leveler.outDB = frame.busOut.get(c.bus);
      }
    });

    for (const bus of this.allBuses()) this.addController(bus.id);

    const saved = this.persisted.levelSource;
    if (saved?.kind === 'usb' && saved.device && this.kind === 'mesa') {
      this.startUsb(saved.device, saved.channels ?? 24, false);
    }
  }

  /** Saídas controláveis: master + auxes (par estéreo conta uma vez; matriz fica de fora). */
  private allBuses(): BusInfo[] {
    return this.adapter.listBuses().filter((b) => !b.isMatrix && primaryBus(b) === b.id);
  }

  private addController(bus: number): void {
    const mode =
      this.persisted.modes?.[String(bus)] ?? (this.cfg.streamAuxes.includes(bus) ? this.cfg.initialMode : 'desligado');
    const leveler = new AuxLeveler(bus, this.cfg.leveler);
    const follower = new FxFollower(bus, this.cfg.leveler);
    leveler.setMode(mode);
    follower.setMode(mode);
    const c: BusController = { bus, leveler, follower, unsubs: [], mode };
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
    return busLabel(this.adapter.listBuses().find((b) => b.id === bus), bus);
  }

  // ---------- fonte de nível: VU (rede) ou áudio USB (físico) ----------

  /** Com a fonte USB ativa e recente, o nível das entradas vem do áudio USB; o resto continua do VU. */
  private levelsFromSource(vu: Map<string, ChannelVu>): Map<string, ChannelVu> {
    const usb = this.usbLevels;
    const fresh = usb && this.usbCapture?.lastLevelsAt !== undefined && Date.now() - this.usbCapture.lastLevelsAt < USB_STALE_MS;
    if (this.levelSource.kind !== 'usb' || !fresh) return vu;
    const out = new Map(vu);
    const master = this.controllers.get(MASTER_BUS);
    const masterSends = new Map(master?.leveler.snapshot(Date.now()).map((s) => [s.key, s.sendDB]) ?? []);
    usb.forEach((db, idx) => {
      const key = `i${idx + 1}`;
      const fader = masterSends.get(key);
      const postFader = fader === undefined ? FLOOR_DB : Math.max(FLOOR_DB, Math.min(0, db + fader));
      out.set(key, { pre: db, post: db, postFader });
    });
    return out;
  }

  private startUsb(device: string, channels: number, announce = true): void {
    this.usbCapture?.stop();
    this.usbLevels = undefined;
    this.levelSource = { kind: 'usb', device, channels };
    this.usbCapture = new UsbAudioCapture({ device, channels }, (levels) => (this.usbLevels = levels));
    this.usbCapture.start();
    if (announce) this.event(`Nível pelo ÁUDIO USB: "${device}" (${channels} canais). Controle continua pela rede.`);
    this.persisted.levelSource = { kind: 'usb', device, channels };
    this.dirty = true;
  }

  private useVu(): void {
    this.usbCapture?.stop();
    this.usbCapture = undefined;
    this.usbLevels = undefined;
    this.levelSource = { kind: 'vu', channels: this.levelSource.channels };
    this.persisted.levelSource = { kind: 'vu' };
    this.dirty = true;
    this.event('Nível pelo VU da mesa (rede).');
  }

  // ---------- ciclo de controle ----------

  private operatorMoved(bus: number, key: string, name: string, change: { fromDB: number; toDB: number }): void {
    this.dirty = true;
    this.fades.delete(`${bus}:${key}`); // o operador manda: cancela fade em andamento
    const actor = this.actors.get(`${bus}:${key}`);
    const who = actor && Date.now() - actor.t < ACTOR_MEMORY_MS ? actor.name : 'Na mesa';
    this.event(`${who}: ${name} → ${this.labelOf(bus)} ${fmt(change.toDB)} dB`, `op:${bus}:${key}`);
    this.log.write('operador', { bus, key, quem: who, ...change });
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
        if (c.mode === 'desligado') continue;
        const active = c.leveler
          .snapshot(now)
          .filter((s) => s.status !== 'silencio' && s.status !== 'sem-envio' && s.status !== 'desabilitado')
          .map((s) => [s.key, s.levelDB, s.sendDB, s.targetDB, s.status]);
        const fx = c.follower.snapshot().map((f) => [f.key, f.sendDB, f.followDeltaDB, f.status]);
        this.log.write('niveis', { bus: c.bus, mode: c.mode, out: c.leveler.outDB, ch: active, fx });
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

  // ---------- permissões ----------

  private requireBus(ctx: ClientCtx, bus: number): BusController {
    const c = this.controllers.get(bus);
    if (!c) throw new CommandError('Essa saída não existe (ou a mesa ainda não conectou).');
    if (!canUseBus(ctx.user, bus)) throw new CommandError(`Você não tem acesso a ${this.labelOf(bus)}. Peça ao admin.`);
    return c;
  }

  private requireAdmin(ctx: ClientCtx): void {
    if (ctx.user.role !== 'admin') throw new CommandError('Só o admin pode fazer isso.');
  }

  /**
   * Envio canal → efeito vale para salão E para todas as saídas que tocam aquele efeito.
   * Pode mexer: admin, quem tem o master, ou — se o efeito NÃO toca no salão — quem tem
   * acesso a alguma saída onde o retorno desse efeito está aberto.
   */
  private canEditFx(user: User, fxKey: string): boolean {
    if (user.role === 'admin' || canUseBus(user, MASTER_BUS)) return true;
    if (this.fxInRoom.get(fxKey)) return false;
    return [...this.controllers.values()].some(
      (c) => c.bus !== MASTER_BUS && canUseBus(user, c.bus) && c.follower.snapshot().some((f) => f.key === fxKey && f.sendDB !== undefined),
    );
  }

  private remember(ctx: ClientCtx, bus: number, key: string): void {
    this.actors.set(`${bus}:${key}`, { name: ctx.user.username, t: Date.now() });
  }

  // ---------- comandos do painel ----------

  /** Executa um comando de uma pessoa. Lança CommandError com a explicação quando não pode. */
  handle(cmd: Command, ctx: ClientCtx): void {
    const now = Date.now();
    const who = ctx.user.username;

    switch (cmd.type) {
      case 'view': {
        if (cmd.bus !== undefined) {
          if (!this.controllers.has(cmd.bus) || !canUseBus(ctx.user, cmd.bus)) throw new CommandError('Saída indisponível para você.');
          if (ctx.view.bus !== cmd.bus) ctx.view.detail = undefined;
          ctx.view.bus = cmd.bus;
        }
        if (cmd.detail !== undefined) ctx.view.detail = cmd.detail && /^[ilp]\d{1,2}$/.test(cmd.detail) ? cmd.detail : undefined;
        return;
      }
      case 'setMode': {
        const c = this.requireBus(ctx, cmd.bus);
        if (!MODES.includes(cmd.mode)) throw new CommandError('Modo inválido.');
        c.mode = cmd.mode;
        c.leveler.setMode(cmd.mode);
        c.follower.setMode(cmd.mode);
        (this.persisted.modes ??= {})[String(cmd.bus)] = cmd.mode;
        this.dirty = true;
        this.event(`${who}: ${this.labelOf(cmd.bus)} em modo ${cmd.mode}`);
        this.log.write('modo', { bus: cmd.bus, mode: cmd.mode, quem: who });
        return;
      }
      case 'capture': {
        const c = this.requireBus(ctx, cmd.bus);
        const n = c.leveler.captureTargets(now);
        c.follower.resetReferences();
        this.dirty = true;
        this.event(`${who}: mixagem atual de ${this.labelOf(c.bus)} gravada como alvo (${n} canais)`);
        this.log.write('captura', { bus: c.bus, canais: n, quem: who, alvos: c.leveler.exportPersisted() });
        return;
      }
      case 'restore': {
        const c = this.requireBus(ctx, cmd.bus);
        const actions = c.leveler.restoreBase();
        this.apply(actions);
        this.event(`${who}: ${this.labelOf(c.bus)} voltou para a mixagem original (${actions.length} canais)`);
        return;
      }
      case 'setEnabled':
        this.requireBus(ctx, cmd.bus).leveler.setEnabled(cmd.key, cmd.enabled);
        this.dirty = true;
        return;
      case 'nudgeTarget':
        this.requireBus(ctx, cmd.bus).leveler.nudgeTarget(cmd.key, clampDelta(cmd.delta));
        this.dirty = true;
        return;
      case 'clearTarget':
        this.requireBus(ctx, cmd.bus).leveler.setTarget(cmd.key, undefined);
        this.dirty = true;
        return;
      case 'setSend':
        // Fader do painel = operador mexendo: NÃO marcamos como nosso, então o nivelador
        // trata como intervenção (pausa o canal e aprende o novo alvo).
        this.requireBus(ctx, cmd.bus);
        if (!/^[ilpf]\d{1,2}$/.test(cmd.key)) throw new CommandError('Canal inválido.');
        this.remember(ctx, cmd.bus, cmd.key);
        this.adapter.setSendDB(cmd.bus, cmd.key, fromWire(cmd.db));
        return;
      case 'setBusMaster':
        this.requireBus(ctx, cmd.bus);
        this.adapter.setBusMasterDB(cmd.bus, fromWire(cmd.db));
        this.event(`${who}: volume geral de ${this.labelOf(cmd.bus)} → ${fmt(fromWire(cmd.db))} dB`, `master:${cmd.bus}`);
        return;
      case 'setFxSend': {
        const fx = this.adapter.listFxReturns().find((f) => f.key === cmd.fx);
        const ch = this.adapter.listChannels().find((x) => x.key === cmd.key);
        if (!fx || !ch) throw new CommandError('Efeito ou canal inválido.');
        if (!this.canEditFx(ctx.user, fx.key)) {
          throw new CommandError(`${fx.name} também toca no salão/em outras saídas: só o admin ou quem tem o master pode mexer.`);
        }
        const db = fromWire(cmd.db);
        this.adapter.setFxSendDB(fx.number, ch.key, db);
        const where = this.fxInRoom.get(fx.key) ? 'salão + live' : 'só live';
        this.event(`${who}: ${ch.name} → ${fx.name} ${fmt(db)} dB (${where})`, `fx:${fx.key}:${ch.key}`);
        this.log.write('efeito', { fx: fx.key, key: ch.key, db: Number.isFinite(db) ? db : null, quem: who });
        return;
      }
      case 'setFxFollow':
        this.requireBus(ctx, cmd.bus).follower.setFollow(cmd.key, cmd.follow);
        this.dirty = true;
        return;
      case 'preset.save':
        this.savePreset(this.requireBus(ctx, cmd.bus), cmd.name, cmd.id, who);
        return;
      case 'preset.load':
        this.loadPreset(this.requireBus(ctx, cmd.bus), cmd.id, who);
        return;
      case 'preset.delete': {
        const p = this.presets.get(cmd.id);
        if (!p) throw new CommandError('Preset não encontrado.');
        const buses = Object.keys(p.auxes).map(Number);
        if (!buses.every((b) => canUseBus(ctx.user, b))) throw new CommandError('Esse preset inclui saídas que você não tem acesso.');
        this.presets.delete(cmd.id);
        for (const [bus, id] of Object.entries(this.persisted.activePresets ?? {})) {
          if (id === cmd.id) delete this.persisted.activePresets![bus];
        }
        this.dirty = true;
        this.event(`${who}: preset "${p.name}" apagado`);
        return;
      }
      case 'sim.scene':
        this.sim()?.setScene(cmd.scene);
        this.event(`[simulador] Momento: ${cmd.scene}`);
        return;
      case 'sim.source':
        this.sim()?.changeSource(cmd.key, clampDelta(cmd.delta));
        this.event(`[simulador] ${cmd.key}: fonte ${cmd.delta > 0 ? '+' : ''}${cmd.delta} dB`);
        return;
      case 'sim.reset':
        this.sim()?.resetSources();
        return;
      case 'conn.test': {
        this.requireAdmin(ctx);
        const ip = String(cmd.ip ?? '').trim();
        if (!isValidHost(ip)) throw new CommandError(`Endereço inválido: "${ip}"`);
        void this.health.test(ip); // funciona mesmo estando no simulador
        return;
      }
      case 'conn.setIp': {
        this.requireAdmin(ctx);
        const ip = String(cmd.ip ?? '').trim();
        if (!isValidHost(ip)) throw new CommandError(`Endereço inválido: "${ip}"`);
        this.connStore.saveIp(ip);
        this.event(`${who}: usando a MESA REAL em ${ip}. Conectando…`);
        void this.switchMixer('mesa', ip);
        return;
      }
      case 'conn.useSim':
        this.requireAdmin(ctx);
        if (this.kind === 'simulador') return;
        this.usbCapture?.stop();
        this.event(`${who}: usando o SIMULADOR (mesa falsa). Nada é enviado para a Ui24R.`);
        void this.switchMixer('simulador', this.ip);
        return;
      case 'conn.reconnect':
        this.requireAdmin(ctx);
        this.event(this.kind === 'mesa' ? `Reconectando na mesa real em ${this.ip}…` : 'Reiniciando o simulador…');
        void this.switchMixer(this.kind, this.ip);
        return;
      case 'level.detect':
        this.requireAdmin(ctx);
        void detectUsbAudio().then((d) => {
          this.usbDetection = d;
          this.event(
            d.ui24Devices.length
              ? `USB: encontrei ${d.ui24Devices.map((x) => x.name).join(', ')}`
              : 'USB: nenhuma Ui24R encontrada no USB',
          );
        });
        return;
      case 'level.useVu':
        this.requireAdmin(ctx);
        this.useVu();
        return;
      case 'level.useUsb': {
        this.requireAdmin(ctx);
        if (this.kind !== 'mesa') throw new CommandError('Áudio USB só faz sentido com a mesa real.');
        const device = String(cmd.device ?? '').trim();
        const channels = Math.round(Number(cmd.channels));
        if (!device || device.length > 200 || /["\r\n]/.test(device)) throw new CommandError('Escolha um dispositivo de áudio.');
        if (!(channels >= 2 && channels <= 32)) throw new CommandError('Número de canais entre 2 e 32.');
        this.startUsb(device, channels);
        return;
      }
    }
  }

  // ---------- presets (por saída) ----------

  private savePreset(c: BusController, name: string, id: string | undefined, who: string): void {
    const cleanName = String(name ?? '').trim().slice(0, 40);
    if (!cleanName) throw new CommandError('Dê um nome ao preset.');
    const existing = id ? this.presets.get(id) : undefined;
    if (id && !existing) throw new CommandError('Preset não encontrado.');
    const auxes = { ...(existing?.auxes ?? {}) };
    auxes[String(c.bus)] = { channels: c.leveler.exportPreset(), fx: c.follower.exportSends() };
    // a mixagem salva vira a referência dos efeitos (eles param de compensar a partir daqui)
    c.leveler.resetReferences();
    c.follower.resetReferences();
    const preset = this.presets.save({ id, name: cleanName, savedAt: Date.now(), auxes });
    (this.persisted.activePresets ??= {})[String(c.bus)] = preset.id;
    this.dirty = true;
    this.event(`${who}: preset "${preset.name}" ${id ? 'atualizado' : 'salvo'} (${this.labelOf(c.bus)})`);
    this.log.write('preset-salvo', { id: preset.id, name: preset.name, bus: c.bus, quem: who });
  }

  private loadPreset(c: BusController, id: string, who: string): void {
    const preset = this.presets.get(id);
    const data = preset?.auxes[String(c.bus)];
    if (!preset || !data) throw new CommandError('Esse preset não tem dados para esta saída.');
    const now = Date.now();
    const durationMs = Math.max(0, this.cfg.leveler.presetFadeSec * 1000);
    const until = now + durationMs + 1500;
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
    (this.persisted.activePresets ??= {})[String(c.bus)] = preset.id;
    this.dirty = true;
    this.event(`${who}: preset "${preset.name}" carregado em ${this.labelOf(c.bus)} (fade de ${this.cfg.leveler.presetFadeSec} s)`);
    this.log.write('preset', { id: preset.id, name: preset.name, bus: c.bus, quem: who });
  }

  private startFade(bus: number, key: string, from: number | undefined, to: number | null, now: number, durationMs: number): void {
    const fromDB = from ?? Number.NEGATIVE_INFINITY;
    const toDB = to ?? Number.NEGATIVE_INFINITY;
    if (fromDB === toDB || (Number.isFinite(fromDB) && Number.isFinite(toDB) && Math.abs(fromDB - toDB) < 0.05)) return;
    this.fades.set(`${bus}:${key}`, { bus, key, fromDB, toDB, start: now, durationMs: Math.max(1, durationMs) });
  }

  // ---------- estado para o painel (por pessoa) ----------

  /** Saídas que esta pessoa pode usar (para o seletor e para o admin escolher permissões). */
  busChoices(user?: User): BusChoice[] {
    if (!this.wired) return [];
    return this.allBuses()
      .filter((b) => !user || canUseBus(user, b.id))
      .map((b) => ({
        id: b.id,
        label: busLabel(b, b.id),
        name: b.name,
        stereo: b.linkedWith !== undefined,
        mode: this.controllers.get(b.id)?.mode ?? 'desligado',
      }));
  }

  /** Saída que a pessoa vê quando ainda não escolheu: a da live (config), senão a primeira liberada. */
  private defaultBus(user: User): number | undefined {
    const allowed = this.busChoices(user).map((b) => b.id);
    return this.cfg.streamAuxes.find((b) => allowed.includes(b)) ?? allowed.find((b) => b !== MASTER_BUS) ?? allowed[0];
  }

  snapshotFor(ctx: ClientCtx): AppSnapshot {
    const now = Date.now();
    const user = ctx.user;
    const buses = this.busChoices(user);
    if (ctx.view.bus === undefined || !buses.some((b) => b.id === ctx.view.bus)) ctx.view.bus = this.defaultBus(user);
    const c = ctx.view.bus === undefined ? undefined : this.controllers.get(ctx.view.bus);
    const info = c ? this.adapter.listBuses().find((b) => b.id === c.bus) : undefined;

    let bus: ViewedBus | undefined;
    if (c) {
      const out = this.outLevels.get(c.bus);
      bus = {
        bus: c.bus,
        label: busLabel(info, c.bus),
        name: this.adapter.busName(c.bus),
        stereo: info?.linkedWith !== undefined,
        mode: c.mode,
        outDB: out === undefined ? undefined : round1(out),
        masterDB: c.masterDB === undefined || !Number.isFinite(c.masterDB) ? undefined : round1(c.masterDB),
        channels: c.leveler.snapshot(now),
        fx: c.follower.snapshot().map((f) => ({ ...f, inRoom: this.fxInRoom.get(f.key) ?? false })),
      };
    }

    const presets = this.presets
      .list()
      .filter((p) => c && p.auxes[String(c.bus)])
      .map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt }));

    return {
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      mixer: this.mixer,
      source: { kind: this.kind, ip: this.ip },
      user: { username: user.username, role: user.role },
      deadbandDB: this.cfg.leveler.deadbandDB,
      buses,
      bus,
      detail: c && ctx.view.detail ? this.channelDetail(ctx, c, ctx.view.detail, now) : undefined,
      presets,
      activePresetId: c ? this.persisted.activePresets?.[String(c.bus)] : undefined,
      events: this.events.slice(-MAX_EVENTS).reverse(),
      sim: this.sim()?.simState(),
      health: this.health.snapshot(),
      levelSource: {
        kind: this.levelSource.kind,
        device: this.levelSource.device,
        channels: this.levelSource.channels,
        usbState: this.usbCapture?.state,
        usbError: this.usbCapture?.lastError,
        usbAgeMs: this.usbCapture?.lastLevelsAt === undefined ? undefined : now - this.usbCapture.lastLevelsAt,
        detection: this.usbDetection,
      },
    };
  }

  private channelDetail(ctx: ClientCtx, c: BusController, key: string, now: number): ChannelDetail | undefined {
    const ch = c.leveler.snapshot(now).find((s) => s.key === key);
    if (!ch) return undefined;
    const sendOf = (bus: number) => {
      const s = this.controllers.get(bus)?.leveler.snapshot(now).find((x) => x.key === key);
      return s?.sendDB ?? null;
    };
    const otherAuxes = this.busChoices(ctx.user)
      .filter((b) => b.id !== MASTER_BUS && b.id !== c.bus)
      .map((b) => ({ bus: b.id, label: b.label, name: b.name, db: sendOf(b.id) }));
    return {
      key,
      name: ch.name,
      master: { db: sendOf(MASTER_BUS), allowed: canUseBus(ctx.user, MASTER_BUS) },
      busSend: c.bus === MASTER_BUS ? undefined : { bus: c.bus, label: this.labelOf(c.bus), db: ch.sendDB ?? null },
      fx: this.adapter.listFxReturns().map((fx) => {
        const db = this.fxSends.get(`${fx.key}:${key}`);
        return {
          key: fx.key,
          name: fx.name,
          db: db === undefined || !Number.isFinite(db) ? null : round1(db),
          inRoom: this.fxInRoom.get(fx.key) ?? false,
          allowed: this.canEditFx(ctx.user, fx.key),
        };
      }),
      otherAuxes,
      levelDB: ch.rawDB,
      enabled: ch.enabled,
      targetDB: ch.targetDB,
      status: ch.status,
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
    (this.persisted.modes ??= {})[String(c.bus)] = c.mode;
  }

  private persistIfDirty(): void {
    if (!this.dirty || !this.wired) return;
    this.dirty = false;
    for (const c of this.controllers.values()) this.persistController(c);
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
