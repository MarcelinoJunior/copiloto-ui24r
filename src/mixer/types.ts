/**
 * Contrato entre o app e "uma mesa". Existem duas implementações:
 * - SoundcraftAdapter: a Ui24R de verdade, via soundcraft-ui-connection
 * - SimulatorAdapter: uma mesa falsa para testar sem estar na igreja
 */

/** i = entrada (mic/line), l = line in estéreo, p = player */
export type ChannelKind = 'i' | 'l' | 'p';

export interface ChannelInfo {
  /** Ex.: "i1", "l2", "p1" */
  key: string;
  kind: ChannelKind;
  number: number;
  name: string;
}

/** Leituras de VU de um canal, em dB (-80..0). */
export interface ChannelVu {
  /** antes do processamento (EQ/dinâmica) */
  pre: number;
  /** depois do processamento, antes do fader */
  post: number;
  /** depois do fader do master */
  postFader: number;
}

export interface VuFrame {
  t: number;
  channels: Map<string, ChannelVu>;
  /** nível de saída de cada aux (dB, pós-fader do aux) */
  auxOut: Map<number, number>;
}

/** Estado do envio de um canal para um aux. */
export interface SendInfo {
  /** nível do envio em dB (-Infinity quando todo para baixo) */
  db: number;
  muted: boolean;
  /** true = envio pós-fader, false = pré-fader */
  postFader: boolean;
  /** true = POST PROC (depois do EQ/dinâmica), false = PRE PROC */
  postProc: boolean;
}

export interface MixerInfo {
  kind: 'mesa' | 'simulador';
  address: string;
  model: string;
  firmware: string;
  auxCount: number;
}

export type ConnectionState = 'conectando' | 'conectado' | 'reconectando' | 'desconectado' | 'erro';

export interface MixerAdapter {
  connect(): Promise<MixerInfo>;
  disconnect(): Promise<void>;
  onStatus(cb: (state: ConnectionState, detail?: string) => void): void;
  listChannels(): ChannelInfo[];
  /** Avisa sempre que o nome de um canal muda (ou é recebido pela primeira vez). */
  onChannelName(cb: (key: string, name: string) => void): void;
  onVu(cb: (frame: VuFrame) => void): void;
  watchSend(aux: number, key: string, cb: (info: SendInfo) => void): void;
  setSendDB(aux: number, key: string, db: number): void;
  auxName(aux: number): string;
}

export function channelKey(kind: ChannelKind, n: number): string {
  return `${kind}${n}`;
}

export function parseChannelKey(key: string): { kind: ChannelKind; number: number } {
  const kind = key[0] as ChannelKind;
  const number = Number(key.slice(1));
  if (!['i', 'l', 'p'].includes(kind) || !Number.isInteger(number)) {
    throw new Error(`Chave de canal inválida: ${key}`);
  }
  return { kind, number };
}

/** Qual leitura de VU representa o que chega no envio, conforme o modo do envio. */
export function tapForSend(vu: ChannelVu, send: SendInfo): number {
  if (send.postFader) return vu.postFader;
  return send.postProc ? vu.post : vu.pre;
}
