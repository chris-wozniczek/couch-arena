/**
 * Per-player tracking pipeline: raw pose → One Euro smoothing → body features → punch/defense detection,
 * plus latency-hiding prediction for rendering between tracking frames.
 */
import { computeBodyFeatures } from '../core/body';
import type { BodyFeatures } from '../core/body';
import { DEFAULT_PROFILE } from '../core/calibration';
import type { CalibrationProfile } from '../core/calibration';
import { DefenseDetector, defenseKind } from '../core/defense';
import { NUM_LANDMARKS } from '../core/landmarks';
import { LandmarkFilter } from '../core/oneEuro';
import { PunchDetector } from '../core/punch';
import type { DefenseKind, DefenseState, Pose, PunchEvent } from '../core/types';

export interface TrackerUpdate {
  features: BodyFeatures | null;
  punches: PunchEvent[];
  defense: DefenseState;
  defenseKind: DefenseKind;
}

export class PlayerTracker {
  profile: CalibrationProfile;
  punch: PunchDetector;
  defense: DefenseDetector;
  features: BodyFeatures | null = null;
  lastPose: Pose | null = null;
  lastSeen = -1e9;
  /** Wall-clock (performance.now) time of the last pose, independent of the frame timestamp base. */
  private seenAt = -1e9;
  private fImg = new LandmarkFilter(NUM_LANDMARKS);
  private fWorld = new LandmarkFilter(NUM_LANDMARKS);
  private lastT = 0;
  private aspect = 16 / 9;

  constructor(profile: CalibrationProfile = DEFAULT_PROFILE) {
    this.profile = profile;
    this.punch = new PunchDetector(profile);
    this.defense = new DefenseDetector(profile);
  }

  setProfile(p: CalibrationProfile): void {
    this.profile = p;
    this.punch = new PunchDetector(p);
    this.defense = new DefenseDetector(p);
  }

  get present(): boolean {
    return performance.now() - this.seenAt < 600;
  }

  reset(): void {
    this.fImg.reset();
    this.fWorld.reset();
    this.punch.reset();
    this.defense.reset();
    this.features = null;
  }

  update(pose: Pose | null, t: number, aspect: number): TrackerUpdate {
    this.aspect = aspect;
    if (!pose) {
      if (t - this.lastSeen > 600) this.features = null;
      return { features: null, punches: [], defense: this.defense.state, defenseKind: this.defense.kind() };
    }
    if (t - this.lastSeen > 500) {
      this.fImg.reset();
      this.fWorld.reset();
    }
    this.lastSeen = t;
    this.seenAt = performance.now();
    this.lastT = t;
    const filtered: Pose = {
      landmarks: this.fImg.filter(pose.landmarks, t),
      world: pose.world ? this.fWorld.filter(pose.world, t) : undefined,
    };
    this.lastPose = filtered;
    const f = computeBodyFeatures(filtered, t, aspect, { shoulderWidthM: this.profile.shoulderWidth });
    this.features = f;
    const punches = f.valid ? this.punch.update(f) : [];
    const defense = f.valid ? this.defense.update(f) : this.defense.state;
    return { features: f, punches, defense, defenseKind: defenseKind(defense) };
  }

  /**
   * Body features extrapolated to `now + extraMs` (render time + display latency). Hides tracking latency
   * for glove rendering; detection itself always uses measured (not predicted) data.
   */
  predicted(now: number, extraMs: number): BodyFeatures | null {
    if (!this.lastPose || !this.features) return this.features;
    const horizon = Math.min(90, Math.max(0, now - this.lastT + extraMs));
    const pose: Pose = {
      landmarks: this.fImg.predict(horizon, 0.06).map((p, i) => ({
        ...p,
        visibility: this.lastPose!.landmarks[i]?.visibility ?? 0,
      })),
      world: this.lastPose.world
        ? this.fWorld.predict(horizon, 0.12).map((p, i) => ({
            ...p,
            visibility: this.lastPose!.world![i]?.visibility ?? 0,
          }))
        : undefined,
    };
    return computeBodyFeatures(pose, now, this.aspect, { shoulderWidthM: this.profile.shoulderWidth });
  }
}
