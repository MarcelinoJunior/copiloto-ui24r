import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readVersion, Updater, windowsTar, writeVersion } from '../src/updater.js';

const NEW = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** ZIP igual ao do GitHub: uma pasta "copiloto-ui24r-<commit>" com os arquivos. */
function githubZip(files: Record<string, string>): Buffer {
  const src = tmp('copiloto-zip-src-');
  const top = `copiloto-ui24r-${NEW}`;
  for (const [rel, text] of Object.entries(files)) put(src, join(top, rel), text);
  const zip = join(src, 'r.zip');
  execFileSync(windowsTar(), ['-a', '-cf', zip, '-C', src, top]);
  return readFileSync(zip);
}

function fakeFetch(zip: Buffer): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('api.github.com')) {
      return new Response(JSON.stringify({ sha: NEW, commit: { message: 'Efeito acompanha a live\n\ndetalhes', committer: { date: '2026-11-15T12:00:00Z' } } }));
    }
    return new Response(new Uint8Array(zip));
  }) as typeof fetch;
}

describe('atualização pelo GitHub (instalado pelo Setup, sem git)', () => {
  it('confere: versão nova quando o commit do GitHub é outro', async () => {
    const root = tmp('copiloto-inst-');
    writeVersion(root, { commit: OLD });
    const up = new Updater(root, { mode: 'zip', fetchImpl: fakeFetch(Buffer.alloc(0)) });
    const st = await up.check();
    expect(st.available).toBe(true);
    expect(st.latest?.message).toBe('Efeito acompanha a live');
    expect(st.current).toBe(OLD);

    writeVersion(root, { commit: NEW });
    expect((await up.check()).available).toBe(false);
  });

  it('sem internet: só adia (não é erro)', async () => {
    const root = tmp('copiloto-inst-');
    writeVersion(root, { commit: OLD });
    const up = new Updater(root, { mode: 'zip', fetchImpl: (async () => Promise.reject(new Error('offline'))) as typeof fetch });
    const st = await up.check();
    expect(st.available).toBe(false);
    expect(st.state).toBe('parado');
    expect(st.detail).toContain('offline');
  });

  it('aplica: copia a versão nova, mantém data/ e node_modules/, apaga o que saiu e grava a versão', async () => {
    const root = tmp('copiloto-inst-');
    put(root, 'src/main.ts', 'versão velha');
    put(root, 'src/velho.ts', 'saiu na versão nova');
    put(root, 'package-lock.json', '{"lock":1}');
    put(root, 'data/conexao.json', '{"ip":"192.168.0.122"}');
    put(root, 'data/copiloto.db', 'usuarios');
    put(root, 'node_modules/tsx/x.js', 'lib');
    writeVersion(root, { commit: OLD, files: ['package-lock.json', 'src/main.ts', 'src/velho.ts'] });

    const zip = githubZip({
      'src/main.ts': 'versão nova',
      'src/fx-link.ts': 'novo',
      'package-lock.json': '{"lock":1}',
      'data/conexao.json': 'NÃO PODE SOBRESCREVER',
    });
    const steps: string[] = [];
    const up = new Updater(root, { mode: 'zip', fetchImpl: fakeFetch(zip) });
    const latest = await up.apply((t) => steps.push(t));

    expect(latest.sha).toBe(NEW);
    expect(readFileSync(join(root, 'src/main.ts'), 'utf8')).toBe('versão nova');
    expect(existsSync(join(root, 'src/fx-link.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/velho.ts'))).toBe(false); // saiu da versão nova
    expect(readFileSync(join(root, 'data/conexao.json'), 'utf8')).toBe('{"ip":"192.168.0.122"}'); // dados intactos
    expect(existsSync(join(root, 'data/copiloto.db'))).toBe(true);
    expect(existsSync(join(root, 'node_modules/tsx/x.js'))).toBe(true);
    expect(readVersion(root)?.commit).toBe(NEW);
    expect(readVersion(root)?.files).toContain('src/fx-link.ts');
    expect(up.status().available).toBe(false);
    expect(steps.some((s) => s.includes('Baixando'))).toBe(true);
  });

  it('git com mudanças locais: não mexe em nada', async () => {
    const root = tmp('copiloto-git-');
    const run = async (cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return OLD;
      if (args[0] === 'merge-base') throw new Error('não contém');
      if (args[0] === 'status') return ' M src/app.ts';
      throw new Error(`não devia rodar: ${cmd} ${args.join(' ')}`);
    };
    const up = new Updater(root, { mode: 'git', fetchImpl: fakeFetch(Buffer.alloc(0)), run });
    expect((await up.check()).available).toBe(true);
    await expect(up.apply()).rejects.toThrow(/mudanças locais/);
    expect(up.status().state).toBe('erro');
  });
});
