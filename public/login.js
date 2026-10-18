// Tela de login. No primeiro acesso (nenhum usuário ainda), cria o admin.

const $ = (sel) => document.querySelector(sel);
let setup = false;
const PROGRAMA_FECHADO = 'O Copiloto não está ligado. Dê dois cliques em “Abrir Copiloto” na área de trabalho e tente de novo.';

function showError(text) {
  const el = $('#error');
  el.textContent = text;
  el.hidden = !text;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    // sem resposta: o programa está fechado (não é erro de senha)
    throw new Error(PROGRAMA_FECHADO);
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Não consegui entrar.');
  return data;
}

async function init() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (me.user) {
    location.href = '/';
    return;
  }
  setup = me.needsSetup;
  $('#setup-msg').hidden = !setup;
  document.querySelectorAll('.setup-only').forEach((el) => (el.hidden = !setup));
  $('#submit').textContent = setup ? 'Criar admin e entrar' : 'Entrar';
  $('#password').autocomplete = setup ? 'new-password' : 'current-password';
  if (setup) $('#username').value = 'admin';
  $(setup ? '#password' : '#username').focus();
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!/^[A-Za-z0-9]{3,32}$/.test(username)) return showError('Usuário: só letras e números, de 3 a 32 caracteres.');
  if (!/^[A-Za-z0-9]{5,64}$/.test(password)) return showError('Senha: só letras e números, com pelo menos 5 caracteres.');
  if (setup && password !== $('#password2').value) return showError('As senhas não conferem.');
  $('#submit').disabled = true;
  try {
    await post(setup ? '/api/setup' : '/api/login', { username, password });
    location.href = '/';
  } catch (err) {
    showError(err.message);
  } finally {
    $('#submit').disabled = false;
  }
});

init().catch(() => showError(PROGRAMA_FECHADO));
