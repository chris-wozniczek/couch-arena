/**
 * Drivers that turn game state into a `BoxerPose` for the rig:
 * - `AiAnimator`: telegraphed wind-ups, strikes, defenses and hurt reactions from `OpponentAI` actions.
 * - `trackedPose`: a tracked (local or remote) player's arm positions, scaled to the rig's arm length.
 */
import type { AiAction } from '../core/ai';
import type { BodyFeatures } from '../core/body';
import { clamp, lerp, smoothstep } from '../core/math';
import { decodeDefense } from '../core/netcode';
import type { PoseSnapshot } from '../core/netcode';
import type { Hand, PunchType, Stance, Target, Vec3 } from '../core/types';
import { GUARD_POSE } from './boxer';
import type { ArmPose, BoxerPose } from './boxer';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

/** Wrist position along a punch's path at progress u (0 guard → 1 full extension), fighter frame. */
export function punchPath(
  type: PunchType,
  hand: Hand,
  target: Target,
  u: number,
  guard: Vec3,
  reach: number,
): { wrist: Vec3; pole: Vec3; roll: number } {
  const sx = hand === 'left' ? -1 : 1;
  const ty = target === 'head' ? 0.05 : -0.22;
  const e = smoothstep(0, 1, u);
  if (type === 'jab' || type === 'cross') {
    const end = v(sx * -0.02, ty, reach * 0.98);
    return { wrist: lerp3(guard, end, e), pole: v(sx * 0.8, -0.6, 0), roll: e * 0.5 * -1 };
  }
  if (type === 'hook') {
    const wide = v(sx * 0.42, ty + 0.02, reach * 0.42);
    const across = v(-sx * 0.1, ty, reach * 0.62);
    const w =
      u < 0.5
        ? lerp3(guard, wide, smoothstep(0, 1, u * 2))
        : lerp3(wide, across, smoothstep(0, 1, (u - 0.5) * 2));
    return { wrist: w, pole: v(sx * 1, 0.5, -0.2), roll: 1.4 * e };
  }
  // Uppercut: dip then rise.
  const low = v(sx * 0.1, -0.28, reach * 0.35);
  const high = v(sx * 0.02, ty + 0.1, reach * 0.6);
  const w =
    u < 0.4
      ? lerp3(guard, low, smoothstep(0, 1, u / 0.4))
      : lerp3(low, high, smoothstep(0, 1, (u - 0.4) / 0.6));
  return { wrist: w, pole: v(sx * 0.5, -1, 0.3), roll: -0.3 * e };
}

export class AiAnimator {
  pose: BoxerPose;
  private lean = 0;
  private duck = 0;
  private twist = 0;
  private lunge = 0;
  private last: AiAction | null = null;
  private strikeStart = -1e9;
  private strike: { type: PunchType; hand: Hand; target: Target } | null = null;

  constructor(
    private stance: Stance = 'orthodox',
    private reach = 0.62,
  ) {
    this.pose = GUARD_POSE(stance);
  }

  /** Duration of the visible strike (last part of wind-up + into recover). */
  static STRIKE_MS = 150;

