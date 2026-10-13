import { describe, expect, it, vi } from 'vitest';
import { AnalysisEngine, DEFAULT_ADVANCED } from '../src/analysis/engine.js';
import { SimulatedAudio } from '../src/mixer/sim-audio.js';
import { SimulatorAdapter } from '../src/mixer/simulator.js';

describe('USB simulado + identificação do som', () => {
  it('reconhece bumbo, baixo, pratos e vozes da banda do simulador', async () => {
    // relógio falso: o simulador alterna frases/pausas pelo relógio; assim 30 s passam em poucos segundos
    let clock = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const sim = new SimulatorAdapter();
    await sim.connect();
    sim.setScene('louvor');
    const engine = new AnalysisEngine(structuredClone(DEFAULT_ADVANCED), 24);
    let t = 1_000_000;
    const audio = new SimulatedAudio(sim, 24, () => {}, (block, ch) => {
      t += 50;
      engine.feed(block, ch, t);
    });
    // ~30 s de áudio
    for (let i = 0; i < 600; i++) {
      clock += 50;
      (sim as unknown as { step: () => void }).step(); // níveis do simulador (VU)
      (audio as unknown as { step: () => void }).step();
    }
    const heard = engine.snapshot().identified;
    const names = sim.listChannels().reduce<Record<string, string>>((m, c) => ((m[c.name] = c.key), m), {});
    const type = (name: string) => heard[names[name]]?.type;
    await sim.disconnect();
    spy.mockRestore();
    expect(type('Bumbo')).toBe('bumbo');
    expect(type('Baixo')).toBe('baixo');
    expect(type('Caixa')).toBe('caixa');
    expect(type('Overhead')).toBe('pratos');
    expect(type('Ministro')).toBe('voz');
    expect(['harmonico', undefined]).toContain(type('Violão'));
  }, 30000);
});
