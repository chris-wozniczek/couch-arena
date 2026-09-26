/** Game-feel helpers shared by modes: map resolved punches onto boxer reactions, audio and screen FX. */
import type { Resolution } from '../core/combat';
import type { PunchEvent } from '../core/types';
import type { Boxer } from '../render/boxer';
import type { GameContext } from './context';

export function hitDirection(p: Pick<PunchEvent, 'type' | 'hand'>): { lateral: number; up: number } {
  const side = p.hand === 'left' ? 1 : -1;
  if (p.type === 'hook') return { lateral: side, up: 0 };
  if (p.type === 'uppercut') return { lateral: side * 0.2, up: 1 };
  return { lateral: side * 0.25, up: 0.1 };
}

/** Applies impact visuals when `victim` (a rendered boxer) is hit. */
export function boxerImpact(ctx: GameContext, victim: Boxer, p: PunchEvent, r: Resolution): void {
  if (r.result === 'slipped' || r.result === 'ducked') {
    ctx.sound.whoosh(p.speed / 5);
    return;
  }
  const blocked = r.result === 'blocked';
  const { lateral, up } = hitDirection(p);
  victim.hit(lateral, up, blocked ? r.impact * 0.3 : r.impact, p.target === 'head');
  ctx.sound.impact(p.type, blocked ? 0.5 : 0.6 + r.impact * 0.5, blocked);
  if (!blocked) {
    ctx.world.hitStop(40 + r.impact * 70);
    ctx.world.shake(0.006 + r.impact * 0.02);
    ctx.world.impactFx(r.impact, false);
    if (r.impact > 0.6) ctx.sound.cheer(r.impact);
  }
}

/** Applies first-person visuals when the local player is hit. */
export function playerImpact(ctx: GameContext, p: PunchEvent, r: Resolution): void {
  if (r.result === 'slipped' || r.result === 'ducked') {
    ctx.sound.whoosh(1.3);
    return;
  }
  const blocked = r.result === 'blocked';
  ctx.sound.impact(p.type, blocked ? 0.55 : 0.8 + r.impact * 0.4, blocked);
  ctx.world.shake(blocked ? 0.01 : 0.025 + r.impact * 0.04);
  if (!blocked) {
    ctx.world.hitStop(50 + r.impact * 60);
    ctx.world.impactFx(r.impact, true);
  }
}

export const RESULT_LABEL: Record<Resolution['result'], string> = {
  landed: 'Landed',
  blocked: 'Blocked',
  slipped: 'Slipped',
  ducked: 'Ducked',
};

export const PUNCH_LABEL: Record<PunchEvent['type'], string> = {
  jab: 'Jab',
  cross: 'Cross',
  hook: 'Hook',
  uppercut: 'Uppercut',
};
