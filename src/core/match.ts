/**
 * Match flow: intro → countdown → fight ⇄ knockdown → roundEnd → rest → … → finished.
 * Owns the round clock and judges' scorecards (10-point must system). Pure and time-driven.
 */
import type { Fighter } from './combat';
import { MAX_HEALTH } from './combat';

export type MatchPhase = 'intro' | 'countdown' | 'fight' | 'knockdown' | 'roundEnd' | 'rest' | 'finished';
export type WinMethod = 'KO' | 'TKO' | 'decision' | 'draw' | 'forfeit';

export interface MatchConfig {
  rounds: number;
  roundMs: number;
  restMs: number;
  introMs: number;
  countdownMs: number;
  /** Knockdowns in a single match that end it (TKO). */
  maxKnockdowns: number;
  /** Duration of each count (1..10). */
  countStepMs: number;
}

export const DEFAULT_MATCH: MatchConfig = {
  rounds: 3,
  roundMs: 90_000,
  restMs: 8_000,
  introMs: 2_500,
  countdownMs: 3_000,
  maxKnockdowns: 3,
  countStepMs: 900,
};

export type MatchEvent =
  | { type: 'phase'; phase: MatchPhase; round: number }
  | { type: 'bell'; kind: 'start' | 'end' }
  | { type: 'count'; n: number; fighter: 0 | 1 }
  | { type: 'getUp'; fighter: 0 | 1 }
  | { type: 'finished'; winner: 0 | 1 | null; method: WinMethod };

export interface RoundScore {
  damage: [number, number];
  knockdowns: [number, number];
}

export class Match {
  phase: MatchPhase = 'intro';
  round = 1;
  /** ms remaining in current phase-bound timer (round clock during fight). */
  clock: number;
  private phaseTime = 0;
  downFighter: 0 | 1 | null = null;
  count = 0;
  /** Count at which each fighter will get up automatically (null = stays down). */
  private getUpAt: number | null = null;
  scorecards: RoundScore[] = [];
  winner: 0 | 1 | null = null;
  method: WinMethod | null = null;
  elapsedFightMs = 0;

  constructor(
    public fighters: [Fighter, Fighter],
    public cfg: MatchConfig = DEFAULT_MATCH,
  ) {
    this.clock = cfg.introMs;
    this.scorecards.push({ damage: [0, 0], knockdowns: [0, 0] });
  }

  get fighting(): boolean {
    return this.phase === 'fight';
  }

  get roundClock(): number {
    return this.phase === 'fight' || this.phase === 'knockdown'
      ? this.roundLeft
      : this.phase === 'countdown' || this.phase === 'intro'
        ? this.cfg.roundMs
        : 0;
  }
  private roundLeft = 0;

  /** Record damage for scorecards; call after each resolved hit. Triggers knockdowns. */
  recordDamage(attacker: 0 | 1, damage: number): MatchEvent[] {
    const card = this.scorecards[this.round - 1]!;
    card.damage[attacker] += damage;
    const def = (1 - attacker) as 0 | 1;
    if (this.phase === 'fight' && this.fighters[def].down) return this.startKnockdown(def);
    return [];
  }

  private setPhase(p: MatchPhase, ms: number): MatchEvent {
    this.phase = p;
    this.clock = ms;
    this.phaseTime = 0;
    return { type: 'phase', phase: p, round: this.round };
  }

  private startKnockdown(f: 0 | 1): MatchEvent[] {
    const fighter = this.fighters[f];
    fighter.knockdowns++;
    this.fighters[(1 - f) as 0 | 1].stats.knockdownsScored++;
    this.scorecards[this.round - 1]!.knockdowns[f]++;
    this.downFighter = f;
    this.count = 0;
    this.getUpAt = fighter.knockdowns >= this.cfg.maxKnockdowns ? null : 4 + fighter.knockdowns * 2;
    return [this.setPhase('knockdown', this.cfg.countStepMs)];
  }

  /** Count at which the downed fighter automatically rises (null = staying down). */
  get getUpCount(): number | null {
    return this.phase === 'knockdown' ? this.getUpAt : null;
  }

