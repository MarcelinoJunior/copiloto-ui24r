import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, type Profile, type SourceKind } from './app.js';
import { AuthService } from './auth.js';
import { openDatabase } from './db.js';
import { ViewStore } from './views.js';
import { loadConfig } from './config.js';
import { ConnectionStore } from './connection-store.js';
import { loadMirror } from './mixer/mirror.js';
import { SimulatorAdapter } from './mixer/simulator.js';
import { SoundcraftAdapter } from './mixer/soundcraft-adapter.js';
import { PresetStore } from './preset-store.js';
import { startServer } from './server.js';
import { SessionLog } from './session-log.js';
import { StateStore } from './state-store.js';
import { Updater } from './updater.js';

// npm start      → começa na MESA REAL
// npm run sim    → começa no SIMULADOR
// Dá para trocar entre os dois a qualquer momento na tela "Conexão".
const startKind: SourceKind = process.argv.includes('--sim') ? 'simulador' : 'mesa';
// Pasta de dados (padrão: ./data). COPILOTO_DATA=outra/pasta permite rodar uma cópia de teste isolada.
const dataDir = resolve(process.env.COPILOTO_DATA ?? 'data');

// Configuração: data/config.json (deste computador, a atualização nunca apaga) tem prioridade sobre
// o config/config.json que vem com o programa.
const localConfig = resolve(dataDir, 'config.json');
const cfg = loadConfig(existsSync(localConfig) ? localConfig : undefined);
// PORT=8081 npm start  → permite rodar duas cópias ao mesmo tempo
if (process.env.PORT) cfg.server.port = Number(process.env.PORT);

// O endereço escolhido na tela "Conexão" tem prioridade sobre o config/config.json.
const connStore = new ConnectionStore(resolve(dataDir, 'conexao.json'));
const ip = connStore.loadIp() ?? cfg.mixer.ip;

// Mesa real e simulador guardam alvos e presets separados, para um não bagunçar o outro.
const profiles: Record<SourceKind, Profile> = {
  mesa: { store: new StateStore(resolve(dataDir, 'estado.json')), presets: new PresetStore(resolve(dataDir, 'presets.json')) },
  simulador: {
    store: new StateStore(resolve(dataDir, 'estado-simulador.json')),
    presets: new PresetStore(resolve(dataDir, 'presets-simulador.json')),
  },
};

const log = new SessionLog(resolve(dataDir, 'sessoes'), startKind);
const app = new App(
  cfg,
  {
    kind: startKind,
    ip,
    // o simulador usa o "espelho" da mesa real (nomes, saídas, envios) quando já conectou nela uma vez
    create: (kind, address) =>
      kind === 'simulador' ? new SimulatorAdapter(loadMirror(resolve(dataDir, 'mesa-espelho.json'))) : new SoundcraftAdapter(address),
    profiles,
    dataDir,
  },
  log,
  connStore,
);

// Banco local (SQLite): usuários, permissões e modos de visualização.
const db = openDatabase(resolve(dataDir, 'copiloto.db'));
const auth = new AuthService(db);
const createdAdmin = auth.ensureDefaultAdmin();
const views = new ViewStore(db);

// botão ⏻ do painel (só admin) usa o mesmo desligamento do Ctrl+C
// chave local para o "Fechar Copiloto" desligar com calma sem precisar listar processos do Windows
const localToken = randomBytes(16).toString('hex');
const tokenFile = resolve(dataDir, 'copiloto.token');
mkdirSync(dataDir, { recursive: true });
writeFileSync(tokenFile, localToken);

const onShutdown = (who: string) => {
  app.announceShutdown(who);
  void shutdown();
};
// Porta ocupada por OUTRO programa (ex.: o AmpSim usa a 8080): tenta as próximas, até 10.
// A porta usada vai para data/copiloto.porta, que o atalho lê para abrir a janela certa.
// Com PORT= definido (cópias de teste) não troca: falha avisando.
const portFile = resolve(dataDir, 'copiloto.porta');
const wantedPort = cfg.server.port;
const tries = process.env.PORT ? 1 : 10;
let stopServer: (() => Promise<void>) | undefined;
for (let i = 0; i < tries && !stopServer; i++) {
  const port = wantedPort + i;
  try {
    stopServer = await startServer({ app, auth, views, onShutdown, localToken }, cfg.server.host, port);
    cfg.server.port = port;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'EADDRINUSE') {
      console.error('\nNão consegui abrir o painel:', err.message, '\n');
      process.exit(1);
    }
    console.error(`A porta ${port} está ocupada por outro programa (ou outro Copiloto).`);
  }
}
if (!stopServer) {
  console.error(`\nNenhuma porta livre entre ${wantedPort} e ${wantedPort + tries - 1}. Feche o outro programa ou mude server.port.\n`);
  process.exit(1);
}
if (cfg.server.port !== wantedPort) console.log(`Usando a porta ${cfg.server.port} (a ${wantedPort} está ocupada).`);
writeFileSync(portFile, String(cfg.server.port));
await app.start();

// Atualização pelo GitHub: confere 20 s depois de ligar e a cada 30 min; aplicar é um clique do admin.
// (COPILOTO_SEM_ATUALIZACAO=1 desliga: cópias de teste)
if (!process.env.COPILOTO_SEM_ATUALIZACAO) {
  const updater = new Updater(process.cwd());
  app.setUpdater(updater);
  setTimeout(() => void updater.check(), 20_000).unref();
  setInterval(() => void updater.check(), 30 * 60_000).unref();
  // depois de atualizar: liga de novo pelo mesmo script dos atalhos (sem abrir outra aba) e sai
  app.onRestart = () => {
    const script = resolve('scripts', 'copiloto.ps1');
    if (existsSync(script)) {
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'reiniciar'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    }
    void shutdown();
  };
}

const panel = `http://${cfg.server.host === '0.0.0.0' ? 'localhost' : cfg.server.host}:${cfg.server.port}`;
console.log('');
console.log('  Copiloto Ui24R');
console.log(
  startKind === 'simulador'
    ? '  Fonte:   SIMULADOR (mesa falsa) — troque para a mesa real na tela Conexão'
    : `  Fonte:   MESA REAL em ${ip} — troque o IP na tela Conexão`,
);
console.log(`  Modo:    ${cfg.initialMode}`);
console.log(`  Painel:  ${panel}`);
if (createdAdmin) console.log('  Login:   usuário "admin", senha "admin"  ← TROQUE a senha em Conta/Pessoas');
console.log(`  Conexão: ${panel}/conexao.html`);
console.log(`  Log:     ${log.file}`);
console.log('  Ctrl+C para sair (os envios ficam como estão).');
console.log('');

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('Encerrando…');
  // prazo de segurança: se algo travar (mesa sem resposta, conexão presa), sai mesmo assim
  setTimeout(() => process.exit(0), 3000);
  rmSync(tokenFile, { force: true });
  rmSync(portFile, { force: true });
  await app.stop().catch(() => undefined);
  await stopServer?.().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
