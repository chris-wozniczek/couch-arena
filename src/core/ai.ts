/**
 * Opponent AI for single player. Deterministic given a seed. Produces telegraphed punches (wind-up then
 * impact) the player can read and defend, reacts to incoming punches with difficulty-dependent
 * probability, manages its own stamina, and exposes continuous state for animation.
 */
import type { Fighter } from './combat';
import { clamp } from './math';
import { Rng } from './rng';
import type { DefenseKind, Hand, PunchEvent, PunchType, Target } from './types';

export interface AiProfile {
  id: string;
  name: string;
  /** Average attacks initiated per second while idle. */
  aggression: number;
  /** Telegraph (wind-up) duration in ms: shorter = harder to defend. */
  windupMs: number;
  /** Probability to evade/block a punch it is not committed against. */
  defense: number;
  /** Probability the guard is up while idle. */
  guardiness: number;
  /** Max punches per combo. */
  maxCombo: number;
  /** Damage multiplier for its punches. */
  damageScale: number;
  /** Health multiplier (applied by the game setup). */
  toughness: number;
}

export const AI_PROFILES: Record<'rookie' | 'contender' | 'champion' | 'legend', AiProfile> = {
  rookie: {
    id: 'rookie',
    name: 'Rookie Rocco',
    aggression: 0.45,
    windupMs: 720,
    defense: 0.18,
    guardiness: 0.35,
    maxCombo: 2,
    damageScale: 0.7,
    toughness: 0.8,
  },
  contender: {
    id: 'contender',
    name: 'Iron Ivan',
    aggression: 0.7,
    windupMs: 560,
    defense: 0.32,
    guardiness: 0.5,
    maxCombo: 3,
    damageScale: 0.95,
    toughness: 1,
  },
  champion: {
    id: 'champion',
    name: 'Champ "Cobra" Cole',
    aggression: 1.0,
    windupMs: 440,
    defense: 0.45,
    guardiness: 0.62,
    maxCombo: 4,
    damageScale: 1.15,
    toughness: 1.2,
  },
  legend: {
    id: 'legend',
    name: 'The Legend',
    aggression: 1.3,
    windupMs: 360,
    defense: 0.55,
    guardiness: 0.7,
    maxCombo: 5,
    damageScale: 1.3,
    toughness: 1.4,
  },
};

export type AiActionKind = 'idle' | 'windup' | 'recover' | 'defend' | 'hurt' | 'down' | 'taunt';

export interface AiAction {
  kind: AiActionKind;
  start: number;
  end: number;
  punch?: { type: PunchType; hand: Hand; target: Target };
  defense?: DefenseKind;
  heavy?: boolean;
}

const COMBOS: ReadonlyArray<ReadonlyArray<[PunchType, Target]>> = [
  [['jab', 'head']],
  [
    ['jab', 'head'],
    ['cross', 'head'],
  ],
  [
    ['jab', 'head'],
    ['jab', 'head'],
    ['cross', 'head'],
  ],
  [
    ['jab', 'head'],
    ['hook', 'head'],
  ],
  [
    ['cross', 'head'],
    ['hook', 'head'],
    ['cross', 'head'],
  ],
  [
    ['jab', 'body'],
    ['uppercut', 'head'],
  ],
  [
    ['hook', 'body'],
    ['hook', 'head'],
  ],
  [
    ['jab', 'head'],
    ['cross', 'body'],
    ['hook', 'head'],
    ['cross', 'head'],
  ],
  [
    ['uppercut', 'head'],
    ['hook', 'head'],
  ],
  [
    ['jab', 'head'],
    ['cross', 'head'],
    ['hook', 'body'],
    ['uppercut', 'head'],
    ['cross', 'head'],
  ],
];

export interface AiContext {
  now: number;
  self: Fighter;
  /** The player's current defense (AI prefers attacking openings). */
  playerDefense: DefenseKind;
}

export class OpponentAI {
  action: AiAction = { kind: 'idle', start: 0, end: 0 };
  guardUp = true;
  /** Lateral stepping target in meters (-0.4..0.4), for animation/footwork. */
  stepX = 0;
  private queue: Array<[PunchType, Target]> = [];
  private nextThink = 0;
  private rng: Rng;
  private lead: Hand = 'left';

  constructor(
    public profile: AiProfile,
    seed = 1,
  ) {
    this.rng = new Rng(seed);
  }

  reset(now: number): void {
    this.action = { kind: 'idle', start: now, end: now };
    this.queue = [];
    this.nextThink = now + 1200;
  }

  /** Current effective defense for resolving a punch landing right now. */
  defenseNow(now: number): DefenseKind {
    const a = this.action;
    if (a.kind === 'defend' && now < a.end) return a.defense ?? 'guard';
    if (a.kind === 'idle' && this.guardUp) return 'guard';
    return 'none';
  }

