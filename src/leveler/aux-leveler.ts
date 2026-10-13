import type { LevelerConfig } from '../config.js';
import { type ChannelVu, type SendInfo, tapForSend } from '../mixer/types.js';
import { clamp, round1 } from '../util/db.js';
import { GatedLevel } from './gated-level.js';

export type Mode = 'desligado' | 'observar' | 'automatico';

export type ChannelStatus =
  | 'desabilitado' // operador tirou o canal do controle
  | 'sem-envio' // envio mutado ou todo para baixo
  | 'sem-alvo' // ainda não sabemos o nível desejado
  | 'manual' // operador mexeu há pouco; esperando
  | 'transicao' // carregando um preset (fade em andamento)
  | 'silencio' // canal não está tocando
  | 'aguardando' // começou a tocar há pouco
  | 'ok' // dentro da tolerância
  | 'corrigindo' // fora do alvo, ajustando aos poucos
  | 'no-limite'; // precisa de mais correção do que o permitido

export interface SendAction {
  bus: number;
  key: string;
  fromDB: number;
  toDB: number;
  reason: 'correcao' | 'restaurar' | 'efeito' | 'preset';
}

export interface ChannelSnapshot {
  key: string;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  /** VU instantâneo no ponto do envio */
  rawDB?: number;
  /** nível médio do canal enquanto toca */
  levelDB?: number;
  sendDB?: number;
  /** envio mutado na mesa (o fader continua onde está) */
  muted: boolean;
  baseSendDB?: number;
  targetDB?: number;
  /** quanto o canal pesa no aux agora (nível + envio) */
  contributionDB?: number;
  /** correção total que o software aplicaria agora, dentro dos limites */
  suggestedDeltaDB: number;
  manualForSec: number;
}

export interface PersistedChannel {
  enabled: boolean;
  targetDB?: number;
}

/** O que um preset guarda de cada canal. */
export interface PresetChannel {
  sendDB: number | null; // null = envio todo para baixo (-∞)
  targetDB?: number;
}

/** Informação que o "efeito acompanha" precisa de cada canal. */
export interface ChannelOffset {
  key: string;
  levelDB?: number;
  /** quanto o envio está acima/abaixo da referência (mixagem gravada); -Infinity se fechado */
  offsetDB: number;
  /** tocou nos últimos segundos */
  recent: boolean;
}

interface ChannelState {
  key: string;
  name: string;
  enabled: boolean;
  targetDB?: number;
  send?: SendInfo;
  /** envio "original" escolhido pelo operador; as correções são limitadas em torno dele */
  baseSendDB?: number;
  lastCommandedDB?: number;
  lastCommandT: number;
  manualUntil: number;
  transitionUntil: number;
  /** envio na mixagem de referência (gravada/preset); usado pelo "efeito acompanha" */
  refSendDB?: number;
  correcting: boolean;
  level: GatedLevel;
  rawDB?: number;
  status: ChannelStatus;
  suggestedDeltaDB: number;
}

/** Diferença tolerada entre o valor que mandamos e o que a mesa devolve (arredondamento do fader). */
const ECHO_TOLERANCE_DB = 0.3;
const ECHO_WINDOW_MS = 3000;
const MIN_STEP_DB = 0.05;

/**
 * Cuida do equilíbrio de UM auxiliar de transmissão.
 *
 * Ideia: cada canal tem um nível-alvo de "contribuição" para o aux (nível do canal + envio).
 * Quando o canal toca mais alto ou mais baixo que o normal, o envio é corrigido devagar,
 * dentro de limites em torno da mixagem original do operador.
 *
 * Como o VU é medido ANTES do envio, mexer no envio não altera a medição: o controle
 * não oscila.
 */
export class AuxLeveler {
  private readonly channels = new Map<string, ChannelState>();
  private mode: Mode = 'observar';
  private lastTickT?: number;
  outDB?: number;

  constructor(
    readonly bus: number,
    private readonly cfg: LevelerConfig,
  ) {}

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  ensureChannel(key: string, name: string, persisted?: PersistedChannel): void {
    const existing = this.channels.get(key);
    if (existing) {
      existing.name = name;
      return;
    }
    this.channels.set(key, {
      key,
      name,
      enabled: persisted?.enabled ?? true,
      targetDB: persisted?.targetDB,
      lastCommandT: 0,
      manualUntil: 0,
      transitionUntil: 0,
      correcting: false,
      level: new GatedLevel(this.cfg.averagingSec, this.cfg.gateDB, this.cfg.releaseSec),
      status: 'sem-alvo',
      suggestedDeltaDB: 0,
    });
  }

  setName(key: string, name: string): void {
    const ch = this.channels.get(key);
    if (ch) ch.name = name;
  }

  setEnabled(key: string, enabled: boolean): void {
    const ch = this.channels.get(key);
    if (ch) ch.enabled = enabled;
  }

  setTarget(key: string, targetDB: number | undefined): void {
    const ch = this.channels.get(key);
    if (ch) ch.targetDB = targetDB === undefined ? undefined : round1(targetDB);
  }

