import { describe, expect, it } from 'vitest';
import { TrafficMeter, healthKeysIn } from '../src/traffic.js';

describe('tráfego com a mesa (saúde da mesa)', () => {
  it('média dos últimos 10 s, pico por segundo e total', () => {
    const t = new TrafficMeter();
    const base = 1_000_000;
    // 10 segundos com 2 comandos cada, e um segundo com 15 (pico)
    for (let s = 0; s < 10; s++) t.add(base + s * 1000, 2);
    t.add(base + 10_000, 15);
    const snap = t.snapshot(base + 11_000);
    expect(snap.total).toBe(35);
    expect(snap.peak).toBe(15);
    expect(snap.peakAt).toBe(base + 10_000);
    expect(snap.perSec).toBe(3.3); // últimos 10 segundos completos (1..10): 9×2 + 15 = 33 → 3,3 por segundo
  });

  it('últimos 60 s, um valor por segundo; o que é mais velho sai', () => {
    const t = new TrafficMeter();
    t.add(0, 5);
    t.add(30_000, 1);
    const snap = t.snapshot(59_000);
    expect(snap.lastMinute).toHaveLength(60);
    expect(snap.lastMinute[0]).toBe(5);
    expect(snap.lastMinute[30]).toBe(1);
    const later = t.snapshot(70_000);
    expect(later.lastMinute.reduce((a, b) => a + b, 0)).toBe(1); // o de t=0 já saiu
    expect(later.total).toBe(6); // o total da sessão continua
  });

  it('só pega chaves que parecem saúde do aparelho', () => {
    const raw = '3:::SETD^i.0.mix^0.5\nSETD^settings.temperature^48\nSETD^hw.0.gain^0.3\nSETD^sys.cpuload^0.21';
    expect(healthKeysIn(raw)).toEqual([
      ['settings.temperature', '48'],
      ['sys.cpuload', '0.21'],
    ]);
  });
});
