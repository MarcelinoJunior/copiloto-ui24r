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
  automatico: 'O software está ajustando as saídas selecionadas (envios e efeitos), devagar e dentro dos limites.',
};

const MASTER_BUS = 0;
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
const tableRows = new Map(); // `${bus}:${key}` -> linha da tabela
const strips = new Map(); // `${bus}:${key}` -> faixa vertical
const busCards = new Map(); // bus -> card

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
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------- render geral ----------

function render() {
  const s = state;
  document.body.classList.toggle('is-sim', Boolean(s.sim));
  const h = s.health;
  const pingTxt = h?.ping.lastMs === undefined ? '' : h.ping.lastMs === null ? ' · sem resposta' : ` · ${Math.round(h.ping.lastMs)} ms`;
  const pillClass = s.connection !== 'conectado' ? s.connection : h?.quality === 'boa' ? 'conectado' : 'conectando';
  setConn(pillClass, s.connection === 'conectado' ? `mesa conectada${pingTxt}${h && h.quality !== 'boa' ? ' · instável' : ''}` : `mesa: ${s.connection}`);
  $('#mixer-info').textContent = s.mixer
    ? `${s.mixer.kind === 'simulador' ? 'SIMULADOR' : s.mixer.address} · ${s.mixer.model} · fw ${s.mixer.firmware}`
    : s.connectionDetail ?? '';

  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
  $('#mode-help').textContent = MODE_HELP[s.mode];

  $('#sim').hidden = !s.sim;
  if (s.sim) document.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('active', b.dataset.scene === s.sim.scene));

  renderBusList(s);
  renderPresets(s);

  const showAll = $('#show-all').checked;
  const controlled = new Set(s.controlled.map((c) => c.bus));
  for (const [bus, card] of busCards) {
    if (controlled.has(bus)) continue;
    card.node.remove();
    busCards.delete(bus);
    for (const id of [...strips.keys()]) if (id.startsWith(`${bus}:`)) strips.delete(id);
    for (const id of [...tableRows.keys()]) if (id.startsWith(`${bus}:`)) tableRows.delete(id);
  }
  for (const bus of s.controlled) renderBus(bus, showAll, s);
  $('#no-bus').hidden = s.controlled.length > 0 || !s.mixer;

  $('#events').innerHTML = s.events
    .map((e) => `<li><time>${new Date(e.t).toLocaleTimeString('pt-BR')}</time>${escapeHtml(e.text)}</li>`)
    .join('');
}

