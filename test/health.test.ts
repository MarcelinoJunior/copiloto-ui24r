import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ConnectionHealth, isValidHost, tcpPing } from '../src/health.js';

describe('isValidHost', () => {
  it('aceita IPs e nomes válidos', () => {
    expect(isValidHost('192.168.0.122')).toBe(true);
    expect(isValidHost('10.10.1.1')).toBe(true);
    expect(isValidHost('ui24r.local')).toBe(true);
  });
  it('recusa lixo', () => {
    expect(isValidHost('192.168.0.300')).toBe(false);
    expect(isValidHost('http://192.168.0.1')).toBe(false);
    expect(isValidHost('')).toBe(false);
  });
});

describe('tcpPing', () => {
  it('mede o tempo de um servidor que responde', async () => {
    const server = createServer((s) => s.end()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const ms = await tcpPing('127.0.0.1', port);
    server.close();
    expect(ms).not.toBeNull();
    expect(ms!).toBeLessThan(500);
  });

  it('retorna null quando ninguém responde', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    server.close(); // porta fechada
    await new Promise((r) => setTimeout(r, 50));
    expect(await tcpPing('127.0.0.1', port, 500)).toBeNull();
  });
});

describe('ConnectionHealth', () => {
  it('sem conexão quando não conectado', () => {
    const h = new ConnectionHealth({ kind: 'mesa', ip: '10.99.99.99' }, async () => 1);
    expect(h.snapshot().quality).toBe('sem-conexao');
  });

  it('não fica ruim quando conectado e recebendo dados', () => {
    const h = new ConnectionHealth({ kind: 'mesa', ip: '10.99.99.99' }, async () => 1);
    h.onState('conectado');
    for (let i = 0; i < 10; i++) h.onVu();
    const s = h.snapshot();
    expect(['boa', 'instavel']).toContain(s.quality); // 'instavel' se o PC estiver em outra rede
    expect(s.vuPerSec).toBeGreaterThan(0);
  });

  it('ruim quando a mesa para de mandar dados', () => {
    const h = new ConnectionHealth({ kind: 'mesa', ip: '10.99.99.99' }, async () => 1);
    h.onState('conectado');
    expect(h.snapshot().quality).toBe('ruim'); // nenhum dado ainda
  });

  it('conta reconexões', () => {
    const h = new ConnectionHealth({ kind: 'mesa', ip: '10.99.99.99' }, async () => 1);
    h.onState('conectado');
    h.onState('reconectando');
    h.onState('conectado');
    expect(h.snapshot().reconnects).toBe(1);
  });
});

describe('ConnectionHealth no simulador', () => {
  it('nunca finge que é uma conexão real', () => {
    const h = new ConnectionHealth({ kind: 'simulador', ip: '192.168.0.122' });
    h.onState('conectado');
    h.onVu();
    const s = h.snapshot();
    expect(s.quality).toBe('simulador');
    expect(s.lastDataAgeMs).toBeUndefined();
    expect(s.ping.samples).toHaveLength(0);
  });
});
