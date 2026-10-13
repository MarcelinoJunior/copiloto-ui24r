/**
 * FFT radix-2 (iterativa, in-place) e espectro de magnitude em dBFS.
 * Sem dependências: rápida o bastante para analisar os canais ativos algumas vezes por segundo.
 */

const cache = new Map<number, { rev: Uint32Array; cos: Float64Array; sin: Float64Array; window: Float64Array; windowSum: number }>();

function tables(n: number) {
  let t = cache.get(n);
  if (t) return t;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`Tamanho de FFT precisa ser potência de 2 (recebi ${n})`);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  // janela de Hann
  const window = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    windowSum += window[i];
  }
  t = { rev, cos, sin, window, windowSum };
  cache.set(n, t);
  return t;
}

/** FFT complexa in-place. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * Espectro de magnitude (dBFS) de um bloco real com janela de Hann.
 * Uma senoide de amplitude A aparece com ~20·log10(A) no bin dela.
 * Retorna n/2 bins; o bin k corresponde a k·sampleRate/n Hz.
 */
export function magnitudeSpectrumDb(samples: Float32Array | Float64Array, floorDb = -140): Float64Array {
  const n = samples.length;
  const { window, windowSum } = tables(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * window[i];
  fft(re, im);
  const out = new Float64Array(n / 2);
  const scale = 2 / windowSum;
  for (let k = 0; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]) * scale;
    out[k] = mag > 0 ? Math.max(floorDb, 20 * Math.log10(mag)) : floorDb;
  }
  return out;
}

export function binFrequency(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

export function frequencyBin(freq: number, sampleRate: number, fftSize: number): number {
  return Math.round((freq * fftSize) / sampleRate);
}
