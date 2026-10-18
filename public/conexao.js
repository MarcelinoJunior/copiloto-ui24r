// Tela "Conexão": de onde vem o som (mesa real ou simulador), IP da mesa e saúde da conexão.

const QUALITY = {
  boa: ['Mesa real · conexão boa', 'q-good'],
  instavel: ['Mesa real · conexão instável', 'q-warn'],
  ruim: ['Mesa real · conexão ruim', 'q-bad'],
  'sem-conexao': ['Mesa real · sem conexão', 'q-bad'],
  simulador: ['SIMULADOR (mesa falsa)', 'q-sim'],
};

const $ = (sel) => document.querySelector(sel);
let socket;
let state;
let ipTouched = false;

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
    if (ev.code === 4401) {
      location.href = '/login.html';
      return;
    }
    const q = $('#quality');
    q.className = 'quality q-bad';
    q.textContent = 'Painel sem conexão com o programa';
    setTimeout(connect, 1500);
  };
}

function send(cmd) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

let errorTimer;
function showError(text) {
  const el = $('#error');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(errorTimer);
  if (text) errorTimer = setTimeout(() => (el.hidden = true), 6000);
}

const ms = (v) => (v === undefined || v === null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);

function duration(msValue) {
  const s = Math.floor(msValue / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function render(s) {
  const h = s.health;
  const isSim = s.source.kind === 'simulador';
  const isAdmin = s.user.role === 'admin';
  $('#admin-note').hidden = isAdmin;
  $('#nav-admin').textContent = isAdmin ? 'Pessoas' : 'Conta';
  document.querySelectorAll('#ip-form button, #ip, #use-sim, #use-vu, #detect, #use-usb-sim, #usb-form button').forEach((el) => {
    if (!isAdmin) el.disabled = true;
  });
  renderLevels(s, isAdmin);
  renderAccess(s, isAdmin);

  const [label, cls] = QUALITY[h.quality] ?? ['—', ''];
  const q = $('#quality');
  q.className = `quality ${cls}`;
  q.textContent = label;

  // cartões "Mesa real" / "Simulador"
  $('#src-real').classList.toggle('active', !isSim);
  $('#src-sim').classList.toggle('active', isSim);
  $('#src-real .now').hidden = isSim;
  $('#src-sim .now').hidden = !isSim;
  $('#use-sim').disabled = isSim;
  $('#use-real').textContent = isSim ? 'Conectar na mesa real' : 'Salvar e reconectar';
  if (!ipTouched && document.activeElement !== $('#ip')) $('#ip').value = s.source.ip;

  $('#target').textContent = isSim ? 'medindo o SIMULADOR (não há rede)' : `medindo a mesa real em ${s.source.ip}`;
  $('#reasons').innerHTML = h.reasons
    .map((r) => `<li class="${h.quality === 'boa' ? 'ok' : h.quality === 'simulador' ? 'sim' : ''}">${escapeHtml(r)}</li>`)
    .join('');

  $('#t-state').textContent = isSim ? 'simulando' : h.state;
  $('#t-since').textContent = isSim ? 'mesa falsa' : h.connectedSince ? `há ${duration(Date.now() - h.connectedSince)}` : h.detail ?? '';
  $('#t-ping').textContent = isSim ? '—' : ms(h.ping.lastMs);
  $('#t-ping-stats').textContent = isSim
    ? 'não se aplica ao simulador'
    : h.ping.avgMs === undefined
      ? 'sem medições'
      : `média ${ms(h.ping.avgMs)} · melhor ${ms(h.ping.minMs)} · pior ${ms(h.ping.maxMs)}`;
  $('#t-loss').textContent = isSim ? '—' : `${h.ping.lossPct}%`;
  const age = h.lastDataAgeMs;
  $('#t-age').textContent = age === undefined ? '—' : age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`;
  $('#t-age').className = `tv ${age > 3000 ? 'bad' : age > 1000 ? 'warn' : ''}`;
  $('#t-vu').textContent = h.vuPerSec.toFixed(1);
  $('#t-msg').textContent = isSim ? '—' : h.msgPerSec.toFixed(1);
  $('#t-rec').textContent = String(h.reconnects);

  renderSpark(h.ping.samples, isSim);
  // operador só vê: reaplica o bloqueio depois dos ajustes acima
  if (!isAdmin) document.querySelectorAll('#ip-form button, #ip, #use-sim, #use-vu, #detect, #use-usb-sim, #usb-form button').forEach((el) => (el.disabled = true));

  $('#pc').innerHTML = h.pc.length
    ? h.pc
        .map((p) => `<li><strong>${escapeHtml(p.address)}</strong> <span class="muted">${escapeHtml(p.iface)}</span> ${
          p.sameSubnet ? '<span class="tag ok">mesma rede da mesa</span>' : '<span class="tag">outra rede</span>'
        }</li>`)
        .join('')
    : '<li class="muted">Nenhuma rede ativa encontrada</li>';

  $('#history').innerHTML = h.history
    .map((e) => `<li><time>${new Date(e.t).toLocaleTimeString('pt-BR')}</time>${escapeHtml(e.text)}</li>`)
    .join('');

  const t = h.lastTest;
  const out = $('#test-result');
  out.hidden = !t;
  if (t) {
    out.className = `test-result ${t.ok ? 'ok' : 'bad'}`;
    out.textContent = t.ok
      ? `✓ ${t.ip} respondeu: ${t.results.map((r) => (r === null ? 'sem resposta' : ms(r))).join(' · ')}`
      : `✗ ${t.ip} não respondeu. Confira o IP e se o PC está no mesmo Wi-Fi da mesa.`;
  }
}

const ACCESS_CHECK = {
  confere: ['ok', 'Senha confere com a da mesa.'],
  'nao-confere': ['bad', 'A senha cadastrada é diferente da que a mesa informa. Confira em Settings › Access (não impede o Copiloto de funcionar).'],
  'nao-informado': ['', 'A mesa não mostra a senha pela conexão de controle, então não dá para conferir. Tudo bem: o controle funciona sem ela (veja o teste de comando).'],
  'mesa-tem-senha': ['', 'A mesa informa que tem senha (Access). Marque "A mesa tem senha" e digite a senha para conferir.'],
};
let accessTouched = false;

function renderAccess(s, isAdmin) {
  const a = s.access;
  if (!a) return;
  if (!accessTouched) $('#acc-enabled').checked = a.enabled;
  $('#acc-pass-wrap').hidden = !$('#acc-enabled').checked;
  $('#acc-pass').placeholder = a.hasPassword ? '•••••• (guardada; digite para trocar)' : 'digite a senha da mesa';
  for (const el of document.querySelectorAll('#access-form input, #access-form button, #write-test')) el.disabled = !isAdmin;

  const st = $('#acc-status');
  const isReal = s.source.kind === 'mesa';
  const msg = !isReal
    ? ['', 'No simulador não há senha: conecte na mesa real para conferir.']
    : s.connection !== 'conectado'
      ? ['', 'Conecte na mesa para conferir a senha.']
      : a.check
        ? ACCESS_CHECK[a.check]
        : a.enabled
          ? ['', 'Salvo.']
          : ['', 'Mesa sem senha (ou a mesa não informou senha).'];
  st.hidden = false;
  st.className = `test-result ${msg[0]}`;
  st.textContent = msg[1];

  const out = $('#wt-result');
  const wt = a.writeTest;
  $('#write-test').textContent = a.writeTesting ? 'Testando…' : 'Testar comando';
  if (a.writeTesting) $('#write-test').disabled = true;
  out.hidden = !wt;
  if (wt) {
    out.className = `test-result ${wt.ok ? 'ok' : wt.ok === false ? 'bad' : ''}`;
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    out.textContent = wt.ok ? `✓ OK em ${wt.ms} ms: ${wt.detail}.` : wt.ok === false ? `✗ ${cap(wt.detail)}.` : `? ${cap(wt.detail)}.`;
    $('#wt-when').textContent = `último teste: ${new Date(wt.at).toLocaleTimeString('pt-BR')}`;
  } else {
    $('#wt-when').textContent = '';
  }
}

$('#acc-enabled').addEventListener('change', () => {
  accessTouched = true;
  $('#acc-pass-wrap').hidden = !$('#acc-enabled').checked;
});
$('#access-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const enabled = $('#acc-enabled').checked;
  const password = $('#acc-pass').value;
  send({ type: 'conn.access', enabled, password: enabled ? password || undefined : null });
  $('#acc-pass').value = '';
  accessTouched = false;
});
$('#write-test').addEventListener('click', () => send({ type: 'conn.writeTest' }));

function renderLevels(s, isAdmin) {
  const lv = s.levelSource;
  const usb = lv.kind === 'usb';
  $('#lv-vu').classList.toggle('active', !usb);
  $('#lv-usb').classList.toggle('active', usb);
  $('#lv-vu .now').hidden = usb;
  $('#lv-usb .now').hidden = !usb;
  if (isAdmin) $('#use-vu').disabled = !usb;
  const simMode = s.source.kind === 'simulador';
  $('#use-usb-sim').hidden = !simMode || usb;
  $('#detect').hidden = simMode;

  const st = $('#usb-state');
  if (usb) {
    const age = lv.usbAgeMs;
    st.textContent =
      lv.usbState === 'capturando' && age !== undefined && age < 1000
        ? `capturando "${lv.device}" (${lv.channels} canais)`
        : `${lv.usbState ?? '—'}${lv.usbError ? `: ${lv.usbError}` : ''}`;
    st.className = `small ${lv.usbState === 'capturando' ? 'ok-text' : 'form-error'}`;
  } else {
    st.textContent = '';
  }

  const d = lv.detection;
  const out = $('#usb-result');
  const sig = JSON.stringify(d ?? null);
  if (out.dataset.sig === sig) return;
  out.dataset.sig = sig;
  if (!d) {
    out.innerHTML = '<p class="muted small">Ainda não procurei. Ligue o cabo USB da mesa e clique em "Procurar".</p>';
    $('#usb-form').hidden = true;
    return;
  }
  const found = d.ui24Devices.length
    ? `<ul class="usb-list">${d.ui24Devices.map((x) => `<li>✓ <strong>${escapeHtml(x.name)}</strong> <span class="muted">(${escapeHtml(x.kind)}, ${escapeHtml(x.status)})</span></li>`).join('')}</ul>`
    : '<p class="small">✗ Nenhuma Ui24R encontrada no USB.</p>';
  const ff = d.ffmpeg.found ? `<p class="small">✓ ffmpeg: ${escapeHtml(d.ffmpeg.version ?? '')}</p>` : '<p class="small">✗ ffmpeg não instalado.</p>';
  const notes = d.notes.length ? `<ul class="notes">${d.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '';
  out.innerHTML = found + ff + notes;
  const devices = d.captureDevices;
  $('#usb-form').hidden = devices.length === 0;
  if (devices.length) {
    const guess = devices.find((x) => /soundcraft|ui24/i.test(x)) ?? devices[0];
    $('#usb-device').innerHTML = devices
      .map((x) => `<option ${x === guess ? 'selected' : ''}>${escapeHtml(x)}</option>`)
      .join('');
  }
}

function renderSpark(samples, isSim) {
  const el = $('#spark');
  if (isSim) {
    el.innerHTML = '';
    $('#spark-max').textContent = 'simulador: sem rede para medir';
    return;
  }
  const values = samples.map((s) => s.ms).filter((v) => v !== null);
  const max = Math.max(20, ...values);
  $('#spark-max').textContent = `escala até ${Math.round(max)} ms`;
  const slots = 60;
  const padded = [...Array(Math.max(0, slots - samples.length)).fill(undefined), ...samples.slice(-slots)];
  el.innerHTML = padded
    .map((s) => {
      if (!s) return '<i class="empty"></i>';
      if (s.ms === null) return '<i class="fail" title="sem resposta"></i>';
      const hgt = Math.max(4, (s.ms / max) * 100);
      const cls = s.ms > 200 ? 'bad' : s.ms > 60 ? 'warn' : '';
      return `<i class="${cls}" style="height:${hgt}%" title="${ms(s.ms)}"></i>`;
    })
    .join('');
}

$('#ip').addEventListener('input', () => (ipTouched = true));
$('#test').addEventListener('click', () => send({ type: 'conn.test', ip: $('#ip').value.trim() }));
$('#use-sim').addEventListener('click', () => {
  if (confirm('Trocar para o SIMULADOR? O software deixa de conversar com a mesa real.')) send({ type: 'conn.useSim' });
});
$('#ip-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ip = $('#ip').value.trim();
  if (!ip) return;
  const isSim = state?.source.kind === 'simulador';
  const msg = isSim ? `Conectar na MESA REAL em ${ip}?` : `Reconectar na mesa real em ${ip}?`;
  if (confirm(msg)) {
    send({ type: 'conn.setIp', ip });
    ipTouched = false;
  }
});

$('#use-vu').addEventListener('click', () => send({ type: 'level.useVu' }));
$('#use-usb-sim').addEventListener('click', () => send({ type: 'level.useUsb', device: 'USB simulado', channels: 24 }));
$('#detect').addEventListener('click', () => {
  $('#usb-result').innerHTML = '<p class="muted small">Procurando…</p>';
  $('#usb-result').dataset.sig = '';
  send({ type: 'level.detect' });
});
$('#usb-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'level.useUsb', device: $('#usb-device').value, channels: Number($('#usb-channels').value) });
});

connect();

/** Recarrega a página quando o programa foi reiniciado com uma versão nova. */
let firstBuild;
function checkBuild(msg) {
  if (!msg.build) return;
  firstBuild ??= msg.build;
  if (msg.build !== firstBuild) location.reload();
}
