import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * "Espelho" da mesa real: nomes dos canais e das saídas, link estéreo, matrizes e os envios.
 * É gravado sempre que o Copiloto está conectado na mesa de verdade e o SIMULADOR usa esses
 * dados: em casa, o simulador fica igual à mesa da igreja (mesmos nomes, mesma live, mesmos fones).
 */
export interface MixerMirror {
  savedAt: number;
  address: string;
  firmware: string;
  channels: { key: string; name: string }[];
  buses: { id: number; name: string; linkedWith?: number; isMatrix: boolean }[];
  /** envios em dB por saída ("0" = fader do canal no master); null = todo para baixo */
  sends: Record<string, Record<string, number | null>>;
}

export function loadMirror(path: string): MixerMirror | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as MixerMirror;
    return Array.isArray(m.channels) && Array.isArray(m.buses) ? m : undefined;
  } catch {
    return undefined;
  }
}

export function saveMirror(path: string, mirror: MixerMirror): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(mirror, null, 2));
  renameSync(tmp, path);
}