  /** Let a player-controlled fighter get up early (e.g. they raised their guard) after count 3. */
  requestGetUp(f: 0 | 1): MatchEvent[] {
    if (this.phase !== 'knockdown' || this.downFighter !== f || this.getUpAt === null || this.count < 3)
      return [];
    return this.getUp();
  }

  private getUp(): MatchEvent[] {
    const f = this.downFighter!;
    const fighter = this.fighters[f];
    fighter.health = Math.max(15, MAX_HEALTH * (0.55 - 0.15 * fighter.knockdowns));
    fighter.stamina = Math.max(fighter.stamina, 50);
    this.downFighter = null;
    const ev: MatchEvent[] = [{ type: 'getUp', fighter: f }];
    ev.push(this.setPhase('fight', this.roundLeft));
    return ev;
  }

  private finish(winner: 0 | 1 | null, method: WinMethod): MatchEvent[] {
    this.winner = winner;
    this.method = method;
    return [this.setPhase('finished', 0), { type: 'finished', winner, method }];
  }

  forfeit(loser: 0 | 1): MatchEvent[] {
    if (this.phase === 'finished') return [];
    return this.finish((1 - loser) as 0 | 1, 'forfeit');
  }

  /** 10-point must: round winner by damage gets 10, loser 9; each knockdown costs a point. */
  totals(): [number, number] {
    const t: [number, number] = [0, 0];
    for (const c of this.scorecards) {
      const [a, b] = c.damage;
      let sa = 10;
      let sb = 10;
      if (a > b + 1) sb = 9;
      else if (b > a + 1) sa = 9;
      sa -= c.knockdowns[0];
      sb -= c.knockdowns[1];
      t[0] += sa;
      t[1] += sb;
    }
    return t;
  }

  update(dtMs: number): MatchEvent[] {
    const ev: MatchEvent[] = [];
    this.phaseTime += dtMs;
    switch (this.phase) {
      case 'intro':
        this.clock -= dtMs;
        if (this.clock <= 0) ev.push(this.setPhase('countdown', this.cfg.countdownMs));
        break;
      case 'countdown':
        this.clock -= dtMs;
        if (this.clock <= 0) {
          this.roundLeft = this.cfg.roundMs;
          ev.push(this.setPhase('fight', this.roundLeft), { type: 'bell', kind: 'start' });
        }
        break;
      case 'fight':
        this.roundLeft -= dtMs;
        this.elapsedFightMs += dtMs;
        this.clock = this.roundLeft;
        if (this.roundLeft <= 0) {
          this.roundLeft = 0;
          ev.push({ type: 'bell', kind: 'end' });
          ev.push(this.setPhase('roundEnd', 2500));
        }
        break;
      case 'knockdown':
        this.clock -= dtMs;
        if (this.clock <= 0) {
          this.count++;
          ev.push({ type: 'count', n: this.count, fighter: this.downFighter! });
          if (this.getUpAt !== null && this.count >= this.getUpAt) ev.push(...this.getUp());
          else if (this.count >= 10) {
            const f = this.downFighter!;
            ev.push(
              ...this.finish(
                (1 - f) as 0 | 1,
                this.fighters[f].knockdowns >= this.cfg.maxKnockdowns ? 'TKO' : 'KO',
              ),
            );
          } else this.clock = this.cfg.countStepMs;
        }
        break;
      case 'roundEnd':
        this.clock -= dtMs;
        if (this.clock <= 0) {
          if (this.round >= this.cfg.rounds) {
            const [a, b] = this.totals();
            ev.push(...this.finish(a === b ? null : a > b ? 0 : 1, a === b ? 'draw' : 'decision'));
          } else ev.push(this.setPhase('rest', this.cfg.restMs));
        }
        break;
      case 'rest':
        this.clock -= dtMs;
        for (const f of this.fighters) f.stamina = Math.min(100, f.stamina + dtMs * 0.01);
        if (this.clock <= 0) {
          this.round++;
          this.scorecards.push({ damage: [0, 0], knockdowns: [0, 0] });
          for (const f of this.fighters) f.health = Math.min(MAX_HEALTH, f.health + 12);
          ev.push(this.setPhase('countdown', this.cfg.countdownMs));
        }
        break;
      case 'finished':
        break;
    }
    return ev;
  }
}
