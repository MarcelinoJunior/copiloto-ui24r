// Tela de mixagem do Copiloto Ui24R.
// Cada pessoa vê UMA saída (ex.: AUX 7+8 da live, ou o master): os canais escolhidos no modo de
// visualização, os efeitos e o master daquela saída no canto. Clicar no nome do canal (com
// "Expandir canal" ligado) abre todos os volumes daquele canal.

const STATUS_LABEL = {
  desabilitado: 'manual',
  'sem-envio': 'sem envio',
  'sem-alvo': 'sem ideal',
  manual: 'operador',
  transicao: 'preset',
  silencio: 'silêncio',
  aguardando: 'aguarda',
  ok: 'ok',
  corrigindo: 'corrige',
  'no-limite': 'limite',
};

const FX_STATUS_LABEL = {
  desligado: 'fixo',
  'sem-envio': 'sem envio',
  'sem-entrada': 'parado',
  transicao: 'preset',
  ok: 'ok',
  acompanhando: 'acomp.',
};

const STATUS_HELP = {
  desabilitado: 'Automático desligado neste canal (AUTO)',
  'sem-envio': 'O envio deste canal para a saída está fechado ou mutado',
  'sem-alvo': 'Ainda sem volume ideal: use "Gravar volumes atuais" com o canal tocando',
  manual: 'Você mexeu há pouco: o automático espera antes de agir',
  transicao: 'Carregando preset (fade)',
  silencio: 'Canal em silêncio: o automático não sobe (evita ruído)',
  aguardando: 'Começou a tocar agora: aguardando estabilizar',
  ok: 'No volume ideal',
  corrigindo: 'Fora do volume ideal: corrigindo devagar',
  'no-limite': 'Precisaria de mais correção do que o limite permite',
};

const MODE_HELP = {
  desligado: 'Ajuste automático DESLIGADO nesta saída: só mostra os níveis. Os faders daqui funcionam como na mesa.',
  observar: 'Ajuste automático em SÓ SUGERIR: embaixo de cada fader aparece quanto ele mexeria, sem mexer na mesa.',
  automatico: 'Ajuste automático LIGADO: os envios estão sendo corrigidos devagar para cada canal ficar no volume ideal.',
};

const MASTER_BUS = 0;
const METER_MIN = -60;
const STRIP_GAP = 2;
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
const SCALE_MARKS = [10, 5, 0, -5, -10, -20, -30, -50];
const SEND_THROTTLE_MS = 80;

const $ = (sel, root = document) => root.querySelector(sel);
let socket;
let state;
let me;
let views = [];
let currentView;
let view; // tela da saída atual: { bus, node, ..., strips: Map, rows: Map }
let toastTimer;

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

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error('O Copiloto não está ligado. Dê dois cliques em “Abrir Copiloto” na área de trabalho e tente de novo.');
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Faça login.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Erro.');
  return data;
}

function savePrefs(patch) {
  me.prefs = { ...me.prefs, ...patch };
  api('PUT', '/api/prefs', patch).catch(() => undefined);
}

// ---------- conexão com o programa ----------

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let first = true;
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'erro') return toast(msg.text);
    checkBuild(msg);
    state = msg;
    if (first) {
      first = false;
      // volta para a última saída que esta pessoa usou (se ainda tiver acesso)
      const last = Number(me.prefs.bus);
      if (Number.isInteger(last) && last !== state.bus?.bus && state.buses.some((b) => b.id === last)) send({ type: 'view', bus: last });
    }
    render();
  };
  socket.onclose = (ev) => {
    if (ev.code === 4401) {
      location.href = '/login.html';
      return;
    }
    setPill('erro', 'painel sem conexão com o programa');
    setTimeout(connect, 1500);
  };
}

function send(cmd) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

function setPill(cls, text) {
  const el = $('#conn');
  el.className = `pill ${cls}`;
  el.textContent = text;
}

// ---------- render geral ----------

function render() {
  const s = state;
  const isSim = s.source?.kind === 'simulador';
  document.body.classList.toggle('is-sim', isSim);

  if (isSim) {
    setPill('simulador', 'SIMULADOR (mesa falsa)');
  } else {
    const h = s.health;
    const ping = h?.ping.lastMs === undefined ? '' : h.ping.lastMs === null ? ' · sem resposta' : ` · ${Math.round(h.ping.lastMs)} ms`;
    const cls = s.connection !== 'conectado' ? s.connection : h?.quality === 'boa' ? 'conectado' : 'conectando';
    const txt = s.connection === 'conectado' ? `mesa ${s.source.ip}${ping}${h && h.quality !== 'boa' ? ' · instável' : ''}` : `mesa ${s.source.ip}: ${s.connection}`;
    setPill(cls, txt);
  }

  const mode = s.bus?.mode ?? 'desligado';
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#mode-help').textContent = s.bus ? MODE_HELP[mode] : '';

  $('#sim').hidden = !isSim;
  if (s.sim) document.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('active', b.dataset.scene === s.sim.scene));

  renderBusSelect(s);
  renderPresets(s);

  if (view && (!s.bus || view.bus !== s.bus.bus)) {
    view.node.remove();
    view = undefined;
  }
  if (s.bus) renderBus(s.bus, s);
  $('#no-bus').hidden = Boolean(s.bus) || !s.mixer;
  renderDetail(s);
  renderTips(s);

  const last = s.events[0];
  $('#last-event').textContent = last ? `${new Date(last.t).toLocaleTimeString('pt-BR')}  ${last.text}` : '—';
  $('#events').innerHTML = s.events
    .map((e) => `<li><time>${new Date(e.t).toLocaleTimeString('pt-BR')}</time>${escapeHtml(e.text)}</li>`)
    .join('');
}

function renderBusSelect(s) {
  const sel = $('#bus-select');
  const current = s.bus?.bus;
  const sig = JSON.stringify([s.buses.map((b) => [b.id, b.label, b.name, b.stereo, b.mode]), current]);
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  const icon = { automatico: ' ●auto', observar: ' ◐obs', desligado: '' };
  sel.innerHTML = s.buses
    .map((b) => {
      const label = b.id === MASTER_BUS ? 'MASTER · salão' : `${b.label} · ${b.name}${b.stereo ? ' (estéreo)' : ''}`;
      return `<option value="${b.id}" ${b.id === current ? 'selected' : ''}>${escapeHtml(label + icon[b.mode])}</option>`;
    })
    .join('');
  sel.classList.toggle('is-master', current === MASTER_BUS);
}

