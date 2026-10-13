import { combineLatest, firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  ConnectionStatus,
  SoundcraftUI,
  vuValueToDB,
  type InputChannelVuData,
} from 'soundcraft-ui-connection';
import {
  type BusInfo,
  type ChannelInfo,
  type ChannelKind,
  type ChannelVu,
  type ConnectionState,
  type MixerAdapter,
  type MixerInfo,
  type SendInfo,
  type Unsubscribe,
  type VuFrame,
  MASTER_BUS,
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

/** O que todo "fader" da biblioteca tem em comum (canal no master, envio de aux, envio de FX...). */
interface Fader {
  faderLevelDB$: Observable<number>;
  mute$: Observable<boolean>;
  setFaderLevelDB(db: number): void;
  setFaderLevel(value: number): void;
}

export class SoundcraftAdapter implements MixerAdapter {
  private readonly ui: SoundcraftUI;
  private channels: ChannelInfo[] = [];
  private fxReturns: ChannelInfo[] = [];
  private buses: BusInfo[] = [];
  private statusCb?: (state: ConnectionState, detail?: string) => void;
  private nameCb?: (key: string, name: string) => void;

  constructor(private readonly ip: string) {
    this.ui = new SoundcraftUI(ip);
    this.ui.status$.subscribe((event) => {
      const detail = event.type === ConnectionStatus.Error ? errorText((event as { payload?: unknown }).payload) : undefined;
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

    this.buses = [{ id: MASTER_BUS, name: 'Master (salão)', isMatrix: false }];
    for (let aux = 1; aux <= caps.aux; aux++) {
      const bus: BusInfo = { id: aux, name: `AUX ${aux}`, isMatrix: false };
      this.buses.push(bus);
      this.ui.master.aux(aux).name$.subscribe((name) => (bus.name = name || `AUX ${aux}`));
      this.ui.aux(aux).isMatrix$.subscribe((m) => (bus.isMatrix = m));
    }
    // Link estéreo: a mesa guarda "a.<n-1>.stereoIndex" (0 = primeiro do par, 1 = segundo, -1 = mono).
    this.ui.store.state$.subscribe((state) => {
      for (const bus of this.buses) {
        if (bus.id === MASTER_BUS) continue;
        const idx = Number(state[`a.${bus.id - 1}.stereoIndex`] ?? -1);
        bus.linkedWith = idx === 0 ? bus.id + 1 : idx === 1 ? bus.id - 1 : undefined;
      }
    });

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

  listBuses(): BusInfo[] {
    return this.buses.map((b) => ({ ...b }));
  }

  busName(bus: number): string {
    return this.buses.find((b) => b.id === bus)?.name ?? (bus === MASTER_BUS ? 'Master' : `AUX ${bus}`);
  }

  onRawMessage(cb: () => void): void {
    this.ui.store.messages$.subscribe(() => cb());
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

      const busOut = new Map<number, number>();
      data.aux.forEach((vu, idx) => busOut.set(idx + 1, vuValueToDB(vu.vuPostFader)));
      if (data.master.length) busOut.set(MASTER_BUS, vuValueToDB(Math.max(...data.master.map((m) => m.vuPostFader))));

      cb({ t: Date.now(), channels, busOut });
    });
  }

  watchSend(bus: number, key: string, cb: (info: SendInfo) => void): Unsubscribe {
    const { kind, number } = parseChannelKey(key);
    if (bus === MASTER_BUS) {
      // No master, o "envio" é o próprio fader do canal: o VU antes dele é o pós-processamento.
      const fader = this.masterChannel(kind, number);
      const sub = combineLatest([fader.faderLevelDB$, fader.mute$]).subscribe(([db, muted]) =>
        cb({ db, muted, postFader: false, postProc: true }),
      );
      return () => sub.unsubscribe();
    }
    const send = this.auxChannel(bus, kind, number);
    const sub = combineLatest([send.faderLevelDB$, send.mute$, send.post$, send.postProc$]).subscribe(
      ([db, muted, postFader, postProc]) => cb({ db, muted, postFader, postProc }),
    );
    return () => sub.unsubscribe();
  }

  setSendDB(bus: number, key: string, db: number): void {
    const { kind, number } = parseChannelKey(key);
    // Num aux em link estéreo, a biblioteca já replica o valor no aux par.
    setFader(bus === MASTER_BUS ? this.masterChannel(kind, number) : this.auxChannel(bus, kind, number), db);
  }

  watchFxSend(fx: number, key: string, cb: (db: number) => void): Unsubscribe {
    const send = this.fxChannel(fx, key);
    const sub = combineLatest([send.faderLevelDB$, send.mute$]).subscribe(([db, muted]) =>
      cb(muted ? Number.NEGATIVE_INFINITY : db),
    );
    return () => sub.unsubscribe();
  }

  setFxSendDB(fx: number, key: string, db: number): void {
    setFader(this.fxChannel(fx, key), db);
  }

  watchBusMaster(bus: number, cb: (db: number) => void): Unsubscribe {
    const fader = bus === MASTER_BUS ? this.ui.master : this.ui.master.aux(bus);
    const sub = fader.faderLevelDB$.subscribe(cb);
    return () => sub.unsubscribe();
  }

  setBusMasterDB(bus: number, db: number): void {
    const fader = bus === MASTER_BUS ? this.ui.master : this.ui.master.aux(bus);
    if (Number.isFinite(db)) fader.setFaderLevelDB(db);
    else fader.setFaderLevel(0);
  }

  private auxChannel(bus: number, kind: ChannelKind, number: number) {
    const aux = this.ui.aux(bus);
    if (kind === 'l') return aux.line(number);
    if (kind === 'p') return aux.player(number);
    if (kind === 'f') return aux.fx(number);
    return aux.input(number);
  }

  private fxChannel(fx: number, key: string) {
    const { kind, number } = parseChannelKey(key);
    const bus = this.ui.fx(fx);
    return kind === 'l' ? bus.line(number) : kind === 'p' ? bus.player(number) : bus.input(number);
  }

  private masterChannel(kind: ChannelKind, number: number): Fader & { name$: Observable<string> } {
    if (kind === 'l') return this.ui.master.line(number);
    if (kind === 'p') return this.ui.master.player(number);
    if (kind === 'f') return this.ui.master.fx(number);
    return this.ui.master.input(number);
  }
}

function setFader(fader: Pick<Fader, 'setFaderLevelDB' | 'setFaderLevel'>, db: number): void {
  if (Number.isFinite(db)) fader.setFaderLevelDB(db);
  else fader.setFaderLevel(0); // -∞: fader todo para baixo
}

/** O erro do WebSocket vem como um evento sem texto útil; extrai o que der. */
function errorText(payload: unknown): string {
  const p = payload as { message?: string; error?: { message?: string; code?: string } } | undefined;
  const msg = p?.error?.code ?? p?.error?.message ?? p?.message;
  return msg ? `falha no WebSocket (${msg})` : 'falha no WebSocket: a mesa não respondeu nesse endereço';
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
