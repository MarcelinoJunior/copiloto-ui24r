import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/**
 * Integração com o OBS Studio pelo obs-websocket v5 (já vem no OBS 28 ou mais novo:
 * Ferramentas › Configurações do servidor WebSocket).
 *
 * O que fazemos:
 * - sabemos se a live está no ar;
 * - lemos o nível REAL de uma fonte de áudio do OBS (o que está indo para a transmissão,
 *   depois dos filtros/plugins do OBS) e se ela está mutada;
 * - listamos as fontes e os filtros, e ligamos/desligamos filtros (ex.: um compressor ou
 *   supressão de ruído RNNoise) — os plugins VST gratuitos rodam dentro do OBS.
 */

/** Autenticação do obs-websocket v5: base64(sha256(base64(sha256(senha+salt)) + challenge)). */
export function obsAuth(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

// bits de assinatura de eventos
const EV_INPUTS = 1 << 3;
const EV_FILTERS = 1 << 5;
const EV_OUTPUTS = 1 << 6;
const EV_INPUT_VOLUME_METERS = 1 << 16;

export interface ObsStatus {
  state: 'desligado' | 'conectando' | 'conectado' | 'erro';
  error?: string;
  streaming: boolean;
  recording: boolean;
  /** fonte de áudio acompanhada */
  input?: string;
  inputMuted?: boolean;
  /** nível da fonte (dBFS, maior canal) e pico */
  levelDb?: number;
  peakDb?: number;
  levelAt?: number;
  inputs: string[];
  filters: { name: string; enabled: boolean }[];
}

export interface ObsConfig {
  host: string;
  port: number;
  password?: string;
  input?: string;
}

type Pending = { resolve: (data: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

const mulToDb = (m: number) => (m > 0 ? Math.max(-100, 20 * Math.log10(m)) : -100);

export class ObsClient {
  private ws?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private retry?: NodeJS.Timeout;
  private wanted = false;
  private cfg?: ObsConfig;
  status: ObsStatus = { state: 'desligado', streaming: false, recording: false, inputs: [], filters: [] };

  /** Liga (ou reconfigura) a conexão; tenta de novo a cada 5 s se o OBS estiver fechado. */
  start(cfg: ObsConfig): void {
    this.stop();
    this.cfg = cfg;
    this.wanted = true;
    this.open();
  }

  stop(): void {
    this.wanted = false;
    clearTimeout(this.retry);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('desconectado'));
    }
    this.pending.clear();
    this.status = { state: 'desligado', streaming: false, recording: false, inputs: [], filters: [] };
  }

  private open(): void {
    if (!this.cfg || !this.wanted) return;
    const { host, port } = this.cfg;
    this.status = { ...this.status, state: 'conectando', error: undefined };
    const ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 4000 });
    this.ws = ws;
    ws.on('message', (raw) => this.onMessage(ws, String(raw)));
    ws.on('error', (err) => {
      this.status = { ...this.status, state: 'erro', error: friendlyError(err) };
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (code === 4009) this.status = { ...this.status, state: 'erro', error: 'senha do OBS incorreta' };
      else if (this.status.state === 'conectado') this.status = { ...this.status, state: 'erro', error: `OBS desconectou (${reason || code})` };
      if (this.wanted) this.retry = setTimeout(() => this.open(), 5000);
    });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let msg: { op: number; d: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.op === 0) {
      // Hello → Identify
      const auth = msg.d.authentication as { challenge: string; salt: string } | undefined;
      const d: Record<string, unknown> = {
        rpcVersion: 1,
        eventSubscriptions: EV_INPUTS | EV_FILTERS | EV_OUTPUTS | EV_INPUT_VOLUME_METERS,
      };
      if (auth) d.authentication = obsAuth(this.cfg?.password ?? '', auth.salt, auth.challenge);
      ws.send(JSON.stringify({ op: 1, d }));
    } else if (msg.op === 2) {
      this.status = { ...this.status, state: 'conectado', error: undefined };
      void this.refresh();
    } else if (msg.op === 7) {
      const id = String(msg.d.requestId);
      const p = this.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      const st = msg.d.requestStatus as { result: boolean; comment?: string };
      if (st?.result) p.resolve((msg.d.responseData as Record<string, unknown>) ?? {});
      else p.reject(new Error(st?.comment ?? 'pedido recusado pelo OBS'));
    } else if (msg.op === 5) {
      this.onEvent(String(msg.d.eventType), (msg.d.eventData as Record<string, unknown>) ?? {});
    }
  }

  private onEvent(type: string, data: Record<string, unknown>): void {
    if (type === 'StreamStateChanged') this.status.streaming = Boolean(data.outputActive);
    else if (type === 'RecordStateChanged') this.status.recording = Boolean(data.outputActive);
    else if (type === 'InputMuteStateChanged' && data.inputName === this.status.input) this.status.inputMuted = Boolean(data.inputMuted);
    else if (type === 'InputVolumeMeters') {
      const inputs = (data.inputs as { inputName: string; inputLevelsMul: number[][] }[]) ?? [];
      const mine = inputs.find((i) => i.inputName === this.status.input);
      if (mine?.inputLevelsMul?.length) {
        // [magnitude, pico, pico de entrada] por canal → usamos o maior canal
        this.status.levelDb = Math.max(...mine.inputLevelsMul.map((c) => mulToDb(c[0])));
        this.status.peakDb = Math.max(...mine.inputLevelsMul.map((c) => mulToDb(c[1])));
        this.status.levelAt = Date.now();
      }
    } else if (type === 'SourceFilterEnableStateChanged' && data.sourceName === this.status.input) {
      this.status.filters = this.status.filters.map((f) => (f.name === data.filterName ? { ...f, enabled: Boolean(data.filterEnabled) } : f));
    }
  }

  request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || this.status.state !== 'conectado') return Promise.reject(new Error('OBS não conectado'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('OBS não respondeu'));
      }, 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  /** Lê o estado da live, a lista de fontes e os filtros/mute da fonte escolhida. */
  async refresh(): Promise<void> {
    try {
      const stream = await this.request('GetStreamStatus');
      this.status.streaming = Boolean(stream.outputActive);
      const rec = await this.request('GetRecordStatus').catch(() => ({ outputActive: false }));
      this.status.recording = Boolean(rec.outputActive);
      const list = await this.request('GetInputList');
      this.status.inputs = ((list.inputs as { inputName: string }[]) ?? []).map((i) => i.inputName);
      this.status.input = this.cfg?.input && this.status.inputs.includes(this.cfg.input) ? this.cfg.input : undefined;
      if (this.status.input) {
        const mute = await this.request('GetInputMute', { inputName: this.status.input });
        this.status.inputMuted = Boolean(mute.inputMuted);
        const filters = await this.request('GetSourceFilterList', { sourceName: this.status.input });
        this.status.filters = ((filters.filters as { filterName: string; filterEnabled: boolean }[]) ?? []).map((f) => ({
          name: f.filterName,
          enabled: f.filterEnabled,
        }));
      } else {
        this.status.filters = [];
      }
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err);
    }
  }

  async setFilterEnabled(filter: string, enabled: boolean): Promise<void> {
    if (!this.status.input) throw new Error('Escolha a fonte de áudio do OBS primeiro.');
    await this.request('SetSourceFilterEnabled', { sourceName: this.status.input, filterName: filter, filterEnabled: enabled });
    this.status.filters = this.status.filters.map((f) => (f.name === filter ? { ...f, enabled } : f));
  }
}

function friendlyError(err: Error): string {
  const m = err.message;
  if (/ECONNREFUSED/.test(m)) return 'OBS fechado ou servidor WebSocket desligado (OBS › Ferramentas › Configurações do servidor WebSocket)';
  if (/ETIMEDOUT|timed out/i.test(m)) return 'OBS não respondeu (confira o IP/porta)';
  return m;
}