  nudgeTarget(key: string, deltaDB: number): void {
    const ch = this.channels.get(key);
    if (ch?.targetDB !== undefined) ch.targetDB = round1(ch.targetDB + deltaDB);
  }

  /**
   * Recebe o estado do envio vindo da mesa. Detecta quando foi o operador que mexeu.
   * Retorna a mudança feita pelo operador (ou undefined se não foi o operador).
   */
  onSend(key: string, info: SendInfo, now: number): { fromDB: number; toDB: number } | undefined {
    const ch = this.channels.get(key);
    if (!ch) return undefined;
    const prevDB = ch.send?.db;
    ch.send = info;

    if (prevDB === undefined) {
      ch.baseSendDB = info.db;
      ch.refSendDB = info.db;
      return undefined;
    }
    if (prevDB === info.db) return undefined;

    const isEcho =
      ch.lastCommandedDB !== undefined &&
      Math.abs(info.db - ch.lastCommandedDB) <= ECHO_TOLERANCE_DB &&
      now - ch.lastCommandT < ECHO_WINDOW_MS;
    if (isEcho) return undefined;

    // Foi o operador (ou outro app) que mexeu: a escolha dele vira a nova referência.
    ch.baseSendDB = info.db;
    ch.correcting = false;
    ch.transitionUntil = 0;
    if (this.mode !== 'desligado') ch.manualUntil = now + this.cfg.manualHoldSec * 1000;
    // Aprende em qualquer modo: assim o alvo sempre reflete a mixagem que o operador quer
    // (importante para presets montados com o automático desligado).
    const delta = info.db - prevDB;
    if (this.cfg.learnFromOperator && ch.targetDB !== undefined && Number.isFinite(delta)) {
      ch.targetDB = round1(ch.targetDB + delta);
    }
    return { fromDB: prevDB, toDB: info.db };
  }

  channelName(key: string): string {
    return this.channels.get(key)?.name ?? key;
  }

  onVu(key: string, vu: ChannelVu, now: number): void {
    const ch = this.channels.get(key);
    if (!ch?.send) return;
    const db = tapForSend(vu, ch.send);
    ch.rawDB = db;
    ch.level.update(db, now);
  }

