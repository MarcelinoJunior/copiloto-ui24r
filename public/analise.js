// Tela "Análise": recursos avançados do modo Áudio USB.

const $ = (sel) => document.querySelector(sel);
let socket;
let state;
let errorTimer;
const touched = new Set(); // campos que a pessoa está editando (não sobrescrever)

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function showError(text) {
  const el = $('#error');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(errorTimer);
  if (text) errorTimer = setTimeout(() => (el.hidden = true), 6000);
}

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'erro') return showError(msg.text);
    checkBuild(msg);
    state = msg;
    render(state);
  };
  socket.onclose = (ev) => {
    if (ev.code === 4401) return (location.href = '/login.html');
    setTimeout(connect, 1500);
  };
}

function send(cmd) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

const lufs = (v) => (v === undefined || v === null ? '—' : v.toFixed(1));
const setIfIdle = (el, value) => {
  if (!touched.has(el.id) && document.activeElement !== el) el.value = value;
};

function render(s) {
  renderBypass(s, send);
  const adv = s.advanced;
  const isAdmin = s.user.role === 'admin';
  const set = adv.settings;
  $('#nav-admin').textContent = isAdmin ? 'Pessoas' : 'Conta';
  $('#admin-note').hidden = isAdmin;
  $('#not-usb').hidden = adv.active;
  const st = $('#adv-state');
  st.className = `quality ${adv.active ? 'q-good' : 'q-warn'}`;
  st.textContent = adv.active ? (s.source.kind === 'simulador' ? 'USB simulado: ativo' : 'Áudio USB: ativo') : 'Desligado (modo VU)';

  // ---- alertas ----
  const a = adv.analysis;
  const items = [];
  for (const f of a?.feedback ?? []) items.push(['alta', `${f.name}: MICROFONIA em ~${f.freqHz} Hz`, `${f.rising ? 'Crescendo' : 'Sustentada'} há ${f.forSec} s, ${f.levelDb} dB.`]);
  for (const h of a?.hum ?? []) items.push(['media', `${h.name}: zumbido de ${h.freqHz} Hz`, `${h.aboveDb} dB acima do fundo.`]);
  for (const h of a?.hiss ?? []) items.push(['baixa', `${h.name}: chiado`, `Ruído largo em ${h.levelDb} dB sem ninguém tocando.`]);
  $('#alerts').innerHTML = items.length
    ? items.map(([sev, t, d]) => `<li class="${sev}"><strong>${escapeHtml(t)}</strong><p>${escapeHtml(d)}</p></li>`).join('')
    : `<li class="empty"><strong>${adv.active ? 'Nenhum alerta agora.' : 'Alertas desligados (modo VU).'}</strong></li>`;
  document.querySelectorAll('[data-set]').forEach((el) => {
    el.checked = Boolean(set[el.dataset.set]);
    el.disabled = !isAdmin;
  });

  // ---- loudness ----
  const l = a?.loudness;
  $('#l-int').textContent = lufs(l?.integrated);
  $('#l-short').textContent = lufs(l?.shortTerm);
  $('#l-mom').textContent = lufs(l?.momentary);
  $('#l-peak').textContent = lufs(l?.peakDb);
  $('#l-peak').className = `tv ${l?.peakDb > -1 ? 'bad' : ''}`;
  const target = set.loudness.target;
  const diff = l?.integrated === undefined ? undefined : l.integrated - target;
  $('#l-diff').textContent = diff === undefined ? `alvo ${target} LUFS` : `${diff > 0 ? '+' : ''}${diff.toFixed(1)} LU do alvo (${target})`;
  $('#l-int').className = `tv ${diff === undefined ? '' : Math.abs(diff) >= 3 ? 'warn' : ''}`;
  const pct = (v) => Math.max(0, Math.min(100, ((v + 40) / 40) * 100)); // -40..0 LUFS
  $('#l-fill').style.width = `${l?.shortTerm === undefined ? 0 : pct(l.shortTerm)}%`;
  $('#l-target').style.left = `${pct(target)}%`;
  $('#l-enabled').checked = set.loudness.enabled;
  setIfIdle($('#l-source'), set.loudness.source);
  setIfIdle($('#l-left'), set.loudness.left);
  setIfIdle($('#l-right'), set.loudness.right);
  setIfIdle($('#l-target-in'), set.loudness.target);
  const devices = s.levelSource.detection?.captureDevices ?? [];
  const devSel = $('#l-device');
  const devSig = JSON.stringify([devices, set.loudness.device]);
  if (devSel.dataset.sig !== devSig) {
    devSel.dataset.sig = devSig;
    const list = [...new Set([set.loudness.device, ...devices].filter(Boolean))];
    devSel.innerHTML = list.length
      ? list.map((d) => `<option ${d === set.loudness.device ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')
      : '<option value="">(procure os dispositivos em Conexão)</option>';
  }
  $('#l-device-wrap').hidden = $('#l-source').value !== 'device';
  $('#l-usb-wrap').hidden = $('#l-source').value !== 'usb';
  document.querySelectorAll('#loud-form input, #loud-form select, #loud-form button, #l-reset').forEach((el) => (el.disabled = !isAdmin));

  // ---- fala × música ----
  const m = a?.moment;
  const label = { fala: 'FALA', musica: 'MÚSICA', silencio: 'silêncio' };
  $('#m-state').textContent = !adv.active
    ? '—'
    : !set.moment.enabled
      ? 'detecção desligada'
      : `${label[m?.state] ?? '—'}${m?.candidate ? ` → mudando para ${label[m.candidate]}…` : ''}`;
  $('#m-enabled').checked = set.moment.enabled;
  $('#m-enabled').disabled = !isAdmin;
  renderAuto(adv);
  renderRoles(adv, isAdmin);

  // ---- gravação ----
  const rec = a?.recording;
  $('#r-state').textContent = rec
    ? `● gravando há ${Math.floor(rec.seconds / 60)} min ${rec.seconds % 60} s · ${(rec.bytes / 1e6).toFixed(0)} MB · ${rec.dir}`
    : 'parada';
  $('#r-start').disabled = !isAdmin || !adv.active || Boolean(rec);
  $('#r-stop').disabled = !isAdmin || !rec;

  // ---- OBS ----
  const o = adv.obs;
  const stLabel = { desligado: 'desligado', conectando: 'conectando…', conectado: 'conectado', erro: `erro: ${o.error ?? ''}` };
  $('#o-state').textContent = set.obs.enabled && !adv.active ? 'só funciona no modo Áudio USB' : stLabel[o.state] ?? o.state;
  $('#o-enabled').checked = set.obs.enabled;
  setIfIdle($('#o-host'), set.obs.host);
  setIfIdle($('#o-port'), set.obs.port);
  $('#o-pass').placeholder = set.obs.hasPassword ? '(mantida)' : '(sem senha)';
  const inSel = $('#o-input');
  const inSig = JSON.stringify([o.inputs, set.obs.input]);
  if (inSel.dataset.sig !== inSig) {
    inSel.dataset.sig = inSig;
    const list = [...new Set([set.obs.input, ...o.inputs].filter(Boolean))];
    inSel.innerHTML = `<option value="">(escolha)</option>` + list.map((i) => `<option ${i === set.obs.input ? 'selected' : ''}>${escapeHtml(i)}</option>`).join('');
  }
  $('#o-live').textContent = o.state !== 'conectado' ? '—' : o.streaming ? '● NO AR' : 'fora do ar';
  $('#o-live').className = `tv ${o.streaming ? 'bad' : ''}`;
  $('#o-level').textContent = o.levelDb === undefined ? '—' : `${o.levelDb.toFixed(0)} dB${o.inputMuted ? ' (MUTADA)' : ''}`;
  $('#o-peak').textContent = o.peakDb === undefined ? '' : `pico ${o.peakDb.toFixed(1)} dB`;
  const fSig = JSON.stringify(o.filters) + isAdmin;
  const fBox = $('#o-filters');
  if (fBox.dataset.sig !== fSig) {
    fBox.dataset.sig = fSig;
    fBox.innerHTML = o.filters.length
      ? o.filters
          .map((f) => `<label class="toggle-btn"><input type="checkbox" data-filter="${escapeHtml(f.name)}" ${f.enabled ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}> ${escapeHtml(f.name)}</label>`)
          .join('')
      : '<span class="muted small">Nenhum filtro (ou fonte não escolhida).</span>';
  }
  document.querySelectorAll('#obs-form input, #obs-form select, #obs-form button').forEach((el) => (el.disabled = !isAdmin));
}

function renderAuto(adv) {
  const box = $('#m-auto');
  const sig = JSON.stringify([adv.presetsByBus, adv.settings.moment.auto]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = adv.presetsByBus
    .map((b) => {
      const cfg = adv.settings.moment.auto[String(b.bus)] ?? { enabled: false };
      const opts = (sel) =>
        `<option value="">(não trocar)</option>` + b.presets.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
      return `<div class="auto-row" data-bus="${b.bus}">
        <label class="toggle-btn"><input type="checkbox" class="a-en" ${cfg.enabled ? 'checked' : ''} ${b.presets.length ? '' : 'disabled'}> ${escapeHtml(b.label)}</label>
        <label>fala → <select class="a-fala">${opts(cfg.fala)}</select></label>
        <label>música → <select class="a-musica">${opts(cfg.musica)}</select></label>
        ${b.presets.length ? '' : '<span class="muted small">crie presets desta saída na Mixagem</span>'}
      </div>`;
    })
    .join('');
}

function renderRoles(adv, isAdmin) {
  const box = $('#m-roles');
  const roles = adv.analysis?.moment.roles ?? {};
  const heard = adv.analysis?.identified ?? {};
  const sig = JSON.stringify([adv.channels, roles, adv.settings.moment.roles, isAdmin, heard]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const names = { auto: 'automático (pelo som)', fala: 'fala', canto: 'canto', instrumento: 'instrumento', ignorar: 'ignorar' };
  const SOUND = { voz: 'voz', bumbo: 'bumbo', caixa: 'caixa', pratos: 'pratos/overhead', baixo: 'baixo', harmonico: 'violão/guitarra/teclado' };
  box.innerHTML = adv.channels
    .map((c) => {
      const role = adv.settings.moment.roles[c.key] ?? roles[c.key] ?? 'auto';
      const h = heard[c.key];
      const tag = h ? ` <span class="heard" title="Reconhecido pelo áudio (${Math.round(h.confidence * 100)}%)">ouvido: ${SOUND[h.type] ?? h.type}</span>` : '';
      return `<label class="role"><span><span class="muted">${c.key}</span> ${escapeHtml(c.name)}${tag}</span>
        <select data-role="${c.key}" ${isAdmin ? '' : 'disabled'}>${Object.entries(names)
          .map(([v, t]) => `<option value="${v}" ${v === role ? 'selected' : ''}>${t}</option>`)
          .join('')}</select></label>`;
    })
    .join('');
}

// ---- ações ----

document.querySelectorAll('[data-set]').forEach((el) =>
  el.addEventListener('change', () => send({ type: 'adv.set', patch: { [el.dataset.set]: el.checked } })),
);
['#l-source', '#l-left', '#l-right', '#l-target-in', '#o-host', '#o-port'].forEach((sel) =>
  $(sel).addEventListener('input', () => touched.add($(sel).id)),
);
$('#l-source').addEventListener('change', () => {
  $('#l-device-wrap').hidden = $('#l-source').value !== 'device';
  $('#l-usb-wrap').hidden = $('#l-source').value !== 'usb';
});
$('#loud-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send({
    type: 'adv.set',
    patch: {
      loudness: {
        enabled: $('#l-enabled').checked,
        source: $('#l-source').value,
        device: $('#l-device').value,
        left: Number($('#l-left').value),
        right: Number($('#l-right').value),
        target: Number($('#l-target-in').value),
      },
    },
  });
  touched.clear();
});
$('#l-reset').addEventListener('click', () => send({ type: 'loud.reset' }));
$('#m-enabled').addEventListener('change', (e) => send({ type: 'adv.set', patch: { moment: { enabled: e.target.checked } } }));
$('#m-auto').addEventListener('change', (e) => {
  const row = e.target.closest('.auto-row');
  if (!row) return;
  send({
    type: 'adv.auto',
    bus: Number(row.dataset.bus),
    enabled: row.querySelector('.a-en').checked,
    fala: row.querySelector('.a-fala').value || null,
    musica: row.querySelector('.a-musica').value || null,
  });
});
$('#m-roles').addEventListener('change', (e) => {
  const key = e.target.dataset?.role;
  if (key) send({ type: 'adv.role', key, role: e.target.value });
});
$('#r-start').addEventListener('click', () => send({ type: 'rec.start' }));
$('#r-stop').addEventListener('click', () => send({ type: 'rec.stop' }));
$('#obs-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const obs = {
    enabled: $('#o-enabled').checked,
    host: $('#o-host').value.trim(),
    port: Number($('#o-port').value),
    input: $('#o-input').value,
  };
  if ($('#o-pass').value) obs.password = $('#o-pass').value;
  send({ type: 'adv.set', patch: { obs } });
  $('#o-pass').value = '';
  touched.clear();
});
$('#o-refresh').addEventListener('click', () => send({ type: 'obs.refresh' }));
$('#o-filters').addEventListener('change', (e) => {
  const filter = e.target.dataset?.filter;
  if (filter) send({ type: 'obs.filter', filter, enabled: e.target.checked });
});

connect();

/** Recarrega a página quando o programa foi reiniciado com uma versão nova. */
let firstBuild;
function checkBuild(msg) {
  if (!msg.build) return;
  firstBuild ??= msg.build;
  if (msg.build !== firstBuild) location.reload();
}
