/**
 * Intensidade do ajuste automático de volume: o quanto o Copiloto se permite corrigir.
 *
 *   suave     = a configuração do config.json (o antigo "Ajustando"): corrige devagar e pouco
 *   moderado  = tolera menos erro, corrige mais rápido e vai mais longe
 *   agressivo = segura o equilíbrio bem de perto (vozes × banda × bateria), rápido
 *
 * Nunca passa do teto absoluto de envio (`maxSendDB`). Lógica pura (testada).
 */

import type { LevelerConfig } from '../config.js';

export type Intensity = 'suave' | 'moderado' | 'agressivo';

export const INTENSITIES: readonly Intensity[] = ['suave', 'moderado', 'agressivo'];

export const INTENSITY_LABEL: Record<Intensity, string> = {
  suave: 'Suave',
  moderado: 'Moderado',
  agressivo: 'Agressivo',
};

interface Scale {
  /** multiplica a tolerância em torno do volume ideal */
  deadband: number;
  /** multiplicam as velocidades de descer e de subir */
  cutRate: number;
  boostRate: number;
  /** somam ao quanto pode descer/subir em relação à mixagem do operador (dB) */
  maxCut: number;
  maxBoost: number;
  /** multiplica a pausa depois que o operador mexe */
  manualHold: number;
  /** voz sumida: dispara mais cedo (dB a menos), fica mais perto da voz mais alta, espera menos, pode subir mais */
  rescueBelow: number;
  rescueTo: number;
  rescueAfter: number;
  rescueMaxBoost: number;
}

const SCALES: Record<Exclude<Intensity, 'suave'>, Scale> = {
  moderado: { deadband: 0.75, cutRate: 1.5, boostRate: 2, maxCut: 3, maxBoost: 2, manualHold: 0.67, rescueBelow: 2, rescueTo: 2, rescueAfter: 0.6, rescueMaxBoost: 3 },
  agressivo: { deadband: 0.5, cutRate: 2.5, boostRate: 3.5, maxCut: 6, maxBoost: 5, manualHold: 0.4, rescueBelow: 4, rescueTo: 3, rescueAfter: 0.4, rescueMaxBoost: 5 },
};

const r1 = (v: number) => Math.round(v * 10) / 10;

export function isIntensity(v: unknown): v is Intensity {
  return typeof v === 'string' && (INTENSITIES as readonly string[]).includes(v);
}

/** Configuração do nivelador para a intensidade escolhida, a partir da configuração base (= suave). */
export function intensityConfig(base: LevelerConfig, level: Intensity): LevelerConfig {
  if (level === 'suave') return { ...base };
  const s = SCALES[level];
  return {
    ...base,
    deadbandDB: r1(base.deadbandDB * s.deadband),
    cutRateDBps: r1(base.cutRateDBps * s.cutRate),
    boostRateDBps: r1(base.boostRateDBps * s.boostRate),
    maxCutDB: base.maxCutDB + s.maxCut,
    maxBoostDB: base.maxBoostDB + s.maxBoost,
    manualHoldSec: Math.round(base.manualHoldSec * s.manualHold),
    rescueBelowDB: Math.max(4, base.rescueBelowDB - s.rescueBelow),
    rescueToDB: Math.max(2, base.rescueToDB - s.rescueTo),
    rescueAfterSec: Math.max(2, Math.round(base.rescueAfterSec * s.rescueAfter)),
    rescueMaxBoostDB: base.rescueMaxBoostDB + s.rescueMaxBoost,
  };
}
