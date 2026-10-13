import { combineLatest, firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  ConnectionStatus,
  SoundcraftUI,
  vuValueToDB,
  type AuxChannel,
  type InputChannelVuData,
} from 'soundcraft-ui-connection';
import {
  type ChannelInfo,
  type ChannelKind,
  type ChannelVu,
  type ConnectionState,
  type MixerAdapter,
  type MixerInfo,
  type SendInfo,
  type VuFrame,
  channelKey,
  parseChannelKey,
} from './types.js';

/** Quantidades usadas se a mesa não informar o modelo a tempo (valores da Ui24R). */
const UI24_FALLBACK = { model: 'ui24', input: 24, line: 2, player: 2, aux: 10, fx: 4 };

const STATUS_MAP: Record<ConnectionStatus, ConnectionState> = {
  [ConnectionStatus.Opening]: 'conectando',
  [ConnectionStatus.Open]: 'conectado',
  [ConnectionStatus.Close]: 'desconectado',
  [ConnectionStatus.Closing]: 'desconectado',
  [ConnectionStatus.Error]: 'erro',
  [ConnectionStatus.Reconnecting]: 'reconectando',
};

export class SoundcraftAdapter implements MixerAdapter {
  private readonly ui: SoundcraftUI;
  private channels: ChannelInfo[] = [];
  private fxReturns: ChannelInfo[] = [];
  private readonly auxNames = new Map<number, string>();
  private statusCb?: (state: ConnectionState, detail?: string) => void;
  private nameCb?: (key: string, name: string) => void;

  constructor(private readonly ip: string) {
    this.ui = new SoundcraftUI(ip);
    this.ui.status$.subscribe((event) => {
      const detail = event.type === ConnectionStatus.Error ? String((event as { payload?: unknown }).payload ?? '') : undefined;
      this.statusCb?.(STATUS_MAP[event.type] ?? 'erro', detail);
    });
  }

  onStatus(cb: (state: ConnectionState, detail?: string) => void): void {
    this.statusCb = cb;
  }

  onChannelName(cb: (key: string, name: string) => void): void {
    this.nameCb = cb;
  }

  async connect(): Promise<MixerInfo> {
    await this.ui.connect();

    const caps = await firstValueFrom(this.ui.deviceInfo.capabilities$.pipe(timeout(5000))).catch(() => UI24_FALLBACK);
    const firmware = await firstValueFrom(this.ui.deviceInfo.firmware$.pipe(timeout(3000))).catch(() => '?');

    const kinds: [ChannelKind, number][] = [
      ['i', caps.input],
      ['l', caps.line],
      ['p', caps.player],
    ];
    this.channels = kinds.flatMap(([kind, count]) =>
      Array.from({ length: count }, (_, idx) => {
        const number = idx + 1;
        return { key: channelKey(kind, number), kind, number, name: defaultName(kind, number) };
      }),
    );

    this.fxReturns = Array.from({ length: caps.fx }, (_, idx) => ({
      key: channelKey('f', idx + 1),
      kind: 'f' as const,
      number: idx + 1,
      name: defaultName('f', idx + 1),
    }));

    for (const ch of [...this.channels, ...this.fxReturns]) {
      this.masterChannel(ch.kind, ch.number).name$.subscribe((name) => {
        if (!name) return;
        ch.name = name;
        this.nameCb?.(ch.key, name);
      });
    }
    for (let aux = 1; aux <= caps.aux; aux++) {
      this.ui.master.aux(aux).name$.subscribe((name) => this.auxNames.set(aux, name || `AUX ${aux}`));
    }

    return { kind: 'mesa', address: this.ip, model: caps.model, firmware, auxCount: caps.aux };
  }

  async disconnect(): Promise<void> {
    await this.ui.disconnect();
  }

  listChannels(): ChannelInfo[] {
    return this.channels;
  }

  listFxReturns(): ChannelInfo[] {
    return this.fxReturns;
  }