function renderBusList(s) {
  const list = $('#bus-list');
  const sig = JSON.stringify(s.buses);
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = s.buses
    .map((b) => {
      const isMaster = b.id === MASTER_BUS;
      const sub = isMaster ? 'som do salão' : `${escapeHtml(b.name)}${b.stereo ? ' · estéreo' : ''}`;
      return `<button data-bus="${b.id}" class="${b.selected ? 'selected' : ''} ${isMaster ? 'master' : ''}" aria-pressed="${b.selected}">
        ${escapeHtml(b.label)}<small>${sub}</small></button>`;
    })
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

function busHelp(bus) {
  if (bus.bus === MASTER_BUS) {
    return '<span class="warn">⚠ MASTER: os faders abaixo são os FADERS dos canais no master. Mexer aqui muda o som do SALÃO.</span>';
  }
  return `Os faders abaixo são os <strong>envios de cada canal para ${escapeHtml(bus.label)}</strong> (igual à tela "${escapeHtml(bus.label.split('+')[0])}" na Ui24R). ` +
    `${bus.stereo ? 'Par estéreo: os dois lados mudam juntos. ' : ''}O som do salão não muda.`;
}

function renderBus(bus, showAll, s) {
  let card = busCards.get(bus.bus);
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
    busCards.set(bus.bus, card);
  }
  card.node.classList.toggle('is-master', bus.bus === MASTER_BUS);
  $('.aux-title', card.node).textContent =
    bus.bus === MASTER_BUS ? 'MASTER — som do salão' : `${bus.label} — ${bus.name}${bus.stereo ? ' (estéreo)' : ''}`;
  $('.aux-help', card.node).innerHTML = busHelp(bus);

  for (const ch of bus.channels) {
    const id = `${bus.bus}:${ch.key}`;
    const hidden = !showAll && ch.status === 'sem-envio';
    const strip = getStrip(id, () => createChannelStrip(bus, ch), card.chGroup);
    updateChannelStrip(strip, ch, s);
    strip.el.hidden = hidden;

    let row = tableRows.get(id);
    if (!row) {
      row = createRow(bus.bus, ch);
      tableRows.set(id, row);
      card.body.append(row.tr);
    }
    updateRow(row, ch, s);
    row.tr.hidden = hidden;
  }

  for (const fx of bus.fx) {
    const strip = getStrip(`${bus.bus}:${fx.key}`, () => createFxStrip(bus, fx), card.fxGroup);
    updateFxStrip(strip, fx, s);
    strip.el.hidden = !showAll && fx.status === 'sem-envio';
  }

  const master = getStrip(`${bus.bus}:master`, () => createMasterStrip(bus), card.masterGroup);
  updateMasterStrip(master, bus);
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

// ---------- faders ----------

/** Liga um fader (vertical ou mini): enquanto o usuário arrasta, o painel não sobrescreve a posição. */
function bindFader(ctrl, onValue) {
  const f = ctrl.fader;
  let lastSent = 0;
  let pending;
  const push = () => {
    lastSent = Date.now();
    pending = undefined;
    onValue(posToDb(Number(f.value)));
  };
  f.addEventListener('pointerdown', () => (ctrl.dragging = true));
  f.addEventListener('input', () => {
    ctrl.dragging = true;
    ctrl.readout.textContent = fmtSend(posToDb(Number(f.value)));
    const wait = SEND_THROTTLE_MS - (Date.now() - lastSent);
    if (wait <= 0) push();
    else if (!pending) pending = setTimeout(push, wait);
  });
  const release = () => {
    if (pending) {
      clearTimeout(pending);
      push();
    }
    setTimeout(() => (ctrl.dragging = false), 400);
  };
  f.addEventListener('change', release);
  f.addEventListener('pointerup', release);
  f.addEventListener('blur', () => (ctrl.dragging = false));
}

/** Atualiza a posição do fader a partir da mesa; destaca quando algo (o software) moveu. */
function setFader(ctrl, db) {
  if (ctrl.dragging) return;
  const pos = Math.round(dbToPos(db));
  if (ctrl.lastValue !== undefined && ctrl.lastValue !== pos) {
    ctrl.fader.classList.add('moving');
    clearTimeout(ctrl.movingTimer);
    ctrl.movingTimer = setTimeout(() => ctrl.fader.classList.remove('moving'), 900);
  }
  ctrl.lastValue = pos;
  ctrl.fader.value = String(pos);
  ctrl.readout.textContent = fmtSend(db);
}

// ---------- faixas verticais ----------

function stripSkeleton({ cls = '', name = '', key = '', toggleLabel = 'AUTO', toggleTitle = '', dest = '' }) {
  const el = document.createElement('div');
  el.className = `strip ${cls}`;
  el.innerHTML = `
    <div class="strip-name"></div>
    <div class="strip-key"></div>
    <span class="status"></span>
    <button class="auto-btn" title="${escapeHtml(toggleTitle)}">${toggleLabel}</button>
    <div class="strip-body">
      <div class="vmeter"><div class="band"></div><div class="fill"></div><div class="avg"></div><div class="target"></div></div>
      <div class="scale">${SCALE_MARKS.map((d) => `<span style="bottom: calc(9px + (100% - 18px) * ${dbToPos(d) / 1000})">${d > 0 ? '+' : ''}${d}</span>`).join('')}</div>
      <input type="range" class="fader" min="0" max="1000" step="1">
    </div>
    <div class="send-db"></div>
    <div class="fader-dest"></div>
    <div class="delta"></div>`;
  $('.strip-name', el).textContent = name;
  $('.strip-key', el).textContent = key;
  $('.fader-dest', el).textContent = dest;
  $('.fader', el).setAttribute('aria-label', `${name}: ${dest}`);
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
    readout: $('.send-db', el),
    delta: $('.delta', el),
  };
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
  el.textContent = value === undefined || value === null || Math.abs(value) < 0.05 ? '' : `${fmt(value, true)} dB`;
  el.className = `delta ${value < -0.05 ? 'down' : value > 0.05 ? 'up' : ''}`;
}

