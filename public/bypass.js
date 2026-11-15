// Botão de pânico (BYPASS) no topo das telas Mixagem, Análise e Conexão.
// Ligado: o Copiloto não manda NADA para a mesa (faders, mute, EQ, ganho, presets), só monitora.
// Ligar é um clique (pânico); desligar pede confirmação.

(function () {
  let last; // { s, send }

  const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

  function toggle() {
    if (!last) return;
    const b = last.s.bypass;
    if (!b.on) {
      last.send({ type: 'bypass', on: true });
      return;
    }
    const ok = confirm(
      'Desligar o BYPASS?\n\nO Copiloto volta a mexer na mesa conforme o modo de cada saída (em "Ajustando" ele corrige os envios sozinho) e os faders do painel voltam a funcionar.',
    );
    if (ok) last.send({ type: 'bypass', on: false });
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#bypass-btn, #bypass-off')) toggle();
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'bypass-allow' || !last) return;
    const bus = e.target.value === '' ? null : Number(e.target.value);
    if (bus !== null && !confirm(`Liberar o Copiloto para mexer nos envios de ${e.target.selectedOptions[0].textContent}?\n\nSó essa saída. Todo o resto da mesa continua no bypass.`)) {
      e.target.value = '';
      return;
    }
    last.send({ type: 'bypass.allow', bus });
  });

  // ---- ⏻ Desligar o Copiloto (só admin) ----
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('#shutdown-btn')) return;
    const ok = confirm(
      'Desligar o Copiloto?\n\nO programa fecha para TODO MUNDO (painel, celulares, tablets). Os envios da mesa ficam como estão: nada muda no som.\n\nPara ligar de novo: ícone "Copiloto Ui24R" na área de trabalho.',
    );
    if (!ok) return;
    try {
      const res = await fetch('/api/shutdown', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Não consegui desligar.');
      showOff();
    } catch (err) {
      alert(err.message);
    }
  });

  function showOff() {
    if (document.getElementById('off-screen')) return;
    const el = document.createElement('div');
    el.id = 'off-screen';
    el.className = 'off-screen';
    el.innerHTML =
      '<div><h2>⏻ Copiloto desligado</h2><p>Os envios da mesa ficaram como estavam: nada mudou no som.</p><p>Para ligar de novo, dê dois cliques em <strong>Copiloto Ui24R</strong> na área de trabalho. Esta página volta sozinha quando ele ligar.</p></div>';
    document.body.appendChild(el);
  }

  // ---- versão nova no GitHub (aviso no topo; só o admin atualiza) ----
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#update-apply') || !last) return;
    const ok = confirm(
      'Atualizar o Copiloto agora?\n\nNÃO faça isso durante o culto: o Copiloto reinicia (uns 30 segundos) e a página volta sozinha. Os envios da mesa ficam como estão; usuários, presets e configurações são mantidos.',
    );
    if (ok) last.send({ type: 'update.apply' });
  });

  function renderUpdate(s) {
    const up = s.update;
    let el = document.getElementById('update-banner');
    const show = Boolean(up && up.latest && (up.available || up.state === 'atualizando'));
    if (!show) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'update-banner';
      el.className = 'update-banner';
      el.setAttribute('role', 'status');
      const anchor = document.getElementById('bypass-banner');
      if (anchor) anchor.after(el);
      else document.body.prepend(el);
    }
    el.hidden = false;
    const when = up.latest.date ? new Date(up.latest.date).toLocaleDateString('pt-BR') : '';
    const what = escape(up.latest.message);
    let action;
    if (up.state === 'atualizando') action = '<strong>Atualizando… o Copiloto reinicia sozinho.</strong>';
    else if (up.allowed) action = '<button type="button" id="update-apply" class="small-btn">Atualizar agora</button>';
    else action = '<span>Peça ao admin para atualizar.</span>';
    const err = up.state === 'erro' && up.detail ? `<span class="update-err">Última tentativa falhou: ${escape(up.detail)}</span>` : '';
    const sig = [what, when, up.state, up.allowed, err].join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = `<span>⬆ <strong>Versão nova do Copiloto</strong>${when ? ` (${when})` : ''}: ${what}</span>${action}${err}`;
  }

  function escape(t) {
    return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ---- sem conexão com a mesa: aviso em todas as telas (o Copiloto abre mesmo assim) ----
  function renderConn(s) {
    let el = document.getElementById('conn-banner');
    const off = s.source?.kind === 'mesa' && s.connection !== 'conectado';
    if (!off) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'conn-banner';
      el.className = 'conn-banner';
      el.setAttribute('role', 'status');
      const anchor = document.getElementById('bypass-banner');
      if (anchor) anchor.before(el);
      else document.body.prepend(el);
    }
    el.hidden = false;
    const estado = s.connection === 'conectando' || s.connection === 'reconectando' ? 'tentando conectar…' : 'tentando de novo a cada 5 s';
    const detalhe = s.connectionDetail ? ` (${escape(s.connectionDetail)})` : '';
    const link = location.pathname.endsWith('conexao.html') ? '' : '<a class="small-btn" href="conexao.html">Ver teste de conexão</a>';
    const sig = [s.source.ip, s.connection, s.connectionDetail].join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = `<span>⚠ <strong>Sem conexão com a mesa</strong> em ${escape(s.source.ip)}: ${estado}${detalhe}. O Copiloto está aberto, mas não lê nem mexe na mesa. Confira se este computador está na rede da mesa.</span>${link}`;
  }

  window.renderBypass = function (s, send) {
    if (!s.bypass) return;
    last = { s, send };
    renderUpdate(s);
    renderConn(s);
    const off = document.getElementById('shutdown-btn');
    if (off) off.hidden = s.user?.role !== 'admin';
    const b = s.bypass;
    const allow = b.on ? b.allow ?? [] : [];
    document.body.classList.toggle('bypass-on', b.on);
    // vendo a saída liberada: faders e mute dela voltam a funcionar
    document.body.classList.toggle('bypass-allowed', b.on && Boolean(s.bus) && allow.includes(s.bus.bus));

    const btn = document.getElementById('bypass-btn');
    if (btn) {
      btn.classList.toggle('on', b.on);
      btn.setAttribute('aria-pressed', String(b.on));
      btn.textContent = b.on ? (allow.length ? `⛔ BYPASS (exceto ${b.allowLabels.join(', ')})` : '⛔ BYPASS LIGADO') : '⛔ BYPASS';
      btn.title = b.on
        ? 'O Copiloto NÃO está mexendo na mesa (só monitora). Clique para desligar o bypass.'
        : 'PÂNICO: clique para o Copiloto parar de mexer em qualquer fader da mesa e só monitorar.';
    }

    const banner = document.getElementById('bypass-banner');
    if (banner) {
      banner.hidden = !b.on;
      if (b.on) {
        const txt = banner.querySelector('.bypass-text');
        const who = b.by ? ` por ${b.by}` : '';
        const when = b.at ? ` às ${hhmm(b.at)}` : '';
        const blocked = b.blocked ? ` · ${b.blocked} envio(s) barrado(s)` : '';
        txt.textContent = allow.length
          ? `BYPASS LIGADO${who}${when}: o Copiloto só mexe nos envios de ${b.allowLabels.join(', ')}; o resto da mesa (salão, live, EQ, ganho) está protegido${blocked}.`
          : `BYPASS LIGADO${who}${when}: o Copiloto NÃO mexe na mesa, só monitora (níveis, dicas e sugestões continuam)${blocked}.`;
        const sel = banner.querySelector('#bypass-allow');
        const opts = (s.buses ?? []).filter((x) => x.id !== 0);
        const sig = JSON.stringify([opts.map((o) => [o.id, o.label, o.name]), s.safety?.safeBuses]);
        if (sel.dataset.sig !== sig) {
          sel.dataset.sig = sig;
          const safe = s.safety?.safeBuses;
          sel.innerHTML =
            '<option value="">nenhuma saída</option>' +
            opts.map((o) => `<option value="${o.id}">${safe ? (safe.includes(o.id) ? '✓ ' : '⚠ ') : ''}${o.label} · ${o.name}</option>`).join('');
        }
        if (document.activeElement !== sel) sel.value = allow.length ? String(allow[0]) : '';
      }
    }
  };
})();