  auxName(aux: number): string {
    return this.auxNames.get(aux) ?? `AUX ${aux}`;
  }

  onVu(cb: (frame: VuFrame) => void): void {
    this.ui.vuProcessor.vuData$.subscribe((data) => {
      const channels = new Map<string, ChannelVu>();
      const add = (kind: ChannelKind, list: InputChannelVuData[]) =>
        list.forEach((vu, idx) => channels.set(channelKey(kind, idx + 1), toDbVu(vu)));
      add('i', data.input);
      add('l', data.line);
      add('p', data.player);
      // retornos de efeito são estéreo: usamos o maior dos dois lados
      data.fx.forEach((vu, idx) => {
        const post = vuValueToDB(Math.max(vu.vuPostL, vu.vuPostR));
        const postFader = vuValueToDB(Math.max(vu.vuPostFaderL, vu.vuPostFaderR));
        channels.set(channelKey('f', idx + 1), { pre: post, post, postFader });
      });

      const auxOut = new Map<number, number>();
      data.aux.forEach((vu, idx) => auxOut.set(idx + 1, vuValueToDB(vu.vuPostFader)));

      cb({ t: Date.now(), channels, auxOut });
    });
  }

  watchSend(aux: number, key: string, cb: (info: SendInfo) => void): void {
    const send = this.auxChannel(aux, key);
    combineLatest([send.faderLevelDB$, send.mute$, send.post$, send.postProc$]).subscribe(
      ([db, muted, postFader, postProc]) => cb({ db, muted, postFader, postProc }),
    );
  }

  setSendDB(aux: number, key: string, db: number): void {
    // Num aux em link estéreo, a biblioteca já replica o valor no aux vizinho.
    const send = this.auxChannel(aux, key);
    if (Number.isFinite(db)) send.setFaderLevelDB(db);
    else send.setFaderLevel(0); // -∞: fader todo para baixo
  }

  watchFxSend(fx: number, key: string, cb: (db: number) => void): void {
    const { kind, number } = parseChannelKey(key);
    const bus = this.ui.fx(fx);
    const send = kind === 'l' ? bus.line(number) : kind === 'p' ? bus.player(number) : bus.input(number);
    combineLatest([send.faderLevelDB$, send.mute$]).subscribe(([db, muted]) =>
      cb(muted ? Number.NEGATIVE_INFINITY : db),
    );
  }

  watchAuxMaster(aux: number, cb: (db: number) => void): void {
    this.ui.master.aux(aux).faderLevelDB$.subscribe(cb);
  }

  setAuxMasterDB(aux: number, db: number): void {
    const master = this.ui.master.aux(aux);
    if (Number.isFinite(db)) master.setFaderLevelDB(db);
    else master.setFaderLevel(0);
  }

  private auxChannel(aux: number, key: string): AuxChannel {
    const { kind, number } = parseChannelKey(key);
    const bus = this.ui.aux(aux);
    if (kind === 'l') return bus.line(number);
    if (kind === 'p') return bus.player(number);
    if (kind === 'f') return bus.fx(number);
    return bus.input(number);
  }

  private masterChannel(kind: ChannelKind, number: number): { name$: Observable<string> } {
    if (kind === 'l') return this.ui.master.line(number);
    if (kind === 'p') return this.ui.master.player(number);
    if (kind === 'f') return this.ui.master.fx(number);
    return this.ui.master.input(number);
  }
}

function toDbVu(vu: InputChannelVuData): ChannelVu {
  return { pre: vuValueToDB(vu.vuPre), post: vuValueToDB(vu.vuPost), postFader: vuValueToDB(vu.vuPostFader) };
}

function defaultName(kind: ChannelKind, n: number): string {
  if (kind === 'l') return `LINE ${n}`;
  if (kind === 'p') return `PLAYER ${n}`;
  if (kind === 'f') return `FX ${n}`;
  return `CH ${n}`;
}
