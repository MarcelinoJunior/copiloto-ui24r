import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Atualização a partir do GitHub (MarcelinoJunior/copiloto-ui24r, branch master).
 *
 * Dois jeitos de instalação:
 * - clonado com git (computador de quem desenvolve): `git fetch` + `git merge --ff-only`; nunca mexe
 *   se houver mudanças locais;
 * - instalado pelo Copiloto-Setup.exe (sem git): baixa o ZIP do commit novo, copia por cima e apaga
 *   o que saiu da versão nova, sem tocar em data/ (usuários, presets, senha da mesa), node/ e
 *   node_modules/. O commit instalado fica em versao.json.
 *
 * Se o package-lock.json mudar, as bibliotecas são reinstaladas (npm do próprio instalador).
 * Só confere sozinho; aplicar é sempre um clique do admin (nunca reinicia no meio do culto).
 */

export const REPO = 'MarcelinoJunior/copiloto-ui24r';
export const BRANCH = 'master';
const API_URL = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
const ZIP_URL = (sha: string) => `https://codeload.github.com/${REPO}/zip/${sha}`;
export const VERSION_FILE = 'versao.json';
/** nunca substituídos nem apagados pela atualização */
export const KEEP = new Set(['data', 'node', 'node_modules', VERSION_FILE, '.git', 'dist']);
const MAX_ZIP = 50 * 1024 * 1024;

export interface RemoteCommit {
  sha: string;
  message: string;
  date: string;
}

export interface UpdateStatus {
  mode: 'git' | 'zip';
  current?: string;
  latest?: RemoteCommit;
  available: boolean;
  checkedAt?: number;
  state: 'parado' | 'conferindo' | 'atualizando' | 'erro';
  detail?: string;
}

interface VersionFile {
  commit: string;
  date?: string;
  message?: string;
  /** arquivos instalados (para apagar o que saiu na versão seguinte) */
  files?: string[];
}

type Run = (cmd: string, args: string[], cwd: string) => Promise<string>;

const defaultRun: Run = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024, shell: cmd.endsWith('.cmd') }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').slice(-3).join(' '))) : resolve(stdout.toString().trim()),
    );
  });

export interface UpdaterOptions {
  fetchImpl?: typeof fetch;
  run?: Run;
  /** força o modo (testes) */
  mode?: 'git' | 'zip';
}

export class Updater {
  private st: UpdateStatus;
  private readonly fetchImpl: typeof fetch;
  private readonly run: Run;
  private applying = false;

  constructor(
    private readonly root: string,
    opts: UpdaterOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.run = opts.run ?? defaultRun;
    const mode = opts.mode ?? (existsSync(join(root, '.git')) ? 'git' : 'zip');
    this.st = { mode, available: false, state: 'parado' };
  }

  status(): UpdateStatus {
    return { ...this.st };
  }

  private async currentCommit(): Promise<string | undefined> {
    if (this.st.mode === 'git') return this.run('git', ['rev-parse', 'HEAD'], this.root).catch(() => undefined);
    return readVersion(this.root)?.commit;
  }

