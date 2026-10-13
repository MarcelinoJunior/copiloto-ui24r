import type { AnalysisSnapshot } from './analysis/engine.js';
import type { ChannelSnapshot, Mode } from './leveler/aux-leveler.js';
import type { ObsStatus } from './obs.js';

/**
 * Dicas para o operador, a partir do que o software está lendo.
 * Funciona sempre com o VU (clip, volume baixo, ruído constante, saída estourando, automático no
 * limite) e, no modo Áudio USB, acrescenta microfonia, zumbido, chiado, loudness da live e OBS.
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
  now: number;
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
          title: `${ch.name}: automático no limite em ${bus.label}`,
          detail: 'O canal precisaria de mais correção do que o permitido. Ajuste o ganho ou a mixagem base desse canal.',
          channel: ch.key,
          bus: bus.bus,
          action: 'canal',
        });
      } else if (ch.status === 'sem-alvo' && bus.mode === 'automatico' && ch.enabled && (ch.levelDB ?? -100) > -50) {
        tips.push({
          id: `notarget:${bus.bus}:${ch.key}`,
          severity: 'baixa',
          title: `${ch.name}: sem alvo`,
          detail: `O automático está ligado em ${bus.label}, mas este canal não tem alvo. Clique em "Gravar" (Alvo) com a mixagem boa.`,
          channel: ch.key,
          bus: bus.bus,
        });
      }
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
