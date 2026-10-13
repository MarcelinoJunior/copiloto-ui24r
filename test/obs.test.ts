import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { obsAuth, ObsClient } from '../src/obs.js';

/** Um "OBS" de mentira que fala o protocolo obs-websocket v5. */
function fakeObs(password: string) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const salt = 'sal123';
  const challenge = 'desafio456';
  const filters = [{ filterName: 'Compressor', filterEnabled: true }];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt, challenge } } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === 1) {
        if (msg.d.authentication !== obsAuth(password, salt, challenge)) return ws.close(4009, 'auth');
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            op: 5,
            d: { eventType: 'InputVolumeMeters', eventData: { inputs: [{ inputName: 'Mesa', inputLevelsMul: [[0.1, 0.5, 0.5], [0.05, 0.2, 0.2]] }] } },
          }));
        }, 150);
      } else if (msg.op === 6) {
        const { requestType, requestId, requestData } = msg.d;
        const respond = (responseData: unknown) =>
          ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
        if (requestType === 'GetStreamStatus') respond({ outputActive: true });
        else if (requestType === 'GetRecordStatus') respond({ outputActive: false });
        else if (requestType === 'GetInputList') respond({ inputs: [{ inputName: 'Mesa' }, { inputName: 'Mic PC' }] });
        else if (requestType === 'GetInputMute') respond({ inputMuted: false });
        else if (requestType === 'GetSourceFilterList') respond({ filters });
        else if (requestType === 'SetSourceFilterEnabled') {
          filters[0].filterEnabled = requestData.filterEnabled;
          respond({});
        }
      }
    });
  });
  return { wss, port: () => (wss.address() as { port: number }).port };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});

describe('OBS (obs-websocket v5)', () => {
  it('autentica, lê a live, as fontes, o nível e liga/desliga filtro', async () => {
    const obs = fakeObs('senhaobs');
    await new Promise((r) => obs.wss.once('listening', r));
    const client = new ObsClient();
    cleanup.push(() => client.stop(), () => obs.wss.close());
    client.start({ host: '127.0.0.1', port: obs.port(), password: 'senhaobs', input: 'Mesa' });
    for (let i = 0; i < 40 && client.status.levelDb === undefined; i++) await wait(50);
    expect(client.status.state).toBe('conectado');
    expect(client.status.streaming).toBe(true);
    expect(client.status.inputs).toEqual(['Mesa', 'Mic PC']);
    expect(client.status.levelDb).toBeCloseTo(-20, 0); // 0,1 → -20 dB
    expect(client.status.peakDb).toBeCloseTo(-6, 0);
    expect(client.status.filters).toEqual([{ name: 'Compressor', enabled: true }]);
    await client.setFilterEnabled('Compressor', false);
    expect(client.status.filters[0].enabled).toBe(false);
  });

  it('senha errada vira erro claro', async () => {
    const obs = fakeObs('certa');
    await new Promise((r) => obs.wss.once('listening', r));
    const client = new ObsClient();
    cleanup.push(() => client.stop(), () => obs.wss.close());
    client.start({ host: '127.0.0.1', port: obs.port(), password: 'errada' });
    for (let i = 0; i < 40 && client.status.state !== 'erro'; i++) await wait(50);
    expect(client.status.error).toContain('senha');
  });
});
