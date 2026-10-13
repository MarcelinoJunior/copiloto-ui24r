import { clamp, dbToPow, FLOOR_DB, powToDb, sumDb } from '../util/db.js';
import { DEFAULT_EQ_RAW } from './eq.js';
import {
  type BusInfo,
  type ChannelInfo,
  type ChannelVu,
  type ConnectionState,
  type MixerAdapter,
  type MixerInfo,
  type SendInfo,
  type Unsubscribe,
  type VuFrame,
  MASTER_BUS,
  channelKey,
  tapForSend,
} from './types.js';

/**
 * Mesa falsa para testar o copiloto em casa.
 *
 * Simula uma banda de igreja com momentos diferentes (louvor, pregação, avisos),
 * cada canal com um comportamento (voz falada com pausas, instrumentos contínuos),
 * 4 efeitos (com cauda de reverb), master, retornos e a live nos auxes 7+8 em link estéreo.
 * O FX 4 é um reverb só da live (não vai para o salão), para testar envios de efeito por canal.
 */

export type Scene = 'louvor' | 'pregacao' | 'avisos';
export type Behavior = 'fala' | 'canto' | 'instrumento' | 'percussao';

interface SimChannel {
  info: ChannelInfo;
  behavior: Behavior;
  /** ganho do pré (dB); 30 dB é o "normal" do simulador */
  gainDB: number;
  phantom: boolean;
  /** último nível pré-processamento calculado (dBFS), usado pelo áudio USB simulado */
  lastPre: number;
  /** nível médio quando toca (dB no VU pré-processamento) */
  baseDB: number;
  scenes: Scene[];
  /** "músico aumentou o volume": deslocamento aplicado pelo painel */
  offsetDB: number;
  /** variação lenta (dinâmica da música) */
  drift: number;
  /** fala: alterna entre frase e pausa */
  phraseOn: boolean;
  phraseUntil: number;
}

// nome, comportamento, nível, momentos, envios para FX1..FX4 (dB)
const BAND: [string, Behavior, number, Scene[], (number | null)[]][] = [
  ['Pastor', 'fala', -18, ['pregacao', 'avisos'], [-12, null, null, null]],
  ['Ministro', 'canto', -16, ['louvor'], [-10, -18, null, null]],
  ['Back 1', 'canto', -22, ['louvor'], [-12, null, null, null]],
  ['Back 2', 'canto', -23, ['louvor'], [-12, null, null, null]],
  ['Violão', 'instrumento', -20, ['louvor'], [-18, null, null, null]],
  ['Guitarra', 'instrumento', -19, ['louvor'], [null, -20, null, null]],
  ['Baixo', 'instrumento', -17, ['louvor'], [null, null, null, null]],
  ['Teclado', 'instrumento', -21, ['louvor', 'pregacao'], [-20, null, null, null]],
  ['Bumbo', 'percussao', -15, ['louvor'], [null, null, -20, null]],
  ['Caixa', 'percussao', -16, ['louvor'], [null, null, -10, null]],
  ['Overhead', 'percussao', -24, ['louvor'], [null, null, -14, null]],
  ['Avisos', 'fala', -20, ['avisos'], [-14, null, null, null]],
];

const FX_NAMES = ['Reverb Voz', 'Delay', 'Reverb Bateria', 'Reverb Live'];
/** Quanto o efeito "devolve" em relação ao que entra, e quanto tempo a cauda dura. */
const FX_RETURN_GAIN_DB = -2;
const FX_TAIL_SEC = [1.8, 0.8, 1.2, 2.2];

const AUX_NAMES = ['Retorno Ministro', 'Retorno Banda', 'Retorno Bateria', 'Fone Teclado', 'AUX 5', 'AUX 6', 'LIVE', 'LIVE', 'AUX 9', 'AUX 10'];
const LINKED: [number, number][] = [[7, 8]];

const NEG = Number.NEGATIVE_INFINITY;
/** Valores iniciais dos envios, por bus. 0 = master (fader do canal). */
const INITIAL: Record<number, { ch: number[]; fx: number[] }> = {
  [MASTER_BUS]: { ch: [0, 0, -3, -3, -2, -4, -2, -3, -1, -2, -6, 0], fx: [-2, -6, -4, NEG] },
  1: { ch: [NEG, 0, -6, -6, -8, NEG, -10, -6], fx: [-10, NEG, NEG, NEG] },
  2: { ch: [NEG, -4, NEG, NEG, -4, 0, -2, -4, -6, -6], fx: [NEG, NEG, NEG, NEG] },
  // live (7+8): propositalmente desequilibrada
  7: { ch: [-3, 0, -6, -6, -4, -2, -5, -8, -6, -6, -10, -4], fx: [-4, -10, -8, -6] },
};

