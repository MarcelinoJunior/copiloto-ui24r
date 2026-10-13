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
    state = JSON.parse(ev.data);
    render(state);
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

function render(s) {
  const h = s.health;
  const isSim = s.source.kind === 'simulador';

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

connect();
