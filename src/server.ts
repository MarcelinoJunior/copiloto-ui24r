import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import type { App, Command } from './app.js';

const PUBLIC_DIR = resolve('public');
const PUSH_INTERVAL_MS = 250;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Painel web: arquivos estáticos de /public e um WebSocket em /ws com o estado ao vivo. */
export function startServer(app: App, host: string, port: number): Promise<() => Promise<void>> {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = normalize(join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('não encontrado');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify(app.snapshot()));
    socket.on('message', (raw) => {
      try {
        app.handle(JSON.parse(String(raw)) as Command);
      } catch (err) {
        console.warn('[painel] comando inválido:', err);
      }
    });
  });

  const pushTimer = setInterval(() => {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(app.snapshot());
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(payload);
  }, PUSH_INTERVAL_MS);

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, () => {
      resolveStart(
        () =>
          new Promise<void>((done) => {
            clearInterval(pushTimer);
            wss.close();
            server.close(() => done());
          }),
      );
    });
  });
}