  private handFor(type: PunchType): Hand {
    const rear: Hand = this.lead === 'left' ? 'right' : 'left';
    if (type === 'jab') return this.lead;
    if (type === 'cross') return rear;
    return this.rng.chance(0.5) ? this.lead : rear;
  }

  private startPunch(now: number, type: PunchType, target: Target, windupScale = 1): void {
    const w = this.profile.windupMs * windupScale * (type === 'jab' ? 0.8 : type === 'cross' ? 1 : 1.12);
    this.action = {
      kind: 'windup',
      start: now,
      end: now + w,
      punch: { type, hand: this.handFor(type), target },
    };
  }

  /**
   * Advance the AI. Returns a punch event when a wind-up reaches its impact moment.
   */
  update(ctx: AiContext): PunchEvent | null {
    const { now, self } = ctx;
    const a = this.action;
    if (self.down) {
      if (a.kind !== 'down') this.action = { kind: 'down', start: now, end: now + 1e9 };
      return null;
    }
    if (a.kind === 'down') this.action = { kind: 'idle', start: now, end: now };

    if (a.kind === 'windup' && now >= a.end) {
      const p = a.punch!;
      this.action = { kind: 'recover', start: now, end: now + 180 + this.rng.range(0, 120) };
      return {
        hand: p.hand,
        type: p.type,
        target: p.target,
        speed: 5,
        power: clamp(0.75 + this.rng.range(0, 0.35) * (self.stamina / 100), 0.3, 1.5),
        time: now,
      };
    }
    if (
      (a.kind === 'recover' || a.kind === 'defend' || a.kind === 'hurt' || a.kind === 'taunt') &&
      now >= a.end
    ) {
      if (a.kind === 'recover' && this.queue.length) {
        const [t, tg] = this.queue.shift()!;
        this.startPunch(now, t, tg, 0.75);
        return null;
      }
      this.action = { kind: 'idle', start: now, end: now };
    }

    if (this.action.kind === 'idle' && now >= this.nextThink) this.think(ctx);
    return null;
  }

  private think(ctx: AiContext): void {
    const { now, self } = ctx;
    const P = this.profile;
    this.nextThink = now + this.rng.range(250, 550);
    this.guardUp = this.rng.chance(P.guardiness);
    if (this.rng.chance(0.35)) this.stepX = this.rng.range(-0.35, 0.35);
    const tired = self.stamina < 25;
    const opening = ctx.playerDefense === 'none' ? 1.4 : 1;
    const pAttack = ((P.aggression * 0.4 * opening) / (tired ? 2.5 : 1)) * (self.stamina > 10 ? 1 : 0);
    if (this.rng.chance(pAttack)) {
      const maxIdx = Math.min(COMBOS.length - 1, 1 + P.maxCombo * 2);
      const combo = COMBOS[this.rng.int(0, maxIdx)]!.slice(0, P.maxCombo);
      const [first, ...rest] = combo;
      this.queue = rest.map((c) => [c[0], c[1]]);
      this.startPunch(now, first![0], first![1]);
    } else if (this.rng.chance(0.04)) {
      this.action = { kind: 'taunt', start: now, end: now + 1100 };
    }
  }

  /**
   * Called when the player throws a punch. Decides whether the AI evades/blocks and returns the defense
   * to use in resolution (and animates it).
   */
  reactToPunch(p: PunchEvent, now: number, self: Fighter): DefenseKind {
    const a = this.action;
    const committed = a.kind === 'windup' && a.end - now < 160;
    if (a.kind === 'hurt' || a.kind === 'down' || committed)
      return a.kind === 'windup' ? 'none' : this.defenseNow(now);
    const fatigue = 0.6 + 0.4 * (self.stamina / 100);
    // Faster punches are harder to read.
    const readability = clamp(1.25 - 0.35 * p.power, 0.55, 1.1);
    if (this.rng.chance(this.profile.defense * fatigue * readability)) {
      let d: DefenseKind;
      if (p.type === 'hook') d = p.target === 'head' ? 'duck' : 'guard';
      else if (p.type === 'uppercut') d = this.rng.chance(0.5) ? 'slipLeft' : 'guard';
      else
        d =
          p.target === 'head' ? this.rng.pick(['slipLeft', 'slipRight', 'guard', 'duck'] as const) : 'guard';
      if (a.kind === 'windup') this.queue = [];
      this.action = { kind: 'defend', start: now, end: now + 420, defense: d };
      return d;
    }
    return this.defenseNow(now);
  }

  onHit(now: number, heavy: boolean): void {
    this.queue = [];
    this.action = { kind: 'hurt', start: now, end: now + (heavy ? 520 : 300), heavy };
    this.nextThink = Math.max(this.nextThink, now + (heavy ? 700 : 350));
  }
}
