// Tela "Conexão": endereço da mesa e saúde da conexão.

const QUALITY = {
  boa: ['Conexão boa', 'q-good'],
  instavel: ['Conexão instável', 'q-warn'],
  ruim: ['Conexão ruim', 'q-bad'],
  'sem-conexao': ['Sem conexão', 'q-bad'],
};

const $ = (sel) => document.querySelector(sel);
let socket;
let state;
let ipTouched = false;

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = (ev) => {
    state = JSON.parse(ev.data);
    render(state.health);
  };
  socket.onclose = () => {
    const q = $('#quality');
    q.className = 'quality q-bad';
    q.textContent = 'Painel sem conexão com o programa';
    setTimeout(connect, 1500);
  };
}

function send(cmd) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
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

function render(h) {
  const [label, cls] = QUALITY[h.quality] ?? ['—', ''];
  const q = $('#quality');
  q.className = `quality ${cls}`;
  q.textContent = label;

  const isSim = h.target.kind === 'simulador';
  $('#target').textContent = isSim ? 'SIMULADOR (sem rede)' : `mesa em ${h.target.ip}`;
  if (!ipTouched && document.activeElement !== $('#ip')) $('#ip').value = isSim ? '' : h.target.ip;
  $('#ip').disabled = isSim;
  document.querySelectorAll('#ip-form button').forEach((b) => (b.disabled = isSim && b.id !== 'reconnect'));
  if (isSim) $('#ip').placeholder = 'simulador: rode "npm start" para usar a mesa';

  $('#reasons').innerHTML = h.reasons
    .map((r) => `<li class="${h.quality === 'boa' ? 'ok' : ''}">${escapeHtml(r)}</li>`)
    .join('');

  $('#t-state').textContent = h.state;
  $('#t-since').textContent = h.connectedSince ? `há ${duration(Date.now() - h.connectedSince)}` : h.detail ?? '';
  $('#t-ping').textContent = ms(h.ping.lastMs);
  $('#t-ping-stats').textContent =
    h.ping.avgMs === undefined ? 'sem medições' : `média ${ms(h.ping.avgMs)} · melhor ${ms(h.ping.minMs)} · pior ${ms(h.ping.maxMs)}`;
  $('#t-loss').textContent = `${h.ping.lossPct}%`;
  $('#t-age').textContent = h.lastDataAgeMs === undefined ? '—' : h.lastDataAgeMs < 1000 ? `${h.lastDataAgeMs} ms` : `${(h.lastDataAgeMs / 1000).toFixed(1)} s`;
  $('#t-age').className = `tv ${h.lastDataAgeMs > 3000 ? 'bad' : h.lastDataAgeMs > 1000 ? 'warn' : ''}`;
  $('#t-vu').textContent = h.vuPerSec.toFixed(1);
  $('#t-msg').textContent = isSim ? '—' : h.msgPerSec.toFixed(1);
  $('#t-rec').textContent = String(h.reconnects);

  renderSpark(h.ping.samples);

  $('#pc').innerHTML = h.pc.length
    ? h.pc
        .map((p) => `<li><strong>${escapeHtml(p.address)}</strong> <span class="muted">${escapeHtml(p.iface)}</span> ${
          isSim ? '' : p.sameSubnet ? '<span class="tag ok">mesma rede da mesa</span>' : '<span class="tag">outra rede</span>'
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

function renderSpark(samples) {
  const el = $('#spark');
  const values = samples.map((s) => s.ms).filter((v) => v !== null);
  const max = Math.max(20, ...values);
  $('#spark-max').textContent = `escala até ${Math.round(max)} ms`;
  const slots = 60;
  const padded = [...Array(Math.max(0, slots - samples.length)).fill(undefined), ...samples.slice(-slots)];
  el.innerHTML = padded
    .map((s) => {
      if (!s) return '<i class="empty"></i>';
      if (s.ms === null) return '<i class="fail" title="sem resposta"></i>';
      const h = Math.max(4, (s.ms / max) * 100);
      const cls = s.ms > 200 ? 'bad' : s.ms > 60 ? 'warn' : '';
      return `<i class="${cls}" style="height:${h}%" title="${ms(s.ms)}"></i>`;
    })
    .join('');
}

$('#ip').addEventListener('input', () => (ipTouched = true));
$('#test').addEventListener('click', () => send({ type: 'conn.test', ip: $('#ip').value.trim() }));
$('#reconnect').addEventListener('click', () => send({ type: 'conn.reconnect' }));
$('#ip-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ip = $('#ip').value.trim();
  if (!ip) return;
  if (state?.health.target.ip === ip || confirm(`Trocar a mesa para ${ip}? A conexão atual será fechada.`)) {
    send({ type: 'conn.setIp', ip });
    ipTouched = false;
  }
});

connect();
