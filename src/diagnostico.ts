/**
 * Diagnóstico da mesa: conecta, lê tudo por alguns segundos e imprime um resumo.
 * Serve para descobrir qual aux é o da transmissão e conferir se a leitura de VU funciona.
 *
 *   npm run diagnostico               (usa o IP do config/config.json)
 *   npm run diagnostico -- 192.168.0.122
 */
import { loadConfig } from './config.js';
import { SoundcraftAdapter } from './mixer/soundcraft-adapter.js';
import type { SendInfo } from './mixer/types.js';

const LISTEN_SEC = 5;
const cfg = loadConfig();
const ip = process.argv[2] ?? cfg.mixer.ip;
const adapter = new SoundcraftAdapter(ip);

adapter.onStatus((state, detail) => console.log(`[conexão] ${state}${detail ? ` ${detail}` : ''}`));

console.log(`Conectando em ${ip}…`);
const info = await Promise.race([
  adapter.connect(),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sem resposta em 10 s')), 10000)),
]).catch((err: Error) => {
  console.error(`\nNão consegui conectar: ${err.message}`);
  console.error('Confira: o PC está no Wi-Fi da mesa? Abra http://' + ip + ' no navegador para testar.');
  process.exit(1);
});

console.log(`\nModelo: ${info.model} | firmware: ${info.firmware} | auxes: ${info.auxCount}`);

const channels = adapter.listChannels();
const sends = new Map<string, SendInfo>();
for (let aux = 1; aux <= info.auxCount; aux++) {
  for (const ch of channels) adapter.watchSend(aux, ch.key, (s) => sends.set(`${aux}:${ch.key}`, s));
}

const peaks = new Map<string, number>();
const auxPeaks = new Map<number, number>();
let frames = 0;
adapter.onVu((frame) => {
  frames++;
  for (const [key, vu] of frame.channels) peaks.set(key, Math.max(peaks.get(key) ?? -80, vu.pre));
  for (const [aux, db] of frame.busOut) auxPeaks.set(aux, Math.max(auxPeaks.get(aux) ?? -80, db));
});

console.log(`Ouvindo a mesa por ${LISTEN_SEC} s…`);
await new Promise((r) => setTimeout(r, LISTEN_SEC * 1000));

const fmt = (db?: number) => (db === undefined ? '   ?' : Number.isFinite(db) ? db.toFixed(1).padStart(6) : '   -∞');

console.log(`\nVU: ${frames} leituras em ${LISTEN_SEC} s (${(frames / LISTEN_SEC).toFixed(1)}/s)`);
if (frames === 0) console.log('  ⚠ Nenhuma leitura de VU chegou. Me avise: precisamos investigar.');

console.log('\n== AUXES ==');
const buses = adapter.listBuses();
for (let aux = 1; aux <= info.auxCount; aux++) {
  const bus = buses.find((b) => b.id === aux);
  const extra = bus?.isMatrix ? ' [MATRIZ]' : bus?.linkedWith ? ` [estéreo com AUX ${bus.linkedWith}]` : '';
  const routed = channels.filter((ch) => {
    const s = sends.get(`${aux}:${ch.key}`);
    return s && !s.muted && Number.isFinite(s.db) && s.db > -60;
  });
  const pre = routed.filter((ch) => !sends.get(`${aux}:${ch.key}`)!.postFader).length;
  console.log(
    `AUX ${String(aux).padStart(2)}  "${adapter.busName(aux)}"`.padEnd(30) +
      `canais enviando: ${String(routed.length).padStart(2)}  (pré-fader: ${pre}, pós-fader: ${routed.length - pre})` +
      `  pico saída: ${fmt(auxPeaks.get(aux))} dB${extra}`,
  );
}

const candidates = [...new Set([...cfg.streamAuxes, 7, 8, 9])].filter((a) => a <= info.auxCount).sort((a, b) => a - b);
console.log(`\n== ENVIOS (dB) para os auxes ${candidates.join(', ')} ==`);
console.log('Canal'.padEnd(22) + 'pico VU ' + candidates.map((a) => `AUX ${a}`.padStart(9)).join(''));
for (const ch of channels) {
  const values = candidates.map((a) => sends.get(`${a}:${ch.key}`));
  if (values.every((s) => !s || !Number.isFinite(s.db) || s.db <= -60)) continue;
  const cells = values.map((s) => (s ? `${fmt(s.db)}${s.muted ? 'M' : ' '}${s.postFader ? 'P' : 'p'}` : '        ?'));
  console.log(`${ch.key.padEnd(4)}${ch.name.slice(0, 17).padEnd(18)}${fmt(peaks.get(ch.key))}  ${cells.join(' ')}`);
}
console.log('\nLegenda: M = envio mutado, P = pós-fader, p = pré-fader. Canais sem envio para esses auxes foram omitidos.');
console.log('Dica: no painel, um par estéreo (ex.: AUX 7+8) aparece como uma opção só; o software mexe nos dois juntos.');

await adapter.disconnect();
process.exit(0);