  update(a: AiAction, now: number, dt: number, guardUp: boolean): BoxerPose {
    const G = GUARD_POSE(this.stance);
    let lean = 0;
    let duck = 0;
    let twist = 0;
    let lunge = 0;
    const arms: Record<Hand, ArmPose> = { left: { ...G.left }, right: { ...G.right } };
    if (!guardUp && a.kind === 'idle') {
      arms.left.wrist = v(-0.18, -0.12, 0.2);
      arms.right.wrist = v(0.18, -0.14, 0.15);
    }
    if (a.kind === 'windup' && a.punch) {
      const total = a.end - a.start;
      const tStrike = a.end - AiAnimator.STRIKE_MS;
      const p = a.punch;
      const sx = p.hand === 'left' ? -1 : 1;
      if (now < tStrike) {
        // Telegraph: cock back, dip shoulder, twist away.
        const u = clamp((now - a.start) / Math.max(1, total - AiAnimator.STRIKE_MS));
        const k = smoothstep(0, 1, u);
        const arm = arms[p.hand];
        const cock =
          p.type === 'hook'
            ? v(sx * 0.3, 0.06, 0.12)
            : p.type === 'uppercut'
              ? v(sx * 0.16, -0.2, 0.14)
              : v(sx * 0.14, 0.1, 0.1);
        arm.wrist = lerp3(arm.wrist, cock, k);
        twist = -sx * 0.35 * k;
        duck = p.type === 'uppercut' ? 0.06 * k : 0;
      } else {
        this.strikeStart = tStrike;
        this.strike = p;
      }
    }
    if (this.strike && now - this.strikeStart < AiAnimator.STRIKE_MS + 200) {
      const t = now - this.strikeStart;
      const p = this.strike;
      const sx = p.hand === 'left' ? -1 : 1;
      const out = t < AiAnimator.STRIKE_MS ? t / AiAnimator.STRIKE_MS : 1 - (t - AiAnimator.STRIKE_MS) / 200;
      const u = clamp(out);
      const path = punchPath(p.type, p.hand, p.target, u, G[p.hand].wrist, this.reach + 0.22);
      arms[p.hand] = { wrist: path.wrist, pole: path.pole, roll: path.roll };
      twist = sx * 0.45 * u;
      lunge = 0.22 * u;
    } else this.strike = null;

    if (a.kind === 'defend') {
      const k =
        smoothstep(0, 1, clamp((now - a.start) / 110)) *
        (1 - smoothstep(0, 1, clamp((now - (a.end - 140)) / 140)));
      if (a.defense === 'slipLeft') lean = -0.2 * k;
      else if (a.defense === 'slipRight') lean = 0.2 * k;
      else if (a.defense === 'duck') duck = 0.24 * k;
      else {
        arms.left.wrist = lerp3(arms.left.wrist, v(-0.07, 0.2, 0.2), k);
        arms.right.wrist = lerp3(arms.right.wrist, v(0.07, 0.2, 0.2), k);
      }
    }
    if (a.kind === 'hurt') {
      const k = 1 - clamp((now - a.start) / (a.end - a.start));
      arms.left.wrist = lerp3(arms.left.wrist, v(-0.2, -0.05, 0.18), k * (a.heavy ? 0.9 : 0.4));
      arms.right.wrist = lerp3(arms.right.wrist, v(0.2, -0.07, 0.15), k * (a.heavy ? 0.9 : 0.4));
      lunge = -0.1 * k;
    }
    if (a.kind === 'taunt') {
      const k = Math.sin(clamp((now - a.start) / (a.end - a.start)) * Math.PI);
      arms.left.wrist = lerp3(arms.left.wrist, v(-0.3, -0.25, 0.1), k);
      arms.right.wrist = lerp3(arms.right.wrist, v(0.3, -0.25, 0.1), k);
      lean = Math.sin(now / 120) * 0.05 * k;
    }
    this.last = a;
    const r = Math.min(1, dt * 18);
    this.lean += (lean - this.lean) * r;
    this.duck += (duck - this.duck) * r;
    this.twist += (twist - this.twist) * Math.min(1, dt * 24);
    this.lunge += (lunge - this.lunge) * Math.min(1, dt * 24);
    this.pose = {
      left: arms.left,
      right: arms.right,
      lean: this.lean,
      duck: this.duck,
      twist: this.twist,
      lunge: this.lunge,
    };
    return this.pose;
  }

  get lastAction(): AiAction | null {
    return this.last;
  }
}

/**
 * Pose for a tracked player (features are in the same fighter frame as the rig). Positions are scaled by
 * rig arm length / player arm length so reach looks right regardless of the player's size.
 */
export function trackedPose(
  f: BodyFeatures,
  rigReach: number,
  headOffset: { x: number; y: number },
): BoxerPose {
  const k = rigReach / Math.max(0.3, f.armLength);
  const arm = (h: Hand): ArmPose => {
    const a = f.arms[h];
    const sx = h === 'left' ? -1 : 1;
    const ext = a.extension;
    const lateral = Math.abs(a.wrist.x - a.shoulder.x);
    return {
      wrist: v(a.wrist.x * k, a.wrist.y * k, Math.max(0.08, a.wrist.z * k)),
      pole: {
        x: (a.elbow.x - (a.shoulder.x + a.wrist.x) / 2) * 4 + sx * 0.3,
        y: (a.elbow.y - (a.shoulder.y + a.wrist.y) / 2) * 4 - 0.3,
        z: 0,
      },
      roll: lateral > 0.3 && ext > 0.4 ? 1.2 : 0,
    };
  };
  return {
    left: arm('left'),
    right: arm('right'),
    lean: clamp(headOffset.x * 0.22, -0.25, 0.25),
    duck: clamp(headOffset.y * 0.2, 0, 0.28),
    twist: clamp((f.arms.left.shoulder.z - f.arms.right.shoulder.z) * 2.2, -0.5, 0.5),
    lunge: 0,
  };
}

/** Pose from a network snapshot (wrists/elbows relative to shoulder midpoint, meters, fighter frame). */
export function snapshotPose(s: PoseSnapshot, rigReach: number, playerReach = 0.6): BoxerPose {
  const k = rigReach / playerReach;
  const d = decodeDefense(s.d);
  const arm = (i: number, h: Hand): ArmPose => {
    const sx = h === 'left' ? -1 : 1;
    const w = v(s.w[i]! * k, s.w[i + 1]! * k, Math.max(0.08, s.w[i + 2]! * k));
    const e = v(s.e[i]! * k, s.e[i + 1]! * k, s.e[i + 2]! * k);
    return { wrist: w, pole: v((e.x - w.x / 2) * 4 + sx * 0.3, (e.y - w.y / 2) * 4 - 0.3, 0), roll: 0 };
  };
  return {
    left: arm(0, 'left'),
    right: arm(3, 'right'),
    lean: clamp(s.h[0] * 0.22, -0.25, 0.25),
    duck: d.duck ? 0.22 : clamp(s.h[1] * 0.2, 0, 0.28),
    twist: 0,
    lunge: 0,
  };
}