const INPUTS = 24;
const AUXES = 10;
const VU_INTERVAL_MS = 50;

export class SimulatorAdapter implements MixerAdapter {
  private readonly sim: SimChannel[] = [];
  private readonly fx: ChannelInfo[] = [];
  /** envio canal -> efeito: `${fx}:${key}` */
  private readonly fxSends = new Map<string, number>();
  private readonly fxPow = [0, 0, 0, 0];
  /** envio canal -> bus: `${bus}:${key}` */
  private readonly sends = new Map<string, SendInfo>();
  private readonly busMaster = new Map<number, number>();
  private readonly watchers = new Map<string, Set<(v: never) => void>>();
  private vuCb?: (frame: VuFrame) => void;
  private statusCb?: (state: ConnectionState) => void;
  private timer?: NodeJS.Timeout;
  private lastT = Date.now();
  scene: Scene = 'louvor';

  constructor() {
    for (let n = 1; n <= INPUTS; n++) {
      const def = BAND[n - 1];
      const key = channelKey('i', n);
      this.sim.push({
        info: { key, kind: 'i', number: n, name: def?.[0] ?? `CH ${n}` },
        behavior: def?.[1] ?? 'instrumento',
        baseDB: def?.[2] ?? FLOOR_DB,
        scenes: def?.[3] ?? [],
        offsetDB: 0,
        drift: 0,
        phraseOn: true,
        phraseUntil: 0,
        gainDB: 30,
        phantom: false,
        lastPre: FLOOR_DB,
      });
      (def?.[4] ?? []).forEach((db, idx) => db !== null && this.fxSends.set(`${idx + 1}:${key}`, db));
    }
    FX_NAMES.forEach((name, idx) => this.fx.push({ key: channelKey('f', idx + 1), kind: 'f', number: idx + 1, name }));
  }

  onStatus(cb: (state: ConnectionState) => void): void {
    this.statusCb = cb;
  }

  onChannelName(): void {
    // nomes do simulador não mudam
  }

  async connect(): Promise<MixerInfo> {
    this.statusCb?.('conectado');
    this.timer = setInterval(() => this.step(), VU_INTERVAL_MS);
    return { kind: 'simulador', address: 'simulador', model: 'ui24 (simulada)', firmware: '-', auxCount: AUXES };
  }

  async disconnect(): Promise<void> {
    clearInterval(this.timer);
    this.statusCb?.('desconectado');
  }

  listChannels(): ChannelInfo[] {
    return this.sim.map((s) => s.info);
  }

  listFxReturns(): ChannelInfo[] {
    return this.fx;
  }

  listBuses(): BusInfo[] {
    const buses: BusInfo[] = [{ id: MASTER_BUS, name: 'Master (salão)', isMatrix: false }];
    for (let aux = 1; aux <= AUXES; aux++) {
      buses.push({ id: aux, name: AUX_NAMES[aux - 1], linkedWith: this.linkedWith(aux), isMatrix: false });
    }
    return buses;
  }

  busName(bus: number): string {
    return bus === MASTER_BUS ? 'Master (salão)' : AUX_NAMES[bus - 1] ?? `AUX ${bus}`;
  }

  onVu(cb: (frame: VuFrame) => void): void {
    this.vuCb = cb;
  }

  onRawMessage(): void {
    // no simulador não há mensagens de rede; o VU já conta como dado recebido
  }

  watchSend(bus: number, key: string, cb: (info: SendInfo) => void): Unsubscribe {
    const id = `send:${bus}:${key}`;
    cb(this.getSend(bus, key));
    return this.watch(id, cb);
  }

  setSendDB(bus: number, key: string, db: number): void {
    // Aux em link estéreo: a mesa espelha o envio no aux par.
    for (const b of [bus, this.linkedWith(bus)].filter((x): x is number => x !== undefined)) {
      const next = { ...this.getSend(b, key), db: quantize(db) };
      this.sends.set(`${b}:${key}`, next);
      this.emit(`send:${b}:${key}`, next);
    }
  }

