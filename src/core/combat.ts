/**
 * Fighter state and hit resolution. Pure rules shared by single player, local 2P and online play.
 */
import { clamp } from './math';
import type { DefenseKind, PunchEvent, PunchType, Target } from './types';

export const PUNCH_BASE_DAMAGE: Record<PunchType, number> = { jab: 4, cross: 7, hook: 8, uppercut: 9 };
export const PUNCH_STAMINA_COST: Record<PunchType, number> = { jab: 3, cross: 5, hook: 6, uppercut: 7 };

export const MAX_HEALTH = 100;
export const MAX_STAMINA = 100;
export const COMBO_WINDOW_MS = 900;
export const COUNTER_WINDOW_MS = 450;

export type HitResult = 'landed' | 'blocked' | 'slipped' | 'ducked';

export interface FighterStats {
  thrown: number;
  landed: number;
  blocked: number;
  evaded: number;
  damageDealt: number;
  maxCombo: number;
  knockdownsScored: number;
  byType: Record<PunchType, number>;
  peakSpeed: number;
}

export const emptyStats = (): FighterStats => ({
  thrown: 0,
  landed: 0,
  blocked: 0,
  evaded: 0,
  damageDealt: 0,
  maxCombo: 0,
  knockdownsScored: 0,
  byType: { jab: 0, cross: 0, hook: 0, uppercut: 0 },
  peakSpeed: 0,
});

export class Fighter {
  health = MAX_HEALTH;
  stamina = MAX_STAMINA;
  knockdowns = 0;
  combo = 0;
  lastLandedAt = -1e9;
  /** Time until which the fighter is stunned (reduced defense). */
  stunnedUntil = -1e9;
  /** Time of this fighter's last evaded (missed) punch, used for counter bonuses. */
  lastWhiffAt = -1e9;
  lastPunchAt = -1e9;
  stats: FighterStats = emptyStats();
  constructor(public name: string) {}

  get down(): boolean {
    return this.health <= 0;
  }

  resetForMatch(): void {
    this.health = MAX_HEALTH;
    this.stamina = MAX_STAMINA;
    this.knockdowns = 0;
    this.combo = 0;
    this.stats = emptyStats();
  }

  /** Stamina regen: faster when not punching; guard slows it slightly. */
  tick(dtMs: number, now: number, guarding: boolean): void {
    const idle = now - this.lastPunchAt > 600;
    const rate = idle ? (guarding ? 11 : 15) : 4;
    this.stamina = clamp(this.stamina + (rate * dtMs) / 1000, 0, MAX_STAMINA);
    if (now - this.lastLandedAt > COMBO_WINDOW_MS) this.combo = 0;
  }

  /** Registers a thrown punch; returns the stamina factor applied to its damage (0.45..1). */
  throwPunch(p: PunchEvent): number {
    this.stats.thrown++;
    this.stats.byType[p.type]++;
    this.stats.peakSpeed = Math.max(this.stats.peakSpeed, p.speed);
    const factor = 0.45 + 0.55 * (this.stamina / MAX_STAMINA);
    this.stamina = clamp(this.stamina - PUNCH_STAMINA_COST[p.type], 0, MAX_STAMINA);
    this.lastPunchAt = p.time;
    return factor;
  }
}

export interface Resolution {
  result: HitResult;
  damage: number;
  /** Combo count of the attacker after this punch. */
  combo: number;
  counter: boolean;
  /** 0..1 how hard the hit visually is (for camera shake / hit-stop). */
  impact: number;
}

/**
 * Which defense beats which punch.
 * - guard blocks head punches (chip damage), partially covers the body.
 * - slips evade straight punches and uppercuts, not hooks (you slip into them).
 * - ducks evade straights and hooks to the head, but eat uppercuts harder.
 */
export function defenseOutcome(
  type: PunchType,
  target: Target,
  defense: DefenseKind,
): { result: HitResult; mult: number } {
  if (defense === 'duck') {
    if (type === 'uppercut') return { result: 'landed', mult: 1.3 };
    if (target === 'head') return { result: 'ducked', mult: 0 };
    return { result: 'landed', mult: 0.8 };
  }
  if (defense === 'slipLeft' || defense === 'slipRight') {
    if (type === 'hook') return { result: 'landed', mult: 1.15 };
    return { result: 'slipped', mult: 0 };
  }
  if (defense === 'guard') {
    if (target === 'head') return { result: 'blocked', mult: 0.12 };
    return { result: 'landed', mult: 0.6 };
  }
  return { result: 'landed', mult: 1 };
}

/**
 * Applies a punch from `attacker` to `defender`, given the defender's defense at impact time.
 * `staminaFactor` comes from `attacker.throwPunch`.
 */
export function resolvePunch(
  attacker: Fighter,
  defender: Fighter,
  punch: PunchEvent,
  defense: DefenseKind,
  staminaFactor: number,
  now: number,
  damageScale = 1,
): Resolution {
  const stunned = now < defender.stunnedUntil;
  const effDefense: DefenseKind = stunned && defense === 'guard' ? 'none' : defense;
  const { result, mult } = defenseOutcome(punch.type, punch.target, effDefense);
  if (result === 'slipped' || result === 'ducked') {
    attacker.lastWhiffAt = now;
    attacker.combo = 0;
    defender.stats.evaded++;
    return { result, damage: 0, combo: 0, counter: false, impact: 0 };
  }
  const counter = now - defender.lastWhiffAt < COUNTER_WINDOW_MS;
  if (result === 'landed') {
    attacker.combo = now - attacker.lastLandedAt < COMBO_WINDOW_MS ? attacker.combo + 1 : 1;
    attacker.lastLandedAt = now;
    attacker.stats.landed++;
    attacker.stats.maxCombo = Math.max(attacker.stats.maxCombo, attacker.combo);
  } else {
    defender.stats.blocked++;
  }
  const comboMult = result === 'landed' ? 1 + Math.min(0.5, 0.1 * (attacker.combo - 1)) : 1;
  const power = clamp(punch.power, 0.3, 1.5);
  const powerMult = 0.55 + 0.45 * power;
  const damage =
    PUNCH_BASE_DAMAGE[punch.type] *
    mult *
    comboMult *
    powerMult *
    staminaFactor *
    (counter ? 1.5 : 1) *
    damageScale;
  const before = defender.health;
  defender.health = Math.max(0, defender.health - damage);
  attacker.stats.damageDealt += before - defender.health;
  if (result === 'landed' && damage > 7) defender.stunnedUntil = now + 350;
  const impact = clamp(damage / 12, result === 'blocked' ? 0.05 : 0.2, 1);
  return { result, damage, combo: result === 'landed' ? attacker.combo : 0, counter, impact };
}
