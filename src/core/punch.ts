/**
 * Punch recognition from a stream of `BodyFeatures`.
 *
 * Each arm runs a small state machine:
 *   ready ──(speed > onset)──▶ tracking ──(shape matches jab/cross/hook/uppercut)──▶ fired
 *   fired ──(hand retracts & slows, min cooldown)──▶ ready          tracking ──(timeout)──▶ ready
 *
 * Signals: wrist velocity in the metric body frame (toward camera = +z), displacement since onset,
 * elbow extension angle, elbow height, and the forward reach relative to the calibrated arm length.
 * Thresholds scale with the player's calibrated arm length and punch speed, and use hysteresis so a
 * single motion can never fire twice.
 */
import type { BodyFeatures } from './body';
import type { CalibrationProfile } from './calibration';
import { DEFAULT_PROFILE } from './calibration';
import { clamp } from './math';
import type { Hand, PunchEvent, PunchType, Target, Vec3 } from './types';

export interface PunchTuning {
  /** Onset speed as a fraction of the calibrated punch speed. */
  onsetFrac: number;
  /** Absolute minimum onset speed (m/s). */
  minOnset: number;
  /** Straight punch: forward reach (fraction of arm length) needed to fire. */
  straightForward: number;
  /** Straight punch: minimum elbow extension (0..1). */
  straightExtension: number;
  /** Hook: lateral travel toward the midline (fraction of arm length). */
  hookLateral: number;
  /** Uppercut: upward travel (fraction of arm length). */
  uppercutRise: number;
  /** Max time from onset to classification (ms). */
  windowMs: number;
  /** Minimum time between two punches of the same hand (ms). */
  cooldownMs: number;
  /** Re-arm when forward reach drops below this fraction of arm length. */
  rearmForward: number;
  /** ...or when it drops this fraction of arm length below its post-punch peak. */
  rearmDrop: number;
}

export const DEFAULT_TUNING: PunchTuning = {
  onsetFrac: 0.38,
  minOnset: 1.0,
  straightForward: 0.5,
  straightExtension: 0.62,
  hookLateral: 0.32,
  uppercutRise: 0.34,
  windowMs: 380,
  cooldownMs: 170,
  rearmForward: 0.36,
  rearmDrop: 0.15,
};

interface Sample {
  t: number;
  wrist: Vec3;
  forward: number;
  extension: number;
  elbowY: number;
  shoulderY: number;
}

type ArmPhase = 'ready' | 'tracking' | 'fired';

class ArmTracker {
  phase: ArmPhase = 'ready';
  history: Sample[] = [];
  onset: Sample | null = null;
  /** Extremes since onset, used as anchors so wind-ups (dip, cock-back) don't hide the real motion. */
  lowest: Sample | null = null;
  outermost: Sample | null = null;
  rearmost: Sample | null = null;
  peakSpeed = 0;
  peakForward = 0;
  lastFire = -1e9;
  velocity: Vec3 = { x: 0, y: 0, z: 0 };
  speed = 0;
  constructor(readonly hand: Hand) {}
}

export class PunchDetector {
  private arms: Record<Hand, ArmTracker> = { left: new ArmTracker('left'), right: new ArmTracker('right') };
  profile: CalibrationProfile;
  tuning: PunchTuning;

  constructor(profile: CalibrationProfile = DEFAULT_PROFILE, tuning: PunchTuning = DEFAULT_TUNING) {
    this.profile = profile;
    this.tuning = tuning;
  }

  reset(): void {
    this.arms = { left: new ArmTracker('left'), right: new ArmTracker('right') };
  }

  /** Current smoothed wrist speed (m/s) for UI/telemetry. */
  speed(hand: Hand): number {
    return this.arms[hand].speed;
  }

  phase(hand: Hand): ArmPhase {
    return this.arms[hand].phase;
  }

  private trackExtremes(a: ArmTracker, q: Sample): void {
    const inwardSign = a.hand === 'left' ? 1 : -1;
    if (q.wrist.y < a.lowest!.wrist.y) a.lowest = q;
    if (q.wrist.x * inwardSign < a.outermost!.wrist.x * inwardSign) a.outermost = q;
    if (q.wrist.z < a.rearmost!.wrist.z) a.rearmost = q;
  }

  private leadHand(): Hand {
    return this.profile.stance === 'orthodox' ? 'left' : 'right';
  }

  /** Feed one frame; returns any punches recognized on this frame. */
  update(b: BodyFeatures): PunchEvent[] {
    const out: PunchEvent[] = [];
    if (!b.valid) {
      for (const h of ['left', 'right'] as const) {
        const a = this.arms[h];
        a.history.length = 0;
        if (a.phase === 'tracking') a.phase = 'ready';
      }
      return out;
    }
    for (const hand of ['left', 'right'] as const) {
      const ev = this.updateArm(this.arms[hand], b);
      if (ev) out.push(ev);
    }
    return out;
  }