function createChannelStrip(bus, ch) {
  const isMaster = bus.bus === MASTER_BUS;
  const strip = stripSkeleton({
    name: ch.name,
    key: ch.key,
    toggleTitle: 'Liga/desliga o controle automático deste canal',
    dest: isMaster ? 'fader no master' : `envio → ${bus.label}`,
  });
  const extra = document.createElement('div');
  extra.innerHTML = `
    <div class="small-label">alvo</div>
    <div class="target-ctl"><button data-act="t-" title="Alvo −1 dB">−</button><span class="target-db"></span><button data-act="t+" title="Alvo +1 dB">+</button></div>
    <div class="fx-sends" title="Quanto deste canal vai para cada efeito"></div>
    <div class="sim-ctl">fonte <button data-act="src-">−6</button><button data-act="src+">+6</button></div>`;
  strip.el.append(...extra.children);
  strip.targetDb = $('.target-db', strip.el);
  strip.fxBox = $('.fx-sends', strip.el);
  strip.fxCtrls = new Map();
  strip.chKey = ch.key;

  strip.toggle.addEventListener('click', () =>
    send({ type: 'setEnabled', bus: bus.bus, key: ch.key, enabled: !strip.toggle.classList.contains('on') }),
  );
  strip.el.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 't-') send({ type: 'nudgeTarget', bus: bus.bus, key: ch.key, delta: -1 });
    if (act === 't+') send({ type: 'nudgeTarget', bus: bus.bus, key: ch.key, delta: 1 });
    if (act === 'src-') send({ type: 'sim.source', key: ch.key, delta: -6 });
    if (act === 'src+') send({ type: 'sim.source', key: ch.key, delta: 6 });
  });
  bindFader(strip, (db) => send({ type: 'setSend', bus: bus.bus, key: ch.key, db }));
  return strip;
}

/** Mini faders "canal → efeito". Laranja = esse efeito também toca no salão. */
function updateFxSends(strip, s) {
  const sends = s.fxSends[strip.chKey] ?? {};
  for (const fx of s.fxInfo) {
    let ctrl = strip.fxCtrls.get(fx.key);
    if (!ctrl) {
      const el = document.createElement('div');
      el.className = 'fx-send';
      el.innerHTML = `<div class="lbl"><span class="nm"></span><span class="val"></span></div>
        <input type="range" min="0" max="1000" step="1">`;
      strip.fxBox.append(el);
      ctrl = { el, fader: $('input', el), readout: $('.val', el), name: $('.nm', el) };
      bindFader(ctrl, (db) => send({ type: 'setFxSend', fx: fx.key, key: strip.chKey, db }));
      strip.fxCtrls.set(fx.key, ctrl);
    }
    ctrl.name.textContent = fx.name;
    ctrl.el.classList.toggle('room', fx.inRoom);
    ctrl.el.title = fx.inRoom
      ? `${fx.name}: este efeito toca no SALÃO e na live — mexer aqui muda os dois`
      : `${fx.name}: efeito só da live — mexer aqui não muda o salão`;
    ctrl.fader.setAttribute('aria-label', `Envio de ${strip.name.textContent} para ${fx.name}`);
    setFader(ctrl, sends[fx.key]);
  }
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
  updateFxSends(strip, s);
}

function createFxStrip(bus, fx) {
  const isMaster = bus.bus === MASTER_BUS;
  const strip = stripSkeleton({
    cls: 'fx',
    name: fx.name,
    key: fx.key.toUpperCase(),
    toggleLabel: 'ACOMP.',
    toggleTitle: 'Efeito acompanha os canais: quando um canal desce nesta saída, o efeito dele desce junto',
    dest: isMaster ? 'retorno no master' : `retorno → ${bus.label}`,
  });
  strip.badge = document.createElement('span');
  strip.el.insertBefore(strip.badge, strip.toggle);
  const label = document.createElement('div');
  label.className = 'small-label';
  label.textContent = 'compensação';
  strip.el.insertBefore(label, strip.delta);
  strip.toggle.addEventListener('click', () =>
    send({ type: 'setFxFollow', bus: bus.bus, key: fx.key, follow: !strip.toggle.classList.contains('on') }),
  );
  bindFader(strip, (db) => send({ type: 'setSend', bus: bus.bus, key: fx.key, db }));
  return strip;
}

