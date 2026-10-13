import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from './db.js';

/**
 * Usuários e permissões.
 *
 * - admin: vê e mexe em tudo, cadastra pessoas e escolhe quais saídas cada uma pode usar.
 * - operador: só vê e mexe nas saídas liberadas (ex.: só o AUX 7+8 da live),
 *   para uma pessoa não mexer no auxiliar da outra.
 *
 * Senhas: só letras e números, mínimo de 6 caracteres. Guardadas com scrypt + sal (nunca em texto).
 * Sessões: token aleatório no cookie; no banco fica só o hash do token.
 */

export type Role = 'admin' | 'operador';

export interface User {
  id: number;
  username: string;
  role: Role;
  /** saídas liberadas (0 = master, 1..10 = aux). Admin pode tudo, independentemente desta lista. */
  buses: number[];
  prefs: Record<string, unknown>;
  createdAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const USERNAME_RE = /^[A-Za-z0-9]{3,32}$/;
export const PASSWORD_RE = /^[A-Za-z0-9]{6,64}$/;
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const LOCK_MS = 30_000;

export function validateUsername(username: string): string {
  const u = String(username ?? '').trim();
  if (!USERNAME_RE.test(u)) throw new AuthError('Usuário: só letras e números, de 3 a 32 caracteres.');
  return u;
}

export function validatePassword(password: string): string {
  const p = String(password ?? '');
  if (!PASSWORD_RE.test(p)) throw new AuthError('Senha: só letras e números, com pelo menos 6 caracteres.');
  return p;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeBuses(buses: unknown): number[] {
  if (!Array.isArray(buses)) return [];
  return [...new Set(buses.map(Number).filter((b) => Number.isInteger(b) && b >= 0 && b <= 10))].sort((a, b) => a - b);
}

interface UserRow {
  id: number;
  username: string;
  role: Role;
  prefs_json: string;
  created_at: number;
  pass_hash: string;
}

export class AuthService {
  private readonly fails = new Map<string, { count: number; until: number }>();

  constructor(private readonly db: Database) {}

  hasUsers(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0;
  }

  listUsers(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as UserRow[];
    return rows.map((r) => this.toUser(r));
  }

  getUser(id: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
    return row ? this.toUser(row) : undefined;
  }

  createUser(input: { username: string; password: string; role: Role; buses?: number[] }): User {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    if (input.role !== 'admin' && input.role !== 'operador') throw new AuthError('Papel inválido.');
    const exists = this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) throw new AuthError(`O usuário "${username}" já existe.`);
    const result = this.db
      .prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password), input.role, Date.now());
    const id = Number(result.lastInsertRowid);
    this.setBuses(id, normalizeBuses(input.buses));
    return this.getUser(id)!;
  }

  updateUser(id: number, changes: { role?: Role; buses?: number[]; password?: string }): User {
    const user = this.getUser(id);
    if (!user) throw new AuthError('Usuário não encontrado.', 404);
    if (changes.role !== undefined) {
      if (changes.role !== 'admin' && changes.role !== 'operador') throw new AuthError('Papel inválido.');
      if (user.role === 'admin' && changes.role !== 'admin' && this.adminCount() <= 1) {
        throw new AuthError('Precisa existir pelo menos um admin.');
      }
      this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(changes.role, id);
    }
    if (changes.buses !== undefined) this.setBuses(id, normalizeBuses(changes.buses));
    if (changes.password !== undefined) {
      this.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(validatePassword(changes.password)), id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // senha nova derruba as sessões antigas
    }
    return this.getUser(id)!;
  }

  deleteUser(id: number): void {
    const user = this.getUser(id);
    if (!user) throw new AuthError('Usuário não encontrado.', 404);
    if (user.role === 'admin' && this.adminCount() <= 1) throw new AuthError('Não dá para apagar o último admin.');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  setPrefs(id: number, prefs: Record<string, unknown>): void {
    const json = JSON.stringify(prefs);
    if (json.length > 4000) throw new AuthError('Preferências grandes demais.');
    this.db.prepare('UPDATE users SET prefs_json = ? WHERE id = ?').run(json, id);
  }

  /** Confere usuário e senha e abre uma sessão. Bloqueia por 30 s depois de 5 erros seguidos. */
  login(username: string, password: string): { token: string; user: User; expiresAt: number } {
    const key = String(username ?? '').trim().toLowerCase();
    const now = Date.now();
    const fail = this.fails.get(key);
    if (fail && fail.until > now) {
      throw new AuthError(`Muitas tentativas. Espere ${Math.ceil((fail.until - now) / 1000)} s.`, 429);
    }
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(key) as unknown as UserRow | undefined;
    const ok = row !== undefined && verifyPassword(String(password ?? ''), row.pass_hash);
    if (!ok) {
      const count = (fail?.until && fail.until <= now ? 0 : fail?.count ?? 0) + 1;
      this.fails.set(key, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
      throw new AuthError('Usuário ou senha incorretos.', 401);
    }
    this.fails.delete(key);
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_DAYS * 24 * 3600 * 1000;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), row.id, expiresAt);
    return { token, user: this.toUser(row), expiresAt };
  }

  sessionUser(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(tokenHash(token), Date.now()) as unknown as UserRow | undefined;
    return row ? this.toUser(row) : undefined;
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  private adminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
  }

  private setBuses(id: number, buses: number[]): void {
    this.db.prepare('DELETE FROM user_buses WHERE user_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO user_buses (user_id, bus) VALUES (?, ?)');
    for (const b of buses) insert.run(id, b);
  }

  private toUser(row: UserRow): User {
    const buses = (this.db.prepare('SELECT bus FROM user_buses WHERE user_id = ? ORDER BY bus').all(row.id) as { bus: number }[]).map(
      (r) => r.bus,
    );
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(row.prefs_json) as Record<string, unknown>;
    } catch {
      prefs = {};
    }
    return { id: row.id, username: row.username, role: row.role, buses, prefs, createdAt: row.created_at };
  }
}

/** O usuário pode ver/mexer nesta saída? */
export function canUseBus(user: Pick<User, 'role' | 'buses'>, bus: number): boolean {
  return user.role === 'admin' || user.buses.includes(bus);
}

/** Visão pública do usuário (sem nada sensível). */
export function publicUser(user: User): Omit<User, 'prefs'> & { prefs: Record<string, unknown> } {
  return { id: user.id, username: user.username, role: user.role, buses: user.buses, prefs: user.prefs, createdAt: user.createdAt };
}
