import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { ConnectionState } from './mixer/types.js';

/**
 * Saúde da conexão com a mesa, para a tela "Conexão".
 *
 * - Tempo de resposta: abre uma conexão TCP na porta 80 da mesa (a da interface web)
 *   a cada 2 s e mede quanto demora. É o tempo de ida e volta na rede (Wi-Fi).
 * - Último dado: há quanto tempo chegou qualquer mensagem da mesa. Se passar de 1-2 s,
 *   o software está "cego" (sem VU) mesmo que a conexão pareça aberta.
 * - Mensagens/s e VU/s: fluxo de dados vindo da mesa.
 */

export type Quality = 'boa' | 'instavel' | 'ruim' | 'sem-conexao' | 'simulador';

export interface PingSample {
  t: number;
  /** null = sem resposta */
  ms: number | null;
}

export interface HealthSnapshot {
  target: { kind: 'mesa' | 'simulador'; ip: string };
  state: ConnectionState;
  detail?: string;
  connectedSince?: number;
  reconnects: number;
  lastDataAgeMs?: number;
  msgPerSec: number;
  vuPerSec: number;
  ping: { lastMs?: number | null; avgMs?: number; minMs?: number; maxMs?: number; lossPct: number; samples: PingSample[] };
  quality: Quality;
  reasons: string[];
  pc: { iface: string; address: string; sameSubnet: boolean }[];
  history: { t: number; text: string }[];
  lastTest?: { ip: string; t: number; results: (number | null)[]; ok: boolean };
}

const PING_EVERY_MS = 2000;
const PING_TIMEOUT_MS = 1500;
const PING_KEEP = 60; // 2 minutos
const RATE_WINDOW_MS = 5000;
const HISTORY_KEEP = 40;

/** Mede o tempo para abrir uma conexão TCP (ida e volta na rede). */
export function tcpPing(host: string, port = 80, timeoutMs = PING_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = connect({ host, port });
    const done = (value: number | null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once('connect', () => done(Math.round((performance.now() - start) * 10) / 10));
    socket.once('error', () => done(null));
  });
}

export function isValidHost(value: string): boolean {
  const v = value.trim();
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const hostname = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  // só números e pontos: tem que ser um IPv4 válido (evita aceitar 192.168.0.300 como "nome")
  if (/^[\d.]+$/.test(v)) return ipv4.test(v);
  return hostname.test(v);
}

export class ConnectionHealth {
  private state: ConnectionState = 'conectando';
  private detail?: string;
  private connectedSince?: number;
  private reconnects = 0;
  private everConnected = false;
  private lastDataT?: number;
  private readonly msgTimes: number[] = [];
  private readonly vuTimes: number[] = [];
  private readonly samples: PingSample[] = [];
  private readonly history: { t: number; text: string }[] = [];
  private lastTest?: HealthSnapshot['lastTest'];
  private timer?: NodeJS.Timeout;
  private pinging = false;

  constructor(
    private target: { kind: 'mesa' | 'simulador'; ip: string },
    private readonly pinger: (ip: string) => Promise<number | null> = (ip) => tcpPing(ip),
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.pingOnce(), PING_EVERY_MS);
    void this.pingOnce();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Mudou o endereço da mesa: zera as medições. */
  setTarget(target: { kind: 'mesa' | 'simulador'; ip: string }): void {
    this.target = target;
    this.samples.length = 0;
    this.msgTimes.length = 0;
    this.vuTimes.length = 0;
    this.lastDataT = undefined;
    this.connectedSince = undefined;
    this.everConnected = false;
    this.reconnects = 0;
    this.note(target.kind === 'simulador' ? 'Fonte: SIMULADOR (mesa falsa)' : `Fonte: mesa real em ${target.ip}`);
  }

  onState(state: ConnectionState, detail?: string): void {
    if (state === this.state && detail === this.detail) return;
    const now = Date.now();
    if (state === 'conectado') {
      if (this.everConnected) this.reconnects++;
      this.everConnected = true;
      this.connectedSince = now;
    } else if (this.state === 'conectado') {
      this.connectedSince = undefined;
    }
    this.state = state;
    this.detail = detail;
    this.note(`${state}${detail ? `: ${detail}` : ''}`);
  }

  onMessage(): void {
    const now = Date.now();
    this.lastDataT = now;
    pushWindow(this.msgTimes, now);
  }

  onVu(): void {
    const now = Date.now();
    this.lastDataT = now;
    pushWindow(this.vuTimes, now);
  }

  /** Testa um endereço sem trocar a conexão atual (3 tentativas). */
  async test(ip: string): Promise<NonNullable<HealthSnapshot['lastTest']>> {
    const results: (number | null)[] = [];
    for (let i = 0; i < 3; i++) results.push(await this.pinger(ip));
    this.lastTest = { ip, t: Date.now(), results, ok: results.some((r) => r !== null) };
    this.note(`Teste de ${ip}: ${results.map((r) => (r === null ? 'sem resposta' : `${r} ms`)).join(', ')}`);
    return this.lastTest;
  }

