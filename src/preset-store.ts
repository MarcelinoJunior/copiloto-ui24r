import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PresetChannel } from './leveler/aux-leveler.js';

/**
 * Preset = uma mixagem completa da live: envio de cada canal e de cada retorno de efeito,
 * mais os alvos do automático. Ex.: "Louvor - mais batera", "Louvor - mais guitarra", "Pregação".
 */
export interface Preset {
  id: string;
  name: string;
  savedAt: number;
  auxes: Record<string, { channels: Record<string, PresetChannel>; fx: Record<string, number | null> }>;
}

export class PresetStore {
  private presets: Preset[] = [];

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      this.presets = (JSON.parse(readFileSync(path, 'utf8')) as { presets: Preset[] }).presets ?? [];
    } catch (err) {
      console.warn(`[presets] não consegui ler ${path}:`, err);
    }
  }

  list(): Preset[] {
    return this.presets;
  }

  get(id: string): Preset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  /** Salva um preset novo ou sobrescreve um existente (mesmo id). */
  save(preset: Omit<Preset, 'id'> & { id?: string }): Preset {
    const id = preset.id ?? `p${Date.now().toString(36)}`;
    const full: Preset = { ...preset, id };
    const idx = this.presets.findIndex((p) => p.id === id);
    if (idx >= 0) this.presets[idx] = full;
    else this.presets.push(full);
    this.flush();
    return full;
  }

  delete(id: string): void {
    this.presets = this.presets.filter((p) => p.id !== id);
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ presets: this.presets }, null, 2));
    renameSync(tmp, this.path);
  }
}
