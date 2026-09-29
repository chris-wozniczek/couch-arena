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
import { GUARD_POSE, GUARD_ROLL } from './boxer';
import type { ArmPose, BoxerPose } from './boxer';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

/** Point on a punch's path plus the body mechanics that drive it (fighter frame). */
export interface PunchFrame {
  wrist: Vec3;
  pole: Vec3;
  roll: number;
  /** Torso yaw (+ turns the right shoulder forward), knee dip (m) and forward weight shift (m). */
  twist: number;
  dip: number;
  lunge: number;
}

/** Guard hand tucked at the chin while the other hand punches. */
const CHIN_GUARD = (hand: Hand): Vec3 => v(hand === 'left' ? -0.085 : 0.085, 0.15, 0.19);
/** High "earmuff" block: gloves at the temples, forearms vertical, elbows squeezed in over the ribs. */
const HIGH_GUARD = (hand: Hand): Vec3 => v(hand === 'left' ? -0.09 : 0.09, 0.22, 0.13);

/** Fast out, soft stop at extension (a punch snaps out and is pulled back, it doesn't glide). */
const snap = (u: number): number => 1 - Math.pow(1 - clamp(u), 2.6);

/**
 * A punch at phase `u`: 0 → 1 drives from guard to full extension, 1 → 2 retracts to guard along a slightly
 * lower, tighter line. Mechanics follow real technique:
 * - jab/cross: elbow stays down until the last third, then the fist corkscrews palm-down on a straight line
 *   to the chin while the shoulder rolls up; the cross turns the hips and shifts weight forward.
 * - hook: the elbow lifts to shoulder height with the forearm level, and the fist travels a short arc
 *   around the turning torso (thumb up) rather than a wide swing.
 * - uppercut: knees dip and the fist drops to the chest, then legs and hips drive it up on a vertical line
 *   with the palm facing the puncher.
 */
export function punchPath(
  type: PunchType,
  hand: Hand,
  target: Target,
  u: number,
  guard: Vec3,
  reach: number,
): PunchFrame {
  const sx = hand === 'left' ? -1 : 1;
  const ty = target === 'head' ? 0.06 : -0.24;
  const back = u > 1;
  const t = back ? 2 - clamp(u, 1, 2) : clamp(u);
  const g = { wrist: guard, pole: v(sx * 0.35, -1, 0.05), roll: GUARD_ROLL };
  if (type === 'jab' || type === 'cross') {
    const e = back ? smoothstep(0, 1, t) : snap(t);
    const across = type === 'cross' ? -sx * 0.07 : -sx * 0.025;
    const end = v(across, ty, reach * 0.97);
    const w = lerp3(guard, end, e);
    // Retract a touch lower and tighter so the hand comes straight back to the chin.
    if (back) w.y -= Math.sin(t * Math.PI) * 0.03;
    else w.y += Math.sin(t * Math.PI) * 0.02;
    const turn = smoothstep(0.45, 1, t);
    const rear = type === 'cross';
    return {
      wrist: w,
      pole: lerp3(g.pole, v(sx * 0.9, -0.35, -0.1), turn),
      roll: lerp(GUARD_ROLL, -0.12, turn),
      twist: sx * (rear ? 0.55 : 0.2) * e,
      dip: rear ? 0.02 * e : 0,
      lunge: (rear ? 0.13 : 0.07) * e,
    };
  }
  if (type === 'hook') {
    const e = smoothstep(0, 1, t);
    // Chamber: elbow up, fist level at the side of the face (compact, not a wide loop).
    const R = reach * (target === 'head' ? 0.62 : 0.58);
    const start = (62 * Math.PI) / 180;
    const finish = (-10 * Math.PI) / 180;
    const phi = lerp(start, finish, smoothstep(0.2, 1, t));
    const arc = v(sx * R * Math.sin(phi), ty + 0.02, R * Math.cos(phi) + 0.05);
    const load = smoothstep(0, 0.3, t);
    const w = back ? lerp3(guard, v(sx * 0.12, ty * 0.5 + 0.08, reach * 0.45), e) : lerp3(guard, arc, load);
    return {
      wrist: w,
      pole: lerp3(g.pole, v(sx * 1, target === 'head' ? 0.35 : -0.2, -0.35), load),
      roll: lerp(GUARD_ROLL, 1.35, load),
      twist: sx * (0.75 * smoothstep(0.1, 1, t) - 0.08 * (1 - t) * load),
      dip: target === 'body' ? 0.1 * load : 0.03 * load,
      lunge: 0.04 * e,
    };
  }
  // Uppercut.
  const sink = smoothstep(0, 0.35, t);
  const drive = smoothstep(0.3, 1, t);
  const low = v(sx * 0.08, target === 'head' ? -0.14 : -0.22, 0.24);
  const high = v(-sx * 0.02, ty + (target === 'head' ? 0.02 : 0.08), reach * 0.58);
  const w = back
    ? lerp3(guard, v(sx * 0.05, ty * 0.5 + 0.04, reach * 0.4), smoothstep(0, 1, t))
    : lerp3(lerp3(guard, low, sink), high, drive);
  return {
    wrist: w,
    pole: lerp3(g.pole, v(sx * 0.3, -1, 0.35), sink),
    roll: lerp(GUARD_ROLL, 0.05, sink),
    twist: sx * (0.45 * drive - 0.12 * sink * (1 - drive)),
    // Sit into the legs, then rise through the punch.
    dip: 0.09 * sink * (1 - drive) - 0.025 * drive,
    lunge: 0.06 * drive,
  };
}

