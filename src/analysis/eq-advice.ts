import type { EqParam, EqState } from '../mixer/eq.js';
import type { SourceType } from './identify.js';
import { RTA_CENTERS } from './rta.js';

/**
 * Sugestões de equalização a partir do espectro médio do canal (modo Áudio USB) e do tipo de som.
 * Regras de bolso de técnico de som, aplicadas com cuidado (cortes pequenos, 2–4 dB).
 * Cada sugestão pode ser aplicada com um clique: vira mudanças nos parâmetros do EQ da mesa.
 */

export interface EqAdvice {
  id: string;
  text: string;
  /** mudanças a aplicar (valores físicos: Hz, dB, Q) */
  changes: { param: EqParam; value: number }[];
}

/** média em dB das bandas de 1/3 de oitava entre lo e hi Hz */
function avg(bands: number[], lo: number, hi: number): number {
  const vals = RTA_CENTERS.map((fc, i) => [fc, bands[i]] as const).filter(([fc]) => fc >= lo && fc <= hi).map(([, v]) => v);
  if (!vals.length) return -100;
  // média em potência
  const p = vals.reduce((s, v) => s + Math.pow(10, v / 10), 0) / vals.length;
  return 10 * Math.log10(p + 1e-20);
}

/** Parte da energia total (0..1) que está entre lo e hi Hz. */
function share(bands: number[], lo: number, hi: number): number {
  let part = 0;
  let total = 0;
  RTA_CENTERS.forEach((fc, i) => {
    const p = Math.pow(10, bands[i] / 10);
    total += p;
    if (fc >= lo && fc <= hi) part += p;
  });
  return total > 0 ? part / total : 0;
}

/** Banda livre do EQ (sem ganho) mais próxima da frequência pedida; senão a mais próxima. */
function pickBand(eq: EqState | undefined, hz: number): 'b1' | 'b2' | 'b3' | 'b4' {
  const bands = eq?.bands ?? [];
  const free = bands.filter((b) => Math.abs(b.gainDB) < 0.5);
  const pool = free.length ? free : bands;
  if (!pool.length) return hz < 200 ? 'b1' : hz < 1000 ? 'b2' : hz < 5000 ? 'b3' : 'b4';
  return pool.reduce((best, b) => (Math.abs(Math.log2(b.freqHz / hz)) < Math.abs(Math.log2(best.freqHz / hz)) ? b : best)).band;
}

function bell(eq: EqState | undefined, hz: number, gain: number, q: number): { param: EqParam; value: number }[] {
  const b = pickBand(eq, hz);
  return [
    { param: `${b}.freq`, value: hz },
    { param: `${b}.gain`, value: gain },
    { param: `${b}.q`, value: q },
  ];
}

export function eqAdvice(type: SourceType, bands: number[] | undefined, eq?: EqState): EqAdvice[] {
  if (!bands || bands.length !== RTA_CENTERS.length) return [];
  const out: EqAdvice[] = [];
  const mid = avg(bands, 500, 2000);
  const lowMid = avg(bands, 250, 400);
  const sub = avg(bands, 25, 80);
  const subShare = share(bands, 25, 80);
  const pres = avg(bands, 2500, 4000);
  const presWide = avg(bands, 2000, 5000);
  const hpfOn = (eq?.hpfHz ?? 20) > 30;

  // passa-altas desligado e algum grave abaixo de 80 Hz (> 0,5% da energia, ~−23 dB): ronco, vento, pancada no pedestal
  if ((type === 'voz' || type === 'harmonico' || type === 'caixa' || type === 'pratos') && !hpfOn && subShare > 0.005) {
    const hz = type === 'pratos' ? 150 : type === 'voz' ? 100 : 80;
    out.push({
      id: 'hpf',
      text: `Grave sobrando (abaixo de 80 Hz): ligue o passa-altas em ~${hz} Hz. Tira ronco de palco e deixa a mixagem mais limpa.`,
      changes: [{ param: 'hpf.freq', value: hz }],
    });
  }
  if (type !== 'bumbo' && type !== 'baixo' && lowMid > mid + 5) {
    out.push({
      id: 'embolado',
      text: `Som embolado (excesso em 250–400 Hz, ${Math.round(lowMid - mid)} dB acima dos médios): corte −3 dB em ~300 Hz.`,
      changes: bell(eq, 300, -3, 1.4),
    });
  }
  // pratos são agudos por natureza: não vale para eles
  if (type !== 'pratos' && pres > mid + 5) {
    out.push({
      id: 'agressivo',
      text: `Agudo agressivo (2,5–4 kHz ${Math.round(pres - mid)} dB acima dos médios): corte −2 dB em ~3,2 kHz.`,
      changes: bell(eq, 3200, -2, 2),
    });
  }
  if (type === 'voz' && presWide < mid - 12) {
    out.push({
      id: 'abafada',
      text: 'Voz abafada (pouca presença em 2–5 kHz): suba +2 dB em ~3,5 kHz para a fala ficar mais clara.',
      changes: bell(eq, 3500, 2, 1),
    });
  }
  if (type === 'bumbo' && avg(bands, 315, 630) > avg(bands, 50, 100) - 6) {
    out.push({
      id: 'papelao',
      text: 'Bumbo com som de "papelão" (300–600 Hz): corte −4 dB em ~400 Hz.',
      changes: bell(eq, 400, -4, 1.5),
    });
  }
  if (type === 'baixo' && !hpfOn && sub > avg(bands, 80, 250) + 3) {
    out.push({
      id: 'rumble',
      text: 'Baixo com ronco abaixo de 40 Hz: passa-altas em ~35 Hz deixa o grave mais firme.',
      changes: [{ param: 'hpf.freq', value: 35 }],
    });
  }
  return out;
}
