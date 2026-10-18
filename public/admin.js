// Tela "Pessoas" (admin): cadastra usuários e escolhe quais saídas cada um pode usar.

const $ = (sel, root = document) => root.querySelector(sel);
let me;
let buses = [];

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function showError(text) {
  const el = $('#error');
  el.textContent = text;
  el.hidden = !text;
  if (text) el.scrollIntoView({ block: 'center' });
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error('O Copiloto não está ligado. Dê dois cliques em “Abrir Copiloto” na área de trabalho e tente de novo.');
  });
  if (res.status === 401) location.href = '/login.html';
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Erro.');
  return data;
}

function busLabel(b) {
  return b.id === 0 ? 'MASTER (salão)' : `${b.label} · ${b.name}`;
}

function busChecks(selected, disabled) {
  if (!buses.length) return '<span class="muted small">Conecte a mesa (ou o simulador) para listar as saídas.</span>';
  return buses
    .map(
      (b) => `<label class="bus-check ${b.id === 0 ? 'master' : ''}"><input type="checkbox" value="${b.id}" ${
        selected.includes(b.id) ? 'checked' : ''
      } ${disabled ? 'disabled' : ''}> ${escapeHtml(busLabel(b))}</label>`,
    )
    .join('');
}

function checked(root) {
  return [...root.querySelectorAll('input[type=checkbox]:checked')].map((i) => Number(i.value));
}

async function load() {
  const [{ users }, busData] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/buses')]);
  buses = busData.buses;
  $('#new-buses').innerHTML = busChecks([], false);
  $('#users').innerHTML = users
    .map(
      (u) => `<tr data-id="${u.id}">
        <td><strong>${escapeHtml(u.username)}</strong>${u.id === me.id ? ' <span class="muted">(você)</span>' : ''}</td>
        <td><select class="role" ${u.id === me.id ? 'disabled' : ''}>
          <option value="operador" ${u.role === 'operador' ? 'selected' : ''}>Operador</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select></td>
        <td class="bus-checks">${u.role === 'admin' ? '<span class="muted">todas (admin)</span>' : busChecks(u.buses, false)}</td>
        <td><input class="newpass" type="password" placeholder="(manter)" autocomplete="new-password"></td>
        <td class="actions-cell">
          <button class="save small-btn primary">Salvar</button>
          ${u.id === me.id ? '' : '<button class="del small-btn danger">Apagar</button>'}
        </td>
      </tr>`,
    )
    .join('');
}

$('#users').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const name = $('strong', tr).textContent;
  showError('');
  try {
    if (e.target.classList.contains('save')) {
      const body = { role: $('.role', tr).value };
      if (body.role === 'operador') body.buses = checked($('.bus-checks', tr));
      const pass = $('.newpass', tr).value;
      if (pass) body.password = pass;
      await api('PATCH', `/api/users/${id}`, body);
      await load();
    } else if (e.target.classList.contains('del')) {
      if (!confirm(`Apagar o usuário "${name}"?`)) return;
      await api('DELETE', `/api/users/${id}`);
      await load();
    }
  } catch (err) {
    showError(err.message);
  }
});

$('#users').addEventListener('change', (e) => {
  // trocou o papel: mostra/esconde as saídas (admin tem todas)
  if (e.target.classList.contains('role')) {
    const td = $('.bus-checks', e.target.closest('tr'));
    td.innerHTML = e.target.value === 'admin' ? '<span class="muted">todas (admin)</span>' : busChecks([], false);
  }
});

$('#new-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const f = e.target;
  try {
    await api('POST', '/api/users', {
      username: f.username.value.trim(),
      password: f.password.value,
      role: f.role.value,
      buses: checked($('#new-buses')),
    });
    f.reset();
    await load();
  } catch (err) {
    showError(err.message);
  }
});

$('#my-pass').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  $('#pass-ok').hidden = true;
  try {
    await api('POST', '/api/me/password', { current: e.target.current.value, password: e.target.password.value });
    e.target.reset();
    $('#pass-ok').hidden = false;
  } catch (err) {
    showError(err.message);
  }
});

(async () => {
  const data = await api('GET', '/api/me');
  me = data.user;
  if (!me) return (location.href = '/login.html');
  $('#me').textContent = `${me.username} (${me.role})`;
  if (me.role !== 'admin') {
    document.querySelectorAll('section.card').forEach((s, i) => (s.hidden = i < 2));
    return;
  }
  await load();
})().catch((err) => showError(err.message));
