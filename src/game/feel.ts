/** Game-feel helpers shared by modes: map resolved punches onto boxer reactions, audio and screen FX. */
import type { Resolution } from '../core/combat';
import type { PunchEvent } from '../core/types';
import type { Boxer } from '../render/boxer';
import type { GameContext } from './context';

/** Applies impact visuals when `victim` (a rendered boxer) is hit. */
export function boxerImpact(ctx: GameContext, victim: Boxer, p: PunchEvent, r: Resolution): void {
  if (r.result === 'slipped' || r.result === 'ducked') {
    ctx.sound.whoosh(p.speed / 5);
    return;
  }
  const blocked = r.result === 'blocked';
  victim.hit({ type: p.type, hand: p.hand, target: p.target, strength: r.impact, blocked });
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
  if (blocked) ctx.world.gloves.absorb(PUNCH_POWER[p.type]);
  if (!blocked) {
    ctx.world.hitStop(50 + r.impact * 60);
    ctx.world.impactFx(r.impact, true);
  }
}

const PUNCH_POWER: Record<PunchEvent['type'], number> = { jab: 0.3, cross: 0.6, hook: 0.9, uppercut: 1 };

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
