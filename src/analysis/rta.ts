/**
 * Analisador de espectro (RTA) em bandas de 1/3 de oitava, de 25 Hz a 20 kHz.
 * É o gráfico de barras do painel do canal: mostra graves embolados, agudos estridentes etc.
 */

export const RTA_CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000,
  6300, 8000, 10000, 12500, 16000, 20000,
];

const EDGE = Math.pow(2, 1 / 6);

/** Converte um espectro (dB por bin) em nível por banda de 1/3 de oitava (dB, soma de potência). */
export function rtaBands(spectrumDb: Float64Array, sampleRate: number, fftSize: number, floorDb = -100): number[] {
  const binHz = sampleRate / fftSize;
  return RTA_CENTERS.map((fc) => {
    const lo = Math.max(1, Math.floor(fc / EDGE / binHz));
    const hi = Math.min(spectrumDb.length - 1, Math.ceil((fc * EDGE) / binHz));
    let pow = 0;
    for (let k = lo; k <= hi; k++) pow += Math.pow(10, spectrumDb[k] / 10);
    return pow > 0 ? Math.max(floorDb, 10 * Math.log10(pow)) : floorDb;
  });
}

/** Suaviza as bandas ao longo do tempo (sobe rápido, desce devagar), como num RTA de mesa. */
export function smoothBands(previous: number[] | undefined, next: number[], fallDbPerUpdate = 3): number[] {
  if (!previous) return next;
  return next.map((v, i) => (v >= previous[i] ? v : Math.max(v, previous[i] - fallDbPerUpdate)));
}
