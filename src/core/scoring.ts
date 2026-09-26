/**
 * Leaderboard scoring and plausibility validation. Shared by the client (to display) and the Convex
 * backend (to recompute and reject implausible submissions).
 */
export type ScoreMode = 'arcade' | 'daily' | 'fitness';

export interface MatchSummary {
  mode: ScoreMode;
  /** Opponent profile id (arcade/daily). */
  opponent: string;
  durationMs: number;
  thrown: number;
  landed: number;
  damageDealt: number;
  damageTaken: number;
  knockdownsScored: number;
  maxCombo: number;
  peakSpeed: number;
  won: boolean;
  method: string;
}

const DIFFICULTY_MULT: Record<string, number> = { rookie: 1, contender: 1.5, champion: 2.2, legend: 3 };

export function computeScore(s: MatchSummary): number {
  if (s.mode === 'fitness') {
    // Fitness: volume + speed.
    return Math.round(s.thrown * 10 + s.landed * 5 + s.peakSpeed * 50);
  }
  const mult = DIFFICULTY_MULT[s.opponent] ?? 1;
  let score =
    s.damageDealt * 10 + s.landed * 5 + s.maxCombo * 25 + s.knockdownsScored * 300 - s.damageTaken * 3;
  if (s.won) {
    score += 1500;
    if (s.method === 'KO' || s.method === 'TKO') score += Math.max(0, (300_000 - s.durationMs) / 1000) * 8;
  }
  return Math.max(0, Math.round(score * mult));
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Physical / rules plausibility checks. Conservative: rejects only clearly impossible submissions. */
export function validateSummary(s: MatchSummary): ValidationResult {
  const secs = s.durationMs / 1000;
  const nums = [
    s.durationMs,
    s.thrown,
    s.landed,
    s.damageDealt,
    s.damageTaken,
    s.knockdownsScored,
    s.maxCombo,
    s.peakSpeed,
  ];
  if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return { ok: false, reason: 'invalid numbers' };
  if (secs < 5 || secs > 45 * 60) return { ok: false, reason: 'duration out of range' };
  if (s.thrown / secs > 6) return { ok: false, reason: 'punch rate too high' };
  if (s.landed > s.thrown) return { ok: false, reason: 'landed > thrown' };
  if (s.maxCombo > s.landed) return { ok: false, reason: 'combo > landed' };
  if (s.peakSpeed > 16) return { ok: false, reason: 'speed implausible' };
  if (s.mode !== 'fitness') {
    if (s.damageDealt > s.landed * 30) return { ok: false, reason: 'damage per punch too high' };
    // Health resets after each knockdown to at most ~55%, plus between-round recovery.
    const maxDamage = 100 + s.knockdownsScored * 55 + 3 * 12 + 1;
    if (s.damageDealt > maxDamage) return { ok: false, reason: 'damage exceeds possible health' };
    if (s.knockdownsScored > 3) return { ok: false, reason: 'too many knockdowns' };
    if (s.won && s.method !== 'KO' && s.method !== 'TKO' && s.method !== 'decision')
      return { ok: false, reason: 'bad method' };
  }
  return { ok: true };
}
