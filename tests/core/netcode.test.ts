import { describe, expect, it } from 'vitest';
import {
  ClockSync,
  DefenseHistory,
  LinkMonitor,
  SnapshotBuffer,
  decodeDefense,
  decodeMessage,
  encodeDefense,
  reconcileImpact,
} from '../../src/core/netcode';
import type { PoseSnapshot } from '../../src/core/netcode';

describe('ClockSync', () => {
  it('estimates offset robustly with asymmetric jitter', () => {
    const c = new ClockSync();
    const trueOffset = 12_345; // local = remote + offset
    const samples = [
      [20, 20],
      [80, 10],
      [15, 15],
      [22, 18],
      [200, 5],
      [18, 17],
    ];
    let t = 1000;
    for (const [up, down] of samples) {
      const t0 = t;
      const t1 = t0 + up! - trueOffset;
      const t2 = t0 + up! + down!;
      c.addSample(t0, t1, t2);
      t += 500;
    }
    expect(c.ready).toBe(true);
    expect(Math.abs(c.offset - trueOffset)).toBeLessThan(5);
    expect(c.rtt).toBe(30);
  });
});

describe('reconcileImpact', () => {
  const clock = new ClockSync();
  for (let i = 0; i < 4; i++) clock.addSample(i * 100, i * 100 + 25 - 1000, i * 100 + 50); // offset 1000, rtt 50
  const hist = new DefenseHistory();
  hist.push(0, 'none');
  hist.push(2000, 'slipLeft');
  hist.push(2300, 'none');

  it('resolves against the defense at the reconciled impact time', () => {
    // Remote punch at remote 1080 → local 2080 + travel 90 = 2170: slipping.
    const r = reconcileImpact(1080, clock, hist, 2200);
    expect(r.defense).toBe('slipLeft');
    expect(r.impactAt).toBeCloseTo(2170);
  });
  it('clamps rewind so laggy attackers cannot rewrite history', () => {
    const r = reconcileImpact(500, clock, hist, 2600);
    expect(r.impactAt).toBe(2600 - 220);
    expect(r.rewound).toBe(220);
  });
  it('gives the defender a small grace window', () => {
    // Impact at 1960 (slip started 40 ms later) → still slipped with 60 ms grace.
    expect(reconcileImpact(870, clock, hist, 1990).defense).toBe('slipLeft');
    expect(reconcileImpact(700, clock, hist, 1990).defense).toBe('none');
  });
});

describe('messages', () => {
  it('validates untrusted input', () => {
    expect(decodeMessage('not json')).toBeNull();
    expect(
      decodeMessage(
        JSON.stringify({
          t: 'punch',
          id: 1,
          ts: 1,
          hand: 'left',
          type: 'jab',
          target: 'head',
          power: 99,
          speed: 3,
        }),
      ),
    ).toBeNull();
    expect(
      decodeMessage(
        JSON.stringify({
          t: 'punch',
          id: 1,
          ts: 1,
          hand: 'left',
          type: 'jab',
          target: 'head',
          power: 1,
          speed: 3,
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeMessage(JSON.stringify({ t: 'hit', id: 1, result: 'landed', damage: 500, health: 1, combo: 1 })),
    ).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: 'evil' }))).toBeNull();
  });
  it('round-trips defense bits', () => {
    for (const d of [
      { guard: true, slip: 0, duck: false },
      { guard: false, slip: -1, duck: true },
      { guard: true, slip: 1, duck: false },
    ] as const)
      expect(decodeDefense(encodeDefense(d))).toEqual(d);
  });
});

describe('SnapshotBuffer', () => {
  const snap = (seq: number, x: number): PoseSnapshot => ({
    t: 'pose',
    seq,
    ts: seq * 33,
    w: [x, 0, 0, 0, 0, 0],
    e: [0, 0, 0, 0, 0, 0],
    h: [0, 0],
    d: 1,
  });
  it('interpolates and drops stale out-of-order packets', () => {
    const b = new SnapshotBuffer(50);
    b.push(snap(1, 0), 1000);
    b.push(snap(3, 1), 1100);
    b.push(snap(2, 99), 1110); // stale
    expect(b.sample(1100)!.w[0]).toBeCloseTo(0.5);
    expect(b.sample(2000)!.w[0]).toBe(1);
  });
});

describe('LinkMonitor', () => {
  it('goes stalled then lost', () => {
    const m = new LinkMonitor(1000, 5000);
    m.received(0);
    expect(m.update(500)).toBe('connected');
    expect(m.update(1500)).toBe('stalled');
    expect(m.update(6000)).toBe('lost');
    m.received(6100);
    expect(m.update(6200)).toBe('connected');
  });
});
