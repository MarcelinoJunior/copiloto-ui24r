// Janela "Saúde da mesa" (aba no topo das telas): quantos comandos o Copiloto manda para a Ui24R,
// o tempo de resposta da mesa e qualquer dado de saúde que a mesa informar (temperatura, CPU…).
// Abre numa caixa de diálogo, sem barra de rolagem. Os dados chegam junto com o resto do estado.

(function () {
  let latest;
  let dialog;

  // Referência do Copiloto (não é um limite oficial da Soundcraft): comandos por segundo
  const LEVELS = [
    { max: 5, cls: 'ok', text: 'tranquilo' },
    { max: 20, cls: 'warn', text: 'moderado' },
    { max: Infinity, cls: 'bad', text: 'alto' },
  ];

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  const num = (v, d = 1) => (v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'health-dialog';
    dialog.className = 'health-dialog';
    dialog.innerHTML = `
      <header class="hd-head">
        <h2>Saúde da mesa</h2>
        <span class="hd-sub" id="hd-sub"></span>
        <span class="spacer"></span>
        <button type="button" class="hd-close" id="hd-close" title="Fechar (Esc)">✕ Fechar</button>
      </header>
      <div class="hd-body" id="hd-body"></div>`;
    document.body.append(dialog);
    dialog.querySelector('#hd-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // clique fora da caixa fecha
    });
    return dialog;
  }

  function open() {
    ensureDialog().showModal();
    if (latest) render(latest);
  }

  function bars(values) {
    const max = Math.max(5, ...values);
    return values
      .map((v) => `<i style="height:${Math.max(v ? 6 : 2, (v / max) * 100)}%" class="${v > 20 ? 'bad' : v > 5 ? 'warn' : ''}" title="${v} no segundo"></i>`)
      .join('');
  }

  function render(s) {
    if (!dialog?.open) return;
    const mh = s.mixerHealth;
    const h = s.health;
    const m = s.mixer;
    const isSim = s.source?.kind === 'simulador';
    dialog.querySelector('#hd-sub').textContent = isSim ? 'simulador (mesa falsa)' : `${m?.model ?? 'Ui24R'} · ${s.source?.ip ?? ''}`;
    if (!mh) {
      dialog.querySelector('#hd-body').innerHTML = '<p class="muted">Aguardando o Copiloto…</p>';
      return;
    }
    const w = mh.writes;
    const level = LEVELS.find((l) => w.perSec <= l.max);
    const ping = h?.ping;
    const kinds = w.byKind.length
      ? w.byKind.map((k) => `<li><span>${esc(k.label)}</span><b>${k.count}</b></li>`).join('')
      : '<li class="muted">nenhum comando ainda</li>';
    const keys = mh.keys.length
      ? `<ul class="hd-keys">${mh.keys.map((k) => `<li><span>${esc(k.key)}</span><b>${esc(k.value)}</b></li>`).join('')}</ul>`
      : `<p class="hd-note">A Ui24R <strong>não informa temperatura nem uso de CPU</strong> pela conexão de controle (a mesma que a página da mesa usa). O Copiloto fica atento: se a mesa mandar algum dado assim, ele aparece aqui sozinho.</p>`;
    dialog.querySelector('#hd-body').innerHTML = `
      <section class="hd-card hd-cmds">
        <h3>Comandos do Copiloto para a mesa</h3>
        <div class="hd-big">
          <span class="hd-num ${level.cls}">${num(w.perSec)}</span>
          <span class="hd-unit">por segundo<br><small>média dos últimos 10 s</small></span>
          <span class="hd-chip ${level.cls}">${level.text}</span>
        </div>
        <div class="hd-bars" title="Comandos em cada segundo do último minuto">${bars(w.lastMinute)}</div>
        <div class="hd-axis"><span>1 min atrás</span><span>agora</span></div>
        <div class="hd-row"><span>pico</span><b>${w.peak} por segundo</b><small>${w.peak ? `às ${hhmm(w.peakAt)}` : ''}</small></div>
        <div class="hd-row"><span>total desde que ligou</span><b>${w.total}</b></div>
        ${mh.sent ? `<div class="hd-row"><span>mensagens pela rede</span><b>${num(mh.sent.perSec)}/s</b><small>pico ${mh.sent.peak}/s · par estéreo conta 2</small></div>` : ''}
        <p class="hd-note">Referência do Copiloto, não um limite oficial: até 5 por segundo é tranquilo; acima de 20, alto. Mexer num fader na página da mesa também manda vários comandos por segundo.</p>
      </section>
      <section class="hd-card">
        <h3>Por tipo (desde que ligou)</h3>
        <ul class="hd-kinds">${kinds}</ul>
      </section>
      <section class="hd-card">
        <h3>Conexão com a mesa</h3>
        <div class="hd-row"><span>estado</span><b>${esc(s.connection ?? '—')}</b></div>
        <div class="hd-row"><span>tempo de resposta</span><b>${isSim ? '—' : ping?.lastMs === null ? 'sem resposta' : `${num(ping?.lastMs, 0)} ms`}</b><small>${isSim ? '' : `média ${num(ping?.avgMs, 0)} ms · perda ${num(ping?.lossPct, 0)}%`}</small></div>
        <div class="hd-row"><span>dados chegando</span><b>${num(h?.msgPerSec)} msg/s</b><small>medidores ${num(h?.vuPerSec)}/s</small></div>
        <div class="hd-row"><span>firmware</span><b>${esc(m?.firmware ?? '—')}</b></div>
      </section>
      <section class="hd-card">
        <h3>Temperatura e CPU</h3>
        ${keys}
      </section>`;
  }

  // a aba "Saúde da mesa" abre a janela (nas telas que carregam este arquivo); nas outras, leva para a mixagem
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.nav-health');
    if (!a) return;
    e.preventDefault();
    open();
  });
  if (location.hash === '#saude') {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(open, 300);
  }

  window.renderSaude = function (s) {
    latest = s;
    render(s);
  };
})();