  private updateArm(a: ArmTracker, b: BodyFeatures): PunchEvent | null {
    const f = b.arms[a.hand];
    const T = this.tuning;
    const L = this.profile.armLength;
    const s: Sample = {
      t: b.time,
      wrist: f.wrist,
      forward: f.forward,
      extension: f.extension,
      elbowY: f.elbow.y,
      shoulderY: f.shoulder.y,
    };
    const h = a.history;
    h.push(s);
    while (h.length > 2 && s.t - h[0]!.t > 400) h.shift();

    // Velocity over a ~40 ms window (robust to single noisy frames).
    let ref = h[h.length - 2];
    for (let i = h.length - 2; i >= 0; i--) {
      ref = h[i];
      if (s.t - h[i]!.t >= 40) break;
    }
    if (ref && ref !== s && s.t > ref.t) {
      const dt = (s.t - ref.t) / 1000;
      a.velocity = {
        x: (s.wrist.x - ref.wrist.x) / dt,
        y: (s.wrist.y - ref.wrist.y) / dt,
        z: (s.wrist.z - ref.wrist.z) / dt,
      };
      a.speed = Math.hypot(a.velocity.x, a.velocity.y, a.velocity.z);
    }

    const onsetSpeed = Math.max(T.minOnset, T.onsetFrac * this.profile.punchSpeed);

    if (a.phase === 'fired') {
      a.peakForward = Math.max(a.peakForward, f.forward);
      // Re-arm once the hand came back toward guard (absolute) or pulled back clearly from its peak
      // (fast combos rarely retract fully).
      const retracted =
        (f.forward < Math.max(T.rearmForward * L, this.profile.guardForward + 0.15 * L) ||
          f.forward < a.peakForward - T.rearmDrop * L) &&
        a.speed < onsetSpeed * 1.2;
      if ((retracted && s.t - a.lastFire > T.cooldownMs) || s.t - a.lastFire > 900) a.phase = 'ready';
      return null;
    }

    if (a.phase === 'ready') {
      if (a.speed > onsetSpeed && s.t - a.lastFire > T.cooldownMs) {
        a.phase = 'tracking';
        // Onset = the most recent slow sample (start of the motion).
        let o = h[0]!;
        for (let i = h.length - 1; i >= 0; i--) {
          if (s.t - h[i]!.t > 140) break;
          o = h[i]!;
        }
        a.onset = o;
        a.lowest = o;
        a.outermost = o;
        a.rearmost = o;
        for (const q of h) if (q.t >= o.t) this.trackExtremes(a, q);
        a.peakSpeed = a.speed;
      } else return null;
    }

    // tracking
    a.peakSpeed = Math.max(a.peakSpeed, a.speed);
    this.trackExtremes(a, s);
    const o = a.onset!;
    if (s.t - o.t > T.windowMs + 140) {
      a.phase = 'ready';
      return null;
    }
    const G = this.profile.guardForward;
    const dir = (from: Sample): { d: Vec3; travel: number } => {
      const d = { x: s.wrist.x - from.wrist.x, y: s.wrist.y - from.wrist.y, z: s.wrist.z - from.wrist.z };
      return { d, travel: Math.hypot(d.x, d.y, d.z) || 1e-6 };
    };
    const inwardSign = a.hand === 'left' ? 1 : -1; // left hand (screen left, -x) hooks toward +x

    let type: PunchType | null = null;
    const st = dir(a.rearmost!);
    const up = dir(a.lowest!);
    const hk = dir(a.outermost!);
    const inward = hk.d.x * inwardSign;
    if (
      st.d.z / st.travel > 0.55 &&
      f.forward > Math.max(T.straightForward * L, G + 0.25 * L) &&
      f.extension > T.straightExtension
    ) {
      type = a.hand === this.leadHand() ? 'jab' : 'cross';
    } else if (up.d.y / up.travel > 0.6 && up.d.y > T.uppercutRise * L && f.extension < 0.85) {
      type = 'uppercut';
    } else if (
      inward / hk.travel > 0.55 &&
      inward > T.hookLateral * L &&
      s.elbowY > s.shoulderY - 0.22 &&
      f.extension > 0.25
    ) {
      type = 'hook';
    }
    if (!type) return null;

    a.phase = 'fired';
    a.lastFire = s.t;
    a.peakForward = f.forward;
    const target: Target = f.wrist.y < -0.28 ? 'body' : 'head';
    return {
      hand: a.hand,
      type,
      target,
      speed: a.peakSpeed,
      power: clamp(a.peakSpeed / this.profile.punchSpeed, 0.3, 1.5),
      time: s.t,
    };
  }
}
