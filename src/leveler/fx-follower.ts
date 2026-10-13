import type { LevelerConfig } from '../config.js';
import type { SendInfo } from '../mixer/types.js';
import { clamp, dbToPow, powToDb, round1 } from '../util/db.js';
import type { ChannelOffset, Mode, SendAction } from './aux-leveler.js';

export type FxStatus =
  | 'desligado' // "acompanha" desligado para este efeito
  | 'sem-envio' // retorno do efeito fechado no aux da live
  | 'sem-entrada' // nenhum canal que alimenta o efeito tocou recentemente
  | 'transicao'
  | 'ok'
  | 'acompanhando';

export interface FxSnapshot {
  key: string;
  name: string;
  follow: boolean;
  status: FxStatus;
  rawDB?: number;
  sendDB?: number;
  refDB?: number;
  /** compensação calculada a partir dos canais (dB) */
  followDeltaDB?: number;
  /** quanto falta mexer no retorno */
  suggestedDeltaDB: number;
}

interface FxState {
  key: string;
  name: string;
  follow: boolean;
  send?: SendInfo;
  /** envio do retorno na mixagem de referência */
  refDB?: number;
  lastDeltaDB?: number;
  lastCommandedDB?: number;
  lastCommandT: number;
  transitionUntil: number;
  status: FxStatus;
  rawDB?: number;
  suggestedDeltaDB: number;
}

const ECHO_TOLERANCE_DB = 0.3;
const ECHO_WINDOW_MS = 3000;
const MIN_STEP_DB = 0.2;

/**
 * "O efeito acompanha os canais."
 *
 * Problema: quando o envio de um canal para a live abaixa, o reverb dele continua igual
 * (o retorno do efeito tem o seu próprio envio para o aux) e a voz fica "dentro do banheiro".
 *
 * Solução: o retorno de cada efeito no aux da live é ajustado pela média, ponderada em potência,
 * de quanto os canais que alimentam aquele efeito estão acima/abaixo da referência.
 * Se o pastor (único na reverb durante a pregação) desceu 4 dB, a reverb desce 4 dB.
 * Se só um de três backs desceu, a reverb desce um pouco.
 * O som do salão não é tocado: só o envio do retorno de efeito para o aux da live.
 */
export class FxFollower {
  private readonly returns = new Map<string, FxState>();
  /** envio canal -> efeito, `${fxKey}:${channelKey}` */
  private readonly fxSends = new Map<string, number>();
  private mode: Mode = 'observar';
  private lastTickT?: number;

  constructor(
    readonly bus: number,
    private readonly cfg: LevelerConfig,
  ) {}

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  ensureReturn(key: string, name: string, follow = true): void {
    const existing = this.returns.get(key);
    if (existing) {
      existing.name = name;
      return;
    }
    this.returns.set(key, { key, name, follow, lastCommandT: 0, transitionUntil: 0, status: 'sem-entrada', suggestedDeltaDB: 0 });
  }

  setName(key: string, name: string): void {
    const fx = this.returns.get(key);
    if (fx) fx.name = name;
  }

  setFollow(key: string, follow: boolean): void {
    const fx = this.returns.get(key);
    if (!fx) return;
    fx.follow = follow;
    // ao religar, a posição atual vira o ponto de partida
    if (follow && fx.send) fx.refDB = fx.send.db - (fx.lastDeltaDB ?? 0);
  }

  onFxSend(fxKey: string, channelKey: string, db: number): void {
    this.fxSends.set(`${fxKey}:${channelKey}`, db);
  }

  onVu(fxKey: string, db: number): void {
    const fx = this.returns.get(fxKey);
    if (fx) fx.rawDB = db;
  }

  /** Envio do retorno de efeito para o aux. Retorna a mudança se foi o operador. */
  onSend(key: string, info: SendInfo, now: number): { fromDB: number; toDB: number } | undefined {
    const fx = this.returns.get(key);
    if (!fx) return undefined;
    const prev = fx.send?.db;
    fx.send = info;
    if (prev === undefined) {
      fx.refDB = info.db;
      return undefined;
    }
    if (prev === info.db) return undefined;
    const isEcho =
      fx.lastCommandedDB !== undefined &&
      Math.abs(info.db - fx.lastCommandedDB) <= ECHO_TOLERANCE_DB &&
      now - fx.lastCommandT < ECHO_WINDOW_MS;
    if (isEcho) return undefined;
    // operador mexeu no retorno: esse passa a ser o nível desejado com a compensação atual
    fx.refDB = info.db - (fx.lastDeltaDB ?? 0);
    return { fromDB: prev, toDB: info.db };
  }

