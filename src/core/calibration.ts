/**
 * 10-second calibration: measures the player's proportions and habits so detection thresholds scale to
 * their body and distance. Phases:
 *   1. frame  (2 s)  stand still, full upper body visible → framing / distance
 *   2. guard  (3 s)  hands up in guard → neutral head, guard height, stance, shoulder width
 *   3. punch  (5 s)  throw a few punches → arm length, personal punch speed
 */
import type { BodyFeatures } from './body';
import { clamp, median } from './math';
import type { Stance, Vec2 } from './types';

export interface CalibrationProfile {
  /** Upper arm + forearm (m). */
  armLength: number;
  /** Metric shoulder width (m). */
  shoulderWidth: number;
  /** Image shoulder width at calibration (image-height units, aspect-corrected). */
  shoulderWidthImg: number;
  /** Neutral nose position (aspect-corrected image units). */
  neutralNose: Vec2;
  /** Neutral nose relative to hip midpoint, if hips were visible. */
  neutralNoseRelHip: Vec2 | null;
  /** Mean guard wrist height relative to shoulders (m, +up). */
  guardHeight: number;
  /** Mean guard wrist distance in front of the shoulders (m). */
  guardForward: number;
  stance: Stance;
  /** Estimated camera distance (m). */
  distance: number;
  /** Typical peak wrist speed of the player's punches (m/s). */
  punchSpeed: number;
  createdAt: number;
}

export const DEFAULT_PROFILE: CalibrationProfile = {
  armLength: 0.6,
  shoulderWidth: 0.37,
  shoulderWidthImg: 0.22,
  neutralNose: { x: 0.89, y: 0.3 },
  neutralNoseRelHip: null,
  guardHeight: 0.12,
  guardForward: 0.22,
  stance: 'orthodox',
  distance: 1.8,
  punchSpeed: 3.2,
  createdAt: 0,
};

export type CalibrationPhase = 'frame' | 'guard' | 'punch' | 'done';

export const CALIBRATION_PHASES: ReadonlyArray<{
  phase: CalibrationPhase;
  durationMs: number;
  prompt: string;
}> = [
  {
    phase: 'frame',
    durationMs: 2000,
    prompt: 'Stand still — make sure your head, shoulders and hands are in frame',
  },
  { phase: 'guard', durationMs: 3000, prompt: 'Hands up! Hold your guard in front of your face' },
  { phase: 'punch', durationMs: 5000, prompt: 'Throw a few hard jabs and crosses at the camera' },
];

/**
 * Estimates camera distance from metric vs image shoulder width, assuming a typical webcam horizontal FOV.
 * `shoulderWidthImg` is in image-height units; aspect converts to image-width units.
 */
export function estimateDistance(
  shoulderWidthM: number,
  shoulderWidthImg: number,
  aspect: number,
  hfovDeg = 70,
): number {
  const wFrac = shoulderWidthImg / aspect; // fraction of image width
  if (wFrac <= 1e-4) return 0;
  const halfTan = Math.tan(((hfovDeg / 2) * Math.PI) / 180);
  return shoulderWidthM / (2 * halfTan * wFrac);
}

export class Calibrator {
  private startTime = -1;
  private samples: Record<Exclude<CalibrationPhase, 'done'>, BodyFeatures[]> = {
    frame: [],
    guard: [],
    punch: [],
  };
  private peakSpeeds: number[] = [];
  private prev: BodyFeatures | null = null;
  private burstPeak = 0;
  private invalidTime = 0;

  constructor(private aspect: number) {}

  get elapsed(): number {
    return this.startTime < 0 ? 0 : (this.prev?.time ?? this.startTime) - this.startTime - this.invalidTime;
  }

  get totalMs(): number {
    return CALIBRATION_PHASES.reduce((a, p) => a + p.durationMs, 0);
  }

