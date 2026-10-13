import { resolve } from 'node:path';
import { App } from './app.js';
import { loadConfig } from './config.js';
import { SimulatorAdapter } from './mixer/simulator.js';
import { SoundcraftAdapter } from './mixer/soundcraft-adapter.js';
import type { MixerAdapter } from './mixer/types.js';
import { PresetStore } from './preset-store.js';
import { startServer } from './server.js';
import { SessionLog } from './session-log.js';
import { StateStore } from './state-store.js';

const useSim = process.argv.includes('--sim');
const cfg = loadConfig();

const adapter: MixerAdapter = useSim ? new SimulatorAdapter() : new SoundcraftAdapter(cfg.mixer.ip);
// Simulador e mesa real guardam alvos separados, para um não bagunçar o outro.
const store = new StateStore(resolve('data', useSim ? 'estado-simulador.json' : 'estado.json'));
const presets = new PresetStore(resolve('data', useSim ? 'presets-simulador.json' : 'presets.json'));
const log = new SessionLog(resolve('data', 'sessoes'), useSim ? 'simulador' : 'mesa');
const app = new App(cfg, adapter, store, presets, log);

const stopServer = await startServer(app, cfg.server.host, cfg.server.port);
await app.start();

console.log('');
console.log('  Copiloto Ui24R');
console.log(`  Mesa:   ${useSim ? 'SIMULADOR' : cfg.mixer.ip}`);
console.log(`  Auxes:  ${cfg.streamAuxes.join(', ')}`);
console.log(`  Modo:   ${cfg.initialMode}`);
console.log(`  Painel: http://${cfg.server.host === '0.0.0.0' ? 'localhost' : cfg.server.host}:${cfg.server.port}`);
console.log(`  Log:    ${log.file}`);
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
