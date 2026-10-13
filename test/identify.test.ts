import { describe, expect, it } from 'vitest';
import { eqAdvice } from '../src/analysis/eq-advice.js';
import { magnitudeSpectrumDb } from '../src/analysis/fft.js';
import { type SourceType, SourceIdentifier } from '../src/analysis/identify.js';
import { RTA_CENTERS, rtaBands } from '../src/analysis/rta.js';
import { eqFromRaw, eqParamToRaw, eqResponseDb, freqFromRaw, freqToRaw, gainFromRaw, gainToRaw } from '../src/mixer/eq.js';

const SR = 48000;
let seed = 7;
const noise = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
};

/** Gera 8 s de um tipo de som e devolve o que o identificador acha. */
function identifySignal(gen: (t: number) => number): SourceType {
  const id = new SourceIdentifier();
  const total = SR * 8;
  const buf = new Float64Array(total);
  for (let i = 0; i < total; i++) buf[i] = gen(i / SR);
  const block = SR / 20; // 50 ms
  let win = 0; // energia dos últimos 200 ms (como o motor faz)
  for (let b = 0; b * block < total; b++) {
    let ss = 0;
    for (let i = b * block; i < (b + 1) * block && i < total; i++) ss += buf[i] * buf[i];
    const rmsDb = 10 * Math.log10(ss / block + 1e-12);
    id.pushBlock(rmsDb);
    win += ss;
    if (b % 4 === 3) {
      const winDb = 10 * Math.log10(win / (block * 4) + 1e-12);
      win = 0;
      if (winDb > -55 && (b + 1) * block >= 4096) {
        id.pushSpectrum(magnitudeSpectrumDb(buf.subarray((b + 1) * block - 4096, (b + 1) * block)), SR, 4096);
      }
    }
  }
  return id.identify().type;
}

let lp = 0;
let hp = 0;
describe('identificação do som do canal', () => {
  it('bumbo: grave curto e batido', () => {
    expect(identifySignal((t) => { const ph = (t * 2) % 1; return 0.8 * Math.exp(-ph * 14) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-ph * 40)) * t); })).toBe('bumbo');
  });
  it('baixo: grave sustentado', () => {
    expect(identifySignal((t) => 0.4 * (Math.sin(2 * Math.PI * 55 * t) + 0.5 * Math.sin(2 * Math.PI * 110 * t) + 0.25 * Math.sin(2 * Math.PI * 165 * t)))).toBe('baixo');
  });
  it('pratos: agudo ruidoso', () => {
    expect(identifySignal((t) => { const n = noise(); const v = n - hp; hp = n; const ph = (t * 4) % 1; return 0.5 * v * Math.exp(-ph * 3); })).toBe('pratos');
  });
  it('caixa: ataque com ruído largo', () => {
    expect(identifySignal((t) => { const ph = (t * 2 + 0.5) % 1; return 0.6 * Math.exp(-ph * 16) * (noise() + 0.6 * Math.sin(2 * Math.PI * 200 * t)); })).toBe('caixa');
  });
  it('voz: médios com pausas de sílabas e frases', () => {
    expect(identifySignal((t) => {
      lp += 0.25 * (noise() - lp);
      const frase = (t % 3) < 2.2 ? 1 : 0; // pausa entre frases
      return frase * 1.2 * lp * Math.abs(Math.sin(2 * Math.PI * 4.5 * t));
    })).toBe('voz');
  });
  it('instrumento harmônico: acorde contínuo', () => {
    expect(identifySignal((t) => [220, 277, 330].reduce((s, f) => s + 0.15 * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t)), 0))).toBe('harmonico');
  });
});

describe('equalizador (escala e sugestões)', () => {
  it('converte ida e volta entre o 0..1 da mesa e Hz/dB', () => {
    expect(freqFromRaw(freqToRaw(1000))).toBeCloseTo(1000, 0);
    expect(gainFromRaw(gainToRaw(-6))).toBeCloseTo(-6, 5);
    expect(gainFromRaw(0.5)).toBe(0);
    expect(eqParamToRaw('bypass', 1)).toBe(1);
  });

  it('curva: banda de +6 dB em 1 kHz aparece no gráfico', () => {
    const eq = eqFromRaw({ 'b2.freq': freqToRaw(1000), 'b2.gain': gainToRaw(6) });
    expect(eqResponseDb(eq, 1000)).toBeCloseTo(6, 0);
    expect(Math.abs(eqResponseDb(eq, 50))).toBeLessThan(0.5);
  });

  it('voz com grave sobrando e embolada recebe passa-altas e corte em 300 Hz', () => {
    const bands = RTA_CENTERS.map((fc) => (fc < 80 ? -25 : fc >= 250 && fc <= 400 ? -14 : fc >= 500 && fc <= 2000 ? -20 : -30));
    const ids = eqAdvice('voz', bands, eqFromRaw({})).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['hpf', 'embolado']));
  });

  it('canal equilibrado não recebe sugestão', () => {
    const spec = magnitudeSpectrumDb(Float64Array.from({ length: 4096 }, () => 0.1 * noise()));
    const bands = rtaBands(spec, SR, 4096);
    // ruído branco tem mais energia nos agudos por banda; usamos uma curva plana "rosa" artificial
    const flat = bands.map(() => -30);
    expect(eqAdvice('harmonico', flat, eqFromRaw({ 'hpf.freq': 0.3 }))).toEqual([]);
  });
});

describe('tipo pelo nome do canal', () => {
  it('reconhece nomes comuns de igreja', async () => {
    const { typeFromName, isLeadVoiceName } = await import('../src/analysis/identify.js');
    expect(typeFromName('BUMBO')).toBe('bumbo');
    expect(typeFromName('Cx')).toBe('caixa');
    expect(typeFromName('OH L')).toBe('pratos');
    expect(typeFromName('Baixo')).toBe('baixo');
    expect(typeFromName('Violão')).toBe('harmonico');
    expect(typeFromName('Voz Pastor')).toBe('voz');
    expect(typeFromName('CH 9')).toBe('desconhecido');
    expect(isLeadVoiceName('Ministro')).toBe(true);
    expect(isLeadVoiceName('Back 2')).toBe(false);
  });
});