  setSendMute(bus: number, key: string, muted: boolean): void {
    for (const b of [bus, this.linkedWith(bus)].filter((x): x is number => x !== undefined)) {
      const next = { ...this.getSend(b, key), muted };
      this.sends.set(`${b}:${key}`, next);
      this.emit(`send:${b}:${key}`, next);
    }
  }

  private readonly eqs = new Map<string, Record<string, number>>();

  watchEq(key: string, cb: (raw: Record<string, number>) => void): Unsubscribe {
    if (!key.startsWith('i')) return () => undefined;
    cb(this.eqs.get(key) ?? { ...DEFAULT_EQ_RAW });
    return this.watch(`eq:${key}`, cb);
  }

  setEqRaw(key: string, param: string, value: number): void {
    const eq = { ...(this.eqs.get(key) ?? DEFAULT_EQ_RAW), [param]: clamp(value, 0, 1) };
    this.eqs.set(key, eq);
    this.emit(`eq:${key}`, eq);
  }

  watchFxSend(fx: number, key: string, cb: (db: number) => void): Unsubscribe {
    cb(this.fxSends.get(`${fx}:${key}`) ?? NEG);
    return this.watch(`fx:${fx}:${key}`, cb);
  }

  setFxSendDB(fx: number, key: string, db: number): void {
    const value = quantize(db);
    this.fxSends.set(`${fx}:${key}`, value);
    this.emit(`fx:${fx}:${key}`, value);
  }

  watchPreamp(key: string, cb: (p: { gainDB: number; phantom: boolean }) => void): Unsubscribe {
    const ch = this.sim.find((s) => s.info.key === key);
    if (!ch) return () => undefined;
    cb({ gainDB: ch.gainDB, phantom: ch.phantom });
    return this.watch(`pre:${key}`, cb);
  }

  setGainDB(key: string, db: number): void {
    const ch = this.sim.find((s) => s.info.key === key);
    if (!ch) return;
    ch.gainDB = Math.round(clamp(db, -6, 57) * 10) / 10;
    this.emit(`pre:${key}`, { gainDB: ch.gainDB, phantom: ch.phantom });
  }

  setPhantom(key: string, on: boolean): void {
    const ch = this.sim.find((s) => s.info.key === key);
    if (!ch) return;
    ch.phantom = on;
    this.emit(`pre:${key}`, { gainDB: ch.gainDB, phantom: ch.phantom });
  }

  /** Para o áudio USB simulado: comportamento e nível atual de cada canal. */
  audioProfile(): { key: string; name: string; behavior: Behavior; preDb: number; index: number }[] {
    return this.sim.map((s, index) => ({ key: s.info.key, name: s.info.name, behavior: s.behavior, preDb: s.lastPre, index }));
  }

  watchBusMaster(bus: number, cb: (db: number) => void): Unsubscribe {
    cb(this.busMaster.get(bus) ?? 0);
    return this.watch(`master:${bus}`, cb);
  }

  setBusMasterDB(bus: number, db: number): void {
    for (const b of [bus, this.linkedWith(bus)].filter((x): x is number => x !== undefined)) {
      const value = quantize(db);
      this.busMaster.set(b, value);
      this.emit(`master:${b}`, value);
    }
  }

  // ---- controles do painel (só existem no simulador) ----

  setScene(scene: Scene): void {
    this.scene = scene;
  }

  /** Simula o músico aumentando/diminuindo o volume do instrumento (ou o pastor falando mais alto). */
  changeSource(key: string, deltaDB: number): void {
    const ch = this.sim.find((s) => s.info.key === key);
    if (ch) ch.offsetDB = clamp(ch.offsetDB + deltaDB, -20, 20);
  }

  resetSources(): void {
    for (const ch of this.sim) ch.offsetDB = 0;
  }

  simState(): { scene: Scene; offsets: Record<string, number> } {
    const offsets: Record<string, number> = {};
    for (const ch of this.sim) if (ch.offsetDB !== 0) offsets[ch.info.key] = ch.offsetDB;
    return { scene: this.scene, offsets };
  }

  // ---- internos ----

  private linkedWith(bus: number): number | undefined {
    for (const [a, b] of LINKED) {
      if (bus === a) return b;
      if (bus === b) return a;
    }
    return undefined;
  }

  private watch(id: string, cb: (v: never) => void): Unsubscribe {
    const set = this.watchers.get(id) ?? new Set();
    set.add(cb);
    this.watchers.set(id, set);
    return () => set.delete(cb);
  }

  private emit(id: string, value: unknown): void {
    for (const cb of this.watchers.get(id) ?? []) (cb as (v: unknown) => void)(value);
  }