const RETRACT_MS = 230;

export class AiAnimator {
  pose: BoxerPose;
  private lean = 0;
  private duck = 0;
  private twist = 0;
  private lunge = 0;
  private arms: Record<Hand, ArmPose>;
  private last: AiAction | null = null;
  private strikeStart = -1e9;
  private strike: { type: PunchType; hand: Hand; target: Target } | null = null;

  constructor(
    private stance: Stance = 'orthodox',
    private reach = 0.62,
  ) {
    this.pose = GUARD_POSE(stance);
    this.arms = { left: { ...this.pose.left }, right: { ...this.pose.right } };
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
      arms.left.wrist = v(-0.17, -0.1, 0.22);
      arms.right.wrist = v(0.17, -0.13, 0.17);
      arms.left.roll = arms.right.roll = 1.3;
    }
    if (a.kind === 'windup' && a.punch) {
      const total = a.end - a.start;
      const tStrike = a.end - AiAnimator.STRIKE_MS;
      const p = a.punch;
      const sx = p.hand === 'left' ? -1 : 1;
      if (now < tStrike) {
        // Telegraph: load the punching side (shoulder dips, weight shifts), the other hand tightens up.
        const u = clamp((now - a.start) / Math.max(1, total - AiAnimator.STRIKE_MS));
        const k = smoothstep(0, 1, u);
        const arm = arms[p.hand];
        const cock =
          p.type === 'hook'
            ? v(sx * 0.2, 0.07, 0.16)
            : p.type === 'uppercut'
              ? v(sx * 0.13, -0.08, 0.17)
              : v(sx * 0.12, 0.1, 0.13);
        arm.wrist = lerp3(arm.wrist, cock, k);
        if (p.type === 'hook') arm.pole = lerp3(arm.pole, v(sx * 0.8, -0.2, -0.3), k);
        const other = p.hand === 'left' ? 'right' : 'left';
        arms[other].wrist = lerp3(arms[other].wrist, CHIN_GUARD(other), k);
        twist = -sx * (p.type === 'hook' ? 0.3 : 0.22) * k;
        duck = (p.type === 'uppercut' ? 0.07 : p.target === 'body' ? 0.05 : 0.015) * k;
        lean = sx * (p.type === 'hook' ? 0.05 : 0.02) * k;
      } else {
        this.strikeStart = tStrike;
        this.strike = p;
      }
    }
    let striking = false;
    if (this.strike && now - this.strikeStart < AiAnimator.STRIKE_MS + RETRACT_MS) {
      const t = now - this.strikeStart;
      const p = this.strike;
      const u =
        t < AiAnimator.STRIKE_MS ? t / AiAnimator.STRIKE_MS : 1 + (t - AiAnimator.STRIKE_MS) / RETRACT_MS;
      const f = punchPath(p.type, p.hand, p.target, u, G[p.hand].wrist, this.reach + 0.22);
      arms[p.hand] = { wrist: f.wrist, pole: f.pole, roll: f.roll };
      const other = p.hand === 'left' ? 'right' : 'left';
      const cover = u <= 1 ? smoothstep(0, 0.4, u) : 1 - smoothstep(1.3, 2, u);
      arms[other].wrist = lerp3(arms[other].wrist, CHIN_GUARD(other), cover);
      twist = f.twist;
      duck = f.dip;
      lunge = f.lunge;
      // Head stays off the centre line behind the punch.
      lean = -(p.hand === 'left' ? -1 : 1) * 0.04 * cover;
      striking = true;
    } else this.strike = null;

