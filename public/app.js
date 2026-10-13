// Painel do Copiloto Ui24R. Recebe o estado do servidor por WebSocket e manda comandos.

const STATUS_LABEL = {
  desabilitado: 'desligado',
  'sem-envio': 'sem envio',
  'sem-alvo': 'sem alvo',
  manual: 'operador',
  silencio: 'silêncio',
  aguardando: 'aguardando',
  ok: 'ok',
  corrigindo: 'corrigindo',
  'no-limite': 'no limite',
};

const MODE_HELP = {
  desligado: 'O software só mostra os níveis. Nada é calculado nem alterado.',
  observar: 'O software calcula as correções, mas NÃO mexe na mesa. Use para conferir antes de ligar o automático.',
  automatico: 'O software está ajustando os envios do aux da live, devagar e dentro dos limites.',
};

const METER_MIN = -60;
const $ = (sel) => document.querySelector(sel);
let socket;
let state;
const rows = new Map(); // `${aux}:${key}` -> elementos da linha
const auxCards = new Map();

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = (ev) => {
    state = JSON.parse(ev.data);
    render();
  };
  socket.onclose = () => {
    setConn('desconectado', 'painel sem conexão com o programa');
    setTimeout(connect, 1500);
  };
}

function send(cmd) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

function setConn(cls, text) {
  const el = $('#conn');
  el.className = `pill ${cls}`;
  el.textContent = text;
}

const pct = (db) => `${Math.max(0, Math.min(100, ((db - METER_MIN) / -METER_MIN) * 100))}%`;
const fmt = (db, signed = false) =>
  db === undefined || db === null ? '—' : `${signed && db > 0 ? '+' : ''}${db.toFixed(1)}`;

function render() {
  const s = state;
  document.body.classList.toggle('is-sim', Boolean(s.sim));
  setConn(s.connection, s.connection === 'conectado' ? 'mesa conectada' : `mesa: ${s.connection}`);
  $('#mixer-info').textContent = s.mixer
    ? `${s.mixer.kind === 'simulador' ? 'SIMULADOR' : s.mixer.address} · ${s.mixer.model} · fw ${s.mixer.firmware}`
    : s.connectionDetail ?? '';

  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
  $('#mode-help').textContent = MODE_HELP[s.mode];

  $('#sim').hidden = !s.sim;
  if (s.sim) document.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('active', b.dataset.scene === s.sim.scene));

  const showAll = $('#show-all').checked;
  for (const aux of s.auxes) renderAux(aux, showAll, s);

  $('#events').innerHTML = s.events
    .map((e) => `<li><time>${new Date(e.t).toLocaleTimeString('pt-BR')}</time>${escapeHtml(e.text)}</li>`)
    .join('');
}

function renderAux(aux, showAll, s) {
  let card = auxCards.get(aux.aux);
  if (!card) {
    const node = $('#aux-tpl').content.firstElementChild.cloneNode(true);
    $('#auxes').append(node);
    card = { node, body: node.querySelector('tbody') };
    auxCards.set(aux.aux, card);
  }
  card.node.querySelector('.aux-title').textContent = `AUX ${aux.aux} — ${aux.name}`;
  card.node.querySelector('.aux-out .fill').style.width = pct(aux.outDB ?? METER_MIN);
  card.node.querySelector('.aux-out-db').textContent = `${fmt(aux.outDB)} dB`;

  for (const ch of aux.channels) {
    const id = `${aux.aux}:${ch.key}`;
    let row = rows.get(id);
    if (!row) {
      row = createRow(aux.aux, ch);
      rows.set(id, row);
      card.body.append(row.tr);
    }
    updateRow(row, ch, s);
    row.tr.hidden = !showAll && ch.status === 'sem-envio';
  }
}

