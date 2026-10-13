import { resolve } from 'node:path';
import { App } from './app.js';
import { loadConfig } from './config.js';
import { ConnectionStore } from './connection-store.js';
import { SimulatorAdapter } from './mixer/simulator.js';
import { SoundcraftAdapter } from './mixer/soundcraft-adapter.js';
import { PresetStore } from './preset-store.js';
import { startServer } from './server.js';
import { SessionLog } from './session-log.js';
import { StateStore } from './state-store.js';

const useSim = process.argv.includes('--sim');
const cfg = loadConfig();
// PORT=8081 npm start  → permite rodar simulador e mesa ao mesmo tempo
if (process.env.PORT) cfg.server.port = Number(process.env.PORT);

// O endereço escolhido na tela "Conexão" tem prioridade sobre o config/config.json.
const connStore = new ConnectionStore(resolve('data', 'conexao.json'));
const ip = useSim ? 'simulador' : connStore.loadIp() ?? cfg.mixer.ip;

// Simulador e mesa real guardam alvos e presets separados, para um não bagunçar o outro.
const store = new StateStore(resolve('data', useSim ? 'estado-simulador.json' : 'estado.json'));
const presets = new PresetStore(resolve('data', useSim ? 'presets-simulador.json' : 'presets.json'));
const log = new SessionLog(resolve('data', 'sessoes'), useSim ? 'simulador' : 'mesa');
const app = new App(
  cfg,
  {
    kind: useSim ? 'simulador' : 'mesa',
    ip,
    create: (address) => (useSim ? new SimulatorAdapter() : new SoundcraftAdapter(address)),
  },
  store,
  presets,
  log,
  connStore,
);

const stopServer = await startServer(app, cfg.server.host, cfg.server.port).catch((err: NodeJS.ErrnoException) => {
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
console.log(`  Mesa:    ${useSim ? 'SIMULADOR' : ip}  (troque na tela Conexão)`);
console.log(`  Saídas:  escolha no painel (padrão inicial: aux ${cfg.streamAuxes.join(', ')})`);
console.log(`  Modo:    ${cfg.initialMode}`);
console.log(`  Painel:  ${panel}`);
console.log(`  Conexão: ${panel}/conexao.html`);
console.log(`  Log:     ${log.file}`);
console.log('  Ctrl+C para sair (os envios ficam como estão).');
console.log('');

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('Encerrando…');
  await app.stop();
  await stopServer();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
