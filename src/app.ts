import { canUseBus, type User } from './auth.js';
import type { AppConfig } from './config.js';
import type { ConnectionStore } from './connection-store.js';
import { ConnectionHealth, type HealthSnapshot, isValidHost } from './health.js';
import { AuxLeveler, type ChannelSnapshot, type Mode, type SendAction } from './leveler/aux-leveler.js';
import { FxFollower, type FxSnapshot } from './leveler/fx-follower.js';
import { resolve } from 'node:path';
import { type AdvancedSettings, type AnalysisSnapshot, AnalysisEngine, DEFAULT_ADVANCED } from './analysis/engine.js';
import type { ChannelRole, Moment } from './analysis/moment.js';
import { type AudioSource, detectUsbAudio, UsbAudioCapture, type UsbDetection } from './levels/usb-audio.js';
import { SimulatedAudio } from './mixer/sim-audio.js';
import { SimulatorAdapter, type Scene } from './mixer/simulator.js';
import { ObsClient, type ObsStatus } from './obs.js';
import { ChannelStats, computeTips, type Tip } from './tips.js';
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
  /** pasta de dados (gravações vão em <dataDir>/gravacoes) */
  dataDir: string;
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
  /** pré-amplificador (só entradas): ganho -6..57 dB e phantom 48V */
  preamp?: { gainDB: number; phantom: boolean; gainAllowed: boolean; phantomAllowed: boolean };
  /** espectro em bandas de 1/3 de oitava (só no modo Áudio USB) */
  rta?: number[];
}

/** Recursos avançados (modo Áudio USB): configuração visível no painel (sem a senha do OBS). */
export interface AdvancedInfo {
  active: boolean;
  settings: Omit<AdvancedSettings, 'obs'> & { obs: Omit<AdvancedSettings['obs'], 'password'> & { hasPassword: boolean } };
  analysis?: AnalysisSnapshot;
  obs: ObsStatus;
  channels: { key: string; name: string }[];
  /** presets de cada saída que a pessoa pode usar (para a troca automática fala × música) */
  presetsByBus: { bus: number; label: string; presets: { id: string; name: string }[] }[];
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
  tips: Tip[];
  advanced: AdvancedInfo;
  /** canais com phantom 48V ligado (etiqueta na faixa) */
  phantom: string[];
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
  | { type: 'level.useUsb'; device: string; channels: number }
  | { type: 'setGain'; key: string; db: number }
  | { type: 'setPhantom'; key: string; on: boolean }
  | { type: 'adv.set'; patch: Partial<AdvancedSettings> }
  | { type: 'adv.role'; key: string; role: ChannelRole }
  | { type: 'adv.auto'; bus: number; enabled: boolean; fala?: string | null; musica?: string | null }
  | { type: 'rec.start' }
  | { type: 'rec.stop' }
  | { type: 'loud.reset' }
  | { type: 'obs.filter'; filter: string; enabled: boolean }
  | { type: 'obs.refresh' }
  | { type: 'sim.inject'; key: string; kind: 'microfonia' | 'zumbido' }
  | { type: 'sim.clearInject'; key?: string };

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
  private usbCapture?: AudioSource;
  private usbLevels?: number[];
  private usbDetection?: UsbDetection;
  /** ganho/phantom de cada entrada */
  private readonly preamps = new Map<string, { gainDB: number; phantom: boolean }>();
  /** histórico curto do nível de cada canal, para as dicas */
  private readonly stats = new Map<string, ChannelStats>();
  private advanced: AdvancedSettings = structuredClone(DEFAULT_ADVANCED);
  private engine?: AnalysisEngine;
  private loudCapture?: UsbAudioCapture;
  private readonly obs = new ObsClient();

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
    this.stopAdvanced();
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
    this.preamps.clear();
    this.stats.clear();
    this.stopAdvanced();
    this.usbCapture?.stop();
    this.usbCapture = undefined;
    this.usbLevels = undefined;
    this.levelSource = { kind: 'vu', channels: this.levelSource.channels };
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

    for (const ch of channels) {
      if (ch.kind === 'i') this.adapter.watchPreamp(ch.key, (p) => this.preamps.set(ch.key, p));
    }
    this.advanced = mergeAdvanced(this.persisted.advanced);

