import { clamp, FLOOR_DB, sumDb } from '../util/db.js';
import {
  type ChannelInfo,
  type ChannelVu,
  type ConnectionState,
  type MixerAdapter,
  type MixerInfo,
  type SendInfo,
  type VuFrame,
  channelKey,
} from './types.js';

/**
 * Mesa falsa para testar o copiloto em casa.
 *
 * Simula uma banda de igreja com momentos diferentes (louvor, pregação, avisos),
 * cada canal com um comportamento (voz falada com pausas, instrumentos contínuos).
 * Pelo painel dá para simular um músico aumentando o volume ou o operador mexendo num envio.
 */

export type Scene = 'louvor' | 'pregacao' | 'avisos';
type Behavior = 'fala' | 'canto' | 'instrumento' | 'percussao';

interface SimChannel {
  info: ChannelInfo;
  behavior: Behavior;
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
  current: number;
}

const BAND: [string, Behavior, number, Scene[]][] = [
  ['Pastor', 'fala', -18, ['pregacao', 'avisos']],
  ['Ministro', 'canto', -16, ['louvor']],
  ['Back 1', 'canto', -22, ['louvor']],
  ['Back 2', 'canto', -23, ['louvor']],
  ['Violão', 'instrumento', -20, ['louvor']],
  ['Guitarra', 'instrumento', -19, ['louvor']],
  ['Baixo', 'instrumento', -17, ['louvor']],
  ['Teclado', 'instrumento', -21, ['louvor', 'pregacao']],
  ['Bumbo', 'percussao', -15, ['louvor']],
  ['Caixa', 'percussao', -16, ['louvor']],
  ['Overhead', 'percussao', -24, ['louvor']],
  ['Avisos', 'fala', -20, ['avisos']],
];

/** Envios iniciais do aux da live (propositalmente desequilibrados). */
const INITIAL_SENDS = [-3, 0, -6, -6, -4, -2, -5, -8, -6, -6, -10, -4];

const INPUTS = 24;
const VU_INTERVAL_MS = 50;

export class SimulatorAdapter implements MixerAdapter {
  private readonly sim: SimChannel[] = [];
  private readonly sends = new Map<string, SendInfo>();
  private readonly sendWatchers = new Map<string, ((info: SendInfo) => void)[]>();
  private vuCb?: (frame: VuFrame) => void;
  private statusCb?: (state: ConnectionState) => void;
  private timer?: NodeJS.Timeout;
  private lastT = Date.now();
  scene: Scene = 'louvor';
  readonly auxCount = 10;

  constructor() {
    for (let n = 1; n <= INPUTS; n++) {
      const def = BAND[n - 1];
      this.sim.push({
        info: { key: channelKey('i', n), kind: 'i', number: n, name: def?.[0] ?? `CH ${n}` },
        behavior: def?.[1] ?? 'instrumento',
        baseDB: def?.[2] ?? FLOOR_DB,
        scenes: def?.[3] ?? [],
        offsetDB: 0,
        drift: 0,
        phraseOn: true,
        phraseUntil: 0,
        current: FLOOR_DB,
      });
    }
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
    return { kind: 'simulador', address: 'simulador', model: 'ui24 (simulada)', firmware: '-', auxCount: this.auxCount };
  }

  async disconnect(): Promise<void> {
    clearInterval(this.timer);
    this.statusCb?.('desconectado');
  }

  listChannels(): ChannelInfo[] {
    return this.sim.map((s) => s.info);
  }

  auxName(aux: number): string {
    return aux === 7 || aux === 8 ? `LIVE ${aux === 7 ? 'L' : 'R'}` : `AUX ${aux}`;
  }

  onVu(cb: (frame: VuFrame) => void): void {
    this.vuCb = cb;
  }

  watchSend(aux: number, key: string, cb: (info: SendInfo) => void): void {
    const id = `${aux}:${key}`;
    if (!this.sends.has(id)) this.sends.set(id, this.initialSend(key));
    this.sendWatchers.set(id, [...(this.sendWatchers.get(id) ?? []), cb]);
    cb(this.sends.get(id)!);
  }

  setSendDB(aux: number, key: string, db: number): void {
    const id = `${aux}:${key}`;
    const current = this.sends.get(id) ?? this.initialSend(key);
    // A mesa real arredonda pela posição do fader; simulamos com passos de 0,1 dB.
    const next = { ...current, db: clamp(Math.round(db * 10) / 10, -80, 10) };
    this.sends.set(id, next);
    for (const cb of this.sendWatchers.get(id) ?? []) cb(next);
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

  private initialSend(key: string): SendInfo {
    const idx = Number(key.slice(1)) - 1;
    const db = INITIAL_SENDS[idx] ?? Number.NEGATIVE_INFINITY;
    return { db, muted: false, postFader: false, postProc: true };
  }

  private step(): void {
    const now = Date.now();
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;

    const channels = new Map<string, ChannelVu>();
    for (const ch of this.sim) {
      const pre = this.levelFor(ch, now, dt);
      // processamento (compressor) segura um pouco os picos
      const post = pre > -20 ? -20 + (pre + 20) * 0.6 - 1 : pre - 1;
      channels.set(ch.info.key, { pre, post, postFader: post });
    }

    const auxOut = new Map<number, number>();
    for (let aux = 1; aux <= this.auxCount; aux++) {
      const contributions: number[] = [];
      for (const ch of this.sim) {
        const send = this.sends.get(`${aux}:${ch.info.key}`);
        const vu = channels.get(ch.info.key)!;
        if (send && !send.muted && Number.isFinite(send.db)) contributions.push(vu.post + send.db);
      }
      auxOut.set(aux, contributions.length ? clamp(sumDb(contributions), FLOOR_DB, 0) : FLOOR_DB);
    }

    this.vuCb?.({ t: now, channels, auxOut });
  }

  private levelFor(ch: SimChannel, now: number, dt: number): number {
    if (!ch.scenes.includes(this.scene)) {
      ch.current = FLOOR_DB;
      return FLOOR_DB + Math.random() * 3; // ruído de fundo
    }

    // dinâmica lenta da música (+-4 dB ao longo de dezenas de segundos)
    ch.drift = clamp(ch.drift + (Math.random() - 0.5) * 0.6 * dt * 10, -4, 4);
    let level = ch.baseDB + ch.offsetDB + ch.drift;

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

    ch.current = clamp(level, FLOOR_DB, 0);
    return ch.current;
  }
}