    if (a.kind === 'defend') {
      const k =
        smoothstep(0, 1, clamp((now - a.start) / 110)) *
        (1 - smoothstep(0, 1, clamp((now - (a.end - 140)) / 140)));
      if (a.defense === 'slipLeft' || a.defense === 'slipRight') {
        const s = a.defense === 'slipLeft' ? -1 : 1;
        lean = 0.2 * s * k;
        duck = 0.05 * k;
        twist = 0.18 * s * k;
      } else if (a.defense === 'duck') {
        duck = 0.24 * k;
        for (const h of ['left', 'right'] as const) arms[h].wrist = lerp3(arms[h].wrist, CHIN_GUARD(h), k);
      } else {
        for (const h of ['left', 'right'] as const) {
          const sx = h === 'left' ? -1 : 1;
          arms[h] = {
            wrist: lerp3(arms[h].wrist, HIGH_GUARD(h), k),
            pole: lerp3(arms[h].pole, v(sx * 0.12, -1, 0.35), k),
            roll: lerp(arms[h].roll, 0.2, k),
          };
        }
        duck = 0.035 * k;
        lunge = -0.03 * k;
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
    // Non-striking arm moves are eased so guard changes read as motion, not pops; the punching arm is
    // exact so its timing matches the hit.
    const ease = Math.min(1, dt * 22);
    for (const h of ['left', 'right'] as const) {
      const exact = striking && this.strike?.hand === h;
      const cur = this.arms[h];
      const want = arms[h];
      this.arms[h] = exact
        ? want
        : {
            wrist: lerp3(cur.wrist, want.wrist, ease),
            pole: lerp3(cur.pole, want.pole, ease),
            roll: lerp(cur.roll, want.roll, ease),
          };
    }
    const r = Math.min(1, dt * 18);
    this.lean += (lean - this.lean) * r;
    this.duck += (duck - this.duck) * Math.min(1, dt * 24);
    this.twist += (twist - this.twist) * Math.min(1, dt * 26);
    this.lunge += (lunge - this.lunge) * Math.min(1, dt * 26);
    this.pose = {
      left: this.arms.left,
      right: this.arms.right,
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

/** Glove roll for a tracked arm: corkscrews palm-down as a straight extends, thumb-up for wide hooks. */
export function trackedRoll(extension: number, lateral: number): number {
  if (lateral > 0.28 && extension > 0.4) return 1.35;
  return lerp(GUARD_ROLL, -0.1, smoothstep(0.55, 0.95, extension));
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
      roll: trackedRoll(ext, lateral),
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
    return {
      wrist: w,
      pole: v((e.x - w.x / 2) * 4 + sx * 0.3, (e.y - w.y / 2) * 4 - 0.3, 0),
      roll: trackedRoll(clamp(Math.hypot(w.x, w.y, w.z) / rigReach), Math.abs(w.x) - 0.18),
    };
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