  markCommanded(key: string, db: number, now: number): void {
    const fx = this.returns.get(key);
    if (!fx) return;
    fx.lastCommandedDB = db;
    fx.lastCommandT = now;
    if (fx.send) fx.send = { ...fx.send, db };
  }

  holdForTransition(key: string, until: number): void {
    const fx = this.returns.get(key);
    if (fx) fx.transitionUntil = until;
  }

  /** Mixagem atual vira referência (gravar alvo / carregar preset). */
  resetReferences(values?: Record<string, number | null>): void {
    for (const fx of this.returns.values()) {
      const v = values?.[fx.key];
      if (values && v !== undefined) fx.refDB = v ?? Number.NEGATIVE_INFINITY;
      else if (fx.send) fx.refDB = fx.send.db;
      fx.lastDeltaDB = 0;
    }
  }

  exportSends(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const fx of this.returns.values()) {
      if (!fx.send) continue;
      out[fx.key] = fx.send.muted || !Number.isFinite(fx.send.db) ? null : fx.send.db;
    }
    return out;
  }

  exportFollow(): Record<string, boolean> {
    return Object.fromEntries([...this.returns.values()].map((fx) => [fx.key, fx.follow]));
  }

  /** Compensação em dB para um efeito: média em potência dos deslocamentos dos canais que o alimentam. */
  followDelta(fxKey: string, offsets: ChannelOffset[]): number | undefined {
    let weightSum = 0;
    let scaledSum = 0;
    for (const ch of offsets) {
      const send = this.fxSends.get(`${fxKey}:${ch.key}`);
      if (send === undefined || !Number.isFinite(send) || ch.levelDB === undefined || !ch.recent) continue;
      const w = dbToPow(ch.levelDB + send);
      weightSum += w;
      scaledSum += w * (Number.isFinite(ch.offsetDB) ? dbToPow(ch.offsetDB) : 0);
    }
    if (weightSum === 0) return undefined;
    return powToDb(scaledSum / weightSum);
  }

  tick(now: number, offsets: ChannelOffset[]): SendAction[] {
    const dt = this.lastTickT === undefined ? 0 : clamp((now - this.lastTickT) / 1000, 0, 2);
    this.lastTickT = now;
    const actions: SendAction[] = [];

    for (const fx of this.returns.values()) {
      fx.suggestedDeltaDB = 0;
      const send = fx.send;
      if (!fx.follow) {
        fx.status = 'desligado';
        continue;
      }
      if (!send || send.muted || !Number.isFinite(send.db) || fx.refDB === undefined || !Number.isFinite(fx.refDB)) {
        fx.status = 'sem-envio';
        continue;
      }
      if (now < fx.transitionUntil) {
        fx.status = 'transicao';
        continue;
      }
      const delta = this.followDelta(fx.key, offsets);
      if (delta === undefined) {
        fx.status = 'sem-entrada';
        continue;
      }
      fx.lastDeltaDB = delta;

      const lo = fx.refDB - this.cfg.fxMaxCutDB;
      const hi = Math.min(fx.refDB + this.cfg.fxMaxBoostDB, this.cfg.maxSendDB);
      const wanted = clamp(fx.refDB + delta, lo, hi);
      const remaining = wanted - send.db;
      fx.suggestedDeltaDB = round1(remaining);

      if (Math.abs(remaining) < MIN_STEP_DB) {
        fx.status = 'ok';
        continue;
      }
      fx.status = 'acompanhando';
      const maxStep = this.cfg.fxRateDBps * dt;
      const step = clamp(remaining, -maxStep, maxStep);
      if (Math.abs(step) >= 0.05) {
        actions.push({ bus: this.bus, key: fx.key, fromDB: send.db, toDB: round1(send.db + step), reason: 'efeito' });
      }
    }
    return this.mode === 'automatico' ? actions : [];
  }

  snapshot(): FxSnapshot[] {
    return [...this.returns.values()].map((fx) => ({
      key: fx.key,
      name: fx.name,
      follow: fx.follow,
      status: fx.status,
      rawDB: fx.rawDB === undefined ? undefined : round1(fx.rawDB),
      sendDB: fx.send && Number.isFinite(fx.send.db) && !fx.send.muted ? round1(fx.send.db) : undefined,
      refDB: fx.refDB !== undefined && Number.isFinite(fx.refDB) ? round1(fx.refDB) : undefined,
      followDeltaDB: fx.lastDeltaDB === undefined ? undefined : round1(fx.lastDeltaDB),
      suggestedDeltaDB: fx.suggestedDeltaDB,
    }));
  }
}
