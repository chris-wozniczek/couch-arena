import { describe, expect, it } from 'vitest';
import { dailyChallenge, goalMet } from '../../src/core/daily';
import type { MatchSummary } from '../../src/core/scoring';
import { computeScore, validateSummary } from '../../src/core/scoring';

const base: MatchSummary = {
  mode: 'arcade',
  opponent: 'contender',
  durationMs: 150_000,
  thrown: 180,
  landed: 90,
  damageDealt: 150,
  damageTaken: 60,
  knockdownsScored: 2,
  maxCombo: 6,
  peakSpeed: 6.2,
  won: true,
  method: 'KO',
};

describe('scoring', () => {
  it('is deterministic and rewards harder opponents', () => {
    expect(computeScore(base)).toBe(computeScore({ ...base }));
    expect(computeScore({ ...base, opponent: 'legend' })).toBeGreaterThan(computeScore(base));
  });
  it('accepts plausible matches', () => {
    expect(validateSummary(base)).toEqual({ ok: true });
  });
  it.each([
    [{ thrown: 5000 }, 'punch rate'],
    [{ landed: 200 }, 'landed > thrown'],
    [{ damageDealt: 900 }, 'damage'],
    [{ peakSpeed: 40 }, 'speed'],
    [{ durationMs: 1000 }, 'duration'],
    [{ maxCombo: 100 }, 'combo'],
    [{ thrown: Number.NaN }, 'invalid'],
  ] as const)('rejects %o', (patch, reason) => {
    const r = validateSummary({ ...base, ...patch });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(reason);
  });
});

describe('daily challenge', () => {
  it('is deterministic per day and varies across days', () => {
    expect(dailyChallenge('2026-09-26')).toEqual(dailyChallenge('2026-09-26'));
    const ids = new Set(
      Array.from(
        { length: 10 },
        (_, i) =>
          JSON.stringify(dailyChallenge(`2026-10-${10 + i}`).goal) +
          dailyChallenge(`2026-10-${10 + i}`).opponent.name,
      ),
    );
    expect(ids.size).toBeGreaterThan(3);
  });
  it('checks goals', () => {
    expect(goalMet({ kind: 'koUnder', ms: 180_000 }, base)).toBe(true);
    expect(goalMet({ kind: 'combo', n: 8 }, base)).toBe(false);
    expect(goalMet({ kind: 'win' }, { ...base, won: false })).toBe(false);
  });
});
