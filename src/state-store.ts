import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedChannel } from './leveler/aux-leveler.js';

/** Alvos e canais habilitados, por aux. Sobrevive a reinícios do programa. */
export interface PersistedState {
  auxes: Record<string, Record<string, PersistedChannel>>;
}

export class StateStore {
  constructor(private readonly path: string) {}

  load(): PersistedState {
    if (!existsSync(this.path)) return { auxes: {} };
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as PersistedState;
    } catch (err) {
      console.warn(`[estado] não consegui ler ${this.path}, começando do zero:`, err);
      return { auxes: {} };
    }
  }

  save(state: PersistedState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }
}
