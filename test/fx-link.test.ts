import { describe, expect, it } from 'vitest';
import { FxLink, type LiveSend } from '../src/leveler/fx-link.js';

const NEG = Number.NEGATIVE_INFINITY;
const live = (entries: [string, number, boolean?][]) => new Map<string, LiveSend>(entries.map(([k, db, muted]) => [k, { db, muted: Boolean(muted) }]));

describe('efeito acompanha a live (envio do canal para o FX segue o envio para a live)', () => {
  it('diferença fixa: alinhar agora e depois acompanhar cada mexida na live', () => {
    const link = new FxLink();
    const fx = new Map([['f2:i1', -30], ['f2:i2', NEG]]);
    // alinhar: VIOLÃO (-20) vai para -28; canal fora da live (-∞) não é mexido agora
    const aligned = link.setOffset('f2', -8, live([['i1', -20], ['i2', NEG]]), fx, true, 0);
    expect(aligned).toEqual([{ fx: 'f2', key: 'i1', db: -28 }]);
    // o operador sobe o VIOLÃO na live: o FX2 dele sobe junto
    expect(link.onLiveSend('i1', { db: -15, muted: false }, new Map([['f2:i1', -28]]), 1000)).toEqual([{ fx: 'f2', key: 'i1', db: -23 }]);
    // live fechada ou mutada: o efeito fecha junto; ao reabrir, volta com a mesma diferença
    expect(link.onLiveSend('i1', { db: -15, muted: true }, new Map([['f2:i1', -23]]), 2000)).toEqual([{ fx: 'f2', key: 'i1', db: NEG }]);
    expect(link.onLiveSend('i1', { db: -12, muted: false }, new Map([['f2:i1', NEG]]), 3000)).toEqual([{ fx: 'f2', key: 'i1', db: -20 }]);
  });

  it('"mesma" (0 dB), vários efeitos e canal ignorado pelo botão FX', () => {
    const link = new FxLink();
    link.setOffset('f1', 0, live([]), new Map(), false, 0);
    link.setOffset('f2', -4, live([]), new Map(), false, 0);
    expect(link.onLiveSend('i3', { db: -10, muted: false }, new Map(), 0)).toEqual([
      { fx: 'f1', key: 'i3', db: -10 },
      { fx: 'f2', key: 'i3', db: -14 },
    ]);
    link.setIgnored('i17', true); // bumbo: o operador não quer reverb acompanhando
    expect(link.onLiveSend('i17', { db: -5, muted: false }, new Map(), 0)).toEqual([]);
    expect(link.export().ignore).toEqual(['i17']);
    link.setIgnored('i17', false);
    expect(link.onLiveSend('i17', { db: -5, muted: false }, new Map(), 0)).toHaveLength(2);
  });

  it('"manter como está": cada canal guarda a própria diferença; canal sem efeito não ganha efeito', () => {
    const link = new FxLink();
    link.setOffset('f1', 'manter', live([['i1', -20], ['i3', -10], ['i9', -30]]), new Map([['f1:i1', -26], ['f1:i3', -25], ['f1:i9', NEG]]), false, 0);
    expect(link.onLiveSend('i1', { db: -17, muted: false }, new Map([['f1:i1', -26]]), 0)).toEqual([{ fx: 'f1', key: 'i1', db: -23 }]); // -6
    expect(link.onLiveSend('i3', { db: -12, muted: false }, new Map([['f1:i3', -25]]), 0)).toEqual([{ fx: 'f1', key: 'i3', db: -27 }]); // -15
    expect(link.onLiveSend('i9', { db: -20, muted: false }, new Map([['f1:i9', NEG]]), 0)).toEqual([]); // não tinha reverb
  });

  it('mexida manual no envio do efeito: no "manter" vira a nova diferença; o eco do que mandamos não conta', () => {
    const link = new FxLink();
    link.setOffset('f1', 'manter', live([['i1', -20]]), new Map([['f1:i1', -26]]), false, 0);
    const [sent] = link.onLiveSend('i1', { db: -18, muted: false }, new Map([['f1:i1', -26]]), 100);
    expect(sent.db).toBe(-24);
    link.onFxSend('f1', 'i1', -24, { db: -18, muted: false }, 150); // eco: ignora
    link.onFxSend('f1', 'i1', -30, { db: -18, muted: false }, 5000); // operador: diferença passa a -12
    expect(link.onLiveSend('i1', { db: -20, muted: false }, new Map([['f1:i1', -30]]), 6000)).toEqual([{ fx: 'f1', key: 'i1', db: -32 }]);
  });

  it('desligar o efeito para de acompanhar; não passa de +10 dB', () => {
    const link = new FxLink();
    link.setOffset('f2', 0, live([]), new Map(), false, 0);
    expect(link.onLiveSend('i1', { db: 12, muted: false }, new Map(), 0)).toEqual([{ fx: 'f2', key: 'i1', db: 10 }]);
    link.setOffset('f2', null, live([]), new Map(), false, 0);
    expect(link.active()).toBe(false);
    expect(link.onLiveSend('i1', { db: -5, muted: false }, new Map(), 0)).toEqual([]);
  });
});