  /** Confere no GitHub se há versão nova. Falha de rede só adia (não é erro para o usuário). */
  async check(): Promise<UpdateStatus> {
    if (this.st.state === 'atualizando') return this.status();
    this.st.state = 'conferindo';
    try {
      const res = await this.fetchImpl(API_URL, { headers: { 'User-Agent': 'copiloto-ui24r', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
      const j = (await res.json()) as { sha: string; commit: { message: string; committer?: { date?: string }; author?: { date?: string } } };
      const latest: RemoteCommit = {
        sha: j.sha,
        message: (j.commit.message ?? '').split('\n')[0],
        date: j.commit.committer?.date ?? j.commit.author?.date ?? '',
      };
      const current = await this.currentCommit();
      let available = Boolean(current && current !== latest.sha);
      // no git: se a cópia local já contém esse commit (ou está à frente), não há o que atualizar
      if (available && this.st.mode === 'git') {
        const contains = await this.run('git', ['merge-base', '--is-ancestor', latest.sha, 'HEAD'], this.root).then(
          () => true,
          () => false,
        );
        available = !contains;
      }
      if (!current && this.st.mode === 'zip') available = true; // instalação sem versão conhecida
      this.st = { ...this.st, current, latest, available, checkedAt: Date.now(), state: 'parado', detail: undefined };
    } catch (err) {
      this.st = { ...this.st, checkedAt: Date.now(), state: 'parado', detail: `não consegui conferir agora (${msg(err)})` };
    }
    return this.status();
  }

  /** Aplica a versão nova. `step` recebe mensagens de progresso. Lança erro com a explicação. */
  async apply(step: (text: string) => void = () => undefined): Promise<RemoteCommit> {
    if (this.applying) throw new Error('Já está atualizando.');
    this.applying = true;
    try {
      const st = await this.check();
      this.st.state = 'atualizando';
      if (!st.latest) throw new Error(st.detail ?? 'Não consegui falar com o GitHub.');
      if (!st.available) throw new Error('Já está na versão mais nova.');
      const lockBefore = hashFile(join(this.root, 'package-lock.json'));
      if (this.st.mode === 'git') await this.applyGit(st.latest, step);
      else await this.applyZip(st.latest, step);
      if (hashFile(join(this.root, 'package-lock.json')) !== lockBefore) {
        step('Atualizando as bibliotecas (pode levar alguns minutos)…');
        await this.npmInstall();
      }
      this.st = { ...this.st, current: st.latest.sha, available: false, state: 'parado', detail: undefined };
      return st.latest;
    } catch (err) {
      this.st = { ...this.st, state: 'erro', detail: msg(err) };
      throw err;
    } finally {
      this.applying = false;
    }
  }

  private async applyGit(latest: RemoteCommit, step: (t: string) => void): Promise<void> {
    const dirty = await this.run('git', ['status', '--porcelain', '--untracked-files=no'], this.root);
    if (dirty) throw new Error('Há mudanças locais nos arquivos do programa: atualize pelo git manualmente.');
    step('Baixando a versão nova (git)…');
    await this.run('git', ['fetch', 'origin', BRANCH], this.root);
    await this.run('git', ['merge', '--ff-only', latest.sha], this.root);
  }

  private async applyZip(latest: RemoteCommit, step: (t: string) => void): Promise<void> {
    step('Baixando a versão nova…');
    const res = await this.fetchImpl(ZIP_URL(latest.sha), { headers: { 'User-Agent': 'copiloto-ui24r' } });
    if (!res.ok) throw new Error(`não consegui baixar (GitHub respondeu ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP) throw new Error('arquivo grande demais');
    const work = mkdtempSync(join(tmpdir(), 'copiloto-atualizacao-'));
    try {
      const zip = join(work, 'versao.zip');
      writeFileSync(zip, buf);
      const out = join(work, 'x');
      mkdirSync(out);
      await this.run(windowsTar(), ['-xf', zip, '-C', out], work); // o tar do Windows abre ZIP
      const top = readdirSync(out).find((n) => statSync(join(out, n)).isDirectory());
      if (!top) throw new Error('ZIP sem a pasta do programa');
      step('Instalando os arquivos…');
      const files = copyRelease(join(out, top), this.root);
      const before = readVersion(this.root);
      removeDropped(this.root, before?.files ?? [], files);
      writeVersion(this.root, { commit: latest.sha, date: latest.date, message: latest.message, files });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private async npmInstall(): Promise<void> {
    const bundled = join(this.root, 'node', 'npm.cmd');
    if (this.st.mode === 'zip' && existsSync(bundled)) await this.run(bundled, ['ci', '--omit=dev', '--no-audit', '--no-fund'], this.root);
    else await this.run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], this.root);
  }
}

/** Copia a versão nova por cima (menos KEEP). Devolve a lista de arquivos (caminhos relativos com /). */
export function copyRelease(src: string, dest: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(src, full);
      if (KEEP.has(rel.split(sep)[0])) continue;
      if (statSync(full).isDirectory()) walk(full);
      else {
        const target = join(dest, rel);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(full, target);
        files.push(rel.split(sep).join('/'));
      }
    }
  };
  walk(src);
  return files.sort();
}

/** Apaga arquivos da versão anterior que não existem mais na nova (nunca dentro de KEEP). */
export function removeDropped(root: string, before: string[], after: string[]): void {
  const keep = new Set(after);
  for (const rel of before) {
    if (keep.has(rel) || KEEP.has(rel.split('/')[0]) || rel.includes('..')) continue;
    const full = join(root, ...rel.split('/'));
    if (existsSync(full)) unlinkSync(full);
  }
}

export function readVersion(root: string): VersionFile | undefined {
  const p = join(root, VERSION_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as VersionFile;
  } catch {
    return undefined;
  }
}

export function writeVersion(root: string, v: VersionFile): void {
  writeFileSync(join(root, VERSION_FILE), JSON.stringify(v, null, 2));
}

/** O tar do próprio Windows (bsdtar, abre ZIP). O "tar" do Git, se vier antes no PATH, não abre. */
export function windowsTar(): string {
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(sys32) ? sys32 : 'tar';
}

function hashFile(p: string): string {
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : '';
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
