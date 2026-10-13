import type { AnalysisSnapshot } from './analysis/engine.js';
import type { EqAdvice } from './analysis/eq-advice.js';
import type { SourceType } from './analysis/identify.js';
import type { ChannelSnapshot, Mode } from './leveler/aux-leveler.js';
import type { ObsStatus } from './obs.js';

/**
 * Dicas para o operador, a partir do que o software está lendo.
 * Funciona sempre com o VU (clip, volume baixo, ruído constante, saída estourando, automático no
 * limite, equilíbrio de volumes entre os canais) e, no modo Áudio USB, acrescenta microfonia,
 * zumbido, chiado, sugestões de EQ, loudness da live e OBS.
 */

export type TipSeverity = 'alta' | 'media' | 'baixa';

export interface Tip {
  id: string;
  severity: TipSeverity;
  title: string;
  detail: string;
  channel?: string;
  bus?: number;
  /** o que o botão da dica abre: o painel do canal (e o ganho) */
  action?: 'canal';
}

/** Estatística de um canal nos últimos segundos (nível pré-processamento, depois do ganho). */
export class ChannelStats {
  private readonly samples: { t: number; db: number }[] = [];
  constructor(private readonly windowMs = 15000) {}

  push(db: number, t: number): void {
    this.samples.push({ t, db });
    while (this.samples.length && t - this.samples[0].t > this.windowMs) this.samples.shift();
  }

  summary(now: number): ChannelSummary {
    const recent = this.samples.filter((s) => now - s.t <= this.windowMs);
    const last10 = recent.filter((s) => now - s.t <= 10000);
    const active = recent.filter((s) => s.db > -50);
    const values = recent.map((s) => s.db);
    return {
      count: recent.length,
      clipHits: last10.filter((s) => s.db >= -1).length,
      activeShare: recent.length ? active.length / recent.length : 0,
      activeAvgDb: active.length ? active.reduce((a, s) => a + s.db, 0) / active.length : undefined,
      minDb: values.length ? Math.min(...values) : -100,
      maxDb: values.length ? Math.max(...values) : -100,
    };
  }
}

export interface ChannelSummary {
  count: number;
  clipHits: number;
  activeShare: number;
  activeAvgDb?: number;
  minDb: number;
  maxDb: number;
}

export interface TipInput {
  channels: { key: string; name: string; summary: ChannelSummary }[];
  bus?: { bus: number; label: string; mode: Mode; outDB?: number; channels: ChannelSnapshot[] };
  analysis?: AnalysisSnapshot;
  obs?: ObsStatus;
  /** tipo de som de cada canal (pelo áudio USB ou pelo nome) */
  types?: Record<string, SourceType>;
  /** canais que são a voz principal (pelo nome) */
  leadVoices?: Set<string>;
  /** sugestões de EQ por canal (modo Áudio USB) */
  eqAdvice?: { key: string; name: string; advice: EqAdvice[] }[];
  now: number;
}

/** Mediana de uma lista (não vazia). */
function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Equilíbrio entre os canais na saída vista, pelo VU: "quanto cada canal pesa" = nível médio
 * enquanto toca + envio. Compara com a mediana dos canais tocando e com o tipo de som:
 * a voz deve ficar acima da banda; um instrumento muito acima dos outros (ou sumido) vira dica.
 */