  /** Registra que mandamos um valor para a mesa, para não confundir o eco com o operador. */
  markCommanded(key: string, db: number, now: number): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    ch.lastCommandedDB = db;
    ch.lastCommandT = now;
    if (ch.send) ch.send = { ...ch.send, db };
  }

  tick(now: number): SendAction[] {
    const dt = this.lastTickT === undefined ? 0 : clamp((now - this.lastTickT) / 1000, 0, 2);
    this.lastTickT = now;
    const actions: SendAction[] = [];

    for (const ch of this.channels.values()) {
      ch.suggestedDeltaDB = 0;
      const send = ch.send;
      const level = ch.level.levelDB;

      if (!ch.enabled) {
        ch.status = 'desabilitado';
      } else if (!send || send.muted || !Number.isFinite(send.db)) {
        ch.status = 'sem-envio';
      } else if (ch.targetDB === undefined) {
        ch.status = 'sem-alvo';
      } else if (now < ch.transitionUntil) {
        ch.status = 'transicao';
      } else if (now < ch.manualUntil) {
        ch.status = 'manual';
      } else if (!ch.level.isActive(now) || level === undefined) {
        ch.status = 'silencio';
        ch.correcting = false;
      } else if (ch.level.activeForSec(now) < this.cfg.minActiveSec) {
        ch.status = 'aguardando';
      } else {
        const action = this.decide(ch, send, level, ch.targetDB, dt);
        if (action) actions.push(action);
      }
    }
    return this.mode === 'automatico' ? actions : [];
  }

  private decide(ch: ChannelState, send: SendInfo, level: number, target: number, dt: number): SendAction | undefined {
    const base = Number.isFinite(ch.baseSendDB) ? (ch.baseSendDB as number) : send.db;
    const lo = base - this.cfg.maxCutDB;
    const hi = Math.min(base + this.cfg.maxBoostDB, this.cfg.maxSendDB);

    const error = level + send.db - target;
    const desired = clamp(send.db - error, lo, hi);
    ch.suggestedDeltaDB = round1(desired - send.db);

    // Histerese: começa a corrigir fora da tolerância e só para bem perto do alvo.
    if (Math.abs(error) > this.cfg.deadbandDB) ch.correcting = true;
    else if (Math.abs(error) < this.cfg.deadbandDB * 0.4) ch.correcting = false;

    if (!ch.correcting) {
      ch.status = 'ok';
      return undefined;
    }

    const remaining = desired - send.db;
    if (Math.abs(remaining) < MIN_STEP_DB) {
      ch.status = 'no-limite';
      return undefined;
    }

    ch.status = 'corrigindo';
    const maxStep = (remaining < 0 ? this.cfg.cutRateDBps : this.cfg.boostRateDBps) * dt;
    const step = clamp(remaining, -maxStep, maxStep);
    if (Math.abs(step) < MIN_STEP_DB) return undefined;

    return { bus: this.bus, key: ch.key, fromDB: send.db, toDB: round1(send.db + step), reason: 'correcao' };
  }

  /**
   * "Esta mixagem está boa": o nível atual de cada canal que tocou recentemente vira o alvo,
   * e o envio atual vira a referência para os limites.
   */
  captureTargets(now: number, recentSec = 30): number {
    let captured = 0;
    for (const ch of this.channels.values()) {
      const level = ch.level.levelDB;
      if (!ch.enabled || !ch.send || ch.send.muted || !Number.isFinite(ch.send.db) || level === undefined) continue;
      if (ch.level.silentForSec(now) > recentSec) continue;
      ch.targetDB = round1(level + ch.send.db);
      ch.baseSendDB = ch.send.db;
      ch.correcting = false;
      captured++;
    }
    this.resetReferences();
    return captured;
  }

  /** A mixagem atual vira a referência do "efeito acompanha" (efeitos param de compensar). */
  resetReferences(): void {
    for (const ch of this.channels.values()) if (ch.send) ch.refSendDB = ch.send.db;
  }

  /** Quanto cada canal está acima/abaixo da referência, para o "efeito acompanha". */
  offsets(now: number, recentSec = 20): ChannelOffset[] {
    return [...this.channels.values()].map((ch) => {
      const send = ch.send;
      const open = send && !send.muted && Number.isFinite(send.db);
      const ref = ch.refSendDB;
      const offsetDB =
        !open || ref === undefined || !Number.isFinite(ref) ? Number.NEGATIVE_INFINITY : send.db - ref;
      return { key: ch.key, levelDB: ch.level.levelDB, offsetDB, recent: ch.level.silentForSec(now) <= recentSec };
    });
  }

  /** Tira o canal do controle automático durante um fade (carregamento de preset). */
  holdForTransition(key: string, until: number): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    ch.transitionUntil = until;
    ch.correcting = false;
  }

  /** Preset carregado: alvos, limites e referência passam a ser os do preset. */
  applyPreset(channels: Record<string, PresetChannel>): void {
    for (const [key, p] of Object.entries(channels)) {
      const ch = this.channels.get(key);
      if (!ch) continue;
      const send = p.sendDB ?? Number.NEGATIVE_INFINITY;
      ch.baseSendDB = send;
      ch.refSendDB = send;
      if (p.targetDB !== undefined) ch.targetDB = p.targetDB;
      ch.correcting = false;
    }
  }

  exportPreset(): Record<string, PresetChannel> {
    const out: Record<string, PresetChannel> = {};
    for (const ch of this.channels.values()) {
      if (!ch.send) continue;
      const db = ch.send.muted || !Number.isFinite(ch.send.db) ? null : ch.send.db;
      out[ch.key] = { sendDB: db, targetDB: ch.targetDB };
    }
    return out;
  }

  /** Botão de pânico: volta todos os envios para a mixagem original do operador. */
  restoreBase(): SendAction[] {
    const actions: SendAction[] = [];
    for (const ch of this.channels.values()) {
      const base = ch.baseSendDB;
      if (!ch.send || base === undefined || !Number.isFinite(base) || !Number.isFinite(ch.send.db)) continue;
      if (Math.abs(ch.send.db - base) < MIN_STEP_DB) continue;
      actions.push({ bus: this.bus, key: ch.key, fromDB: ch.send.db, toDB: base, reason: 'restaurar' });
    }
    return actions;
  }

  snapshot(now: number): ChannelSnapshot[] {
    return [...this.channels.values()].map((ch) => {
      const level = ch.level.levelDB;
      const sendDB = ch.send?.db;
      const contribution =
        level !== undefined && sendDB !== undefined && Number.isFinite(sendDB) ? round1(level + sendDB) : undefined;
      return {
        key: ch.key,
        name: ch.name,
        enabled: ch.enabled,
        status: ch.status,
        rawDB: ch.rawDB === undefined ? undefined : round1(ch.rawDB),
        levelDB: level === undefined ? undefined : round1(level),
        sendDB: sendDB === undefined || !Number.isFinite(sendDB) ? undefined : round1(sendDB),
        muted: ch.send?.muted ?? false,
        baseSendDB:
          ch.baseSendDB === undefined || !Number.isFinite(ch.baseSendDB) ? undefined : round1(ch.baseSendDB),
        targetDB: ch.targetDB,
        contributionDB: contribution,
        suggestedDeltaDB: ch.suggestedDeltaDB,
        manualForSec: Math.max(0, Math.ceil((ch.manualUntil - now) / 1000)),
      };
    });
  }

  exportPersisted(): Record<string, PersistedChannel> {
    const out: Record<string, PersistedChannel> = {};
    for (const ch of this.channels.values()) out[ch.key] = { enabled: ch.enabled, targetDB: ch.targetDB };
    return out;
  }
}
