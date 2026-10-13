// Painel do Copiloto Ui24R. Recebe o estado do servidor por WebSocket e manda comandos.

const STATUS_LABEL = {
  desabilitado: 'manual',
  'sem-envio': 'sem envio',
  'sem-alvo': 'sem alvo',
  manual: 'operador',
  transicao: 'preset',
  silencio: 'silêncio',
  aguardando: 'aguardando',
  ok: 'ok',
  corrigindo: 'corrigindo',
  'no-limite': 'no limite',
};

const FX_STATUS_LABEL = {
  desligado: 'fixo',
  'sem-envio': 'sem envio',
  'sem-entrada': 'parado',
  transicao: 'preset',
  ok: 'ok',
  acompanhando: 'acompanhando',
};

const MODE_HELP = {
  desligado: 'O software só mostra os níveis. Os faders daqui continuam funcionando, como na mesa.',
  observar: 'O software calcula as correções, mas NÃO mexe na mesa. Use para conferir antes de ligar o automático.',
  automatico: 'O software está ajustando os envios do aux da live e os efeitos, devagar e dentro dos limites.',
};

const METER_MIN = -60;
/** Posição do fader (0..1000) para cada dB, parecida com a escala da Ui24R. */
const FADER_MAP = [
  [-80, 1],
  [-50, 80],
  [-40, 160],
  [-30, 260],
  [-20, 390],
  [-10, 560],
  [-5, 660],
  [0, 760],
  [5, 880],
  [10, 1000],
];
const SCALE_MARKS = [10, 5, 0, -5, -10, -20, -30, -40, -50];
const SEND_THROTTLE_MS = 80;

const $ = (sel, root = document) => root.querySelector(sel);
let socket;
let state;
const tableRows = new Map(); // `${aux}:${key}` -> linha da tabela
const strips = new Map(); // `${aux}:${key}` -> faixa vertical
const auxCards = new Map();

// ---------- conexão ----------

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

// ---------- utilidades ----------

const meterPct = (db) => Math.max(0, Math.min(100, ((db - METER_MIN) / -METER_MIN) * 100));
const fmt = (db, signed = false) =>
  db === undefined || db === null ? '—' : `${signed && db > 0 ? '+' : ''}${db.toFixed(1)}`;
const fmtSend = (db) => (db === undefined || db === null ? '-∞' : db.toFixed(1));

