import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Senha da mesa (Settings › Access da Ui24R). A conexão de controle não pede senha:
 * guardamos só para conferir com o que a mesa informa. Fica em data/ (nunca vai para o git).
 */
export interface MixerAccess {
  enabled: boolean;
  password?: string;
}

interface Saved {
  ip?: string;
  access?: MixerAccess;
}

/** Endereço da mesa escolhido no painel (tem prioridade sobre o config/config.json) e a senha da mesa. */
export class ConnectionStore {
  constructor(private readonly path: string) {}

  private load(): Saved {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Saved;
    } catch {
      return {};
    }
  }

  private save(patch: Saved): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...this.load(), ...patch }, null, 2));
    renameSync(tmp, this.path);
  }

  loadIp(): string | undefined {
    return this.load().ip;
  }

  saveIp(ip: string): void {
    this.save({ ip });
  }

  loadAccess(): MixerAccess {
    const a = this.load().access;
    return { enabled: Boolean(a?.enabled), password: typeof a?.password === 'string' && a.password ? a.password : undefined };
  }

  saveAccess(access: MixerAccess): void {
    this.save({ access });
  }
}
