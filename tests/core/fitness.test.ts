import { describe, expect, it } from 'vitest';
import { FitnessSession, punchNumber } from '../../src/core/fitness';
import { LandmarkFilter, OneEuroFilter } from '../../src/core/oneEuro';

describe('FitnessSession', () => {
  it('maps punches to boxing numbers', () => {
    expect(punchNumber({ type: 'hook', hand: 'left' }, 'orthodox')).toBe(3);
    expect(punchNumber({ type: 'hook', hand: 'left' }, 'southpaw')).toBe(4);
    expect(punchNumber({ type: 'uppercut', hand: 'right' }, 'orthodox')).toBe(6);
  });
  it('calls combos, tracks completion and phases', () => {
    const s = new FitnessSession({ rounds: 2, workMs: 5000, restMs: 1000, level: 0 });
    let now = 0;
    const phases: string[] = [];
    let completed = 0;
    for (; now < 20_000; now += 50) {
      for (const e of s.update(50, now)) {
        if (e.type === 'phase') phases.push(e.phase);
      }
      if (s.combo.length && s.phase === 'work') {
        const n = s.combo[s.index]!;
        const type = n === 1 ? 'jab' : n === 2 ? 'cross' : n <= 4 ? 'hook' : 'uppercut';
        const hand = n === 1 || n === 3 || n === 5 ? 'left' : 'right';
        for (const e of s.onPunch({ type, hand, target: 'head', speed: 4, power: 1, time: now }))
          if (e.type === 'comboDone') completed++;
      }
    }
    expect(phases).toEqual(['work', 'rest', 'work', 'done']);
    expect(completed).toBeGreaterThan(3);
    expect(s.stats.combosCompleted).toBe(completed);
    expect(s.stats.kcal).toBeGreaterThan(0);
  });
});

describe('OneEuroFilter', () => {
  it('suppresses jitter at rest and tracks fast motion with little lag', () => {
    const f = new OneEuroFilter();
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      const y = f.filter(0.5 + (i % 2 ? 0.004 : -0.004), i * 16.7);
      if (i > 10) maxDev = Math.max(maxDev, Math.abs(y - 0.5));
    }
    expect(maxDev).toBeLessThan(0.002);
    const g = new OneEuroFilter();
    let out = 0;
    for (let i = 0; i < 20; i++) out = g.filter(i * 0.05, i * 16.7); // 3 m/s ramp
    expect(0.95 - out).toBeLessThan(0.1);
  });
  it('predicts ahead along the velocity', () => {
    const f = new LandmarkFilter(1);
    for (let i = 0; i < 30; i++) f.filter([{ x: i * 0.02, y: 0, z: 0, visibility: 1 }], i * 16.7);
    const p = f.predict(33)[0]!;
    expect(p.x).toBeGreaterThan(0.58);
  });
});