function createRow(aux, ch) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="checkbox" class="en"></td>
    <td><strong class="name"></strong> <span class="muted key"></span></td>
    <td><span class="status"></span></td>
    <td><div class="meter"><div class="band"></div><div class="fill"></div><div class="avg"></div><div class="target"></div></div></td>
    <td class="num send"></td>
    <td class="num delta"></td>
    <td class="num">
      <button class="small" data-act="t-">−1</button>
      <span class="target-db"></span>
      <button class="small" data-act="t+">+1</button>
      <button class="small" data-act="clear" title="Esquecer o alvo deste canal">×</button>
    </td>
    <td class="sim-col">
      fonte <button class="small" data-act="src-">−6</button><button class="small" data-act="src+">+6</button>
      operador <button class="small" data-act="op-">−3</button><button class="small" data-act="op+">+3</button>
    </td>`;
  tr.querySelector('.key').textContent = ch.key;
  tr.querySelector('.en').addEventListener('change', (e) =>
    send({ type: 'setEnabled', aux, key: ch.key, enabled: e.target.checked }),
  );
  tr.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    const key = ch.key;
    if (act === 't-') send({ type: 'nudgeTarget', aux, key, delta: -1 });
    if (act === 't+') send({ type: 'nudgeTarget', aux, key, delta: 1 });
    if (act === 'clear') send({ type: 'clearTarget', aux, key });
    if (act === 'src-') send({ type: 'sim.source', key, delta: -6 });
    if (act === 'src+') send({ type: 'sim.source', key, delta: 6 });
    if (act === 'op-') send({ type: 'sim.operator', aux, key, delta: -3 });
    if (act === 'op+') send({ type: 'sim.operator', aux, key, delta: 3 });
  });
  return {
    tr,
    en: tr.querySelector('.en'),
    name: tr.querySelector('.name'),
    status: tr.querySelector('.status'),
    fill: tr.querySelector('.fill'),
    avg: tr.querySelector('.avg'),
    target: tr.querySelector('.target'),
    band: tr.querySelector('.band'),
    send: tr.querySelector('.send'),
    delta: tr.querySelector('.delta'),
    targetDb: tr.querySelector('.target-db'),
  };
}

function updateRow(row, ch, s) {
  row.tr.classList.toggle('off', !ch.enabled);
  row.en.checked = ch.enabled;
  row.name.textContent = ch.name;

  let label = STATUS_LABEL[ch.status] ?? ch.status;
  if (ch.status === 'manual') label += ` ${ch.manualForSec}s`;
  if (ch.status === 'corrigindo' && s.mode !== 'automatico') label = 'corrigiria';
  row.status.textContent = label;
  row.status.className = `status ${ch.status}`;

  const silent = ch.status === 'silencio' || ch.rawDB === undefined || ch.rawDB <= -79;
  const instant = !silent && ch.sendDB !== undefined ? ch.rawDB + ch.sendDB : METER_MIN;
  row.fill.style.width = pct(instant);
  row.avg.style.display = ch.contributionDB === undefined ? 'none' : '';
  row.avg.style.left = pct(ch.contributionDB ?? METER_MIN);

  const hasTarget = ch.targetDB !== undefined && ch.targetDB !== null;
  row.target.style.display = hasTarget ? '' : 'none';
  row.band.style.display = hasTarget ? '' : 'none';
  if (hasTarget) {
    row.target.style.left = pct(ch.targetDB);
    const lo = parseFloat(pct(ch.targetDB - s.deadbandDB));
    const hi = parseFloat(pct(ch.targetDB + s.deadbandDB));
    row.band.style.left = `${lo}%`;
    row.band.style.width = `${hi - lo}%`;
  }

  row.send.textContent = ch.sendDB === undefined ? '-∞' : `${fmt(ch.sendDB)} dB`;

  // Correção: no automático, o quanto já mexeu; observando, o quanto mexeria.
  const applied = ch.sendDB !== undefined && ch.baseSendDB !== undefined ? ch.sendDB - ch.baseSendDB : 0;
  const shown = s.mode === 'automatico' ? applied : ch.suggestedDeltaDB;
  row.delta.textContent = Math.abs(shown) < 0.05 ? '—' : `${fmt(shown, true)} dB`;
  row.delta.className = `num delta ${shown < -0.05 ? 'down' : shown > 0.05 ? 'up' : ''}`;

  row.targetDb.textContent = hasTarget ? fmt(ch.targetDB) : '—';
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.mode === 'automatico' && state?.mode !== 'automatico' && state?.mixer?.kind === 'mesa') {
      if (!confirm('Ligar o modo AUTOMÁTICO? O software vai mexer nos envios do aux da live.')) return;
    }
    send({ type: 'setMode', mode: b.dataset.mode });
  }),
);
document.querySelectorAll('[data-scene]').forEach((b) =>
  b.addEventListener('click', () => send({ type: 'sim.scene', scene: b.dataset.scene })),
);
$('#capture').addEventListener('click', () => {
  if (confirm('Gravar o nível atual de cada canal que está tocando como alvo da live?')) send({ type: 'capture' });
});
$('#restore').addEventListener('click', () => {
  if (confirm('Voltar todos os envios do aux da live para a mixagem original?')) send({ type: 'restore' });
});
$('#sim-reset').addEventListener('click', () => send({ type: 'sim.reset' }));
$('#show-all').addEventListener('change', () => state && render());

connect();
