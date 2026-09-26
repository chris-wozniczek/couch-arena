/**
 * Fitness / training mode: interval timer, combo caller and punch statistics.
 * Boxing number system: 1 jab, 2 cross, 3 lead hook, 4 rear hook, 5 lead uppercut, 6 rear uppercut.
 */
import { Rng } from './rng';
import type { Hand, PunchEvent, PunchType, Stance } from './types';

export type ComboNumber = 1 | 2 | 3 | 4 | 5 | 6;

export const COMBO_NAMES: Record<ComboNumber, string> = {
  1: 'Jab',
  2: 'Cross',
  3: 'Lead hook',
  4: 'Rear hook',
  5: 'Lead uppercut',
  6: 'Rear uppercut',
};

export function punchNumber(p: Pick<PunchEvent, 'type' | 'hand'>, stance: Stance): ComboNumber {
  const lead: Hand = stance === 'orthodox' ? 'left' : 'right';
  const isLead = p.hand === lead;
  switch (p.type) {
    case 'jab':
      return 1;
    case 'cross':
      return 2;
    case 'hook':
      return isLead ? 3 : 4;
    case 'uppercut':
      return isLead ? 5 : 6;
  }
}

const LEVELS: ReadonlyArray<ReadonlyArray<ReadonlyArray<ComboNumber>>> = [
  [[1], [2], [1, 2], [1, 1], [1, 1, 2]],
  [
    [1, 2],
    [1, 2, 3],
    [1, 1, 2],
    [2, 3, 2],
    [1, 6],
    [3, 2],
  ],
  [
    [1, 2, 3, 2],
    [1, 2, 5, 2],
    [1, 6, 3, 2],
    [3, 4, 3],
    [1, 2, 3, 4],
    [5, 6, 3, 4],
  ],
];

export interface IntervalConfig {
  rounds: number;
  workMs: number;
  restMs: number;
  level: 0 | 1 | 2;
}

export const DEFAULT_INTERVALS: IntervalConfig = { rounds: 3, workMs: 60_000, restMs: 20_000, level: 1 };

export interface FitnessStats {
  punches: number;
  byType: Record<PunchType, number>;
  peakSpeed: number;
  speedSum: number;
  combosCalled: number;
  combosCompleted: number;
  /** Mean reaction time from call to first correct punch (ms). */
  reactionSum: number;
  reactionCount: number;
  /** Estimated active kcal (MET-based rough estimate). */
  kcal: number;
}

export type FitnessPhase = 'ready' | 'work' | 'rest' | 'done';

export type FitnessEvent =
  | { type: 'phase'; phase: FitnessPhase; round: number }
  | { type: 'call'; combo: ComboNumber[] }
  | { type: 'progress'; index: number; correct: boolean }
  | { type: 'comboDone'; ms: number; perfect: boolean };

export class FitnessSession {
  phase: FitnessPhase = 'ready';
  round = 1;
  clock: number;
  combo: ComboNumber[] = [];
  index = 0;
  private callAt = 0;
  private mistakes = 0;
  private nextCallIn = 1500;
  private rng: Rng;
  private now = 0;
  stats: FitnessStats = {
    punches: 0,
    byType: { jab: 0, cross: 0, hook: 0, uppercut: 0 },
    peakSpeed: 0,
    speedSum: 0,
    combosCalled: 0,
    combosCompleted: 0,
    reactionSum: 0,
    reactionCount: 0,
    kcal: 0,
  };
  /** Timestamps of recent punches for the punches-per-minute meter. */
  private recent: number[] = [];

  constructor(
    public cfg: IntervalConfig = DEFAULT_INTERVALS,
    public stance: Stance = 'orthodox',
    seed = 7,
  ) {
    this.clock = 3000;
    this.rng = new Rng(seed);
  }

  get punchesPerMinute(): number {
    return this.recent.filter((t) => this.now - t < 10_000).length * 6;
  }

  get avgSpeed(): number {
    return this.stats.punches ? this.stats.speedSum / this.stats.punches : 0;
  }

  update(dtMs: number, now: number): FitnessEvent[] {
    this.now = now;
    const ev: FitnessEvent[] = [];
    this.clock -= dtMs;
    // ~8 MET while working, 3 at rest, assuming 75 kg.
    const met = this.phase === 'work' ? 8 : 3;
    if (this.phase !== 'done' && this.phase !== 'ready')
      this.stats.kcal += ((met * 3.5 * 75) / 200 / 60000) * dtMs;
    if (this.clock > 0) {
      if (this.phase === 'work' && this.combo.length === 0) {
        this.nextCallIn -= dtMs;
        if (this.nextCallIn <= 0) ev.push(this.call(now));
      }
      return ev;
    }
    if (this.phase === 'ready' || this.phase === 'rest') {
      if (this.phase === 'rest') this.round++;
      this.phase = 'work';
      this.clock = this.cfg.workMs;
      this.combo = [];
      this.nextCallIn = 800;
      ev.push({ type: 'phase', phase: 'work', round: this.round });
    } else if (this.phase === 'work') {
      this.combo = [];
      if (this.round >= this.cfg.rounds) {
        this.phase = 'done';
        this.clock = 0;
        ev.push({ type: 'phase', phase: 'done', round: this.round });
      } else {
        this.phase = 'rest';
        this.clock = this.cfg.restMs;
        ev.push({ type: 'phase', phase: 'rest', round: this.round });
      }
    }
    return ev;
  }

  private call(now: number): FitnessEvent {
    this.combo = [...this.rng.pick(LEVELS[this.cfg.level]!)];
    this.index = 0;
    this.mistakes = 0;
    this.callAt = now;
    this.stats.combosCalled++;
    return { type: 'call', combo: this.combo };
  }

  onPunch(p: PunchEvent): FitnessEvent[] {
    const ev: FitnessEvent[] = [];
    this.stats.punches++;
    this.stats.byType[p.type]++;
    this.stats.peakSpeed = Math.max(this.stats.peakSpeed, p.speed);
    this.stats.speedSum += p.speed;
    this.recent.push(p.time);
    while (this.recent.length && p.time - this.recent[0]! > 10_000) this.recent.shift();
    if (this.phase !== 'work' || this.combo.length === 0) return ev;
    const n = punchNumber(p, this.stance);
    const expected = this.combo[this.index]!;
    const correct = n === expected;
    if (this.index === 0 && correct) {
      this.stats.reactionSum += p.time - this.callAt;
      this.stats.reactionCount++;
    }
    if (correct) {
      ev.push({ type: 'progress', index: this.index, correct: true });
      this.index++;
      if (this.index >= this.combo.length) {
        this.stats.combosCompleted++;
        ev.push({ type: 'comboDone', ms: p.time - this.callAt, perfect: this.mistakes === 0 });
        this.combo = [];
        this.nextCallIn = 700 + this.rng.range(0, 700);
      }
    } else {
      this.mistakes++;
      ev.push({ type: 'progress', index: this.index, correct: false });
    }
    return ev;
  }
}
