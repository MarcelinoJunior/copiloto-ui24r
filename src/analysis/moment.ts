/**
 * Fala × música: descobre o "momento do culto" para trocar o preset sozinho
 * (ex.: preset "Pregação" quando só tem fala, "Louvor" quando a banda toca).
 *
 * Usa duas pistas, as duas vindas do áudio USB:
 * 1. Quais canais estão tocando, conforme o papel de cada um (fala, canto, instrumento).
 *    Instrumentos tocando = música, de forma muito confiável.
 * 2. Para canais de papel "automático", o jeito do som: fala tem muitas pausas curtas
 *    (alta proporção de trechos de baixa energia); música é contínua.
 *
 * A troca só acontece depois que o novo momento se mantém por alguns segundos (histerese).
 */

export type ChannelRole = 'auto' | 'fala' | 'canto' | 'instrumento' | 'ignorar';
export type Moment = 'fala' | 'musica' | 'silencio';

/** Papel padrão pelo nome do canal (dá para trocar na tela Análise). */
export function guessRole(name: string): ChannelRole {
  const n = name.toLowerCase();
  if (/pastor|prega|avis|palestr|fala|locu|mc\b|apresent|lider/.test(n)) return 'fala';
  if (/minist|back|vocal|voz|coral|cantor|canto|solo/.test(n)) return 'canto';
  if (/viol|guit|baix|bass|tecl|key|piano|bumbo|kick|caixa|snare|tom|over|bat|drum|sax|trompe|flaut|cord|synth|pad|play/.test(n)) {
    return 'instrumento';
  }
  return 'auto';
}

export interface ChannelActivity {
  key: string;
  role: ChannelRole;
  /** nível RMS do bloco (dBFS) */
  rmsDb: number;
}

const ACTIVE_DB = -45;
const FRAME_WINDOW = 60; // ~12 s de blocos de 200 ms

export class MomentClassifier {
  private history: Moment[] = [];
  /** energia recente dos canais "auto"/fala, para medir as pausas típicas da fala */
  private readonly speechEnergy = new Map<string, number[]>();
  state: Moment = 'silencio';
  since = Date.now();
  candidate?: { moment: Moment; since: number };

  constructor(private readonly holdMs = 12000) {}

  /** nível médio de cada canal enquanto toca (média em potência, só nos blocos ativos) e quando tocou por último */
  private readonly level = new Map<string, { pow: number; lastActive: number }>();
  private tick = 0;

  /**
   * Classifica o instante atual (um bloco ~200 ms).
   * Compara a energia da FALA com a da MÚSICA (instrumentos + canto) nos últimos segundos:
   * um teclado de fundo durante a pregação não vira "música" se o pastor está acima dele.
   */
  raw(channels: ChannelActivity[]): Moment {
    this.tick++;
    for (const c of channels) {
      if (c.role === 'ignorar') continue;
      if (c.role === 'auto' || c.role === 'fala') {
        const list = this.speechEnergy.get(c.key) ?? [];
        list.push(c.rmsDb);
        if (list.length > 25) list.shift(); // ~5 s
        this.speechEnergy.set(c.key, list);
      }
      if (c.rmsDb <= ACTIVE_DB) continue;
      const p = Math.pow(10, c.rmsDb / 10);
      const st = this.level.get(c.key);
      if (!st) this.level.set(c.key, { pow: p, lastActive: this.tick });
      else {
        st.pow += 0.15 * (p - st.pow); // ~1,5 s de média
        st.lastActive = this.tick;
      }
    }

    // "recente" = tocou nos últimos ~3 s (fala tem pausas entre frases)
    let speech = 0;
    let music = 0;
    for (const c of channels) {
      const st = this.level.get(c.key);
      if (!st || this.tick - st.lastActive > 15) continue;
      const role = c.role === 'auto' ? (this.looksLikeSpeech(c.key) ? 'fala' : 'musica') : c.role;
      if (role === 'fala') speech = Math.max(speech, st.pow);
      else if (role === 'instrumento' || role === 'canto' || role === 'musica') music += st.pow;
    }
    if (speech === 0 && music === 0) return 'silencio';
    return speech >= music ? 'fala' : 'musica';
  }

  /** Fala tem pausas: muitos blocos bem abaixo da média recente. */
  looksLikeSpeech(key: string): boolean {
    const list = this.speechEnergy.get(key) ?? [];
    if (list.length < 10) return false;
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    const low = list.filter((v) => v < mean - 8).length / list.length;
    return low > 0.25;
  }

  /** Atualiza o estado com histerese. Retorna o novo momento quando ele muda. */
  update(channels: ChannelActivity[], t: number): Moment | undefined {
    const r = this.raw(channels);
    this.history.push(r);
    if (this.history.length > FRAME_WINDOW) this.history.shift();
    // silêncio curto não muda nada (pausa entre músicas, oração em silêncio)
    const counts = { fala: 0, musica: 0, silencio: 0 };
    for (const m of this.history.slice(-Math.ceil(this.holdMs / 200))) counts[m]++;
    const winner = (Object.entries(counts) as [Moment, number][]).sort((a, b) => b[1] - a[1])[0][0];
    if (winner === 'silencio' || winner === this.state) {
      this.candidate = undefined;
      return undefined;
    }
    if (!this.candidate || this.candidate.moment !== winner) this.candidate = { moment: winner, since: t };
    if (t - this.candidate.since >= this.holdMs) {
      this.state = winner;
      this.since = t;
      this.candidate = undefined;
      return winner;
    }
    return undefined;
  }
}
