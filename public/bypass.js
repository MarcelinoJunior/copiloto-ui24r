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

  window.renderBypass = function (s, send) {
    if (!s.bypass) return;
    last = { s, send };
    const b = s.bypass;
    document.body.classList.toggle('bypass-on', b.on);

    const btn = document.getElementById('bypass-btn');
    if (btn) {
      btn.classList.toggle('on', b.on);
      btn.setAttribute('aria-pressed', String(b.on));
      btn.textContent = b.on ? '⛔ BYPASS LIGADO' : '⛔ BYPASS';
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
        txt.textContent = `BYPASS LIGADO${who}${when}: o Copiloto NÃO mexe na mesa, só monitora (níveis, dicas e sugestões continuam)${blocked}.`;
      }
    }
  };
})();