function dbToPos(db) {
  if (db === undefined || db === null || !Number.isFinite(db) || db <= -80) return 0;
  for (let i = 1; i < FADER_MAP.length; i++) {
    const [d1, p1] = FADER_MAP[i];
    if (db <= d1) {
      const [d0, p0] = FADER_MAP[i - 1];
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 1000;
}

function posToDb(pos) {
  if (pos <= 0) return null; // -∞
  for (let i = 1; i < FADER_MAP.length; i++) {
    const [d1, p1] = FADER_MAP[i];
    if (pos <= p1) {
      const [d0, p0] = FADER_MAP[i - 1];
      return Math.round((d0 + ((pos - p0) / (p1 - p0)) * (d1 - d0)) * 10) / 10;
    }
  }
  return 10;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------- render geral ----------

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

  renderPresets(s);

  const showAll = $('#show-all').checked;
  for (const aux of s.auxes) renderAux(aux, showAll, s);

  $('#events').innerHTML = s.events
    .map((e) => `<li><time>${new Date(e.t).toLocaleTimeString('pt-BR')}</time>${escapeHtml(e.text)}</li>`)
    .join('');
}

function renderPresets(s) {
  const list = $('#preset-list');
  const sig = JSON.stringify([s.presets, s.activePresetId]);
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.innerHTML = s.presets.length
      ? s.presets
          .map(
            (p) =>
              `<button data-preset="${p.id}" class="${p.id === s.activePresetId ? 'active' : ''}" title="Carregar (fade suave)">${escapeHtml(p.name)}</button>`,
          )
          .join('')
      : '<span class="empty">nenhum preset ainda — monte a mixagem e clique em "Salvar novo"</span>';
  }
  const hasActive = s.presets.some((p) => p.id === s.activePresetId);
  $('#preset-update').disabled = !hasActive;
  $('#preset-delete').disabled = !hasActive;
}

function renderAux(aux, showAll, s) {
  let card = auxCards.get(aux.aux);
  if (!card) {
    const node = $('#aux-tpl').content.firstElementChild.cloneNode(true);
    $('#auxes').append(node);
    card = {
      node,
      body: $('tbody', node),
      chGroup: $('.ch-group', node),
      fxGroup: $('.fx-group', node),
      masterGroup: $('.master-group', node),
    };
    auxCards.set(aux.aux, card);
  }
  $('.aux-title', card.node).textContent = `AUX ${aux.aux} — ${aux.name}`;

  for (const ch of aux.channels) {
    const hidden = !showAll && ch.status === 'sem-envio';
    const strip = getStrip(`${aux.aux}:${ch.key}`, () => createChannelStrip(aux.aux, ch), card.chGroup);
    updateChannelStrip(strip, ch, s);
    strip.el.hidden = hidden;

    let row = tableRows.get(`${aux.aux}:${ch.key}`);
    if (!row) {
      row = createRow(aux.aux, ch);
      tableRows.set(`${aux.aux}:${ch.key}`, row);
      card.body.append(row.tr);
    }
    updateRow(row, ch, s);
    row.tr.hidden = hidden;
  }

  for (const fx of aux.fx) {
    const strip = getStrip(`${aux.aux}:${fx.key}`, () => createFxStrip(aux.aux, fx), card.fxGroup);
    updateFxStrip(strip, fx, s);
    strip.el.hidden = !showAll && fx.status === 'sem-envio';
  }

  const master = getStrip(`${aux.aux}:master`, () => createMasterStrip(aux.aux), card.masterGroup);
  updateMasterStrip(master, aux);
}

function getStrip(id, create, parent) {
  let strip = strips.get(id);
  if (!strip) {
    strip = create();
    strips.set(id, strip);
    parent.append(strip.el);
  }
  return strip;
}

// ---------- faixas verticais ----------

function stripSkeleton({ cls = '', name = '', key = '', toggleLabel = 'AUTO', toggleTitle = '' }) {
  const el = document.createElement('div');
  el.className = `strip ${cls}`;
  el.innerHTML = `
    <div class="strip-name"></div>
    <div class="strip-key"></div>
    <span class="status"></span>
    <button class="auto-btn" title="${toggleTitle}">${toggleLabel}</button>
    <div class="strip-body">
      <div class="vmeter"><div class="band"></div><div class="fill"></div><div class="avg"></div><div class="target"></div></div>
      <div class="scale">${SCALE_MARKS.map((d) => `<span style="bottom: calc(9px + (100% - 18px) * ${dbToPos(d) / 1000})">${d > 0 ? '+' : ''}${d}</span>`).join('')}</div>
      <input type="range" class="fader" min="0" max="1000" step="1" aria-label="Envio para a live">
    </div>
    <div class="send-db"></div>
    <div class="delta"></div>`;
  $('.strip-name', el).textContent = name;
  $('.strip-key', el).textContent = key;
  return {
    el,
    name: $('.strip-name', el),
    status: $('.status', el),
    toggle: $('.auto-btn', el),
    fill: $('.fill', el),
    avg: $('.avg', el),
    target: $('.target', el),
    band: $('.band', el),
    fader: $('.fader', el),
    sendDb: $('.send-db', el),
    delta: $('.delta', el),
    lastValue: undefined,
  };
}

/** Liga o fader: enquanto o usuário arrasta, o painel não sobrescreve a posição. */
function bindFader(strip, onValue) {
  const f = strip.fader;
  let lastSent = 0;
  let pending;
  const push = () => {
    lastSent = Date.now();
    pending = undefined;
    onValue(posToDb(Number(f.value)));
  };
  f.addEventListener('pointerdown', () => (strip.dragging = true));
  f.addEventListener('input', () => {
    strip.dragging = true;
    strip.sendDb.textContent = fmtSend(posToDb(Number(f.value)));
    const wait = SEND_THROTTLE_MS - (Date.now() - lastSent);
    if (wait <= 0) push();
    else if (!pending) pending = setTimeout(push, wait);
  });
  const release = () => {
    if (pending) {
      clearTimeout(pending);
      push();
    }
    setTimeout(() => (strip.dragging = false), 400);
  };
  f.addEventListener('change', release);
  f.addEventListener('pointerup', release);
  f.addEventListener('blur', () => (strip.dragging = false));
}

/** Atualiza a posição do fader a partir da mesa; destaca quando foi o software que moveu. */
function setFader(strip, db) {
  if (strip.dragging) return;
  const pos = Math.round(dbToPos(db));
  if (strip.lastValue !== undefined && strip.lastValue !== pos) {
    strip.fader.classList.add('moving');
    clearTimeout(strip.movingTimer);
    strip.movingTimer = setTimeout(() => strip.fader.classList.remove('moving'), 900);
  }
  strip.lastValue = pos;
  strip.fader.value = String(pos);
  strip.sendDb.textContent = fmtSend(db);
}

function setMeter(strip, instantDB, avgDB, targetDB, deadbandDB) {
  strip.fill.style.height = `${meterPct(instantDB ?? METER_MIN)}%`;
  strip.avg.style.display = avgDB === undefined || avgDB === null ? 'none' : '';
  strip.avg.style.bottom = `${meterPct(avgDB ?? METER_MIN)}%`;
  const hasTarget = targetDB !== undefined && targetDB !== null;
  strip.target.style.display = hasTarget ? '' : 'none';
  strip.band.style.display = hasTarget && deadbandDB ? '' : 'none';
  if (hasTarget) {
    strip.target.style.bottom = `${meterPct(targetDB)}%`;
    if (deadbandDB) {
      const lo = meterPct(targetDB - deadbandDB);
      strip.band.style.bottom = `${lo}%`;
      strip.band.style.height = `${meterPct(targetDB + deadbandDB) - lo}%`;
    }
  }
}

function setDelta(el, value) {
  el.textContent = value === undefined || Math.abs(value) < 0.05 ? '' : `${fmt(value, true)} dB`;
  el.className = `delta ${value < -0.05 ? 'down' : value > 0.05 ? 'up' : ''}`;
}

function createChannelStrip(aux, ch) {
  const strip = stripSkeleton({
    name: ch.name,
    key: ch.key,
    toggleTitle: 'Liga/desliga o controle automático deste canal',
  });
  const extra = document.createElement('div');
  extra.innerHTML = `
    <div class="small-label">alvo</div>
    <div class="target-ctl"><button data-act="t-" title="Alvo −1 dB">−</button><span class="target-db"></span><button data-act="t+" title="Alvo +1 dB">+</button></div>
    <div class="sim-ctl">fonte <button data-act="src-">−6</button><button data-act="src+">+6</button></div>`;
  strip.el.append(...extra.children);
  strip.targetDb = $('.target-db', strip.el);

  strip.toggle.addEventListener('click', () =>
    send({ type: 'setEnabled', aux, key: ch.key, enabled: !strip.toggle.classList.contains('on') }),
  );
  strip.el.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 't-') send({ type: 'nudgeTarget', aux, key: ch.key, delta: -1 });
    if (act === 't+') send({ type: 'nudgeTarget', aux, key: ch.key, delta: 1 });
    if (act === 'src-') send({ type: 'sim.source', key: ch.key, delta: -6 });
    if (act === 'src+') send({ type: 'sim.source', key: ch.key, delta: 6 });
  });
  bindFader(strip, (db) => send({ type: 'setSend', aux, key: ch.key, db }));
  return strip;
}

