import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * Grava o que aconteceu em cada culto (níveis, correções, intervenções do operador)
 * em data/sessoes/AAAA-MM-DD_HHmm.jsonl, uma linha JSON por evento.
 *
 * É a matéria-prima para as próximas frentes: relatório pós-culto com IA,
 * ajuste fino dos parâmetros e aprendizado dos alvos por momento do culto.
 */
export class SessionLog {
  private readonly stream: WriteStream;
  readonly file: string;

  constructor(dir: string, label: string) {
    mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    this.file = join(dir, `${stamp}_${label}.jsonl`);
    this.stream = createWriteStream(this.file, { flags: 'a' });
  }

  write(type: string, data: Record<string, unknown>): void {
    this.stream.write(`${JSON.stringify({ t: Date.now(), type, ...data })}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