function updateFxStrip(strip, fx, s) {
  strip.name.textContent = fx.name;
  strip.name.title = fx.name;
  const inRoom = s.fxInfo.find((f) => f.key === fx.key)?.inRoom;
  strip.badge.className = `fx-badge ${inRoom ? 'room' : 'live'}`;
  strip.badge.textContent = inRoom ? 'salão + live' : 'só live';
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

function createMasterStrip(bus) {
  const isMaster = bus.bus === MASTER_BUS;
  const strip = stripSkeleton({
    cls: 'master',
    name: isMaster ? 'MASTER' : bus.label,
    key: isMaster ? 'master do salão' : 'master do aux',
    toggleLabel: 'GERAL',
    dest: 'volume geral',
  });
  strip.toggle.disabled = true;
  strip.toggle.title = 'Volume geral desta saída: não muda o equilíbrio entre os canais';
  bindFader(strip, (db) => send({ type: 'setBusMaster', bus: bus.bus, db }));
  return strip;
}

function updateMasterStrip(strip, bus) {
  strip.status.textContent = bus.outDB === undefined ? '—' : `saída ${fmt(bus.outDB)}`;
  strip.status.className = `status ${bus.outDB > -3 ? 'no-limite' : 'ok'}`;
  setMeter(strip, bus.outDB);
  setFader(strip, bus.masterDB);
}

// ---------- vista tabela ----------

function createRow(bus, ch) {
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
  $('.en', tr).addEventListener('change', (e) => send({ type: 'setEnabled', bus, key: ch.key, enabled: e.target.checked }));
  tr.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    const key = ch.key;
    if (act === 't-') send({ type: 'nudgeTarget', bus, key, delta: -1 });
    if (act === 't+') send({ type: 'nudgeTarget', bus, key, delta: 1 });
    if (act === 'clear') send({ type: 'clearTarget', bus, key });
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

// ---------- preferências locais ----------

function pref(key, fallback) {
  try {
    return localStorage.getItem(`copiloto.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(`copiloto.${key}`, value);
  } catch {
    // sem localStorage: só não lembra a preferência
  }
}

function setView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  setPref('view', view);
}

setView(pref('view', 'mesa') === 'tabela' ? 'tabela' : 'mesa');
$('#show-fx').checked = pref('showFx', '1') === '1';
document.body.classList.toggle('show-fx', $('#show-fx').checked);

// ---------- controles do topo ----------

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.mode === 'automatico' && state?.mode !== 'automatico' && state?.mixer?.kind === 'mesa') {
      if (!confirm('Ligar o modo AUTOMÁTICO? O software vai mexer nas saídas selecionadas.')) return;
    }
    send({ type: 'setMode', mode: b.dataset.mode });
  }),
);
$('#bus-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bus]');
  if (!btn || !state) return;
  const id = Number(btn.dataset.bus);
  const current = state.buses.filter((b) => b.selected).map((b) => b.id);
  const turningOn = !current.includes(id);
  if (turningOn && id === MASTER_BUS) {
    if (!confirm('Controlar o MASTER muda o som do SALÃO (os faders dos canais). Tem certeza?')) return;
  }
  send({ type: 'setBuses', buses: turningOn ? [...current, id] : current.filter((b) => b !== id) });
});
document.querySelectorAll('[data-scene]').forEach((b) =>
  b.addEventListener('click', () => send({ type: 'sim.scene', scene: b.dataset.scene })),
);
$('#capture').addEventListener('click', () => {
  if (confirm('Gravar o nível atual de cada canal que está tocando como alvo?')) send({ type: 'capture' });
});
$('#restore').addEventListener('click', () => {
  if (confirm('Voltar todos os envios para a mixagem original (ou do preset carregado)?')) send({ type: 'restore' });
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
$('#show-fx').addEventListener('change', (e) => {
  document.body.classList.toggle('show-fx', e.target.checked);
  setPref('showFx', e.target.checked ? '1' : '0');
});

connect();
