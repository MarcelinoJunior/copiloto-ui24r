/**
 * "Efeito acompanha a live": o envio de cada canal para um efeito (FX1, FX2…) segue o envio
 * do MESMO canal para a live, com uma diferença escolhida na tela.
 *
 *   diferença fixa (0, −2, −4, −8, −10, −15, −20 dB): envio FX = envio live + diferença
 *   "manter": cada canal guarda a diferença que tinha quando a opção foi ligada
 *
 * Só reage quando o envio do canal para a live MUDA (operador na mesa, no painel ou o ajuste
 * automático). Uma mexida manual no envio para o efeito vale até a próxima mudança na live
 * (no "manter", ela vira a nova diferença do canal). Canal ignorado (botão FX na faixa) não é mexido.
 * Lógica pura: quem manda para a mesa é o App.
 */

export type FxOffset = number | 'manter';

/** Diferenças oferecidas na tela (dB). */
export const FX_OFFSETS = [0, -2, -4, -8, -10, -15, -20] as const;

export interface FxLinkState {
  /** efeito ("f1") → diferença; ausente = desligado */
  offsets: Record<string, FxOffset>;
  /** canais que NÃO acompanham (botão FX desligado na faixa) */
  ignore: string[];
  /** modo "manter": diferença de cada canal ("f1:i3" → dB) */
  rel: Record<string, number>;
}

export interface FxSendAction {
  fx: string;
  key: string;
  db: number;
}

export interface LiveSend {
  db: number;
  muted: boolean;
}

const NEG = Number.NEGATIVE_INFINITY;
const MAX_FX_SEND_DB = 10;
const ECHO_MS = 2000;

const audible = (s: LiveSend | undefined): s is LiveSend => Boolean(s && !s.muted && Number.isFinite(s.db));

export class FxLink {
  private state: FxLinkState;
  /** o que mandamos por último, para o eco da mesa não parecer o operador */
  private readonly sent = new Map<string, { db: number; t: number }>();

  constructor(state?: Partial<FxLinkState>) {
    this.state = { offsets: { ...state?.offsets }, ignore: [...(state?.ignore ?? [])], rel: { ...state?.rel } };
  }

  export(): FxLinkState {
    return { offsets: { ...this.state.offsets }, ignore: [...this.state.ignore], rel: { ...this.state.rel } };
  }

  offset(fx: string): FxOffset | undefined {
    return this.state.offsets[fx];
  }

  isIgnored(key: string): boolean {
    return this.state.ignore.includes(key);
  }

  active(): boolean {
    return Object.keys(this.state.offsets).length > 0;
  }

  setIgnored(key: string, ignored: boolean): void {
    const set = new Set(this.state.ignore);
    if (ignored) set.add(key);
    else set.delete(key);
    this.state.ignore = [...set].sort();
  }

  /**
   * Liga, troca ou desliga (null) a diferença de um efeito. Com `align`, devolve os envios a
   * ajustar agora (diferença fixa). Canais fora da live (envio −∞) não são mexidos agora:
   * entram quando o fader deles na live for aberto.
   */
  setOffset(
    fx: string,
    offset: FxOffset | null,
    live: Map<string, LiveSend>,
    fxSends: Map<string, number>,
    align: boolean,
    now: number,
  ): FxSendAction[] {
    for (const k of Object.keys(this.state.rel)) if (k.startsWith(`${fx}:`)) delete this.state.rel[k];
    if (offset === null) {
      delete this.state.offsets[fx];
      return [];
    }
    this.state.offsets[fx] = offset;
    if (offset === 'manter') {
      // guarda a diferença atual de cada canal que tem envio para a live e para o efeito
      for (const [key, s] of live) {
        const f = fxSends.get(`${fx}:${key}`);
        if (audible(s) && f !== undefined && Number.isFinite(f)) this.state.rel[`${fx}:${key}`] = round1(f - s.db);
      }
      return [];
    }
    if (!align) return [];
    const out: FxSendAction[] = [];
    for (const [key, s] of live) {
      if (this.isIgnored(key) || !audible(s)) continue;
      const action = this.actionFor(fx, key, s, fxSends.get(`${fx}:${key}`), now);
      if (action) out.push(action);
    }
    return out;
  }

  /** O envio do canal para a live mudou: ajusta os efeitos ligados. */
  onLiveSend(key: string, send: LiveSend, fxSends: Map<string, number>, now: number): FxSendAction[] {
    if (this.isIgnored(key)) return [];
    const out: FxSendAction[] = [];
    for (const fx of Object.keys(this.state.offsets)) {
      const action = this.actionFor(fx, key, send, fxSends.get(`${fx}:${key}`), now);
      if (action) out.push(action);
    }
    return out;
  }

  /**
   * O envio do canal para o efeito mudou. Se não foi eco nosso, foi o operador: no "manter",
   * vira a nova diferença do canal.
   */
  onFxSend(fx: string, key: string, db: number, live: LiveSend | undefined, now: number): void {
    const id = `${fx}:${key}`;
    const mine = this.sent.get(id);
    if (mine && now - mine.t < ECHO_MS && sameDb(mine.db, db)) return;
    if (this.state.offsets[fx] === 'manter' && audible(live) && Number.isFinite(db)) this.state.rel[id] = round1(db - live.db);
  }

  private actionFor(fx: string, key: string, send: LiveSend, current: number | undefined, now: number): FxSendAction | undefined {
    const offset = this.state.offsets[fx];
    if (offset === undefined) return undefined;
    let target: number;
    if (!audible(send)) target = NEG; // live fechada ou mutada: o efeito daquele canal fecha junto
    else if (offset === 'manter') {
      const rel = this.state.rel[`${fx}:${key}`];
      if (rel === undefined) return undefined; // canal sem efeito quando o "manter" foi ligado: não ganha efeito
      target = round1(Math.min(MAX_FX_SEND_DB, send.db + rel));
    } else target = round1(Math.min(MAX_FX_SEND_DB, send.db + offset));
    if (current !== undefined && sameDb(current, target)) return undefined;
    this.sent.set(`${fx}:${key}`, { db: target, t: now });
    return { fx, key, db: target };
  }
}

function sameDb(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) < 0.15;
}

function round1(db: number): number {
  return Math.round(db * 10) / 10;
}
