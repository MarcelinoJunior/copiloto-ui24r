import { dbToPow, powToDb } from '../util/db.js';

/**
 * Mede o nível "típico" de um canal enquanto ele está tocando.
 *
 * Média exponencial em potência, mas só alimentada quando o sinal passa do gate:
 * pausas entre frases não puxam a média para baixo, então quando o pregador volta
 * a falar o nível já está correto.
 */
export class GatedLevel {
  private pow?: number;
  private lastT?: number;
  private lastAboveT = Number.NEGATIVE_INFINITY;
  private activeSinceT?: number;

  constructor(
    private readonly tauSec: number,
    private readonly gateDB: number,
    private readonly releaseSec: number,
  ) {}

  update(db: number, now: number): void {
    const dt = this.lastT === undefined ? 0 : Math.max(0, (now - this.lastT) / 1000);
    this.lastT = now;
    if (db <= this.gateDB) return;

    if (!this.isActive(now)) this.activeSinceT = now;
    this.lastAboveT = now;

    const p = dbToPow(db);
    if (this.pow === undefined) {
      this.pow = p;
    } else {
      const alpha = 1 - Math.exp(-dt / this.tauSec);
      this.pow += alpha * (p - this.pow);
    }
  }

  isActive(now: number): boolean {
    return now - this.lastAboveT <= this.releaseSec * 1000;
  }

  /** Há quantos segundos o canal está tocando sem parar (0 se em silêncio). */
  activeForSec(now: number): number {
    if (!this.isActive(now) || this.activeSinceT === undefined) return 0;
    return (now - this.activeSinceT) / 1000;
  }

  /** Segundos desde a última vez que o canal passou do gate. */
  silentForSec(now: number): number {
    return (now - this.lastAboveT) / 1000;
  }

  get levelDB(): number | undefined {
    return this.pow === undefined ? undefined : powToDb(this.pow);
  }
}