  /** Current phase and 0..1 progress within it. */
  get state(): { phase: CalibrationPhase; progress: number; overall: number; prompt: string } {
    let t = this.elapsed;
    for (const p of CALIBRATION_PHASES) {
      if (t < p.durationMs)
        return {
          phase: p.phase,
          progress: t / p.durationMs,
          overall: this.elapsed / this.totalMs,
          prompt: p.prompt,
        };
      t -= p.durationMs;
    }
    return { phase: 'done', progress: 1, overall: 1, prompt: 'Calibrated!' };
  }

  /** Feed features. Time only advances while the body is valid (pauses if the player leaves frame). */
  push(b: BodyFeatures): void {
    if (this.startTime < 0) {
      if (!b.valid) return;
      this.startTime = b.time;
    }
    if (this.prev && !b.valid) this.invalidTime += b.time - this.prev.time;
    const phase = this.state.phase;
    if (phase !== 'done' && b.valid) {
      this.samples[phase].push(b);
      if (phase === 'punch' && this.prev?.valid) {
        const dt = (b.time - this.prev.time) / 1000;
        if (dt > 0 && dt < 0.2) {
          for (const h of ['left', 'right'] as const) {
            const a = b.arms[h].wrist;
            const p = this.prev.arms[h].wrist;
            const s = Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) / dt;
            if (s > this.burstPeak) this.burstPeak = s;
          }
          const both = Math.max(b.arms.left.forward, b.arms.right.forward);
          const g = this.samples.guard;
          const guardF = g.length
            ? median(g.map((q) => Math.max(q.arms.left.forward, q.arms.right.forward)))
            : 0.2;
          // A burst ends when both hands come back to guard; record its peak.
          if (both < guardF + 0.08 && this.burstPeak > 1.2) {
            this.peakSpeeds.push(this.burstPeak);
            this.burstPeak = 0;
          }
        }
      }
    }
    this.prev = b;
  }

  get done(): boolean {
    return this.state.phase === 'done';
  }

  result(now = Date.now()): CalibrationProfile {
    const all = [...this.samples.frame, ...this.samples.guard, ...this.samples.punch];
    const guard = this.samples.guard.length ? this.samples.guard : all;
    if (all.length === 0) return { ...DEFAULT_PROFILE, createdAt: now };
    const armLength = clamp(median(all.map((b) => b.armLength)), 0.4, 0.9);
    const shoulderWidth = clamp(median(all.map((b) => b.shoulderWidth)), 0.25, 0.55);
    const shoulderWidthImg = median(guard.map((b) => b.img.shoulderWidth));
    const neutralNose = {
      x: median(guard.map((b) => b.img.nose.x)),
      y: median(guard.map((b) => b.img.nose.y)),
    };
    const withHips = guard.filter((b) => b.img.hipMid);
    const neutralNoseRelHip =
      withHips.length > guard.length / 2
        ? {
            x: median(withHips.map((b) => b.img.nose.x - b.img.hipMid!.x)),
            y: median(withHips.map((b) => b.img.nose.y - b.img.hipMid!.y)),
          }
        : null;
    const guardHeight = median(guard.map((b) => (b.arms.left.wrist.y + b.arms.right.wrist.y) / 2));
    const guardForward = clamp(
      median(guard.map((b) => (b.arms.left.forward + b.arms.right.forward) / 2)),
      0,
      0.45,
    );
    // Lead hand sits further forward (toward camera) in guard.
    const leadDiff = median(guard.map((b) => b.arms.left.forward - b.arms.right.forward));
    const stance: Stance = leadDiff >= -0.01 ? 'orthodox' : 'southpaw';
    if (this.burstPeak > 1.2) this.peakSpeeds.push(this.burstPeak);
    const punchSpeed = this.peakSpeeds.length
      ? clamp(median(this.peakSpeeds), 1.8, 7)
      : DEFAULT_PROFILE.punchSpeed;
    return {
      armLength,
      shoulderWidth,
      shoulderWidthImg,
      neutralNose,
      neutralNoseRelHip,
      guardHeight,
      guardForward,
      stance,
      distance: estimateDistance(shoulderWidth, shoulderWidthImg, this.aspect),
      punchSpeed,
      createdAt: now,
    };
  }
}
