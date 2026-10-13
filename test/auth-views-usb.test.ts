import { describe, expect, it } from 'vitest';
import { AuthError, AuthService, canUseBus } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { pcmBlockLevels, parseDshowDevices } from '../src/levels/usb-audio.js';
import { ViewStore } from '../src/views.js';

function setup() {
  const db = openDatabase(':memory:');
  return { db, auth: new AuthService(db), views: new ViewStore(db) };
}

describe('AuthService', () => {
  it('cria admin, faz login e lê a sessão', () => {
    const { auth } = setup();
    expect(auth.hasUsers()).toBe(false);
    auth.createUser({ username: 'marcelino', password: 'abc123', role: 'admin' });
    const { token, user } = auth.login('Marcelino', 'abc123');
    expect(user.role).toBe('admin');
    expect(auth.sessionUser(token)?.username).toBe('marcelino');
    auth.logout(token);
    expect(auth.sessionUser(token)).toBeUndefined();
  });

  it('exige senha de letras e números com 5+ caracteres', () => {
    const { auth } = setup();
    expect(() => auth.createUser({ username: 'joao', password: '1234', role: 'operador' })).toThrow(AuthError);
    expect(() => auth.createUser({ username: 'joao', password: 'abc 123', role: 'operador' })).toThrow(AuthError);
    expect(() => auth.createUser({ username: 'jo ao', password: 'abc123', role: 'operador' })).toThrow(AuthError);
    expect(auth.createUser({ username: 'joao', password: 'abc123', role: 'operador' }).username).toBe('joao');
  });

  it('senha errada não entra e bloqueia depois de 5 tentativas', () => {
    const { auth } = setup();
    auth.createUser({ username: 'ana', password: 'senha1', role: 'operador' });
    for (let i = 0; i < 5; i++) expect(() => auth.login('ana', 'errada1')).toThrow('incorretos');
    expect(() => auth.login('ana', 'senha1')).toThrow('Muitas tentativas');
  });

  it('operador só usa as saídas liberadas; admin usa todas', () => {
    const { auth } = setup();
    const admin = auth.createUser({ username: 'admin', password: 'admin123', role: 'admin' });
    const op = auth.createUser({ username: 'live', password: 'live123', role: 'operador', buses: [7] });
    expect(canUseBus(op, 7)).toBe(true);
    expect(canUseBus(op, 1)).toBe(false);
    expect(canUseBus(op, 0)).toBe(false);
    expect(canUseBus(admin, 0)).toBe(true);
    const updated = auth.updateUser(op.id, { buses: [1, 7, 99] });
    expect(updated.buses).toEqual([1, 7]);
  });

  it('não deixa ficar sem admin', () => {
    const { auth } = setup();
    const admin = auth.createUser({ username: 'admin', password: 'admin123', role: 'admin' });
    expect(() => auth.deleteUser(admin.id)).toThrow('último admin');
    expect(() => auth.updateUser(admin.id, { role: 'operador' })).toThrow('admin');
  });

  it('trocar a senha derruba as sessões antigas', () => {
    const { auth } = setup();
    const u = auth.createUser({ username: 'bia', password: 'senha1', role: 'operador' });
    const { token } = auth.login('bia', 'senha1');
    auth.updateUser(u.id, { password: 'senha2' });
    expect(auth.sessionUser(token)).toBeUndefined();
  });
});

describe('admin padrão', () => {
  it('cria admin/admin só na primeira vez e avisa que a senha é a padrão', () => {
    const { auth } = setup();
    expect(auth.ensureDefaultAdmin()).toBe(true);
    expect(auth.ensureDefaultAdmin()).toBe(false);
    const { user } = auth.login('admin', 'admin');
    expect(user.role).toBe('admin');
    expect(auth.usesDefaultPassword(user.id)).toBe(true);
    auth.updateUser(user.id, { password: 'nova123' });
    expect(auth.usesDefaultPassword(user.id)).toBe(false);
  });
});

describe('ViewStore', () => {
  it('lista os modos prontos e salva os do usuário', () => {
    const { auth, views } = setup();
    const u = auth.createUser({ username: 'ana', password: 'senha1', role: 'operador' });
    expect(views.list(u.id).filter((v) => v.builtin).length).toBeGreaterThan(0);
    const v = views.create(u.id, 'Banda', { faders: 12, channels: ['i1', 'i2', 'xx'], showFxReturns: false });
    expect(v.config).toMatchObject({ faders: 12, channels: ['i1', 'i2'], showFxReturns: false });
    const edited = views.update(u.id, v.id, 'Banda 2', { faders: 7 });
    expect(edited.name).toBe('Banda 2');
    expect(edited.config.faders).toBe(0); // valor fora da lista volta para "todos"
    views.delete(u.id, v.id);
    expect(views.list(u.id).some((x) => x.id === v.id)).toBe(false);
  });

  it('um usuário não mexe no modo do outro, e os prontos não mudam', () => {
    const { auth, views } = setup();
    const a = auth.createUser({ username: 'ana', password: 'senha1', role: 'operador' });
    const b = auth.createUser({ username: 'beto', password: 'senha1', role: 'operador' });
    const v = views.create(a.id, 'Meu', {});
    expect(() => views.update(b.id, v.id, 'Hack', {})).toThrow('não encontrado');
    expect(() => views.update(a.id, 'padrao', 'x', {})).toThrow('prontos');
  });
});

describe('áudio USB', () => {
  it('mede o pico de cada canal em PCM intercalado', () => {
    const channels = 3;
    const frames = 100;
    const buf = Buffer.alloc(frames * channels * 2);
    for (let f = 0; f < frames; f++) {
      buf.writeInt16LE(16384, (f * channels + 0) * 2); // canal 1: meia escala → -6 dB
      buf.writeInt16LE(0, (f * channels + 1) * 2); // canal 2: silêncio
      buf.writeInt16LE(-32767, (f * channels + 2) * 2); // canal 3: quase 0 dB
    }
    const [c1, c2, c3] = pcmBlockLevels(buf, channels);
    expect(c1).toBeCloseTo(-6, 0);
    expect(c2).toBe(-80);
    expect(c3).toBeCloseTo(0, 0);
  });

  it('lê a lista de dispositivos do ffmpeg', () => {
    const stderr = `[dshow @ 0x1] "Microfone (Realtek Audio)" (audio)
[dshow @ 0x1]   Alternative name "@device_cm_..."
[dshow @ 0x1] "Soundcraft Ui24R USB Audio" (audio)
[dshow @ 0x1] "Integrated Camera" (video)`;
    expect(parseDshowDevices(stderr)).toEqual(['Microfone (Realtek Audio)', 'Soundcraft Ui24R USB Audio']);
  });
});