function updateChannelStrip(strip, ch, s) {
  strip.el.classList.toggle('off', !ch.enabled);
  strip.name.textContent = ch.name;
  strip.name.title = ch.name;
  strip.toggle.classList.toggle('on', ch.enabled);

  let label = STATUS_LABEL[ch.status] ?? ch.status;
  if (ch.status === 'manual') label += ` ${ch.manualForSec}s`;
  if (ch.status === 'corrigindo' && s.mode !== 'automatico') label = 'corrigiria';
  strip.status.textContent = label;
  strip.status.className = `status ${ch.status}`;

  const silent = ch.status === 'silencio' || ch.rawDB === undefined || ch.rawDB <= -79;
  const instant = !silent && ch.sendDB !== undefined ? ch.rawDB + ch.sendDB : METER_MIN;
  setMeter(strip, instant, ch.contributionDB, ch.targetDB, s.deadbandDB);
  setFader(strip, ch.sendDB);

  const applied = ch.sendDB !== undefined && ch.baseSendDB !== undefined ? ch.sendDB - ch.baseSendDB : 0;
  setDelta(strip.delta, s.mode === 'automatico' ? applied : ch.suggestedDeltaDB);
  strip.targetDb.textContent = ch.targetDB === undefined || ch.targetDB === null ? '—' : fmt(ch.targetDB);
}