    const adapter = this.adapter;
    adapter.onChannelName((key, name) => {
      if (adapter !== this.adapter) return;
      for (const c of this.controllers.values()) {
        c.leveler.setName(key, name);
        c.follower.setName(key, name);
      }
      this.engine?.setNames(this.inputNames());
    });

    adapter.onVu((frame) => {
      if (adapter !== this.adapter) return;
      this.health.onVu();
      this.outLevels = frame.busOut;
      const channelsVu = this.levelsFromSource(frame.channels);
      for (const [key, vu] of channelsVu) {
        if (key.startsWith('f')) continue;
        let st = this.stats.get(key);
        if (!st) this.stats.set(key, (st = new ChannelStats()));
        st.push(vu.pre, frame.t);
      }
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
    if (saved?.kind === 'usb' && (saved.device || this.kind === 'simulador')) {
      this.startUsb(saved.device ?? 'USB simulado', saved.channels ?? 24, false);
    }
  }

  private inputNames(): string[] {
    return this.adapter
      .listChannels()
      .filter((c) => c.kind === 'i')
      .map((c) => this.controllers.get(MASTER_BUS)?.leveler.channelName(c.key) ?? c.name);
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
    this.stopAdvanced();
    this.usbLevels = undefined;
    this.levelSource = { kind: 'usb', device, channels };
    const engine = new AnalysisEngine(this.advanced, channels);
    engine.setNames(this.inputNames());
    engine.onMomentChange = (m) => this.onMoment(m);
    this.engine = engine;
    const onLevels = (levels: number[]) => (this.usbLevels = levels);
    const onBlock = (block: Buffer, ch: number) => this.engine?.feed(block, ch);
    const sim = this.sim();
    this.usbCapture = sim ? new SimulatedAudio(sim, channels, onLevels, onBlock) : new UsbAudioCapture({ device, channels }, onLevels, onBlock);
    this.usbCapture.start();
    this.startAdvancedExtras();
    if (announce) {
      this.event(
        sim
          ? `Nível pelo ÁUDIO USB SIMULADO (${channels} canais): recursos avançados ligados.`
          : `Nível pelo ÁUDIO USB: "${device}" (${channels} canais). Controle continua pela rede. Recursos avançados ligados.`,
      );
    }
    this.persisted.levelSource = { kind: 'usb', device: sim ? undefined : device, channels };
    this.dirty = true;
  }

  private useVu(): void {
    this.stopAdvanced();
    this.usbCapture?.stop();
    this.usbCapture = undefined;
    this.usbLevels = undefined;
    this.levelSource = { kind: 'vu', channels: this.levelSource.channels };
    this.persisted.levelSource = { kind: 'vu' };
    this.dirty = true;
    this.event('Nível pelo VU da mesa (rede). Recursos avançados (USB) desligados.');
  }

  /** Loudness por dispositivo separado e OBS: só existem no modo Áudio USB. */
  private startAdvancedExtras(): void {
    this.loudCapture?.stop();
    this.loudCapture = undefined;
    const l = this.advanced.loudness;
    if (this.engine && l.enabled && l.source === 'device' && l.device && !this.sim()) {
      this.loudCapture = new UsbAudioCapture({ device: l.device, channels: 2 }, () => undefined, (b, ch) =>
        this.engine?.feedLoudnessDevice(b, ch),
      );
      this.loudCapture.start();
    }
    if (this.engine && this.advanced.obs.enabled) this.obs.start(this.advanced.obs);
    else this.obs.stop();
  }

  private stopAdvanced(): void {
    const rec = this.engine?.stopRecording();
    if (rec) this.event(`Gravação encerrada: ${rec.dir}`);
    this.engine?.stop();
    this.engine = undefined;
    this.loudCapture?.stop();
    this.loudCapture = undefined;
    this.obs.stop();
  }

  /** Mudou o momento (fala/música): troca o preset das saídas que pediram isso. */
  private onMoment(m: Moment): void {
    const label = m === 'fala' ? 'FALA (pregação/avisos)' : 'MÚSICA (louvor)';
    this.event(`Momento detectado: ${label}`);
    this.log.write('momento', { momento: m });
    if (m === 'silencio') return;
    for (const [busKey, cfg] of Object.entries(this.advanced.moment.auto)) {
      const presetId = cfg[m];
      const c = this.controllers.get(Number(busKey));
      if (!cfg.enabled || !presetId || !c) continue;
      try {
        this.loadPreset(c, presetId, 'automático (fala × música)');
      } catch (err) {
        this.event(`Troca automática em ${this.labelOf(c.bus)} falhou: ${err instanceof Error ? err.message : err}`);
      }
    }
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
        if (this.sim()) {
          this.startUsb('USB simulado', 24); // no simulador, o "USB" gera áudio de teste
          return;
        }
        const device = String(cmd.device ?? '').trim();
        const channels = Math.round(Number(cmd.channels));
        if (!validDevice(device)) throw new CommandError('Escolha um dispositivo de áudio.');
        if (!(channels >= 2 && channels <= 32)) throw new CommandError('Número de canais entre 2 e 32.');
        this.startUsb(device, channels);
        return;
      }
      case 'setGain': {
        // o ganho vale para TUDO (salão, auxes, gravação): admin ou quem tem o master
        if (ctx.user.role !== 'admin' && !canUseBus(ctx.user, MASTER_BUS)) {
          throw new CommandError('O ganho muda o salão e todas as saídas: só o admin ou quem tem o master pode mexer.');
        }
        if (!/^i\d{1,2}$/.test(cmd.key) || !this.preamps.has(cmd.key)) throw new CommandError('Só canais de entrada têm ganho.');
        const db = Math.round(Math.max(-6, Math.min(57, Number(cmd.db))) * 2) / 2;
        if (!Number.isFinite(db)) throw new CommandError('Ganho inválido.');
        this.adapter.setGainDB(cmd.key, db);
        this.event(`${who}: ganho de ${this.channelName(cmd.key)} → ${db.toFixed(1)} dB`, `gain:${cmd.key}`);
        this.log.write('ganho', { key: cmd.key, db, quem: who });
        return;
      }
      case 'setPhantom': {
        this.requireAdmin(ctx);
        if (!this.preamps.has(cmd.key)) throw new CommandError('Só canais de entrada têm phantom.');
        this.adapter.setPhantom(cmd.key, Boolean(cmd.on));
        this.event(`${who}: phantom 48V de ${this.channelName(cmd.key)} ${cmd.on ? 'LIGADO' : 'desligado'}`);
        this.log.write('phantom', { key: cmd.key, on: Boolean(cmd.on), quem: who });
        return;
      }
      case 'adv.set': {
        this.requireAdmin(ctx);
        const next = mergeAdvanced(sanitizeAdvancedPatch(cmd.patch ?? {}, this.advanced));
        if (next.loudness.device !== undefined && next.loudness.device !== '' && !validDevice(next.loudness.device)) {
          throw new CommandError('Dispositivo de loudness inválido.');
        }
        this.advanced = next;
        this.persisted.advanced = next;
        this.dirty = true;
        this.engine?.configure(next);
        if (this.engine) this.startAdvancedExtras();
        this.event(`${who}: configuração dos recursos avançados atualizada`, 'adv');
        return;
      }
      case 'adv.role': {
        this.requireAdmin(ctx);
        if (!/^i\d{1,2}$/.test(cmd.key) || !['auto', 'fala', 'canto', 'instrumento', 'ignorar'].includes(cmd.role)) {
          throw new CommandError('Papel inválido.');
        }
        this.advanced.moment.roles[cmd.key] = cmd.role;
        this.persisted.advanced = this.advanced;
        this.dirty = true;
        this.engine?.configure(this.advanced);
        return;
      }
      case 'adv.auto': {
        this.requireBus(ctx, cmd.bus);
        const presets = this.presets.list();
        const check = (id: string | null | undefined) => {
          if (!id) return undefined;
          if (!presets.some((p) => p.id === id && p.auxes[String(cmd.bus)])) throw new CommandError('Preset inválido para esta saída.');
          return id;
        };
        this.advanced.moment.auto[String(cmd.bus)] = { enabled: Boolean(cmd.enabled), fala: check(cmd.fala), musica: check(cmd.musica) };
        this.persisted.advanced = this.advanced;
        this.dirty = true;
        this.event(`${who}: troca automática de preset em ${this.labelOf(cmd.bus)} ${cmd.enabled ? 'ligada' : 'desligada'}`);
        return;
      }
      case 'rec.start': {
        this.requireAdmin(ctx);
        if (!this.engine) throw new CommandError('A gravação usa o áudio USB: ligue o modo Áudio USB primeiro.');
        const info = this.engine.startRecording(resolve(this.target.dataDir, 'gravacoes'));
        this.event(`${who}: gravação multipista iniciada em ${info.dir}`);
        return;
      }
      case 'rec.stop': {
        this.requireAdmin(ctx);
        const info = this.engine?.stopRecording();
        if (info) this.event(`${who}: gravação encerrada (${(info.bytes / 1e6).toFixed(0)} MB) em ${info.dir}`);
        return;
      }
      case 'loud.reset':
        this.requireAdmin(ctx);
        this.engine?.resetLoudness();
        this.event(`${who}: loudness integrado zerado`);
        return;
      case 'obs.filter':
        this.requireAdmin(ctx);
        void this.obs
          .setFilterEnabled(String(cmd.filter), Boolean(cmd.enabled))
          .then(() => this.event(`${who}: filtro "${cmd.filter}" do OBS ${cmd.enabled ? 'ligado' : 'desligado'}`))
          .catch((err) => this.event(`OBS: ${err instanceof Error ? err.message : err}`));
        return;
      case 'obs.refresh':
        this.requireAdmin(ctx);
        void this.obs.refresh();
        return;
      case 'sim.inject': {
        const audio = this.usbCapture instanceof SimulatedAudio ? this.usbCapture : undefined;
        if (!audio) throw new CommandError('Ligue o "USB simulado" (tela Conexão) para simular microfonia/zumbido.');
        audio.inject(cmd.key, cmd.kind === 'zumbido' ? 'zumbido' : 'microfonia');
        this.event(`[simulador] ${cmd.kind} injetado em ${this.channelName(cmd.key)}`);
        return;
      }
      case 'sim.clearInject':
        if (this.usbCapture instanceof SimulatedAudio) this.usbCapture.clearInjections(cmd.key);
        return;
    }
  }

  private channelName(key: string): string {
    return this.controllers.get(MASTER_BUS)?.leveler.channelName(key) ?? key;
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
      tips: this.tipsFor(user, bus, now),
      phantom: [...this.preamps].filter(([, p]) => p.phantom).map(([k]) => k),
      advanced: this.advancedInfo(user, ctx.view.detail),
    };
  }

  /** Resumo dos canais (para as dicas), recalculado no máximo 1×/s para todas as pessoas. */
  private summaryCache?: { t: number; list: { key: string; name: string; summary: ReturnType<ChannelStats['summary']> }[] };
  private analysisCache?: { t: number; snap: AnalysisSnapshot };

  private channelSummaries(now: number) {
    if (this.summaryCache && now - this.summaryCache.t < 1000) return this.summaryCache.list;
    const list = [...this.stats.entries()].map(([key, st]) => ({ key, name: this.channelName(key), summary: st.summary(now) }));
    this.summaryCache = { t: now, list };
    return list;
  }

  private analysisSnapshot(now: number): AnalysisSnapshot | undefined {
    if (!this.engine) return undefined;
    if (this.analysisCache && now - this.analysisCache.t < 200) return this.analysisCache.snap;
    const snap = this.engine.snapshot(this.engine.wantRta);
    this.analysisCache = { t: now, snap };
    return snap;
  }

  private tipsFor(user: User, bus: ViewedBus | undefined, now: number): Tip[] {
    return computeTips({
      now,
      channels: this.channelSummaries(now),
      bus: bus && { bus: bus.bus, label: bus.label, mode: bus.mode, outDB: bus.outDB, channels: bus.channels },
      analysis: this.analysisSnapshot(now),
      obs: this.engine && this.advanced.obs.enabled ? this.obs.status : undefined,
    }).filter((t) => t.bus === undefined || canUseBus(user, t.bus));
  }

  /** Pedidos de espectro (painel do canal aberto): a análise só calcula o RTA de quem está sendo visto. */
  private readonly rtaRequests = new Map<string, number>();

  private advancedInfo(user: User, detail: string | undefined): AdvancedInfo {
    const now = Date.now();
    if (detail && this.engine) {
      this.rtaRequests.set(detail, now);
      for (const [k, t] of this.rtaRequests) if (now - t > 3000) this.rtaRequests.delete(k);
      this.engine.wantRta.clear();
      for (const k of this.rtaRequests.keys()) this.engine.wantRta.add(k);
    }
    const { password, ...obs } = this.advanced.obs;
    return {
      active: Boolean(this.engine),
      settings: { ...this.advanced, obs: { ...obs, hasPassword: Boolean(password) } },
      analysis: this.analysisSnapshot(now),
      obs: this.obs.status,
      channels: this.adapter.listChannels().filter((c) => c.kind === 'i').map((c) => ({ key: c.key, name: this.channelName(c.key) })),
      presetsByBus: this.busChoices(user).map((b) => ({
        bus: b.id,
        label: b.id === MASTER_BUS ? 'MASTER' : `${b.label} · ${b.name}`,
        presets: this.presets
          .list()
          .filter((p) => p.auxes[String(b.id)])
          .map((p) => ({ id: p.id, name: p.name })),
      })),
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
      preamp: this.preamps.has(key)
        ? {
            ...this.preamps.get(key)!,
            gainAllowed: ctx.user.role === 'admin' || canUseBus(ctx.user, MASTER_BUS),
            phantomAllowed: ctx.user.role === 'admin',
          }
        : undefined,
      rta: this.analysisSnapshot(now)?.rta[key],
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

/** Nome de dispositivo de áudio aceitável para passar ao ffmpeg. */
function validDevice(device: string): boolean {
  return device.length > 0 && device.length <= 200 && !/["\r\n]/.test(device);
}

/** Configuração completa a partir do que foi salvo (campos novos ganham o valor padrão). */
export function mergeAdvanced(saved?: Partial<AdvancedSettings>): AdvancedSettings {
  const d = structuredClone(DEFAULT_ADVANCED);
  if (!saved) return d;
  return {
    feedback: saved.feedback ?? d.feedback,
    noise: saved.noise ?? d.noise,
    rta: saved.rta ?? d.rta,
    moment: { ...d.moment, ...saved.moment, roles: { ...saved.moment?.roles }, auto: { ...saved.moment?.auto } },
    loudness: { ...d.loudness, ...saved.loudness },
    obs: { ...d.obs, ...saved.obs },
  };
}

/** Aplica só os campos válidos de uma alteração vinda do painel. Senha do OBS vazia = mantém a atual. */
export function sanitizeAdvancedPatch(patch: Partial<AdvancedSettings>, current: AdvancedSettings): AdvancedSettings {
  const next = structuredClone(current);
  if (typeof patch.feedback === 'boolean') next.feedback = patch.feedback;
  if (typeof patch.noise === 'boolean') next.noise = patch.noise;
  if (typeof patch.rta === 'boolean') next.rta = patch.rta;
  if (patch.moment && typeof patch.moment.enabled === 'boolean') next.moment.enabled = patch.moment.enabled;
  const l = patch.loudness;
  if (l) {
    if (typeof l.enabled === 'boolean') next.loudness.enabled = l.enabled;
    if (l.source === 'usb' || l.source === 'device') next.loudness.source = l.source;
    if (Number.isInteger(l.left) && l.left >= 1 && l.left <= 32) next.loudness.left = l.left;
    if (Number.isInteger(l.right) && l.right >= 1 && l.right <= 32) next.loudness.right = l.right;
    if (typeof l.device === 'string') next.loudness.device = l.device.trim();
    if (Number.isFinite(l.target) && l.target >= -30 && l.target <= -5) next.loudness.target = l.target;
  }
  const o = patch.obs;
  if (o) {
    if (typeof o.enabled === 'boolean') next.obs.enabled = o.enabled;
    if (typeof o.host === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(o.host.trim())) next.obs.host = o.host.trim();
    if (Number.isInteger(o.port) && o.port > 0 && o.port < 65536) next.obs.port = o.port;
    if (typeof o.password === 'string' && o.password !== '') next.obs.password = o.password.slice(0, 200);
    if (typeof o.input === 'string') next.obs.input = o.input.slice(0, 200);
  }
  return next;
}
