/**
 * Contrato entre o app e "uma mesa". Existem duas implementações:
 * - SoundcraftAdapter: a Ui24R de verdade, via soundcraft-ui-connection
 * - SimulatorAdapter: uma mesa falsa para testar sem estar na igreja
 *
 * "Bus" é a saída que o software controla:
 * - MASTER_BUS (0): o master (som do salão). "Envio" = fader do canal no master.
 * - 1..10: os auxiliares. "Envio" = nível do canal mandado para aquele aux.
 */

export const MASTER_BUS = 0;

/** i = entrada (mic/line), l = line in estéreo, p = player, f = retorno de efeito (FX 1-4) */
export type ChannelKind = 'i' | 'l' | 'p' | 'f';

export type Unsubscribe = () => void;

export interface ChannelInfo {
  /** Ex.: "i1", "l2", "p1", "f3" */
  key: string;
  kind: ChannelKind;
  number: number;
  name: string;
}

export interface BusInfo {
  /** 0 = master, 1..10 = aux */
  id: number;
  name: string;
  /** aux em link estéreo com este (ex.: 7 ↔ 8) */
  linkedWith?: number;
  /** aux convertido em matriz (não dá para controlar como aux) */
  isMatrix: boolean;
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
  /** nível de saída de cada bus (dB, depois do fader master do bus); 0 = master */
  busOut: Map<number, number>;
}

/** Estado do "envio" de um canal para um bus. */
export interface SendInfo {
  /** nível em dB (-Infinity quando todo para baixo) */
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
  /** Canais de entrada (i, l, p). */
  listChannels(): ChannelInfo[];
  /** Retornos de efeito (f1..f4). */
  listFxReturns(): ChannelInfo[];
  /** Master + auxes, com nomes e link estéreo (valores atuais). */
  listBuses(): BusInfo[];
  /** Avisa sempre que o nome de um canal muda (ou é recebido pela primeira vez). */
  onChannelName(cb: (key: string, name: string) => void): void;
  /** VU de entradas e de retornos de efeito (chaves "f1".."f4"). */
  onVu(cb: (frame: VuFrame) => void): void;
  /** Qualquer mensagem recebida da mesa (para medir a saúde da conexão). */
  onRawMessage(cb: () => void): void;
  /** Envio de um canal (ou retorno de efeito, "fN") para um bus. No master, é o fader do canal. */
  watchSend(bus: number, key: string, cb: (info: SendInfo) => void): Unsubscribe;
  setSendDB(bus: number, key: string, db: number): void;
  /** Mute do envio para o bus (no master: mute do canal). */
  setSendMute(bus: number, key: string, muted: boolean): void;
  /** EQ do canal de entrada ("iN"): valores brutos 0..1 como a mesa guarda (ver mixer/eq.ts). */
  watchEq(key: string, cb: (raw: Record<string, number>) => void): Unsubscribe;
  setEqRaw(key: string, param: string, value: number): void;
  /** Envio de um canal para um efeito (quanto do canal entra no reverb/delay). Vale para salão E live. */
  watchFxSend(fx: number, key: string, cb: (db: number) => void): Unsubscribe;
  setFxSendDB(fx: number, key: string, db: number): void;
  /**
   * Pré-amplificador da entrada física (só canais "iN"): ganho de -6 a +57 dB e phantom 48V.
   * Vale para TUDO (salão, auxes e gravação). Considera patch 1:1 (entrada N = canal N).
   */
  watchPreamp(key: string, cb: (p: { gainDB: number; phantom: boolean }) => void): Unsubscribe;
  setGainDB(key: string, db: number): void;
  setPhantom(key: string, on: boolean): void;
  /** Fader master do bus (volume geral daquela saída). */
  watchBusMaster(bus: number, cb: (db: number) => void): Unsubscribe;
  setBusMasterDB(bus: number, db: number): void;
  busName(bus: number): string;
}

export function channelKey(kind: ChannelKind, n: number): string {
  return `${kind}${n}`;
}

export function parseChannelKey(key: string): { kind: ChannelKind; number: number } {
  const kind = key[0] as ChannelKind;
  const number = Number(key.slice(1));
  if (!['i', 'l', 'p', 'f'].includes(kind) || !Number.isInteger(number)) {
    throw new Error(`Chave de canal inválida: ${key}`);
  }
  return { kind, number };
}

/** Qual leitura de VU representa o que chega no envio, conforme o modo do envio. */
export function tapForSend(vu: ChannelVu, send: SendInfo): number {
  if (send.postFader) return vu.postFader;
  return send.postProc ? vu.post : vu.pre;
}

/** Num par estéreo, o bus "dono" é o de número menor (7 em 7+8). */
export function primaryBus(bus: BusInfo): number {
  return bus.linkedWith !== undefined ? Math.min(bus.id, bus.linkedWith) : bus.id;
}

export function busLabel(bus: BusInfo | undefined, id: number): string {
  if (id === MASTER_BUS) return 'MASTER';
  if (bus?.linkedWith !== undefined) {
    const [a, b] = [bus.id, bus.linkedWith].sort((x, y) => x - y);
    return `AUX ${a}+${b}`;
  }
  return `AUX ${id}`;
}
