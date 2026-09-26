import { describe, expect, it } from 'vitest';
import { Fighter, defenseOutcome, resolvePunch } from '../../src/core/combat';
import { DEFAULT_MATCH, Match } from '../../src/core/match';
import type { PunchEvent } from '../../src/core/types';

const punch = (
  type: PunchEvent['type'],
  time: number,
  target: PunchEvent['target'] = 'head',
): PunchEvent => ({
  hand: 'left',
  type,
  target,
  speed: 4,
  power: 1,
  time,
});

describe('defense matrix', () => {
  it('guard blocks head shots with chip damage', () => {
    expect(defenseOutcome('cross', 'head', 'guard')).toEqual({ result: 'blocked', mult: 0.12 });
  });
  it('slip beats straights but not hooks', () => {
    expect(defenseOutcome('jab', 'head', 'slipLeft').result).toBe('slipped');
    expect(defenseOutcome('hook', 'head', 'slipRight').result).toBe('landed');
  });
  it('duck beats head hooks, eats uppercuts', () => {
    expect(defenseOutcome('hook', 'head', 'duck').result).toBe('ducked');
    expect(defenseOutcome('uppercut', 'head', 'duck').mult).toBeGreaterThan(1);
  });
});

describe('resolvePunch', () => {
  it('builds combos and scales damage', () => {
    const a = new Fighter('a');
    const d = new Fighter('d');
    const r1 = resolvePunch(a, d, punch('jab', 0), 'none', a.throwPunch(punch('jab', 0)), 0);
    const r2 = resolvePunch(a, d, punch('cross', 300), 'none', a.throwPunch(punch('cross', 300)), 300);
    expect(r1.combo).toBe(1);
    expect(r2.combo).toBe(2);
    expect(d.health).toBeLessThan(100 - r1.damage);
    expect(a.stats.landed).toBe(2);
    expect(a.stats.maxCombo).toBe(2);
  });
  it('awards counter damage after the defender whiffs', () => {
    const a = new Fighter('a');
    const d = new Fighter('d');
    resolvePunch(d, a, punch('jab', 0), 'slipLeft', 1, 0); // d whiffs
    const plain = resolvePunch(new Fighter('x'), new Fighter('y'), punch('cross', 200), 'none', 1, 200);
    const counter = resolvePunch(a, d, punch('cross', 200), 'none', 1, 200);
    expect(counter.counter).toBe(true);
    expect(counter.damage).toBeCloseTo(plain.damage * 1.5, 5);
  });
  it('tired fighters hit softer', () => {
    const f = new Fighter('f');
    f.stamina = 0;
    expect(f.throwPunch(punch('jab', 0))).toBeCloseTo(0.45);
  });
});

describe('Match', () => {
  const run = (m: Match, ms: number): string[] => {
    const out: string[] = [];
    for (let t = 0; t < ms; t += 50)
      for (const e of m.update(50)) out.push(e.type === 'phase' ? e.phase : e.type);
    return out;
  };
  it('runs intro → countdown → fight → decision', () => {
    const cfg = { ...DEFAULT_MATCH, rounds: 2, roundMs: 2000, restMs: 500 };
    const m = new Match([new Fighter('a'), new Fighter('b')], cfg);
    const ev = run(m, 2500 + 3000 + 2000);
    expect(ev).toEqual(['countdown', 'fight', 'bell', 'bell', 'roundEnd']);
    m.recordDamage(0, 20);
    run(m, 12_000);
    expect(m.phase).toBe('finished');
    expect(m.method).toBe('decision');
    expect(m.winner).toBe(0);
    expect(m.totals()).toEqual([20, 19]);
  });
  it('knockdown → count → KO when fighter stays down', () => {
    const a = new Fighter('a');
    const b = new Fighter('b');
    const m = new Match([a, b], { ...DEFAULT_MATCH, maxKnockdowns: 1 });
    run(m, 6000);
    b.health = 0;
    expect(m.recordDamage(0, 10).map((e) => e.type)).toEqual(['phase']);
    expect(m.phase).toBe('knockdown');
    run(m, 10 * DEFAULT_MATCH.countStepMs + 100);
    expect(m.phase).toBe('finished');
    expect(m.winner).toBe(0);
    expect(['KO', 'TKO']).toContain(m.method);
  });
  it('fighter can beat the count and resumes with reduced health', () => {
    const b = new Fighter('b');
    const m = new Match([new Fighter('a'), b]);
    run(m, 6000);
    b.health = 0;
    m.recordDamage(0, 10);
    run(m, 3 * DEFAULT_MATCH.countStepMs + 20);
    expect(m.requestGetUp(1).map((e) => e.type)).toContain('getUp');
    expect(m.phase).toBe('fight');
    expect(b.health).toBeGreaterThan(0);
    expect(b.health).toBeLessThan(60);
  });
});
