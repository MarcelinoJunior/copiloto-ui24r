import type { Database } from './db.js';

/**
 * Modos de visualização da tela de mixagem: quantos faders cabem na tela, quais canais
 * aparecem e quais controles extras ficam visíveis. Cada pessoa cria os seus (no SQLite).
 */

export interface ViewConfig {
  /** quantos faders de canal cabem na tela (0 = todos os escolhidos de uma vez) */
  faders: number;
  /** canais que aparecem, na ordem (ex.: ["i1","i2","i9"]); null = todas as entradas */
  channels: string[] | null;
  /** mostrar as faixas de retorno dos 4 efeitos */
  showFxReturns: boolean;
  /** mostrar line in e player */
  showLinePlayer: boolean;
}

export interface ViewMode {
  id: string;
  name: string;
  builtin: boolean;
  config: ViewConfig;
}

export const DEFAULT_VIEW: ViewConfig = {
  faders: 0,
  channels: null,
  showFxReturns: true,
  showLinePlayer: false,
};

export const BUILTIN_VIEWS: ViewMode[] = [
  { id: 'padrao', name: 'Padrão — todos os canais', builtin: true, config: DEFAULT_VIEW },
  { id: 'doze', name: '12 faders por tela', builtin: true, config: { ...DEFAULT_VIEW, faders: 12 } },
  { id: 'oito', name: '8 faders por tela (tablet)', builtin: true, config: { ...DEFAULT_VIEW, faders: 8, showFxReturns: false } },
];

const ALLOWED_FADERS = [0, 4, 6, 8, 10, 12, 16, 20, 24, 32];
const CHANNEL_KEY_RE = /^[ilp]\d{1,2}$/;

export class ViewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function sanitizeViewConfig(raw: unknown): ViewConfig {
  const r = (raw ?? {}) as Partial<ViewConfig>;
  const faders = Number(r.faders);
  let channels: string[] | null = null;
  if (Array.isArray(r.channels)) {
    channels = [...new Set(r.channels.map(String).filter((k) => CHANNEL_KEY_RE.test(k)))].slice(0, 40);
    if (channels.length === 0) throw new ViewError('Escolha pelo menos um canal.');
  }
  return {
    faders: ALLOWED_FADERS.includes(faders) ? faders : 0,
    channels,
    showFxReturns: r.showFxReturns !== false,
    showLinePlayer: r.showLinePlayer === true,
  };
}

function sanitizeName(name: unknown): string {
  const n = String(name ?? '').trim().slice(0, 40);
  if (!n) throw new ViewError('Dê um nome ao modo de visualização.');
  return n;
}

interface ViewRow {
  id: number;
  name: string;
  config_json: string;
}

export class ViewStore {
  constructor(private readonly db: Database) {}

  /** Modos prontos + os criados por este usuário. */
  list(userId: number): ViewMode[] {
    const rows = this.db
      .prepare('SELECT id, name, config_json FROM view_modes WHERE user_id = ? ORDER BY name')
      .all(userId) as unknown as ViewRow[];
    return [...BUILTIN_VIEWS, ...rows.map((r) => this.toView(r))];
  }

  create(userId: number, name: unknown, config: unknown): ViewMode {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM view_modes WHERE user_id = ?').get(userId) as { n: number }).n;
    if (count >= 30) throw new ViewError('Limite de 30 modos por usuário.');
    const now = Date.now();
    const result = this.db
      .prepare('INSERT INTO view_modes (user_id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, sanitizeName(name), JSON.stringify(sanitizeViewConfig(config)), now, now);
    return this.get(userId, String(result.lastInsertRowid))!;
  }

  update(userId: number, id: string, name: unknown, config: unknown): ViewMode {
    if (!/^\d+$/.test(id)) throw new ViewError('Os modos prontos não podem ser alterados. Use "Duplicar".');
    const result = this.db
      .prepare('UPDATE view_modes SET name = ?, config_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(sanitizeName(name), JSON.stringify(sanitizeViewConfig(config)), Date.now(), Number(id), userId);
    if (result.changes === 0) throw new ViewError('Modo não encontrado.', 404);
    return this.get(userId, id)!;
  }

  delete(userId: number, id: string): void {
    if (!/^\d+$/.test(id)) throw new ViewError('Os modos prontos não podem ser apagados.');
    const result = this.db.prepare('DELETE FROM view_modes WHERE id = ? AND user_id = ?').run(Number(id), userId);
    if (result.changes === 0) throw new ViewError('Modo não encontrado.', 404);
  }

  get(userId: number, id: string): ViewMode | undefined {
    const builtin = BUILTIN_VIEWS.find((v) => v.id === id);
    if (builtin) return builtin;
    if (!/^\d+$/.test(id)) return undefined;
    const row = this.db
      .prepare('SELECT id, name, config_json FROM view_modes WHERE id = ? AND user_id = ?')
      .get(Number(id), userId) as unknown as ViewRow | undefined;
    return row ? this.toView(row) : undefined;
  }

  private toView(row: ViewRow): ViewMode {
    let config = DEFAULT_VIEW;
    try {
      config = sanitizeViewConfig(JSON.parse(row.config_json));
    } catch {
      config = DEFAULT_VIEW;
    }
    return { id: String(row.id), name: row.name, builtin: false, config };
  }
}