export function balanceTips(
  bus: NonNullable<TipInput['bus']>,
  types: Record<string, SourceType> = {},
  leadVoices: Set<string> = new Set(),
): Tip[] {
  const tips: Tip[] = [];
  const playing = bus.channels.filter(
    (c) => c.contributionDB !== undefined && !c.muted && !c.key.startsWith('f') && (c.levelDB ?? -100) > -50 && (c.rawDB ?? -100) > -60,
  );
  if (playing.length < 3) return tips;
  const contrib = (c: ChannelSnapshot) => c.contributionDB as number;
  const voices = playing.filter((c) => types[c.key] === 'voz');
  const instruments = playing.filter((c) => types[c.key] !== undefined && types[c.key] !== 'voz');
  const mid = median(playing.map(contrib));
  const fmt = (d: number) => `${Math.round(d)} dB`;

  for (const c of playing) {
    const diff = contrib(c) - mid;
    const isVoice = types[c.key] === 'voz';
    // a voz principal pode (e deve) ficar acima da média
    const loudLimit = isVoice ? 14 : 9;
    if (diff > loudLimit) {
      const lower = Math.round(diff - (isVoice ? 8 : 4));
      tips.push({
        id: `bal-alto:${bus.bus}:${c.key}`,
        severity: 'media',
        title: `${c.name}: muito acima dos outros em ${bus.label}`,
        detail: `Está ${fmt(diff)} acima da média dos canais tocando. Baixe o envio uns ${lower} dB (ou o ganho, se estiver clipando) para não esconder o resto.`,
        channel: c.key,
        bus: bus.bus,
        action: 'canal',
      });
    } else if (diff < -15 && types[c.key] !== 'pratos') {
      tips.push({
        id: `bal-baixo:${bus.bus}:${c.key}`,
        severity: 'baixa',
        title: `${c.name}: quase sumindo em ${bus.label}`,
        detail: `Está ${fmt(-diff)} abaixo da média dos canais tocando: na live quase não aparece. Se deveria ser ouvido, suba o envio uns ${Math.round(-diff - 10)} dB.`,
        channel: c.key,
        bus: bus.bus,
        action: 'canal',
      });
    }
  }

  if (voices.length && instruments.length >= 2) {
    const named = voices.filter((v) => leadVoices.has(v.key));
    const lead = (named.length ? named : voices).reduce((a, b) => (contrib(b) > contrib(a) ? b : a));
    const band = median(instruments.map(contrib));
    const gap = contrib(lead) - band;
    if (gap < 2) {
      tips.push({
        id: `bal-voz:${bus.bus}`,
        severity: 'media',
        title: `${lead.name}: voz encoberta pela banda em ${bus.label}`,
        detail: `A voz está ${gap >= 0 ? `só ${fmt(gap)} acima` : `${fmt(-gap)} abaixo`} da média dos instrumentos. Na live a voz costuma ficar 3 a 6 dB acima: suba a voz uns ${Math.round(4 - gap)} dB ou baixe a banda. Se o som estiver embolado, tire um pouco de 250–400 Hz dos instrumentos no EQ em vez de só subir volume.`,
        channel: lead.key,
        bus: bus.bus,
        action: 'canal',
      });
    }
  }
  return tips;
}

const ORDER: Record<TipSeverity, number> = { alta: 0, media: 1, baixa: 2 };

