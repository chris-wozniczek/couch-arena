/** Deterministic daily challenge derived from the UTC date, identical on client and server. */
import type { AiProfile } from './ai';
import { AI_PROFILES } from './ai';
import type { MatchSummary } from './scoring';
import { hashString, Rng } from './rng';

export type DailyGoal =
  | { kind: 'win' }
  | { kind: 'koUnder'; ms: number }
  | { kind: 'combo'; n: number }
  | { kind: 'land'; n: number };

export interface DailyChallenge {
  id: string;
  title: string;
  description: string;
  opponent: AiProfile;
  goal: DailyGoal;
  seed: number;
}

const TWISTS = [
  { name: 'Speed Demon', windup: 0.8, aggression: 1.3, defense: 1 },
  { name: 'The Wall', windup: 1.05, aggression: 0.8, defense: 1.6 },
  { name: 'Brawler', windup: 0.95, aggression: 1.6, defense: 0.7 },
  { name: 'Counter Puncher', windup: 0.85, aggression: 0.9, defense: 1.35 },
  { name: 'Glass Jaw', windup: 0.9, aggression: 1.2, defense: 0.8 },
];

export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);

export function dailyChallenge(day: string): DailyChallenge {
  const seed = hashString(`couch-arena:${day}`);
  const rng = new Rng(seed);
  const base = rng.pick([AI_PROFILES.contender, AI_PROFILES.champion]);
  const twist = rng.pick(TWISTS);
  const opponent: AiProfile = {
    ...base,
    id: base.id,
    name: `${twist.name} ${base.name.split(' ').slice(-1)[0]}`,
    windupMs: Math.round(base.windupMs * twist.windup),
    aggression: base.aggression * twist.aggression,
    defense: Math.min(0.7, base.defense * twist.defense),
    toughness: twist.name === 'Glass Jaw' ? 0.7 : base.toughness,
  };
  const goals: DailyGoal[] = [
    { kind: 'win' },
    { kind: 'koUnder', ms: rng.pick([120_000, 150_000, 180_000]) },
    { kind: 'combo', n: rng.pick([5, 6, 8]) },
    { kind: 'land', n: rng.pick([40, 60, 80]) },
  ];
  const goal = rng.pick(goals);
  const desc =
    goal.kind === 'win'
      ? 'Win the fight by any method.'
      : goal.kind === 'koUnder'
        ? `Knock them out in under ${goal.ms / 1000}s of fight time.`
        : goal.kind === 'combo'
          ? `Land a ${goal.n}-hit combo and win.`
          : `Land ${goal.n} punches and win.`;
  return { id: day, title: `Daily: ${opponent.name}`, description: desc, opponent, goal, seed };
}

export function goalMet(goal: DailyGoal, s: MatchSummary): boolean {
  if (!s.won) return false;
  switch (goal.kind) {
    case 'win':
      return true;
    case 'koUnder':
      return (s.method === 'KO' || s.method === 'TKO') && s.durationMs <= goal.ms;
    case 'combo':
      return s.maxCombo >= goal.n;
    case 'land':
      return s.landed >= goal.n;
  }
}