function createFxStrip(aux, fx) {
  const strip = stripSkeleton({
    cls: 'fx',
    name: fx.name,
    key: fx.key.toUpperCase(),
    toggleLabel: 'ACOMP.',
    toggleTitle: 'Efeito acompanha os canais: quando o envio de um canal para a live desce, o efeito dele desce junto',
  });
  const label = document.createElement('div');
  label.className = 'small-label';
  label.textContent = 'compensação';
  strip.el.insertBefore(label, strip.delta);
  strip.toggle.addEventListener('click', () =>
    send({ type: 'setFxFollow', aux, key: fx.key, follow: !strip.toggle.classList.contains('on') }),
  );
  bindFader(strip, (db) => send({ type: 'setSend', aux, key: fx.key, db }));
  return strip;
}

function updateFxStrip(strip, fx, s) {
  strip.name.textContent = fx.name;
  strip.name.title = fx.name;
  strip.toggle.classList.toggle('on', fx.follow);
  let label = FX_STATUS_LABEL[fx.status] ?? fx.status;
  if (fx.status === 'acompanhando' && s.mode !== 'automatico') label = 'acompanharia';
  strip.status.textContent = label;
  strip.status.className = `status ${fx.status}`;
  const instant = fx.rawDB !== undefined && fx.sendDB !== undefined ? fx.rawDB + fx.sendDB : METER_MIN;
  setMeter(strip, instant);
  setFader(strip, fx.sendDB);
  setDelta(strip.delta, fx.follow ? fx.followDeltaDB : undefined);
}

function createMasterStrip(aux) {
  const strip = stripSkeleton({ cls: 'master', name: 'LIVE', key: `master aux ${aux}`, toggleLabel: 'GERAL' });
  strip.toggle.disabled = true;
  strip.toggle.title = 'Volume geral da live: não muda o equilíbrio entre os canais';
  bindFader(strip, (db) => send({ type: 'setAuxMaster', aux, db }));
  return strip;
}

function updateMasterStrip(strip, aux) {
  strip.status.textContent = aux.outDB === undefined ? '—' : `saída ${fmt(aux.outDB)}`;
  strip.status.className = `status ${aux.outDB > -3 ? 'no-limite' : 'ok'}`;
  setMeter(strip, aux.outDB);
  setFader(strip, aux.masterDB);
}

