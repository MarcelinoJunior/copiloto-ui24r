import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Mode, PersistedChannel } from './leveler/aux-leveler.js';

/**
 * Estado da mixagem por saída (chave "0" = master, "7" = aux 7): alvos, canais com AUTO,
 * "efeito acompanha", modo de cada saída, preset ativo e a fonte de nível (VU ou USB).
 * Sobrevive a reinícios do programa.
 */
export interface PersistedState {
  auxes: Record<string, Record<string, PersistedChannel>>;
  fxFollow?: Record<string, Record<string, boolean>>;
  modes?: Record<string, Mode>;
  activePresets?: Record<string, string>;
  levelSource?: { kind: 'vu' | 'usb'; device?: string; channels?: number };
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
