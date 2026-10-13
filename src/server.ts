import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { type App, type ClientCtx, type Command, CommandError } from './app.js';
import { AuthError, type AuthService, publicUser, type Role, type User } from './auth.js';
import { ViewError, type ViewStore } from './views.js';

const PUBLIC_DIR = resolve('public');
/** muda a cada vez que o programa abre: as páginas abertas recarregam sozinhas quando ele é atualizado */
const BUILD = String(Date.now());
const PUSH_INTERVAL_MS = 250;
const USER_REFRESH_MS = 2000;
const MAX_BODY = 64 * 1024;
const COOKIE = 'copiloto_sid';
/** Páginas e arquivos que abrem sem login. */
const OPEN_FILES = new Set(['/login.html', '/login.js', '/style.css']);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface ServerDeps {
  app: App;
  auth: AuthService;
  views: ViewStore;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token: string, expiresAt: number): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(expiresAt).toUTCString()}`;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // exigir JSON também protege contra formulários de outros sites (CSRF)
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Envie JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Requisição grande demais.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

/** Painel web + API + WebSocket /ws. Tudo exige login, menos a tela de login. */
export function startServer(deps: ServerDeps, host: string, port: number): Promise<() => Promise<void>> {
  const { app, auth, views } = deps;
  const userFrom = (req: IncomingMessage): User | undefined => auth.sessionUser(parseCookies(req.headers.cookie)[COOKIE]);

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const user = userFrom(req);
    const need = (): User => {
      if (!user) throw new HttpError(401, 'Faça login.');
      return user;
    };
    const needAdmin = (): User => {
      const u = need();
      if (u.role !== 'admin') throw new HttpError(403, 'Só o admin pode fazer isso.');
      return u;
    };

    // --- sessão ---
    if (path === '/api/me' && method === 'GET') {
      return json(res, 200, {
        user: user ? publicUser(user) : null,
        needsSetup: !auth.hasUsers(),
        defaultPassword: user ? auth.usesDefaultPassword(user.id) : false,
      });
    }
    if (path === '/api/setup' && method === 'POST') {
      // só funciona enquanto não existe nenhum usuário: cria o primeiro admin
      if (auth.hasUsers()) throw new HttpError(409, 'O admin já foi criado. Faça login.');
      const body = await readJson(req);
      auth.createUser({ username: String(body.username), password: String(body.password), role: 'admin' });
      const s = auth.login(String(body.username), String(body.password));
      return json(res, 200, { user: publicUser(s.user) }, { 'set-cookie': sessionCookie(s.token, s.expiresAt) });
    }
    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(req);
      const s = auth.login(String(body.username ?? ''), String(body.password ?? ''));
      return json(res, 200, { user: publicUser(s.user) }, { 'set-cookie': sessionCookie(s.token, s.expiresAt) });
    }
    if (path === '/api/logout' && method === 'POST') {
      auth.logout(parseCookies(req.headers.cookie)[COOKIE]);
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (path === '/api/me/password' && method === 'POST') {
      const u = need();
      const body = await readJson(req);
      auth.login(u.username, String(body.current ?? '')); // confere a senha atual
      auth.updateUser(u.id, { password: String(body.password ?? '') });
      const s = auth.login(u.username, String(body.password));
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(s.token, s.expiresAt) });
    }
    if (path === '/api/prefs' && method === 'PUT') {
      const u = need();
      const body = await readJson(req);
      auth.setPrefs(u.id, { ...u.prefs, ...body });
      return json(res, 200, { ok: true });
    }

    // --- saídas (para o admin escolher permissões) ---
    if (path === '/api/buses' && method === 'GET') {
      need();
      return json(res, 200, { buses: app.busChoices() });
    }

    // --- usuários (admin) ---
    if (path === '/api/users' && method === 'GET') {
      needAdmin();
      return json(res, 200, { users: auth.listUsers().map(publicUser) });
    }
    if (path === '/api/users' && method === 'POST') {
      needAdmin();
      const body = await readJson(req);
      const created = auth.createUser({
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
        role: (body.role === 'admin' ? 'admin' : 'operador') as Role,
        buses: body.buses as number[],
      });
      return json(res, 201, { user: publicUser(created) });
    }
    const userMatch = /^\/api\/users\/(\d+)$/.exec(path);
    if (userMatch && (method === 'PATCH' || method === 'DELETE')) {
      const admin = needAdmin();
      const id = Number(userMatch[1]);
      if (method === 'DELETE') {
        if (id === admin.id) throw new HttpError(400, 'Você não pode apagar a si mesmo.');
        auth.deleteUser(id);
        return json(res, 200, { ok: true });
      }
      const body = await readJson(req);
      const updated = auth.updateUser(id, {
        role: body.role === undefined ? undefined : ((body.role === 'admin' ? 'admin' : 'operador') as Role),
        buses: body.buses as number[] | undefined,
        password: body.password === undefined || body.password === '' ? undefined : String(body.password),
      });
      return json(res, 200, { user: publicUser(updated) });
    }

    // --- modos de visualização (de cada usuário) ---
    if (path === '/api/views' && method === 'GET') {
      const u = need();
      return json(res, 200, { views: views.list(u.id), currentId: u.prefs.viewId ?? 'padrao' });
    }
    if (path === '/api/views' && method === 'POST') {
      const u = need();
      const body = await readJson(req);
      return json(res, 201, { view: views.create(u.id, body.name, body.config) });
    }
    const viewMatch = /^\/api\/views\/([a-z0-9]+)$/.exec(path);
    if (viewMatch && (method === 'PUT' || method === 'DELETE')) {
      const u = need();
      if (method === 'DELETE') {
        views.delete(u.id, viewMatch[1]);
        return json(res, 200, { ok: true });
      }
      const body = await readJson(req);
      return json(res, 200, { view: views.update(u.id, viewMatch[1], body.name, body.config) });
    }

    throw new HttpError(404, 'Rota não encontrada.');
  }

  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    try {
      if (urlPath.startsWith('/api/')) return await api(req, res, urlPath);

      const page = urlPath === '/' ? '/index.html' : urlPath;
      if (!OPEN_FILES.has(page) && !userFrom(req)) {
        // sem login: páginas vão para a tela de login; outros arquivos recebem 401
        if (page.endsWith('.html')) {
          res.writeHead(302, { location: '/login.html' }).end();
        } else {
          res.writeHead(401).end();
        }
        return;
      }
      const file = normalize(join(PUBLIC_DIR, page));
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      if (err instanceof HttpError || err instanceof AuthError || err instanceof ViewError) {
        return json(res, err instanceof HttpError ? err.status : err.status, { error: err.message });
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404).end('não encontrado');
        return;
      }
      console.error('[painel] erro:', err);
      json(res, 500, { error: 'Erro interno.' });
    }
  });

  // --- WebSocket: cada conexão é uma pessoa logada, com a sua própria visão ---
  const wss = new WebSocketServer({ noServer: true });
  wss.on('error', () => undefined);
  const clients = new Map<WebSocket, ClientCtx & { token: string; checkedAt: number }>();

  server.on('upgrade', (req, socket, head) => {
    if (decodeURIComponent((req.url ?? '').split('?')[0]) !== '/ws') {
      socket.destroy();
      return;
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const user = auth.sessionUser(token);
    if (!user || !token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ctx = { user, view: {}, token, checkedAt: Date.now() };
      clients.set(ws, ctx);
      ws.send(JSON.stringify({ ...app.snapshotFor(ctx), build: BUILD }));
      ws.on('message', (raw) => {
        let cmd: Command;
        try {
          cmd = JSON.parse(String(raw)) as Command;
        } catch {
          return;
        }
        try {
          app.handle(cmd, ctx);
        } catch (err) {
          const text = err instanceof CommandError ? err.message : 'Não consegui fazer isso.';
          if (!(err instanceof CommandError)) console.warn('[painel] comando falhou:', err);
          ws.send(JSON.stringify({ type: 'erro', text }));
        }
      });
      ws.on('close', () => clients.delete(ws));
    });
  });

  const pushTimer = setInterval(() => {
    const now = Date.now();
    for (const [ws, ctx] of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // relê o usuário de tempos em tempos: permissões mudam e sessões expiram
      if (now - ctx.checkedAt > USER_REFRESH_MS) {
        const fresh = auth.sessionUser(ctx.token);
        ctx.checkedAt = now;
        if (!fresh) {
          ws.close(4401, 'sessão encerrada');
          continue;
        }
        ctx.user = fresh;
      }
      ws.send(JSON.stringify({ ...app.snapshotFor(ctx), build: BUILD }));
    }
  }, PUSH_INTERVAL_MS);

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, () => {
      resolveStart(
        () =>
          new Promise<void>((done) => {
            clearInterval(pushTimer);
            for (const ws of clients.keys()) ws.close();
            wss.close();
            server.close(() => done());
          }),
      );
    });
  });
}
