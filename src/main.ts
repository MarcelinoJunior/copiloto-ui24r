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

// npm start      → começa na MESA REAL
// npm run sim    → começa no SIMULADOR
// Dá para trocar entre os dois a qualquer momento na tela "Conexão".
const startKind: SourceKind = process.argv.includes('--sim') ? 'simulador' : 'mesa';
const cfg = loadConfig();
// PORT=8081 npm start  → permite rodar duas cópias ao mesmo tempo
if (process.env.PORT) cfg.server.port = Number(process.env.PORT);

// Pasta de dados (padrão: ./data). COPILOTO_DATA=outra/pasta permite rodar uma cópia de teste isolada.
const dataDir = resolve(process.env.COPILOTO_DATA ?? 'data');

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
const onShutdown = (who: string) => {
  app.announceShutdown(who);
  void shutdown();
};
const stopServer = await startServer({ app, auth, views, onShutdown }, cfg.server.host, cfg.server.port).catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nA porta ${cfg.server.port} já está em uso: o Copiloto já está aberto em outra janela?`);
    console.error(`Feche a outra janela ou use outra porta, ex.: PORT=${cfg.server.port + 1} npm start\n`);
  } else {
    console.error('\nNão consegui abrir o painel:', err.message, '\n');
  }
  process.exit(1);
});
await app.start();

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
  await app.stop().catch(() => undefined);
  await stopServer().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
