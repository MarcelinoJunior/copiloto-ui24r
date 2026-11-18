/**
 * Contador de tráfego com a mesa (lógica pura, testada): quantas mensagens/comandos por segundo,
 * a média recente, o pico da sessão e o total. Usado na janela "Saúde da mesa" para ver se o
 * Copiloto está mandando comandos demais para a Ui24R.
 */

export interface TrafficSnapshot {
  /** média por segundo nos últimos 10 s */
  perSec: number;
  /** maior quantidade num segundo, desde que o Copiloto ligou */
  peak: number;
  peakAt?: number;
  total: number;
  /** quantidade em cada um dos últimos 60 s (o último é o segundo atual) */
  lastMinute: number[];
}

const HISTORY_SEC = 60;
const AVERAGE_SEC = 10;

export class TrafficMeter {
  private readonly perSecond = new Map<number, number>();
  private total = 0;
  private peak = 0;
  private peakAt?: number;

  add(now: number, n = 1): void {
    const sec = Math.floor(now / 1000);
    const count = (this.perSecond.get(sec) ?? 0) + n;
    this.perSecond.set(sec, count);
    this.total += n;
    if (count > this.peak) {
      this.peak = count;
      this.peakAt = now;
    }
    if (this.perSecond.size > HISTORY_SEC + 5) this.prune(sec);
  }

  snapshot(now: number): TrafficSnapshot {
    const sec = Math.floor(now / 1000);
    this.prune(sec);
    const lastMinute: number[] = [];
    for (let s = sec - HISTORY_SEC + 1; s <= sec; s++) lastMinute.push(this.perSecond.get(s) ?? 0);
    // média dos últimos 10 segundos completos (o segundo atual ainda está enchendo)
    let sum = 0;
    for (let s = sec - AVERAGE_SEC; s < sec; s++) sum += this.perSecond.get(s) ?? 0;
    return { perSec: Math.round((sum / AVERAGE_SEC) * 10) / 10, peak: this.peak, peakAt: this.peakAt, total: this.total, lastMinute };
  }

  private prune(sec: number): void {
    for (const s of this.perSecond.keys()) if (s <= sec - HISTORY_SEC) this.perSecond.delete(s);
  }
}

/** Chaves do estado da mesa que parecem dados de saúde (temperatura, CPU, ventoinha, tensão). */
export const HEALTH_KEY = /(temp|celsius|therm|cpu|load|fan|volt)/i;

/**
 * Lê as mensagens cruas da Ui24R ("SETD^chave^valor", às vezes várias numa só) e devolve as que
 * parecem saúde do aparelho. Hoje a Ui24R não manda nada assim; se um dia mandar, aparece sozinho.
 */
export function healthKeysIn(raw: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of raw.matchAll(/SET[DS]\^([^^\n]+)\^([^\n]*)/g)) {
    if (HEALTH_KEY.test(m[1]) && !/(gain|level|mix|aux|fx|eq|dyn|gate|vol)/i.test(m[1])) out.push([m[1], m[2].trim()]);
  }
  return out;
}
