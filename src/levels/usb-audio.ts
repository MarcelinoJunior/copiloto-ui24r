import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { FLOOR_DB } from '../util/db.js';

/**
 * Medição de nível pela conexão FÍSICA (USB).
 *
 * A Ui24R é uma interface de áudio USB multicanal: com o driver da Soundcraft instalado,
 * o PC recebe o áudio de cada canal. Aqui medimos esse áudio direto (mais preciso que o VU da rede).
 *
 * Importante: pelo USB a mesa só manda ÁUDIO. Mexer em faders/envios continua sendo pela REDE.
 * Então "modo USB" = níveis pelo USB + controle pela rede.
 *
 * A captura usa o ffmpeg que vem JUNTO com o Copiloto (pacote ffmpeg-static, baixado no
 * `npm install`), lendo o dispositivo de áudio do Windows (DirectShow) em PCM e calculando o
 * nível de cada canal a cada 50 ms. Nada para instalar à parte.
 */

const run = promisify(execFile);

/** Caminho do ffmpeg embutido; se faltar (instalação incompleta), tenta o do sistema. */
export function ffmpegBinary(): string {
  try {
    const bundled = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // pacote ausente: cai para o ffmpeg do sistema
  }
  return 'ffmpeg';
}

export interface UsbDetection {
  platform: string;
  checkedAt: number;
  /** dispositivos que parecem ser da Soundcraft / Ui24R (driver instalado e mesa ligada no USB) */
  ui24Devices: { name: string; status: string; kind: string }[];
  /** dispositivos de áudio de captura que o ffmpeg enxerga (nome exato para usar) */
  captureDevices: string[];
  ffmpeg: { found: boolean; version?: string };
  notes: string[];
}

/** Procura a Ui24R no USB (Windows: PnP) e os dispositivos de captura. Não muda nada no sistema. */
export async function detectUsbAudio(): Promise<UsbDetection> {
  const out: UsbDetection = {
    platform: process.platform,
    checkedAt: Date.now(),
    ui24Devices: [],
    captureDevices: [],
    ffmpeg: { found: false },
    notes: [],
  };

  try {
    const { stdout, stderr } = await run(ffmpegBinary(), ['-hide_banner', '-version'], { timeout: 5000 });
    out.ffmpeg = { found: true, version: (stdout || stderr).split('\n')[0]?.trim() };
  } catch {
    out.notes.push('O ffmpeg que vem com o Copiloto não foi encontrado. Rode "npm install" de novo na pasta do Copiloto.');
  }

  if (process.platform === 'win32') {
    try {
      const ps =
        "Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -match 'Soundcraft|Ui24|Ui 24' } | " +
        'Select-Object FriendlyName, Status, Class | ConvertTo-Json -Compress';
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
      const parsed = stdout.trim() ? (JSON.parse(stdout) as unknown) : [];
      const list = (Array.isArray(parsed) ? parsed : [parsed]) as { FriendlyName?: string; Status?: string; Class?: string }[];
      out.ui24Devices = list
        .filter((d) => d?.FriendlyName)
        .map((d) => ({ name: d.FriendlyName!, status: d.Status ?? '?', kind: d.Class ?? '?' }));
    } catch {
      out.notes.push('Não consegui consultar os dispositivos do Windows (PowerShell).');
    }
    if (out.ui24Devices.length === 0) {
      out.notes.push(
        'Nenhuma Ui24R no USB. Ligue o cabo USB da mesa ao PC. Se ela não aparecer na lista de áudio, o Windows precisa ' +
          'do driver USB da Soundcraft (instalado uma vez no Windows; driver de hardware não dá para vir dentro do Copiloto).',
      );
    }
  } else {
    out.notes.push('Detecção automática do driver feita só no Windows. No Linux/macOS, escolha o dispositivo manualmente.');
  }

  if (out.ffmpeg.found && process.platform === 'win32') {
    out.captureDevices = await listDshowAudioDevices();
  }
  return out;
}

