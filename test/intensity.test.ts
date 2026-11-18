import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELER } from '../src/config.js';
import { AuxLeveler } from '../src/leveler/aux-leveler.js';
import { intensityConfig, isIntensity } from '../src/leveler/intensity.js';

describe('intensidade do ajuste automático (suave, moderado, agressivo)', () => {
  const base = { ...DEFAULT_LEVELER };

  it('suave é a configuração do config.json; moderado e agressivo corrigem mais, mais rápido e mais cedo', () => {
    const s = intensityConfig(base, 'suave');
    const m = intensityConfig(base, 'moderado');
    const a = intensityConfig(base, 'agressivo');
    expect(s).toEqual(base);
    // tolera menos erro
    expect(m.deadbandDB).toBeLessThan(s.deadbandDB);
    expect(a.deadbandDB).toBeLessThan(m.deadbandDB);
    // corrige mais rápido e vai mais longe
    expect(a.cutRateDBps).toBeGreaterThan(m.cutRateDBps);
    expect(m.cutRateDBps).toBeGreaterThan(s.cutRateDBps);
    expect(a.boostRateDBps).toBeGreaterThan(m.boostRateDBps);
    expect(a.maxBoostDB).toBeGreaterThan(m.maxBoostDB);
    expect(a.maxCutDB).toBeGreaterThan(m.maxCutDB);
    // espera menos depois que o operador mexe; voz sumida dispara mais cedo
    expect(a.manualHoldSec).toBeLessThan(s.manualHoldSec);
    expect(a.rescueBelowDB).toBeLessThan(s.rescueBelowDB);
    expect(a.rescueAfterSec).toBeLessThan(s.rescueAfterSec);
    // o teto absoluto de envio nunca muda
    expect(a.maxSendDB).toBe(base.maxSendDB);
  });

  it('o nivelador troca de intensidade sem perder o tempo de análise escolhido', () => {
    const l = new AuxLeveler(5, base);
    l.setAveragingSec(20);
    l.setIntensity('agressivo');
    expect(l.intensity).toBe('agressivo');
    expect(l.averagingSec).toBe(20);
    expect(l.config.deadbandDB).toBe(intensityConfig(base, 'agressivo').deadbandDB);
    l.setIntensity('suave');
    expect(l.config.deadbandDB).toBe(base.deadbandDB);
  });

  it('só aceita os três nomes', () => {
    expect(isIntensity('moderado')).toBe(true);
    expect(isIntensity('observar')).toBe(false);
    expect(isIntensity(undefined)).toBe(false);
  });
});
