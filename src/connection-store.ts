import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Endereço da mesa escolhido no painel (tem prioridade sobre o config/config.json). */
export class ConnectionStore {
  constructor(private readonly path: string) {}

  loadIp(): string | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return (JSON.parse(readFileSync(this.path, 'utf8')) as { ip?: string }).ip;
    } catch {
      return undefined;
    }
  }

  saveIp(ip: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ip }, null, 2));
    renameSync(tmp, this.path);
  }
}