/** Lista os dispositivos de captura de áudio que o ffmpeg vê no Windows. */
export async function listDshowAudioDevices(): Promise<string[]> {
  // A lista vem no stderr. Conforme a versão, o ffmpeg termina com ou sem erro nesse comando: lemos nos dois casos.
  let text = '';
  try {
    const { stderr } = await run(ffmpegBinary(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      timeout: 10000,
    });
    text = String(stderr ?? '');
  } catch (err) {
    text = String((err as { stderr?: string }).stderr ?? '');
  }
  return parseDshowDevices(text);
}

export function parseDshowDevices(stderr: string): string[] {
  const devices: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\(audio\)/.exec(line);
    if (m) devices.push(m[1]);
  }
  return devices;
}

/**
 * Nível de cada canal num bloco de PCM 16 bits intercalado (canal 1, canal 2, ... canal N, canal 1, ...).
 * Retorna o pico em dBFS (-80..0), na mesma escala do VU da mesa.
 */
export function pcmBlockLevels(block: Buffer, channels: number): number[] {
  const peaks = new Array<number>(channels).fill(0);
  const frameBytes = channels * 2;
  const frames = Math.floor(block.length / frameBytes);
  for (let f = 0; f < frames; f++) {
    const base = f * frameBytes;
    for (let c = 0; c < channels; c++) {
      const v = Math.abs(block.readInt16LE(base + c * 2)) / 32768;
      if (v > peaks[c]) peaks[c] = v;
    }
  }
  return peaks.map((p) => (p <= 0 ? FLOOR_DB : Math.max(FLOOR_DB, 20 * Math.log10(p))));
}

export interface UsbCaptureOptions {
  device: string;
  channels: number;
  sampleRate?: number;
  blockMs?: number;
  /** troca a entrada do ffmpeg (usado nos testes, com um sinal gerado em vez do dispositivo USB) */
  inputArgs?: string[];
}

export type UsbCaptureState = 'parado' | 'iniciando' | 'capturando' | 'erro';

/** O que o app precisa de uma fonte de áudio (captura USB real ou o USB simulado). */
export interface AudioSource {
  state: UsbCaptureState;
  lastError?: string;
  lastLevelsAt?: number;
  start(): void;
  stop(): void;
}

/** Captura contínua via ffmpeg; chama `onLevels` a cada bloco com o nível (dB) de cada canal. */
export class UsbAudioCapture implements AudioSource {
  private proc?: ChildProcess;
  private pending = Buffer.alloc(0);
  state: UsbCaptureState = 'parado';
  lastError?: string;
  lastLevelsAt?: number;

  constructor(
    private readonly opts: UsbCaptureOptions,
    private readonly onLevels: (levels: number[]) => void,
    /** recebe também o bloco bruto (PCM 16 bits intercalado), para a análise avançada */
    private readonly onBlock?: (block: Buffer, channels: number) => void,
  ) {}

  start(): void {
    if (this.proc) return;
    const rate = this.opts.sampleRate ?? 48000;
    const blockBytes = Math.round((rate * (this.opts.blockMs ?? 50)) / 1000) * this.opts.channels * 2;
    this.state = 'iniciando';
    this.lastError = undefined;
    const input = this.opts.inputArgs ?? [
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-channels', String(this.opts.channels),
      '-sample_rate', String(rate),
      '-i', `audio=${this.opts.device}`,
    ];
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      ...input,
      '-ac', String(this.opts.channels),
      '-ar', String(rate),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-',
    ];
    const proc = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.state = 'capturando';
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= blockBytes) {
        const block = this.pending.subarray(0, blockBytes);
        this.pending = this.pending.subarray(blockBytes);
        this.lastLevelsAt = Date.now();
        this.onLevels(pcmBlockLevels(block, this.opts.channels));
        this.onBlock?.(Buffer.from(block), this.opts.channels);
      }
    });
    proc.on('error', (err) => {
      this.state = 'erro';
      this.lastError = err.message.includes('ENOENT') ? 'ffmpeg não encontrado (rode "npm install" de novo)' : err.message;
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this.state !== 'parado') {
        this.state = 'erro';
        this.lastError = this.lastError ?? (stderr.trim().split('\n').pop() || `ffmpeg saiu (código ${code})`);
      }
    });
  }

  stop(): void {
    const proc = this.proc;
    this.state = 'parado';
    this.proc = undefined;
    proc?.kill();
  }
}