function renderPresets(s) {
  const sel = $('#preset-select');
  const sig = JSON.stringify([s.presets, s.activePresetId, s.bus?.bus]);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    const active = s.presets.some((p) => p.id === s.activePresetId);
    sel.innerHTML =
      `<option value="" ${active ? '' : 'selected'} disabled>${s.presets.length ? '— carregar —' : 'nenhum'}</option>` +
      s.presets
        .map((p) => `<option value="${p.id}" ${p.id === s.activePresetId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
        .join('');
  }
  const hasActive = s.presets.some((p) => p.id === s.activePresetId);
  $('#preset-update').disabled = !hasActive;
  $('#preset-delete').disabled = !hasActive;
}

function busHelp(bus) {
  if (bus.bus === MASTER_BUS) return '<span class="warn">⚠ faders = FADERS dos canais no master: muda o som do SALÃO</span>';
  return `faders = <strong>envios de cada canal para ${escapeHtml(bus.label)}</strong>${bus.stereo ? ' (os dois lados juntos)' : ''} · o salão não muda`;
}

/** Canais que este modo de visualização mostra, na ordem do modo. */
function visibleChannels(bus) {
  const cfg = currentView?.config;
  const byKey = new Map(bus.channels.map((c) => [c.key, c]));
  if (cfg?.channels) return cfg.channels.map((k) => byKey.get(k)).filter(Boolean);
  return bus.channels.filter((c) => c.key.startsWith('i') || cfg?.showLinePlayer);
}

function renderBus(bus, s) {
  if (!view) {
    const node = $('#bus-tpl').content.firstElementChild.cloneNode(true);
    $('#mixer').append(node);
    view = {
      bus: bus.bus,
      node,
      body: $('tbody', node),
      scroll: $('.ch-scroll', node),
      chGroup: $('.ch-group', node),
      fxGroup: $('.fx-group', node),
      masterGroup: $('.master-group', node),
      strips: new Map(),
      rows: new Map(),
      order: '',
    };
    $('.bank-prev', node).addEventListener('click', () => bankStep(-1));
    $('.bank-next', node).addEventListener('click', () => bankStep(1));
    view.scroll.addEventListener('scroll', () => updateBankLabel());
    new ResizeObserver(() => layoutStrips()).observe(view.scroll);
  }
  const isMaster = bus.bus === MASTER_BUS;
  view.node.classList.toggle('is-master', isMaster);
  $('.bus-title', view.node).textContent = isMaster ? 'MASTER — salão' : `${bus.label} — ${bus.name}${bus.stereo ? ' (estéreo)' : ''}`;
  $('.bus-help', view.node).innerHTML = busHelp(bus);

  const visible = visibleChannels(bus);
  const visibleKeys = new Set(visible.map((c) => c.key));
  for (const ch of bus.channels) {
    const strip = getStrip(ch.key, () => createChannelStrip(bus, ch), view.chGroup);
    updateChannelStrip(strip, ch, s);
    strip.el.hidden = !visibleKeys.has(ch.key);
    strip.el.classList.toggle('selected', s.detail?.key === ch.key);

    let row = view.rows.get(ch.key);
    if (!row) {
      row = createRow(bus.bus, ch);
      view.rows.set(ch.key, row);
      view.body.append(row.tr);
    }
    updateRow(row, ch, s);
    row.tr.hidden = !visibleKeys.has(ch.key);
  }
  // ordem dos canais = ordem do modo de visualização
  const order = visible.map((c) => c.key).join(',');
  if (order !== view.order) {
    view.order = order;
    for (const c of visible) view.chGroup.append(view.strips.get(c.key).el);
    view.visibleCount = visible.length;
    layoutStrips();
  }

  const showFx = currentView?.config.showFxReturns !== false;
  view.fxGroup.hidden = !showFx;
  for (const fx of bus.fx) {
    const strip = getStrip(fx.key, () => createFxStrip(bus, fx), view.fxGroup);
    updateFxStrip(strip, fx, s);
  }

  const master = getStrip('master', () => createMasterStrip(bus), view.masterGroup);
  updateMasterStrip(master, bus);
}

function getStrip(id, create, parent) {
  let strip = view.strips.get(id);
  if (!strip) {
    strip = create();
    view.strips.set(id, strip);
    parent.append(strip.el);
  }
  return strip;
}

// ---------- quantos faders na tela (bancos) ----------

function layoutStrips() {
  if (!view) return;
  const n = currentView?.config.faders ?? 0;
  const count = view.visibleCount ?? 0;
  const banked = n > 0 && count > 0;
  view.scroll.classList.toggle('banked', banked);
  if (banked) {
    const w = Math.max(30, (view.scroll.clientWidth - (n - 1) * STRIP_GAP) / n);
    view.scroll.style.setProperty('--strip-w', `${w}px`);
    view.chGroup.style.minWidth = '';
  } else {
    view.scroll.style.removeProperty('--strip-w');
    view.chGroup.style.minWidth = `${count * 48}px`; // em tela estreita, rola em vez de espremer
  }
  $('.bank', view.node).hidden = !(banked && count > n);
  updateBankLabel();
}

function bankStep(dir) {
  const n = currentView?.config.faders ?? 0;
  if (!view || !n) return;
  const w = parseFloat(view.scroll.style.getPropertyValue('--strip-w')) + STRIP_GAP;
  view.scroll.scrollBy({ left: dir * n * w, behavior: 'smooth' });
}

function updateBankLabel() {
  if (!view) return;
  const n = currentView?.config.faders ?? 0;
  const count = view.visibleCount ?? 0;
  if (!n || count <= n) return;
  const w = parseFloat(view.scroll.style.getPropertyValue('--strip-w')) + STRIP_GAP;
  const first = Math.round(view.scroll.scrollLeft / w) + 1;
  $('.bank-label', view.node).textContent = `canais ${first}–${Math.min(count, first + n - 1)} de ${count}`;
}

// ---------- faders ----------

/** Liga um fader: enquanto o usuário arrasta, o painel não sobrescreve a posição. */
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

function scaleHtml() {
  return `<div class="scale">${SCALE_MARKS.map((d) => `<span style="bottom: calc(7px + (100% - 14px) * ${dbToPos(d) / 1000})">${d > 0 ? '+' : ''}${d}</span>`).join('')}</div>`;
}

// ---------- faixas verticais ----------

function stripSkeleton({ cls = '', name = '', key = '', num = '', toggleLabel = 'AUTO', toggleTitle = '', dest = '' }) {
  const el = document.createElement('div');
  el.className = `strip ${cls}`;
  // linhas de altura fixa: assim os faders de canais, efeitos e master ficam alinhados
  el.innerHTML = `
    <button class="strip-name" type="button"></button>
    <div class="strip-sub"><span class="status"></span></div>
    <div class="strip-tag"><span class="tag-text"></span></div>
    <button class="auto-btn" title="${escapeHtml(toggleTitle)}">${toggleLabel}</button>
    <button class="mute-btn" type="button">MUTE</button>
    <div class="strip-body">
      <div class="vmeter"><div class="band"></div><div class="fill"></div><div class="avg"></div><div class="target"></div></div>
      ${scaleHtml()}
      <input type="range" class="fader" min="0" max="1000" step="1">
    </div>
    <div class="send-db"></div>
    <div class="delta"></div>
    <div class="strip-num" title="${escapeHtml(key)}"></div>`;
  $('.strip-name', el).textContent = name;
  $('.strip-name', el).title = `${name} — ${dest}`;
  $('.strip-num', el).textContent = num;
  $('.fader', el).setAttribute('aria-label', `${name}: ${dest}`);
  $('.fader', el).title = dest;
  return {
    el,
    name: $('.strip-name', el),
    status: $('.status', el),
    toggle: $('.auto-btn', el),
    mute: $('.mute-btn', el),
    fill: $('.fill', el),
    avg: $('.avg', el),
    target: $('.target', el),
    band: $('.band', el),
    fader: $('.fader', el),
    readout: $('.send-db', el),
    delta: $('.delta', el),
    tag: $('.tag-text', el),
  };
}

/** Botão MUTE da faixa: liga/desliga o mute do envio desta saída (no master, o mute do canal). */
function bindMute(strip, bus, key) {
  const where = bus.bus === MASTER_BUS ? 'no salão (mute do canal na mesa)' : `em ${bus.label} (só nesta saída)`;
  strip.mute.title = `Muta/desmuta ${where}`;
  strip.mute.addEventListener('click', () => send({ type: 'setMute', bus: bus.bus, key, muted: !strip.mute.classList.contains('on') }));
}

function setMuted(strip, muted) {
  strip.mute.classList.toggle('on', muted);
  strip.el.classList.toggle('muted', muted);
}

/** Número que aparece embaixo do fader: 1, 2… (entradas), L1/P1 (line/player), FX1… */
function stripNumber(key) {
  const n = key.slice(1);
  return key[0] === 'i' ? n : key[0] === 'l' ? `L${n}` : key[0] === 'p' ? `P${n}` : `FX${n}`;
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
  el.textContent = value === undefined || value === null || Math.abs(value) < 0.05 ? '' : fmt(value, true);
  el.className = `delta ${value < -0.05 ? 'down' : value > 0.05 ? 'up' : ''}`;
}

function createChannelStrip(bus, ch) {
  const isMaster = bus.bus === MASTER_BUS;
  const strip = stripSkeleton({
    name: ch.name,
    key: ch.key,
    num: stripNumber(ch.key),
    toggleTitle: 'Liga/desliga o automático deste canal nesta saída',
    dest: isMaster ? 'fader do canal no master (salão)' : `envio do canal para ${bus.label}`,
  });
  strip.toggle.addEventListener('click', () =>
    send({ type: 'setEnabled', bus: bus.bus, key: ch.key, enabled: !strip.toggle.classList.contains('on') }),
  );
  strip.name.addEventListener('click', () => {
    if (!$('#expand').checked) return toast('Ligue "Expandir canal" (barra de cima) para abrir os controles do canal.');
    openDetail(ch.key);
  });
  bindMute(strip, bus, ch.key);
  bindFader(strip, (db) => send({ type: 'setSend', bus: bus.bus, key: ch.key, db }));
  return strip;
}

/** Diminui a fonte do nome até caber em 2 linhas sem quebrar palavras (11px → 7px). */
function fitName(el) {
  let size = 11;
  el.style.fontSize = `${size}px`;
  while (size > 7 && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
    size -= 0.5;
    el.style.fontSize = `${size}px`;
  }
}

/** Atualiza o nome e reajusta a fonte quando o texto ou a largura mudam. */
function setStripName(strip, text) {
  if (strip.name.textContent === text && strip.fitW === strip.name.clientWidth) return;
  strip.name.textContent = text;
  strip.name.title = text;
  strip.fitW = strip.name.clientWidth;
  if (strip.fitW > 0) fitName(strip.name);
}

function updateChannelStrip(strip, ch, s) {
  strip.el.classList.toggle('off', !ch.enabled);
  if (!strip.el.hidden) setStripName(strip, ch.name);
  strip.toggle.classList.toggle('on', ch.enabled);
  setMuted(strip, ch.muted);
  const phantom = s.phantom?.includes(ch.key);
  strip.tag.textContent = phantom ? '48V' : '';
  strip.tag.className = `tag-text ${phantom ? 'p48' : ''}`;
  strip.tag.title = phantom ? 'Phantom 48V ligado' : '';

  let label = STATUS_LABEL[ch.status] ?? ch.status;
  if (ch.status === 'manual') label = `oper. ${ch.manualForSec}s`;
  if (ch.status === 'corrigindo' && s.bus.mode !== 'automatico') label = 'corrigiria';
  strip.status.textContent = label;
  strip.status.title = STATUS_HELP[ch.status] ?? '';
  strip.status.className = `status ${ch.status}`;

  const silent = ch.status === 'silencio' || ch.rawDB === undefined || ch.rawDB <= -79;
  const instant = !silent && ch.sendDB !== undefined ? ch.rawDB + ch.sendDB : METER_MIN;
  setMeter(strip, instant, ch.contributionDB, ch.targetDB, s.deadbandDB);
  setFader(strip, ch.sendDB);

  const applied = ch.sendDB !== undefined && ch.baseSendDB !== undefined ? ch.sendDB - ch.baseSendDB : 0;
  setDelta(strip.delta, s.bus.mode === 'automatico' ? applied : ch.suggestedDeltaDB);
}

function createFxStrip(bus, fx) {
  const isMaster = bus.bus === MASTER_BUS;
  const strip = stripSkeleton({
    cls: 'fx',
    name: fx.name,
    key: fx.key.toUpperCase(),
    num: stripNumber(fx.key),
    toggleLabel: 'ACOMP.',
    toggleTitle: 'Efeito acompanha os canais: quando um canal desce nesta saída, o efeito dele desce junto',
    dest: isMaster ? 'retorno do efeito no master' : `retorno do efeito em ${bus.label}`,
  });
  strip.name.disabled = true;
  strip.badge = strip.tag;
  strip.toggle.addEventListener('click', () =>
    send({ type: 'setFxFollow', bus: bus.bus, key: fx.key, follow: !strip.toggle.classList.contains('on') }),
  );
  bindMute(strip, bus, fx.key);
  bindFader(strip, (db) => send({ type: 'setSend', bus: bus.bus, key: fx.key, db }));
  return strip;
}

function updateFxStrip(strip, fx, s) {
  setStripName(strip, fx.name);
  strip.badge.className = `fx-badge ${fx.inRoom ? 'room' : 'live'}`;
  strip.badge.textContent = fx.inRoom ? 'salão' : 'só live';
  strip.badge.title = fx.inRoom ? 'Este efeito toca no salão e nas saídas' : 'Este efeito não toca no salão (só nas saídas)';
  strip.toggle.classList.toggle('on', fx.follow);
  setMuted(strip, fx.muted);
  let label = FX_STATUS_LABEL[fx.status] ?? fx.status;
  if (fx.status === 'acompanhando' && s.bus.mode !== 'automatico') label = 'acomp.?';
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
    cls: `master ${isMaster ? 'is-master' : ''}`,
    name: isMaster ? 'MASTER' : bus.label,
    key: isMaster ? 'salão' : 'master',
    num: isMaster ? 'MST' : bus.label.replace('AUX ', 'A'),
    toggleLabel: 'GERAL',
    dest: isMaster ? 'volume geral do salão' : `volume geral de ${bus.label}`,
  });
  strip.name.disabled = true;
  strip.toggle.disabled = true;
  strip.toggle.title = 'Volume geral desta saída: não muda o equilíbrio entre os canais';
  strip.mute.style.visibility = 'hidden'; // mantém o fader alinhado com os canais
  bindFader(strip, (db) => send({ type: 'setBusMaster', bus: bus.bus, db }));
  return strip;
}

function updateMasterStrip(strip, bus) {
  setStripName(strip, bus.bus === MASTER_BUS ? 'MASTER' : bus.label);
  strip.status.textContent = bus.outDB === undefined ? '—' : `saída ${fmt(bus.outDB)}`;
  strip.status.className = `status ${bus.outDB > -3 ? 'no-limite' : 'ok'}`;
  setMeter(strip, bus.outDB);
  setFader(strip, bus.masterDB);
}

// ---------- painel do canal ----------

const detailCtrls = new Map(); // id -> { el, fader, readout, ... }

function openDetail(key) {
  send({ type: 'view', detail: key });
  $('#detail').hidden = false;
  $('#detail-backdrop').hidden = false;
  $('#d-close').focus();
}

function closeDetail() {
  send({ type: 'view', detail: null });
  $('#detail').hidden = true;
  $('#detail-backdrop').hidden = true;
}

function detailFader(id, { title, sub, badge, badgeCls, locked, lockText, onValue }) {
  let c = detailCtrls.get(id);
  if (!c) {
    const el = document.createElement('div');
    el.className = 'dfader';
    el.innerHTML = `
      <div class="dfader-title"></div>
      <div class="dfader-sub"></div>
      <span class="fx-badge"></span>
      <div class="dfader-body">${scaleHtml()}<input type="range" class="fader" min="0" max="1000" step="1"></div>
      <div class="send-db"></div>
      <div class="dfader-lock small"></div>`;
    c = { el, fader: $('.fader', el), readout: $('.send-db', el) };
    bindFader(c, (db) => c.onValue?.(db));
    detailCtrls.set(id, c);
  }
  c.onValue = onValue;
  $('.dfader-title', c.el).textContent = title;
  $('.dfader-sub', c.el).textContent = sub ?? '';
  const b = $('.fx-badge', c.el);
  b.hidden = !badge;
  b.textContent = badge ?? '';
  b.className = `fx-badge ${badgeCls ?? ''}`;
  c.fader.disabled = Boolean(locked);
  c.el.classList.toggle('locked', Boolean(locked));
  $('.dfader-lock', c.el).textContent = locked ? lockText ?? 'sem acesso' : '';
  c.fader.setAttribute('aria-label', `${title} ${sub ?? ''}`);
  return c;
}

function renderDetail(s) {
  const d = s.detail;
  // a janela só fecha pelo usuário (✕, Esc, clique fora, troca de saída); sem dados ainda = aguardando o servidor
  if (!d || $('#detail').hidden) return;
  const ch = s.bus?.channels.find((c) => c.key === d.key);
  $('#d-num').textContent = stripNumber(d.key);
  $('#d-name').textContent = d.name;
  $('#d-sub').textContent = `${d.key} · ${STATUS_LABEL[d.status] ?? d.status}${s.bus ? ` · em ${s.bus.label}` : ''}`;
  $('#d-auto').checked = d.enabled;
  const dbTxt = (v) => (v === undefined || v === null ? '—' : `${fmt(v)} dB`);
  $('#d-now').textContent = dbTxt(d.levelDB);
  $('#d-avg').textContent = dbTxt(ch?.levelDB);
  $('#d-target').textContent = dbTxt(d.targetDB);
  $('#d-send').textContent = ch?.sendDB === undefined ? '-∞' : dbTxt(ch.sendDB);
  const corr = ch && ch.sendDB !== undefined && ch.baseSendDB !== undefined ? ch.sendDB - ch.baseSendDB : undefined;
  $('#d-corr').textContent = s.bus?.mode === 'automatico' ? dbTxt(corr) : ch?.suggestedDeltaDB ? `${fmt(ch.suggestedDeltaDB, true)} (sugerida)` : '—';
  $('#d-status-help').textContent = STATUS_HELP[d.status] ?? '';
  renderPreamp(d);
  renderRta(d, s);
  renderEq(d, s);
  $('#d-ident').textContent = d.identified
    ? `som: ${d.identified.label} (${d.identified.by === 'audio' ? `pelo áudio, ${Math.round(d.identified.confidence * 100)}%` : 'pelo nome'})`
    : 'som: ainda não identificado';
  const dMute = $('#d-mute');
  dMute.classList.toggle('on', Boolean(d.muted));
  dMute.textContent = d.muted ? 'MUTADO' : 'MUTE';
  dMute.title = `Mute deste canal em ${s.bus?.bus === MASTER_BUS ? 'salão (master)' : s.bus?.label ?? 'esta saída'}`;
  $('.sim-ctl-d').hidden = s.source.kind !== 'simulador';

  // alertas só deste canal
  const tips = (s.tips ?? []).filter((t) => t.channel === d.key);
  const tipSig = JSON.stringify(tips.map((t) => [t.id, t.detail]));
  const tipBox = $('#d-tips');
  if (tipBox.dataset.sig !== tipSig) {
    tipBox.dataset.sig = tipSig;
    tipBox.innerHTML = tips.length
      ? tips.map((t) => `<li class="${t.severity}"><strong>${escapeHtml(t.title)}</strong><p>${escapeHtml(t.detail)}</p></li>`).join('')
      : '<li class="empty"><strong>Nada de errado com este canal.</strong></li>';
  }

  const used = [];
  const add = (id, opts, db) => {
    const c = detailFader(id, opts);
    c.el.dataset.kind = opts.kind;
    setFader(c, db);
    used.push(c.el);
  };
  add(
    'master',
    {
      kind: 'master',
      title: 'MASTER',
      sub: 'som do salão',
      badge: 'salão',
      badgeCls: 'room',
      locked: !d.master.allowed,
      lockText: 'sem acesso ao master',
      onValue: (db) => send({ type: 'setSend', bus: MASTER_BUS, key: d.key, db }),
    },
    d.master.db,
  );
  if (d.busSend) {
    add(
      'bus',
      {
        kind: 'bus',
        title: d.busSend.label,
        sub: 'esta saída',
        badge: 'você está aqui',
        badgeCls: 'live',
        onValue: (db) => send({ type: 'setSend', bus: d.busSend.bus, key: d.key, db }),
      },
      d.busSend.db,
    );
  }
  for (const fx of d.fx) {
    add(
      fx.key,
      {
        kind: 'fx',
        title: fx.key.toUpperCase(),
        sub: fx.name,
        badge: fx.inRoom ? 'salão+live' : 'só live',
        badgeCls: fx.inRoom ? 'room' : 'live',
        locked: !fx.allowed,
        lockText: 'toca no salão: só admin/master',
        onValue: (db) => send({ type: 'setFxSend', fx: fx.key, key: d.key, db }),
      },
      fx.db,
    );
  }
  // outros auxiliares liberados: também como faders verticais (aproveita a janela grande)
  for (const o of d.otherAuxes) {
    add(
      `aux:${o.bus}`,
      {
        kind: 'aux',
        title: o.label,
        sub: o.name,
        badge: 'outro aux',
        badgeCls: '',
        onValue: (db) => send({ type: 'setSend', bus: o.bus, key: d.key, db }),
      },
      o.db,
    );
  }
  const box = $('#d-faders');
  if (box.children.length !== used.length || used.some((el, i) => box.children[i] !== el)) box.replaceChildren(...used);
}

$('#d-mute').addEventListener('click', () => {
  const d = state?.detail;
  if (d && state.bus) send({ type: 'setMute', bus: state.bus.bus, key: d.key, muted: !d.muted });
});
$('#d-close').addEventListener('click', closeDetail);
$('#detail-backdrop').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#detail').hidden) closeDetail();
});
$('#d-auto').addEventListener('change', (e) => {
  const d = state?.detail;
  if (d && state.bus) send({ type: 'setEnabled', bus: state.bus.bus, key: d.key, enabled: e.target.checked });
});
$('#d-tminus').addEventListener('click', () => state?.detail && send({ type: 'nudgeTarget', bus: state.bus.bus, key: state.detail.key, delta: -1 }));
$('#d-tplus').addEventListener('click', () => state?.detail && send({ type: 'nudgeTarget', bus: state.bus.bus, key: state.detail.key, delta: 1 }));
$('#d-srcminus').addEventListener('click', () => state?.detail && send({ type: 'sim.source', key: state.detail.key, delta: -6 }));
$('#d-srcplus').addEventListener('click', () => state?.detail && send({ type: 'sim.source', key: state.detail.key, delta: 6 }));

// ---------- dicas ----------

let tipsSig = '';

function renderTips(s) {
  const tips = s.tips ?? [];
  const worst = tips[0]?.severity;
  const btn = $('#tips-btn');
  btn.className = `tips-btn ${worst ?? ''}`;
  $('#tips-count').textContent = String(tips.length);
  btn.title = tips.length ? tips.map((t) => `• ${t.title}`).join('\n') : 'Nenhuma dica agora: tudo parece bem.';
  if ($('#tips').hidden) return;
  const sig = JSON.stringify(tips.map((t) => [t.id, t.title, t.detail]));
  if (sig === tipsSig) return;
  tipsSig = sig;
  $('#tips-sub').textContent = s.advanced?.active
    ? 'Com o áudio USB: equilíbrio de volumes, EQ pelo som de cada canal, microfonia, zumbido, chiado, loudness e OBS.'
    : 'Pelo VU da rede: clip, volume e equilíbrio entre os canais. No modo Áudio USB aparecem também EQ, microfonia, zumbido e loudness.';
  $('#tips-list').innerHTML = tips.length
    ? tips
        .map(
          (t) => `<li class="${t.severity}"><strong>${escapeHtml(t.title)}</strong><p>${escapeHtml(t.detail)}</p>${
            t.channel && t.action === 'canal' ? `<button class="small-btn" data-open="${t.channel}">Abrir o canal</button>` : ''
          }</li>`,
        )
        .join('')
    : '<li class="empty"><strong>Tudo certo por aqui.</strong><p>Nenhum clip, volume baixo ou ruído detectado agora.</p></li>';
}

$('#tips-btn').addEventListener('click', () => {
  const panel = $('#tips');
  panel.hidden = !panel.hidden;
  tipsSig = '';
  if (!panel.hidden && state) renderTips(state);
});
$('#tips-close').addEventListener('click', () => ($('#tips').hidden = true));
$('#tips-list').addEventListener('click', (e) => {
  const key = e.target.dataset?.open;
  if (!key) return;
  $('#tips').hidden = true;
  $('#expand').checked = true;
  openDetail(key);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#tips').hidden) $('#tips').hidden = true;
});

// ---------- pré-amplificador e espectro no painel do canal ----------

let gainDragging = false;

function renderPreamp(d) {
  const box = $('#d-preamp');
  box.hidden = !d.preamp;
  if (!d.preamp) return;
  const p = d.preamp;
  const gain = $('#d-gain');
  if (!gainDragging) gain.value = String(p.gainDB);
  $('#d-gain-val').textContent = `${Number(gainDragging ? gain.value : p.gainDB).toFixed(1)} dB`;
  for (const el of [gain, $('#d-gminus'), $('#d-gplus')]) el.disabled = !p.gainAllowed;
  $('#d-phantom').checked = p.phantom;
  $('#d-phantom').disabled = !p.phantomAllowed;
  $('#d-preamp-note').textContent = !p.gainAllowed
    ? 'ganho: só admin ou quem tem o master (muda salão e todas as saídas)'
    : 'o ganho muda o salão, todas as saídas e a gravação';
}

function sendGain(db) {
  const d = state?.detail;
  if (!d?.preamp) return;
  const v = Math.max(-6, Math.min(57, db));
  const before = d.preamp.gainDB;
  if (Math.abs(v - before) >= 6 && !confirm(`Mudar o ganho de ${d.name} de ${before.toFixed(1)} para ${v.toFixed(1)} dB? Isso muda o salão e todas as saídas.`)) {
    $('#d-gain').value = String(before);
    return;
  }
  send({ type: 'setGain', key: d.key, db: v });
}

$('#d-gain').addEventListener('input', () => {
  gainDragging = true;
  $('#d-gain-val').textContent = `${Number($('#d-gain').value).toFixed(1)} dB`;
});
$('#d-gain').addEventListener('change', () => {
  gainDragging = false;
  sendGain(Number($('#d-gain').value));
});
$('#d-gminus').addEventListener('click', () => state?.detail?.preamp && sendGain(state.detail.preamp.gainDB - 1));
$('#d-gplus').addEventListener('click', () => state?.detail?.preamp && sendGain(state.detail.preamp.gainDB + 1));
$('#d-phantom').addEventListener('change', (e) => {
  const d = state?.detail;
  if (!d) return;
  const on = e.target.checked;
  const msg = on
    ? `LIGAR o phantom 48V em ${d.name}? Abaixe o volume antes: ligar com o som aberto dá um estalo forte. Só use em microfones condensadores/DI ativos.`
    : `DESLIGAR o phantom 48V em ${d.name}? Abaixe o volume antes para evitar estalo; microfone condensador vai parar de funcionar.`;
  if (!confirm(msg)) {
    e.target.checked = !on;
    return;
  }
  send({ type: 'setPhantom', key: d.key, on });
});

const RTA_MIN = -90;
const RTA_MAX = -10;

function renderRta(d, s) {
  const wrap = $('#d-rta-wrap');
  const bands = d.rta;
  wrap.hidden = !(s.advanced?.active && s.advanced.settings.rta);
  if (wrap.hidden) return;
  const canvas = $('#d-rta');
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.clientWidth || 560);
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!bands) {
    ctx.fillStyle = '#8b96a5';
    ctx.font = '12px system-ui';
    ctx.fillText('aguardando áudio deste canal…', 10, h / 2);
    return;
  }
  const bw = w / bands.length;
  bands.forEach((db, i) => {
    const v = Math.max(0, Math.min(1, (db - RTA_MIN) / (RTA_MAX - RTA_MIN)));
    const bh = v * (h - 4);
    ctx.fillStyle = db > -20 ? '#f5b642' : '#3ecf8e';
    ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
  });
}

// ---------- equalizador ----------

const RTA_CENTERS = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const EQ_F_MIN = 20;
const EQ_F_MAX = 20000;
const EQ_DB = 15; // escala do gráfico ±15 dB
const logPos = (v, min, max) => Math.log(v / min) / Math.log(max / min);
const logVal = (p, min, max) => min * Math.pow(max / min, p);
const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} k` : `${Math.round(hz)}`);

/** Controles de cada parâmetro: slider 0..1000 ↔ valor físico. */
const EQ_PARAMS = {
  freq: { min: 20, max: 20000, log: true, fmt: (v) => `${fmtHz(v)}Hz` },
  gain: { min: -15, max: 15, log: false, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
  q: { min: 0.3, max: 10, log: true, fmt: (v) => `Q ${v.toFixed(1)}` },
  hpf: { min: 20, max: 400, log: true, fmt: (v) => (v <= 21 ? 'desligado' : `${Math.round(v)} Hz`) },
};
const toPos = (kind, v) => {
  const p = EQ_PARAMS[kind];
  const x = Math.max(p.min, Math.min(p.max, v));
  return Math.round((p.log ? logPos(x, p.min, p.max) : (x - p.min) / (p.max - p.min)) * 1000);
};
const fromPos = (kind, pos) => {
  const p = EQ_PARAMS[kind];
  const t = pos / 1000;
  return p.log ? logVal(t, p.min, p.max) : Math.round((p.min + t * (p.max - p.min)) * 2) / 2;
};

let eqBuilt = false;
const eqDragging = new Set();
const eqThrottle = new Map();

function sendEq(param, value, final) {
  const d = state?.detail;
  if (!d) return;
  const now = Date.now();
  if (!final && now - (eqThrottle.get(param) ?? 0) < 150) return;
  eqThrottle.set(param, now);
  send({ type: 'setEq', key: d.key, param, value });
}

function eqSlider(param, kind, label) {
  return `<label class="eq-ctl"><span>${label}</span><input type="range" min="0" max="1000" step="1" data-param="${param}" data-kind="${kind}"><output data-out="${param}"></output></label>`;
}

function buildEq() {
  if (eqBuilt) return;
  eqBuilt = true;
  const names = { b1: 'Banda 1 (graves)', b2: 'Banda 2', b3: 'Banda 3', b4: 'Banda 4 (agudos)' };
  $('#d-eq-bands').innerHTML =
    `<div class="eq-band hpf"><strong>Passa-altas</strong>${eqSlider('hpf.freq', 'hpf', 'corte')}</div>` +
    ['b1', 'b2', 'b3', 'b4']
      .map((b) => `<div class="eq-band"><strong>${names[b]}</strong>${eqSlider(`${b}.freq`, 'freq', 'freq')}${eqSlider(`${b}.gain`, 'gain', 'ganho')}${eqSlider(`${b}.q`, 'q', 'largura')}</div>`)
      .join('');
  for (const input of document.querySelectorAll('#d-eq-bands input')) {
    const { param, kind } = input.dataset;
    const show = () => {
      const v = fromPos(kind, Number(input.value));
      $(`output[data-out="${param}"]`).textContent = `≈ ${EQ_PARAMS[kind].fmt(v)}`;
      return v;
    };
    input.addEventListener('input', () => {
      eqDragging.add(param);
      sendEq(param, show(), false);
    });
    input.addEventListener('change', () => {
      eqDragging.delete(param);
      sendEq(param, show(), true);
    });
  }
}

function eqResponseDb(eq, hz) {
  if (eq.bypass) return 0;
  let db = 0;
  for (const b of eq.bands) {
    const bw = 1 / Math.max(0.05, b.q);
    const oct = Math.log2(hz / b.freqHz);
    db += b.gainDB * Math.exp(-0.5 * Math.pow(oct / (bw / 2), 2));
  }
  if (eq.hpfHz > 21) {
    const r = Math.pow(hz / eq.hpfHz, 4);
    db += 10 * Math.log10(r / (1 + r));
  }
  return db;
}

function drawEq(eq, rta) {
  const canvas = $('#d-eq-canvas');
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.clientWidth || 600);
  const h = (canvas.height = canvas.clientHeight || 150);
  ctx.clearRect(0, 0, w, h);
  const xOf = (hz) => logPos(hz, EQ_F_MIN, EQ_F_MAX) * w;
  const yOf = (db) => h / 2 - (Math.max(-EQ_DB, Math.min(EQ_DB, db)) / EQ_DB) * (h / 2 - 6);
  // grade
  ctx.strokeStyle = '#232a33';
  ctx.lineWidth = 1;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    ctx.beginPath();
    ctx.moveTo(xOf(hz), 0);
    ctx.lineTo(xOf(hz), h);
    ctx.stroke();
  }
  for (const db of [-12, -6, 0, 6, 12]) {
    ctx.strokeStyle = db === 0 ? '#3a4452' : '#232a33';
    ctx.beginPath();
    ctx.moveTo(0, yOf(db));
    ctx.lineTo(w, yOf(db));
    ctx.stroke();
  }
  // espectro do canal (modo Áudio USB) por baixo da curva
  if (rta) {
    const max = Math.max(...rta);
    rta.forEach((db, i) => {
      const lo = i ? Math.sqrt(RTA_CENTERS[i - 1] * RTA_CENTERS[i]) : RTA_CENTERS[0] / 1.12;
      const hi = i < RTA_CENTERS.length - 1 ? Math.sqrt(RTA_CENTERS[i] * RTA_CENTERS[i + 1]) : 20000;
      const v = Math.max(0, Math.min(1, (db - (max - 50)) / 50));
      ctx.fillStyle = 'rgba(62, 207, 142, 0.22)';
      ctx.fillRect(xOf(lo) + 1, h - v * h, Math.max(1, xOf(hi) - xOf(lo) - 2), v * h);
    });
  }
  // curva
  ctx.strokeStyle = eq.bypass ? '#6b7584' : '#4aa8ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const hz = logVal(x / w, EQ_F_MIN, EQ_F_MAX);
    const y = yOf(eqResponseDb(eq, hz));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // pontos das bandas
  eq.bands.forEach((b, i) => {
    ctx.fillStyle = ['#f5b642', '#3ecf8e', '#c77dff', '#ff6b6b'][i];
    ctx.beginPath();
    ctx.arc(xOf(b.freqHz), yOf(b.gainDB), 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#8b96a5';
  ctx.font = '10px system-ui';
  ctx.fillText('+12', 4, yOf(12) - 2);
  ctx.fillText('0 dB', 4, yOf(0) - 2);
  ctx.fillText('−12', 4, yOf(-12) - 2);
}

let eqAdviceSig = '';

function renderEq(d, s) {
  const wrap = $('#d-eq');
  wrap.hidden = !d.eq;
  if (!d.eq) return;
  buildEq();
  const eq = d.eq;
  const values = { 'hpf.freq': ['hpf', eq.hpfHz] };
  for (const b of eq.bands) {
    values[`${b.band}.freq`] = ['freq', b.freqHz];
    values[`${b.band}.gain`] = ['gain', b.gainDB];
    values[`${b.band}.q`] = ['q', b.q];
  }
  for (const input of document.querySelectorAll('#d-eq-bands input')) {
    const p = input.dataset.param;
    input.disabled = !eq.allowed;
    if (eqDragging.has(p) || !values[p]) continue;
    const [kind, v] = values[p];
    input.value = String(toPos(kind, v));
    $(`output[data-out="${p}"]`).textContent = `≈ ${EQ_PARAMS[kind].fmt(v)}`;
  }
  const on = $('#d-eq-on');
  on.checked = !eq.bypass;
  on.disabled = !eq.allowed;
  $('#d-eq-note').textContent = eq.allowed
    ? '— vale para o canal inteiro (salão, auxes e live). Valores ≈ convertidos da escala da mesa.'
    : '— só o admin ou quem tem o master pode mexer (muda o salão também).';
  drawEq(eq, d.rta);

  const advice = d.eqAdvice ?? [];
  const sig = JSON.stringify([advice.map((a) => a.id + a.text), eq.allowed, s.advanced?.active]);
  if (sig !== eqAdviceSig) {
    eqAdviceSig = sig;
    const box = $('#d-eq-advice');
    if (!s.advanced?.active) {
      box.innerHTML = '<li class="muted">As sugestões automáticas de EQ precisam ouvir o canal: ligue o modo Áudio USB (tela Conexão).</li>';
    } else if (!advice.length) {
      box.innerHTML = '<li class="muted">Nenhuma sugestão: o som deste canal parece equilibrado (ou ainda está ouvindo — leva alguns segundos tocando).</li>';
    } else {
      box.innerHTML = advice
        .map(
          (a) =>
            `<li><span>${escapeHtml(a.text)}</span><button class="small-btn primary" data-advice="${escapeHtml(a.id)}" ${eq.allowed ? '' : 'disabled title="Só admin ou quem tem o master"'}>Aplicar</button></li>`,
        )
        .join('');
    }
  }
}

$('#d-eq-on').addEventListener('change', (e) => {
  const d = state?.detail;
  if (d) send({ type: 'setEq', key: d.key, param: 'bypass', value: e.target.checked ? 0 : 1 });
});
$('#d-eq-advice').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-advice]');
  const d = state?.detail;
  if (!btn || !d) return;
  if (confirm(`Aplicar esta sugestão no EQ de ${d.name}? Vale para o salão e todas as saídas.`)) {
    send({ type: 'eq.apply', key: d.key, adviceId: btn.dataset.advice });
  }
});

