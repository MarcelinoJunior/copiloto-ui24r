import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMirror, type MixerMirror, saveMirror } from '../src/mixer/mirror.js';
import { SimulatorAdapter } from '../src/mixer/simulator.js';
import type { SendInfo } from '../src/mixer/types.js';

/** "Espelho" parecido com a mesa da igreja (nomes e saídas reais). */
const mirror: MixerMirror = {
  savedAt: 0,
  address: '192.168.0.122',
  firmware: '3.4.8318-ui24',
  channels: [
    { key: 'i1', name: 'VIOLAO' },
    { key: 'i3', name: 'MINISTRO' },
    { key: 'i17', name: 'BUMBO' },
    { key: 'i23', name: 'CH 23' },
  ],
  buses: [
    { id: 5, name: 'LIVE', linkedWith: 6, isMatrix: false },
    { id: 6, name: 'LIVE', linkedWith: 5, isMatrix: false },
    { id: 7, name: 'PA - TRAS', isMatrix: true },
    { id: 9, name: 'F. SAMUEL', isMatrix: false },
  ],
  sends: { '5': { i1: -17.7, i3: null }, '9': { i1: -7.9 } },
};

describe('simulador clonado da mesa real', () => {
  it('usa os nomes dos canais e das saídas, o link estéreo, as matrizes e os envios', () => {
    const sim = new SimulatorAdapter(mirror);
    const names = Object.fromEntries(sim.listChannels().map((c) => [c.key, c.name]));
    expect(names.i1).toBe('VIOLAO');
    expect(names.i17).toBe('BUMBO');
    expect(names.i2).toBe('CH 2'); // sem nome no espelho
    const buses = sim.listBuses();
    expect(buses.find((b) => b.id === 5)).toMatchObject({ name: 'LIVE', linkedWith: 6, isMatrix: false });
    expect(buses.find((b) => b.id === 7)?.isMatrix).toBe(true);
    expect(sim.busName(9)).toBe('F. SAMUEL');
    let live: SendInfo | undefined;
    let ministro: SendInfo | undefined;
    sim.watchSend(5, 'i1', (s) => (live = s));
    sim.watchSend(5, 'i3', (s) => (ministro = s));
    expect(live?.db).toBe(-17.7);
    expect(ministro?.db).toBe(Number.NEGATIVE_INFINITY);
    // tipo de som pelo nome: bumbo bate, CH 23 (sem uso) fica em silêncio
    const profile = Object.fromEntries(sim.audioProfile().map((p) => [p.name, p.behavior]));
    expect(profile.BUMBO).toBe('percussao');
    expect(profile.MINISTRO).toBe('canto');
  });

  it('grava e lê o espelho em data/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copiloto-espelho-'));
    const path = join(dir, 'mesa-espelho.json');
    expect(loadMirror(path)).toBeUndefined();
    saveMirror(path, mirror);
    expect(loadMirror(path)?.buses).toHaveLength(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it('sem espelho, o simulador continua com a banda de exemplo', () => {
    expect(new SimulatorAdapter().listChannels()[0].name).toBe('Pastor');
  });
});
