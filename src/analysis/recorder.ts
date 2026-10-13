import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gravação multipista: um arquivo WAV (16 bits, mono) por canal, direto do áudio USB.
 * Abre em qualquer editor de áudio (Reaper, Audacity…) para treinar a mixagem e ajustar o
 * automático durante a semana. ~2,8 MB por minuto por canal.
 */

function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // tamanho do bloco fmt
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9À-ÿ _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 30) || 'canal';
}

export interface RecordingInfo {
  dir: string;
  startedAt: number;
  channels: number;
  bytes: number;
}

export class MultitrackRecorder {
  private fds: number[] = [];
  private written: number[] = [];
  info?: RecordingInfo;

  constructor(private readonly sampleRate = 48000) {}

  get active(): boolean {
    return this.fds.length > 0;
  }

  start(baseDir: string, names: string[]): RecordingInfo {
    if (this.active) throw new Error('Já está gravando.');
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dir = join(baseDir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
    mkdirSync(dir, { recursive: true });
    this.fds = names.map((name, i) => {
      const fd = openSync(join(dir, `${String(i + 1).padStart(2, '0')}-${safeName(name)}.wav`), 'w+');
      writeSync(fd, wavHeader(0, this.sampleRate));
      return fd;
    });
    this.written = names.map(() => 0);
    this.info = { dir, startedAt: Date.now(), channels: names.length, bytes: 0 };
    return this.info;
  }

  /** Recebe um bloco PCM 16 bits intercalado e grava cada canal no seu arquivo. */
  write(block: Buffer, channels: number): void {
    if (!this.active) return;
    const frames = Math.floor(block.length / (channels * 2));
    const n = Math.min(channels, this.fds.length);
    for (let c = 0; c < n; c++) {
      const out = Buffer.allocUnsafe(frames * 2);
      for (let f = 0; f < frames; f++) out.writeInt16LE(block.readInt16LE((f * channels + c) * 2), f * 2);
      writeSync(this.fds[c], out);
      this.written[c] += out.length;
    }
    if (this.info) this.info.bytes = this.written.reduce((s, b) => s + b, 0);
  }

  /** Fecha os arquivos e corrige o cabeçalho (tamanho final). */
  stop(): RecordingInfo | undefined {
    if (!this.active) return undefined;
    this.fds.forEach((fd, i) => {
      writeSync(fd, wavHeader(this.written[i], this.sampleRate), 0, 44, 0);
      closeSync(fd);
    });
    this.fds = [];
    const info = this.info;
    this.info = undefined;
    return info;
  }
}