// ---------- vista tabela ----------

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
    </td>`;
  $('.key', tr).textContent = ch.key;
  $('.en', tr).addEventListener('change', (e) =>
    send({ type: 'setEnabled', aux, key: ch.key, enabled: e.target.checked }),
  );
  tr.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    const key = ch.key;
    if (act === 't-') send({ type: 'nudgeTarget', aux, key, delta: -1 });
    if (act === 't+') send({ type: 'nudgeTarget', aux, key, delta: 1 });
    if (act === 'clear') send({ type: 'clearTarget', aux, key });
    if (act === 'src-') send({ type: 'sim.source', key, delta: -6 });
    if (act === 'src+') send({ type: 'sim.source', key, delta: 6 });
  });
  return {
    tr,
    en: $('.en', tr),
    name: $('.name', tr),
    status: $('.status', tr),
    fill: $('.fill', tr),
    avg: $('.avg', tr),
    target: $('.target', tr),
    band: $('.band', tr),
    send: $('.send', tr),
    delta: $('.delta', tr),
    targetDb: $('.target-db', tr),
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
  row.fill.style.width = `${meterPct(instant)}%`;
  row.avg.style.display = ch.contributionDB === undefined ? 'none' : '';
  row.avg.style.left = `${meterPct(ch.contributionDB ?? METER_MIN)}%`;

  const hasTarget = ch.targetDB !== undefined && ch.targetDB !== null;
  row.target.style.display = hasTarget ? '' : 'none';
  row.band.style.display = hasTarget ? '' : 'none';
  if (hasTarget) {
    row.target.style.left = `${meterPct(ch.targetDB)}%`;
    const lo = meterPct(ch.targetDB - s.deadbandDB);
    row.band.style.left = `${lo}%`;
    row.band.style.width = `${meterPct(ch.targetDB + s.deadbandDB) - lo}%`;
  }

  row.send.textContent = `${fmtSend(ch.sendDB)} dB`;
  const applied = ch.sendDB !== undefined && ch.baseSendDB !== undefined ? ch.sendDB - ch.baseSendDB : 0;
  const shown = s.mode === 'automatico' ? applied : ch.suggestedDeltaDB;
  row.delta.textContent = Math.abs(shown) < 0.05 ? '—' : `${fmt(shown, true)} dB`;
  row.delta.className = `num delta ${shown < -0.05 ? 'down' : shown > 0.05 ? 'up' : ''}`;
  row.targetDb.textContent = hasTarget ? fmt(ch.targetDB) : '—';
}

// ---------- controles do topo ----------

function setView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  try {
    localStorage.setItem('copiloto.view', view);
  } catch {
    // sem localStorage: tudo bem, só não lembra a vista
  }
}

let savedView = 'mesa';
try {
  savedView = localStorage.getItem('copiloto.view') ?? 'mesa';
} catch {
  // ignora
}
setView(savedView === 'tabela' ? 'tabela' : 'mesa');

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

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
  if (confirm('Voltar todos os envios do aux da live para a mixagem original (ou do preset carregado)?')) send({ type: 'restore' });
});
$('#preset-list').addEventListener('click', (e) => {
  const id = e.target.dataset?.preset;
  if (id) send({ type: 'preset.load', id });
});
$('#preset-new').addEventListener('click', () => {
  const name = prompt('Nome do preset (ex.: "Louvor - mais batera"):');
  if (name?.trim()) send({ type: 'preset.save', name: name.trim() });
});
$('#preset-update').addEventListener('click', () => {
  const p = state?.presets.find((x) => x.id === state.activePresetId);
  if (p && confirm(`Sobrescrever o preset "${p.name}" com a mixagem atual?`)) send({ type: 'preset.save', name: p.name, id: p.id });
});
$('#preset-delete').addEventListener('click', () => {
  const p = state?.presets.find((x) => x.id === state.activePresetId);
  if (p && confirm(`Apagar o preset "${p.name}"?`)) send({ type: 'preset.delete', id: p.id });
});
$('#sim-reset').addEventListener('click', () => send({ type: 'sim.reset' }));
$('#show-all').addEventListener('change', () => state && render());

connect();