$('#d-fb').addEventListener('click', () => state?.detail && send({ type: 'sim.inject', key: state.detail.key, kind: 'microfonia' }));
$('#d-hum').addEventListener('click', () => state?.detail && send({ type: 'sim.inject', key: state.detail.key, kind: 'zumbido' }));
$('#d-clear').addEventListener('click', () => state?.detail && send({ type: 'sim.clearInject', key: state.detail.key }));

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
      <button class="small" data-act="clear" title="Esquecer o volume ideal deste canal">×</button>
    </td>`;
  $('.key', tr).textContent = ch.key;
  $('.en', tr).addEventListener('change', (e) => send({ type: 'setEnabled', bus, key: ch.key, enabled: e.target.checked }));
  tr.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 't-') send({ type: 'nudgeTarget', bus, key: ch.key, delta: -1 });
    if (act === 't+') send({ type: 'nudgeTarget', bus, key: ch.key, delta: 1 });
    if (act === 'clear') send({ type: 'clearTarget', bus, key: ch.key });
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
  if (ch.status === 'corrigindo' && s.bus.mode !== 'automatico') label = 'corrigiria';
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
  const shown = s.bus.mode === 'automatico' ? applied : ch.suggestedDeltaDB;
  row.delta.textContent = Math.abs(shown) < 0.05 ? '—' : `${fmt(shown, true)} dB`;
  row.delta.className = `num delta ${shown < -0.05 ? 'down' : shown > 0.05 ? 'up' : ''}`;
  row.targetDb.textContent = hasTarget ? fmt(ch.targetDB) : '—';
}

// ---------- modos de visualização (salvos no servidor) ----------

function tableMode() {
  try {
    return localStorage.getItem('copiloto.table') === '1';
  } catch {
    return false;
  }
}

function applyView(v) {
  currentView = v;
  document.body.dataset.view = tableMode() ? 'tabela' : 'mesa';
  if (view) view.order = ''; // força reordenar/re-layout
  if (state) render();
  layoutStrips();
}

function renderViewSelect() {
  $('#view-select').innerHTML = views
    .map((v) => `<option value="${v.id}" ${v.id === currentView?.id ? 'selected' : ''}>${escapeHtml(v.name)}${v.builtin ? '' : ' ★'}</option>`)
    .join('');
}

async function loadViews(selectId) {
  const data = await api('GET', '/api/views');
  views = data.views;
  const id = selectId ?? currentView?.id ?? data.currentId;
  applyView(views.find((v) => v.id === id) ?? views[0]);
  renderViewSelect();
}

$('#view-select').addEventListener('change', (e) => {
  const v = views.find((x) => x.id === e.target.value);
  if (!v) return;
  applyView(v);
  savePrefs({ viewId: v.id });
});

let editing; // modo sendo editado

function openViewEditor() {
  editing = currentView;
  const cfg = editing.config;
  $('#vf-name').value = editing.builtin ? `${editing.name} (cópia)` : editing.name;
  $('#vf-faders').value = String(cfg.faders);
  $('#vf-all').checked = !cfg.channels;
  $('#vf-fx').checked = cfg.showFxReturns;
  $('#vf-lp').checked = cfg.showLinePlayer;
  $('#vf-table').checked = tableMode();
  const chans = state?.bus?.channels ?? [];
  const selected = new Set(cfg.channels ?? chans.filter((c) => c.key.startsWith('i')).map((c) => c.key));
  $('#vf-channels').innerHTML = chans
    .map((c) => `<label><input type="checkbox" value="${c.key}" ${selected.has(c.key) ? 'checked' : ''}> <span class="muted">${c.key}</span> ${escapeHtml(c.name)}</label>`)
    .join('');
  $('#vf-channels').classList.toggle('disabled', $('#vf-all').checked);
  $('#vf-save').textContent = editing.builtin ? 'Salvar como meu modo' : 'Salvar';
  $('#vf-saveas').hidden = editing.builtin;
  $('#vf-delete').hidden = editing.builtin;
  $('#vf-error').hidden = true;
  $('#view-dialog').showModal();
}

function formConfig() {
  const channels = $('#vf-all').checked ? null : [...$('#vf-channels').querySelectorAll('input:checked')].map((i) => i.value);
  return {
    faders: Number($('#vf-faders').value),
    channels,
    showFxReturns: $('#vf-fx').checked,
    showLinePlayer: $('#vf-lp').checked,
  };
}

async function saveView(asNew) {
  try {
    try {
      localStorage.setItem('copiloto.table', $('#vf-table').checked ? '1' : '0');
    } catch {
      // sem localStorage
    }
    const body = { name: $('#vf-name').value.trim(), config: formConfig() };
    const res = editing.builtin || asNew ? await api('POST', '/api/views', body) : await api('PUT', `/api/views/${editing.id}`, body);
    $('#view-dialog').close();
    await loadViews(res.view.id);
    savePrefs({ viewId: res.view.id });
  } catch (err) {
    $('#vf-error').textContent = err.message;
    $('#vf-error').hidden = false;
  }
}

$('#view-edit').addEventListener('click', openViewEditor);
$('#vf-all').addEventListener('change', (e) => $('#vf-channels').classList.toggle('disabled', e.target.checked));
$('#vf-cancel').addEventListener('click', () => $('#view-dialog').close());
$('#vf-save').addEventListener('click', () => saveView(false));
$('#vf-saveas').addEventListener('click', () => saveView(true));
$('#vf-delete').addEventListener('click', async () => {
  if (!confirm(`Apagar o modo "${editing.name}"?`)) return;
  try {
    await api('DELETE', `/api/views/${editing.id}`);
    $('#view-dialog').close();
    await loadViews('padrao');
    savePrefs({ viewId: 'padrao' });
  } catch (err) {
    $('#vf-error').textContent = err.message;
    $('#vf-error').hidden = false;
  }
});

// ---------- barra superior ----------

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    const bus = state?.bus;
    if (!bus) return;
    if (b.dataset.mode === 'automatico' && bus.mode !== 'automatico' && state.source.kind === 'mesa') {
      if (!confirm(`Ligar o AJUSTE AUTOMÁTICO DE VOLUME em ${bus.label}? O software vai mexer nos envios dessa saída na mesa real.`)) return;
    }
    send({ type: 'setMode', bus: bus.bus, mode: b.dataset.mode });
  }),
);

$('#bus-select').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  if (id === MASTER_BUS && !confirm('Mostrar e controlar o MASTER mexe no som do SALÃO (faders dos canais). Continuar?')) {
    e.target.dataset.sig = ''; // volta a seleção anterior no próximo render
    return;
  }
  $('#detail').hidden = true;
  $('#detail-backdrop').hidden = true;
  send({ type: 'view', bus: id, detail: null });
  savePrefs({ bus: id });
});

document.querySelectorAll('[data-scene]').forEach((b) =>
  b.addEventListener('click', () => send({ type: 'sim.scene', scene: b.dataset.scene })),
);
$('#suggest-targets').addEventListener('click', () => {
  if (!state?.bus) return;
  if (
    confirm(
      `Calcular o volume ideal de cada canal de ${state.bus.label} pelo tipo de som?\n\nA voz principal vira a referência; backs ~5 dB abaixo, bumbo/baixo ~6, violão/teclado ~8, pratos ~12. Use com a banda e a voz tocando. Não mexe nos faders agora: só muda o volume ideal (o ajuste automático vai em direção a ele).`,
    )
  ) {
    send({ type: 'suggestTargets', bus: state.bus.bus });
  }
});
$('#capture').addEventListener('click', () => {
  if (state?.bus && confirm(`Gravar o volume atual de cada canal que está tocando como o VOLUME IDEAL de ${state.bus.label}?`)) {
    send({ type: 'capture', bus: state.bus.bus });
  }
});
$('#restore').addEventListener('click', () => {
  if (state?.bus && confirm(`Desfazer os ajustes: voltar os envios de ${state.bus.label} para antes das correções (ou para o preset carregado)?`)) {
    send({ type: 'restore', bus: state.bus.bus });
  }
});
$('#preset-select').addEventListener('change', (e) => {
  if (e.target.value && state?.bus) send({ type: 'preset.load', bus: state.bus.bus, id: e.target.value });
});
$('#preset-new').addEventListener('click', () => {
  if (!state?.bus) return;
  const name = prompt(`Nome do preset para ${state.bus.label} (ex.: "Música - mais batera"):`);
  if (name?.trim()) send({ type: 'preset.save', bus: state.bus.bus, name: name.trim() });
});
$('#preset-update').addEventListener('click', () => {
  const p = state?.presets.find((x) => x.id === state.activePresetId);
  if (p && confirm(`Sobrescrever o preset "${p.name}" com a mixagem atual?`)) send({ type: 'preset.save', bus: state.bus.bus, name: p.name, id: p.id });
});
$('#preset-delete').addEventListener('click', () => {
  const p = state?.presets.find((x) => x.id === state.activePresetId);
  if (p && confirm(`Apagar o preset "${p.name}"?`)) send({ type: 'preset.delete', id: p.id });
});
$('#sim-reset').addEventListener('click', () => send({ type: 'sim.reset' }));

$('#expand').addEventListener('change', (e) => {
  savePrefs({ expand: e.target.checked });
  if (!e.target.checked) closeDetail();
});
$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => undefined);
  location.href = '/login.html';
});

/** Preferência só deste navegador (não quebra se o armazenamento estiver bloqueado). */
function localPref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`copiloto.${key}`);
    localStorage.setItem(`copiloto.${key}`, value);
  } catch {
    return null;
  }
  return value;
}

$('#help-btn').addEventListener('click', () => {
  const panel = $('#toolbar-help');
  panel.hidden = !panel.hidden;
  $('#help-btn').setAttribute('aria-expanded', String(!panel.hidden));
  localPref('help', panel.hidden ? '0' : '1');
  layoutStrips();
});
if (localPref('help') === '1') {
  $('#toolbar-help').hidden = false;
  $('#help-btn').setAttribute('aria-expanded', 'true');
}

// fecha menus ao clicar fora
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((m) => {
    if (!m.contains(e.target)) m.open = false;
  });
});

// ---------- início ----------

(async () => {
  const data = await api('GET', '/api/me');
  me = data.user;
  if (!me) {
    location.href = '/login.html';
    return;
  }
  $('#user-name').textContent = `${me.username}${me.role === 'admin' ? ' (admin)' : ''}`;
  $('#default-pass').hidden = !data.defaultPassword;
  $('#nav-admin').textContent = me.role === 'admin' ? 'Pessoas' : 'Conta';
  $('#expand').checked = me.prefs.expand !== false;
  await loadViews(me.prefs.viewId);
  connect();
})().catch((err) => toast(err.message));

/** Recarrega a página quando o programa foi reiniciado com uma versão nova. */
let firstBuild;
function checkBuild(msg) {
  if (!msg.build) return;
  firstBuild ??= msg.build;
  if (msg.build !== firstBuild) location.reload();
}
