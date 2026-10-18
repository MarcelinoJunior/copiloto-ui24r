import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mode } from './leveler/aux-leveler.js';

export interface LevelerConfig {
  /** Intervalo entre decisões do controlador (ms). */
  tickMs: number;
  /** Abaixo deste nível (dB no VU) o canal é considerado em silêncio. */
  gateDB: number;
  /** Janela de média do nível de cada canal (s). */
  averagingSec: number;
  /** Tempo que um canal precisa estar tocando antes de ser corrigido (s). */
  minActiveSec: number;
  /** Tempo abaixo do gate até o canal ser considerado em silêncio (s). */
  releaseSec: number;
  /** Erro tolerado em torno do alvo antes de corrigir (dB). */
  deadbandDB: number;
  /** Velocidade máxima para ABAIXAR um envio (dB por segundo). */
  cutRateDBps: number;
  /** Velocidade máxima para SUBIR um envio (dB por segundo). */
  boostRateDBps: number;
  /** Quanto o software pode abaixar em relação à mixagem original (dB). */
  maxCutDB: number;
  /** Quanto o software pode subir em relação à mixagem original (dB). */
  maxBoostDB: number;
  /** Valor máximo absoluto de um envio (dB). */
  maxSendDB: number;
  /** Depois que o operador mexe num envio, o software deixa o canal em paz por este tempo (s). */
  manualHoldSec: number;
  /** Quando o operador mexe num envio, o alvo do canal acompanha a mudança. */
  learnFromOperator: boolean;
  /** "Efeito acompanha": velocidade máxima de ajuste do retorno do efeito (dB/s). */
  fxRateDBps: number;
  /** "Efeito acompanha": quanto o retorno pode descer/subir em relação à referência (dB). */
  fxMaxCutDB: number;
  fxMaxBoostDB: number;
  /** Duração do fade ao carregar um preset (s). */
  presetFadeSec: number;
}

export interface AppConfig {
  mixer: { ip: string };
  server: { host: string; port: number };
  streamAuxes: number[];
  /**
   * Saídas já testadas com o Copiloto (ex.: a live e um fone). As outras, o master e os
   * comandos que mexem no canal inteiro (EQ, ganho, phantom, efeitos) ficam travados com aviso
   * de risco até alguém liberar por 10 min. Sem esta opção, tudo fica liberado.
   */
  safeBuses?: number[];
  initialMode: Mode;
  leveler: LevelerConfig;
}

export const DEFAULT_LEVELER: LevelerConfig = {
  tickMs: 500,
  gateDB: -50,
  averagingSec: 4,
  minActiveSec: 2,
  releaseSec: 1.5,
  deadbandDB: 2,
  cutRateDBps: 1.0,
  boostRateDBps: 0.4,
  maxCutDB: 9,
  maxBoostDB: 4,
  maxSendDB: 6,
  manualHoldSec: 30,
  learnFromOperator: true,
  fxRateDBps: 3,
  fxMaxCutDB: 20,
  fxMaxBoostDB: 6,
  presetFadeSec: 3,
};

const MODES: Mode[] = ['desligado', 'observar', 'automatico'];

export function loadConfig(path = resolve('config/config.json')): AppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>;
  const config: AppConfig = {
    mixer: { ip: raw.mixer?.ip ?? '192.168.0.122' },
    server: { host: raw.server?.host ?? '127.0.0.1', port: raw.server?.port ?? 8080 },
    streamAuxes: raw.streamAuxes ?? [7],
    safeBuses: raw.safeBuses,
    initialMode: raw.initialMode ?? 'observar',
    leveler: { ...DEFAULT_LEVELER, ...raw.leveler },
  };

  if (!MODES.includes(config.initialMode)) {
    throw new Error(`initialMode inválido: "${config.initialMode}". Use: ${MODES.join(', ')}`);
  }
  if (config.streamAuxes.length === 0 || config.streamAuxes.some((a) => !Number.isInteger(a) || a < 1 || a > 10)) {
    throw new Error('streamAuxes precisa ter números de aux entre 1 e 10');
  }
  if (config.safeBuses && config.safeBuses.some((a) => !Number.isInteger(a) || a < 0 || a > 10)) {
    throw new Error('safeBuses precisa ter números de saída entre 0 (master) e 10');
  }
  return config;
}
