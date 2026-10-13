/**
 * Equalizador de canal da Ui24R: 4 bandas paramétricas + passa-altas (HPF) + bypass.
 *
 * A mesa guarda cada parâmetro como um número de 0 a 1 (ex.: "i.0.eq.b1.freq" = 0.42).
 * As faixas físicas são do manual da Ui24R: frequência 20 Hz–22 kHz, Q 0,05–15, ganho ±20 dB.
 *
 * ATENÇÃO: a fórmula exata de 0..1 → Hz/dB/Q não é documentada. Aqui usamos a suposição mais
 * comum (frequência e Q em escala logarítmica, ganho linear). Por isso a tela mostra "≈".
 * Para calibrar: `npm run diagnostico` mostra os valores brutos do EQ do canal 1; compare com
 * a interface web da mesa e ajuste as constantes abaixo (é o único lugar que precisa mudar).
 */

export const EQ_FREQ_MIN = 20;
export const EQ_FREQ_MAX = 22000;
export const EQ_Q_MIN = 0.05;
export const EQ_Q_MAX = 15;
export const EQ_GAIN_MAX = 20; // ±20 dB
export const HPF_FREQ_MIN = 20;
export const HPF_FREQ_MAX = 22000;

export const EQ_BANDS = ['b1', 'b2', 'b3', 'b4'] as const;
export type EqBand = (typeof EQ_BANDS)[number];
/** parâmetros que o painel pode mudar */
export type EqParam = `${EqBand}.freq` | `${EqBand}.gain` | `${EqBand}.q` | 'hpf.freq' | 'bypass';

export interface EqState {
  bypass: boolean;
  hpfHz: number;
  bands: { band: EqBand; freqHz: number; gainDB: number; q: number }[];
  /** valores brutos (0..1) como estão na mesa, para conferência/calibração */
  raw: Record<string, number>;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const logTo = (v: number, min: number, max: number) => min * Math.pow(max / min, clamp01(v));
const logFrom = (x: number, min: number, max: number) => clamp01(Math.log(x / min) / Math.log(max / min));

export function freqFromRaw(v: number): number {
  return logTo(v, EQ_FREQ_MIN, EQ_FREQ_MAX);
}
export function freqToRaw(hz: number): number {
  return logFrom(Math.max(EQ_FREQ_MIN, Math.min(EQ_FREQ_MAX, hz)), EQ_FREQ_MIN, EQ_FREQ_MAX);
}
export function gainFromRaw(v: number): number {
  return (clamp01(v) * 2 - 1) * EQ_GAIN_MAX;
}
export function gainToRaw(db: number): number {
  return clamp01((Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, db)) / EQ_GAIN_MAX + 1) / 2);
}
export function qFromRaw(v: number): number {
  return logTo(v, EQ_Q_MIN, EQ_Q_MAX);
}
export function qToRaw(q: number): number {
  return logFrom(Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, q)), EQ_Q_MIN, EQ_Q_MAX);
}
export function hpfFromRaw(v: number): number {
  return logTo(v, HPF_FREQ_MIN, HPF_FREQ_MAX);
}
export function hpfToRaw(hz: number): number {
  return logFrom(Math.max(HPF_FREQ_MIN, Math.min(HPF_FREQ_MAX, hz)), HPF_FREQ_MIN, HPF_FREQ_MAX);
}

/** Valores padrão (mesa "zerada") usados no simulador e quando a mesa ainda não informou. */
export const DEFAULT_EQ_RAW: Record<string, number> = {
  bypass: 0,
  'hpf.freq': 0,
  'b1.freq': freqToRaw(100),
  'b1.gain': 0.5,
  'b1.q': qToRaw(0.7),
  'b2.freq': freqToRaw(400),
  'b2.gain': 0.5,
  'b2.q': qToRaw(1),
  'b3.freq': freqToRaw(2500),
  'b3.gain': 0.5,
  'b3.q': qToRaw(1),
  'b4.freq': freqToRaw(8000),
  'b4.gain': 0.5,
  'b4.q': qToRaw(0.7),
};

export function eqFromRaw(raw: Record<string, number>): EqState {
  const r = { ...DEFAULT_EQ_RAW, ...raw };
  return {
    bypass: r.bypass >= 0.5,
    hpfHz: Math.round(hpfFromRaw(r['hpf.freq'])),
    bands: EQ_BANDS.map((band) => ({
      band,
      freqHz: Math.round(freqFromRaw(r[`${band}.freq`])),
      gainDB: Math.round(gainFromRaw(r[`${band}.gain`]) * 10) / 10,
      q: Math.round(qFromRaw(r[`${band}.q`]) * 100) / 100,
    })),
    raw: r,
  };
}

/** Converte um valor físico (Hz, dB, Q ou liga/desliga) para o 0..1 da mesa. */
export function eqParamToRaw(param: EqParam, value: number): number {
  if (param === 'bypass') return value ? 1 : 0;
  if (param === 'hpf.freq') return hpfToRaw(value);
  if (param.endsWith('.freq')) return freqToRaw(value);
  if (param.endsWith('.gain')) return gainToRaw(value);
  return qToRaw(value);
}

export function isEqParam(p: string): p is EqParam {
  return p === 'bypass' || p === 'hpf.freq' || /^b[1-4]\.(freq|gain|q)$/.test(p);
}

/**
 * Resposta aproximada da curva (dB) em uma frequência, para desenhar o gráfico:
 * soma de sinos (peaking) + um passa-altas de 2ª ordem. Só ilustrativa.
 */
export function eqResponseDb(eq: EqState, hz: number): number {
  if (eq.bypass) return 0;
  let db = 0;
  for (const b of eq.bands) {
    const bw = 1 / Math.max(0.05, b.q); // largura em oitavas ~ 1/Q
    const oct = Math.log2(hz / b.freqHz);
    db += b.gainDB * Math.exp(-0.5 * Math.pow(oct / (bw / 2), 2));
  }
  if (eq.hpfHz > HPF_FREQ_MIN + 1) {
    const ratio = hz / eq.hpfHz;
    db += 10 * Math.log10(Math.pow(ratio, 4) / (1 + Math.pow(ratio, 4)));
  }
  return db;
}
