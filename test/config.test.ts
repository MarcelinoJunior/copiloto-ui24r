import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('aceita arquivo com BOM (Bloco de Notas / PowerShell)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copiloto-cfg-'));
    const p = join(dir, 'config.json');
    writeFileSync(p, '\uFEFF{"server":{"port":8095},"streamAuxes":[5,6]}');
    const cfg = loadConfig(p);
    expect(cfg.server.port).toBe(8095);
    expect(cfg.streamAuxes).toEqual([5, 6]);
    rmSync(dir, { recursive: true, force: true });
  });
});