export function computeTips(input: TipInput): Tip[] {
  const tips: Tip[] = [];
  const { now } = input;

  for (const ch of input.channels) {
    const s = ch.summary;
    if (s.count < 20) continue; // pouco dado ainda (~1 s)
    if (s.clipHits >= 3) {
      tips.push({
        id: `clip:${ch.key}`,
        severity: 'alta',
        title: `${ch.name}: clipando`,
        detail: `O sinal bateu no máximo ${s.clipHits}× nos últimos 10 s. Baixe o ganho (pré) uns 3 a 6 dB.`,
        channel: ch.key,
        action: 'canal',
      });
    } else if (s.activeShare > 0.3 && s.activeAvgDb !== undefined && s.activeAvgDb < -40) {
      tips.push({
        id: `low:${ch.key}`,
        severity: 'media',
        title: `${ch.name}: volume baixo demais`,
        detail: `Tocando, mas com média de ${Math.round(s.activeAvgDb)} dB. Suba o ganho (pré) até a média ficar perto de -20 dB; assim o ruído não aparece quando o envio é aumentado.`,
        channel: ch.key,
        action: 'canal',
      });
    }
    if (s.activeShare < 0.05 && s.minDb > -68 && s.maxDb < -42 && s.maxDb - s.minDb < 8) {
      tips.push({
        id: `noise:${ch.key}`,
        severity: 'baixa',
        title: `${ch.name}: possível ruído ou microfone aberto sem uso`,
        detail: `Sinal constante entre ${Math.round(s.minDb)} e ${Math.round(s.maxDb)} dB sem ninguém tocando. Verifique cabo, ruído de fundo ou mute o canal enquanto não usa.`,
        channel: ch.key,
        action: 'canal',
      });
    }
  }

  const bus = input.bus;
  if (bus) {
    if (bus.outDB !== undefined && bus.outDB > -3) {
      tips.push({
        id: `out:${bus.bus}`,
        severity: 'alta',
        title: `${bus.label}: saída perto de clipar`,
        detail: `A saída está em ${bus.outDB.toFixed(1)} dB. Baixe o master da saída (fader no canto direito).`,
        bus: bus.bus,
      });
    }
    for (const ch of bus.channels) {
      if (ch.status === 'no-limite') {
        tips.push({
          id: `limit:${bus.bus}:${ch.key}`,
          severity: 'media',
          title: `${ch.name}: ajuste automático no limite em ${bus.label}`,
          detail: 'O canal precisaria de mais correção do que o permitido. Ajuste o ganho ou a mixagem base desse canal.',
          channel: ch.key,
          bus: bus.bus,
          action: 'canal',
        });
      } else if (ch.status === 'sem-alvo' && bus.mode === 'automatico' && ch.enabled && (ch.levelDB ?? -100) > -50) {
        tips.push({
          id: `notarget:${bus.bus}:${ch.key}`,
          severity: 'baixa',
          title: `${ch.name}: sem volume ideal`,
          detail: `O ajuste automático está ligado em ${bus.label}, mas este canal não tem volume ideal. Clique em "Gravar volumes atuais" com a mixagem boa.`,
          channel: ch.key,
          bus: bus.bus,
        });
      }
    }
    tips.push(...balanceTips(bus, input.types, input.leadVoices));
  }

  // EQ: uma dica por canal só quando são poucos; muitos canais viram uma dica só (não poluir a lista)
  const eqList = (input.eqAdvice ?? []).filter((e) => e.advice.length);
  if (eqList.length > 3) {
    tips.push({
      id: 'eq:varios',
      severity: 'baixa',
      title: `Sugestões de EQ em ${eqList.length} canais`,
      detail: `${eqList.map((e) => e.name).join(', ')}. Abra cada canal (clique no nome) para ver a curva, o espectro e aplicar com um clique.`,
    });
  } else {
    for (const e of eqList) {
      tips.push({
        id: `eq:${e.key}`,
        severity: 'baixa',
        title: `${e.name}: sugestão de EQ`,
        detail: `${e.advice.map((a) => a.text).join(' ')} Abra o canal para ver a curva e aplicar com um clique.`,
        channel: e.key,
        action: 'canal',
      });
    }
  }

  const a = input.analysis;
  if (a) {
    for (const f of a.feedback) {
      tips.push({
        id: `fb:${f.key}`,
        severity: 'alta',
        title: `${f.name}: MICROFONIA em ~${f.freqHz} Hz`,
        detail: `Tom puro ${f.rising ? 'crescendo' : 'sustentado'} há ${f.forSec} s (${f.levelDb} dB). Baixe o canal agora; depois corte ~${f.freqHz} Hz no EQ ou afaste o microfone da caixa.`,
        channel: f.key,
        action: 'canal',
      });
    }
    for (const h of a.hum) {
      tips.push({
        id: `hum:${h.key}`,
        severity: 'media',
        title: `${h.name}: zumbido de ${h.freqHz} Hz`,
        detail: `Zumbido da rede elétrica ${h.aboveDb} dB acima do fundo. Costuma ser cabo, DI ou aterramento; experimente o ground lift ou trocar o cabo.`,
        channel: h.key,
        action: 'canal',
      });
    }
    for (const h of a.hiss) {
      tips.push({
        id: `hiss:${h.key}`,
        severity: 'baixa',
        title: `${h.name}: chiado constante`,
        detail: `Ruído largo em ${h.levelDb} dB sem ninguém tocando. Ganho alto demais com o instrumento parado ou equipamento ruidoso; um gate ajuda.`,
        channel: h.key,
        action: 'canal',
      });
    }
    const l = a.loudness;
    if (l?.integrated !== undefined) {
      const diff = l.integrated - l.target;
      if (Math.abs(diff) >= 3) {
        tips.push({
          id: 'lufs',
          severity: 'media',
          title: `Live ${diff > 0 ? 'alta' : 'baixa'}: ${l.integrated.toFixed(1)} LUFS`,
          detail: `O alvo é ${l.target} LUFS. ${diff > 0 ? 'Baixe' : 'Suba'} uns ${Math.abs(diff).toFixed(0)} dB no master da live (ou no OBS).`,
        });
      }
    }
    if (l?.peakDb !== undefined && l.peakDb > -1) {
      tips.push({ id: 'lufs-peak', severity: 'alta', title: 'Live estourando', detail: `Pico de ${l.peakDb.toFixed(1)} dBFS na transmissão. Baixe o master da live ou use um limitador no OBS.` });
    }
  }

  const obs = input.obs;
  if (obs?.state === 'conectado' && obs.streaming && obs.input) {
    if (obs.inputMuted) {
      tips.push({ id: 'obs-mute', severity: 'alta', title: `OBS: "${obs.input}" está MUTADA com a live no ar`, detail: 'A transmissão está sem esse áudio. Desmute no OBS.' });
    } else if (obs.levelDb !== undefined && obs.levelAt && now - obs.levelAt < 3000 && obs.levelDb < -60) {
      tips.push({ id: 'obs-silent', severity: 'media', title: 'OBS: live quase sem som', detail: `A fonte "${obs.input}" está em ${obs.levelDb.toFixed(0)} dB. Confira se o áudio da mesa está chegando no OBS.` });
    }
    if (obs.peakDb !== undefined && obs.peakDb > -1) {
      tips.push({ id: 'obs-peak', severity: 'alta', title: 'OBS: áudio clipando', detail: `Pico de ${obs.peakDb.toFixed(1)} dB na fonte "${obs.input}". Baixe o ganho no OBS ou use um limitador.` });
    }
  }

  return tips.sort((x, y) => ORDER[x.severity] - ORDER[y.severity]);
}