  private getSend(bus: number, key: string): SendInfo {
    const existing = this.sends.get(`${bus}:${key}`);
    if (existing) return existing;
    const source = INITIAL[bus] ?? INITIAL[this.linkedWith(bus) ?? -1];
    const idx = Number(key.slice(1)) - 1;
    const db = (key.startsWith('f') ? source?.fx[idx] : source?.ch[idx]) ?? NEG;
    // master: o "envio" é o fader (VU pós-processamento); auxes de retorno pós-fader; live pré-fader
    const info: SendInfo = { db, muted: false, postFader: bus !== MASTER_BUS && bus < 7, postProc: true };
    this.sends.set(`${bus}:${key}`, info);
    return info;
  }

  private step(): void {
    const now = Date.now();
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;

    const channels = new Map<string, ChannelVu>();
    for (const ch of this.sim) {
      const pre = this.levelFor(ch, now, dt);
      ch.lastPre = pre;
      // processamento (compressor) segura um pouco os picos
      const post = pre > -20 ? -20 + (pre + 20) * 0.6 - 1 : pre - 1;
      const fader = this.getSend(MASTER_BUS, ch.info.key);
      const postFader = fader.muted || !Number.isFinite(fader.db) ? FLOOR_DB : clamp(post + fader.db, FLOOR_DB, 0);
      channels.set(ch.info.key, { pre, post, postFader });
    }

    // efeitos: soma do que entra, com uma cauda que decai devagar (o "reverb")
    for (const fx of this.fx) {
      const inputs = this.sim
        .map((ch) => {
          const send = this.fxSends.get(`${fx.number}:${ch.info.key}`);
          return send === undefined || !Number.isFinite(send) ? undefined : channels.get(ch.info.key)!.postFader + send;
        })
        .filter((v): v is number => v !== undefined);
      const input = inputs.length ? dbToPow(sumDb(inputs) + FX_RETURN_GAIN_DB) : 0;
      const idx = fx.number - 1;
      const decay = Math.exp(-dt / FX_TAIL_SEC[idx]);
      this.fxPow[idx] = Math.max(input, this.fxPow[idx] * decay);
      const level = clamp(powToDb(this.fxPow[idx]), FLOOR_DB, 0);
      channels.set(fx.key, { pre: level, post: level, postFader: level });
    }

    const busOut = new Map<number, number>();
    for (let bus = MASTER_BUS; bus <= AUXES; bus++) {
      const contributions: number[] = [];
      for (const [key, vu] of channels) {
        const send = this.getSend(bus, key);
        if (!send.muted && Number.isFinite(send.db)) contributions.push(tapForSend(vu, send) + send.db);
      }
      const master = this.busMaster.get(bus) ?? 0;
      busOut.set(bus, contributions.length ? clamp(sumDb(contributions) + master, FLOOR_DB, 0) : FLOOR_DB);
    }

    this.vuCb?.({ t: now, channels, busOut });
  }

  private levelFor(ch: SimChannel, now: number, dt: number): number {
    if (!ch.scenes.includes(this.scene)) return FLOOR_DB + Math.random() * 3; // ruído de fundo

    // dinâmica lenta da música (+-4 dB ao longo de dezenas de segundos)
    ch.drift = clamp(ch.drift + (Math.random() - 0.5) * 0.6 * dt * 10, -4, 4);
    let level = ch.baseDB + ch.offsetDB + ch.drift + (ch.gainDB - 30);

    if (ch.behavior === 'fala' || ch.behavior === 'canto') {
      if (now > ch.phraseUntil) {
        ch.phraseOn = !ch.phraseOn;
        const [min, max] = ch.phraseOn ? [1500, 6000] : ch.behavior === 'fala' ? [400, 2000] : [800, 4000];
        ch.phraseUntil = now + min + Math.random() * (max - min);
      }
      if (!ch.phraseOn) return FLOOR_DB + Math.random() * 6;
      level += (Math.random() - 0.5) * 10; // sílabas
    } else if (ch.behavior === 'percussao') {
      level += Math.random() < 0.3 ? 4 : -6 * Math.random(); // batidas
    } else {
      level += (Math.random() - 0.5) * 4;
    }
    return clamp(level, FLOOR_DB, 0);
  }
}

function quantize(db: number): number {
  return Number.isFinite(db) ? clamp(Math.round(db * 10) / 10, -80, 10) : db;
}
