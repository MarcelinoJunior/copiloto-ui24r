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

  window.renderBypass = function (s, send) {
    if (!s.bypass) return;
    last = { s, send };
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
        const sig = JSON.stringify(opts.map((o) => [o.id, o.label, o.name]));
        if (sel.dataset.sig !== sig) {
          sel.dataset.sig = sig;
          sel.innerHTML = '<option value="">nenhuma saída</option>' + opts.map((o) => `<option value="${o.id}">${o.label} · ${o.name}</option>`).join('');
        }
        if (document.activeElement !== sel) sel.value = allow.length ? String(allow[0]) : '';
      }
    }
  };
})();