  snapshot(): HealthSnapshot {
    const now = Date.now();
    const ok = this.samples.filter((s) => s.ms !== null).map((s) => s.ms as number);
    const recent = this.samples.slice(-30);
    const lossPct = recent.length ? Math.round((recent.filter((s) => s.ms === null).length / recent.length) * 100) : 0;
    const ping = {
      lastMs: this.samples.at(-1)?.ms,
      avgMs: ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : undefined,
      minMs: ok.length ? Math.min(...ok) : undefined,
      maxMs: ok.length ? Math.max(...ok) : undefined,
      lossPct,
      samples: this.samples,
    };
    const lastDataAgeMs =
      this.lastDataT === undefined || this.target.kind === 'simulador' ? undefined : now - this.lastDataT;
    const { quality, reasons } = this.assess(lastDataAgeMs, ping);

    return {
      target: this.target,
      state: this.state,
      detail: this.detail,
      connectedSince: this.connectedSince,
      reconnects: this.reconnects,
      lastDataAgeMs,
      msgPerSec: rate(this.msgTimes, now),
      vuPerSec: rate(this.vuTimes, now),
      ping,
      quality,
      reasons,
      pc: this.pcAddresses(),
      history: [...this.history].reverse(),
      lastTest: this.lastTest,
    };
  }

  private assess(
    age: number | undefined,
    ping: { avgMs?: number; maxMs?: number; lossPct: number },
  ): { quality: Quality; reasons: string[] } {
    if (this.target.kind === 'simulador') {
      return {
        quality: 'simulador',
        reasons: ['Modo SIMULADOR: os dados vêm de uma mesa falsa. Nenhuma Ui24R está conectada e nada é enviado para ela.'],
      };
    }
    if (this.state !== 'conectado') {
      return { quality: 'sem-conexao', reasons: [`Conexão: ${this.state}${this.detail ? ` (${this.detail})` : ''}`] };
    }
    const bad: string[] = [];
    const warn: string[] = [];
    if (age === undefined || age > 3000) bad.push('A mesa parou de mandar dados (VU) há mais de 3 s');
    else if (age > 1000) warn.push('Dados da mesa chegando com atraso (mais de 1 s)');
    if (ping.lossPct >= 20) bad.push(`Perda de ${ping.lossPct}% nos testes de rede`);
    else if (ping.lossPct > 0) warn.push(`Perda de ${ping.lossPct}% nos testes de rede`);
    if ((ping.avgMs ?? 0) > 200) bad.push(`Tempo de resposta médio alto (${ping.avgMs} ms)`);
    else if ((ping.avgMs ?? 0) > 60) warn.push(`Tempo de resposta médio de ${ping.avgMs} ms (Wi-Fi congestionado?)`);
    if ((ping.maxMs ?? 0) > 300) warn.push(`Picos de ${ping.maxMs} ms no tempo de resposta`);
    if (this.target.kind === 'mesa' && !this.pcAddresses().some((p) => p.sameSubnet)) {
      warn.push('Este PC não parece estar na mesma rede (sub-rede) da mesa');
    }
    if (bad.length) return { quality: 'ruim', reasons: [...bad, ...warn] };
    if (warn.length) return { quality: 'instavel', reasons: warn };
    return { quality: 'boa', reasons: ['Tudo certo'] };
  }

  private pcAddresses(): HealthSnapshot['pc'] {
    const out: HealthSnapshot['pc'] = [];
    const prefix = this.target.ip.split('.').slice(0, 3).join('.');
    for (const [iface, list] of Object.entries(networkInterfaces())) {
      for (const addr of list ?? []) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        out.push({ iface, address: addr.address, sameSubnet: addr.address.split('.').slice(0, 3).join('.') === prefix });
      }
    }
    return out;
  }

  private async pingOnce(): Promise<void> {
    // no simulador não há rede: não medimos nada (para não parecer uma conexão real)
    if (this.pinging || this.target.kind === 'simulador') return;
    this.pinging = true;
    try {
      const ms = await this.pinger(this.target.ip);
      this.samples.push({ t: Date.now(), ms });
      if (this.samples.length > PING_KEEP) this.samples.splice(0, this.samples.length - PING_KEEP);
    } finally {
      this.pinging = false;
    }
  }

  private note(text: string): void {
    this.history.push({ t: Date.now(), text });
    if (this.history.length > HISTORY_KEEP) this.history.splice(0, this.history.length - HISTORY_KEEP);
  }
}

function pushWindow(list: number[], now: number): void {
  list.push(now);
  while (list.length && now - list[0] > RATE_WINDOW_MS) list.shift();
}

function rate(list: number[], now: number): number {
  const recent = list.filter((t) => now - t <= RATE_WINDOW_MS).length;
  return Math.round((recent / (RATE_WINDOW_MS / 1000)) * 10) / 10;
}
