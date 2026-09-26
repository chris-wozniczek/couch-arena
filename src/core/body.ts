/**
 * Converts raw (filtered) landmarks into a metric, body-centric description of the upper body that the
 * punch / defense detectors consume. Pure and allocation-light.
 *
 * Body frame (meters): origin at the shoulder midpoint, +x = screen right (mirror view), +y = up,
 * +z = toward the camera. So a straight punch increases wrist z.
 */
import { ARM, LM } from './landmarks';
import { angleAt, clamp, dist3, mid3, sub3 } from './math';
import type { Hand, Landmark, Pose, Vec2, Vec3 } from './types';

export interface ArmFeatures {
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  /** Elbow interior angle in degrees (180 = straight arm). */
  elbowAngle: number;
  /** 0 (tight guard, ~60°) .. 1 (fully straight, ~170°). */
  extension: number;
  /** How far the wrist is in front of its own shoulder toward the camera (m). */
  forward: number;
  /** Straight-line shoulder→wrist distance divided by arm length (0..~1). */
  reach: number;
  /** Mean visibility of shoulder, elbow, wrist. */
  visibility: number;
  /** Wrist in normalized image coordinates (mirror view). */
  wristImg: Vec2;
}

export interface BodyFeatures {
  time: number;
  /** Whether enough of the upper body is visible to trust the features. */
  valid: boolean;
  arms: Record<Hand, ArmFeatures>;
  /** Head (nose) in body frame. */
  head: Vec3;
  /** Image-space geometry (aspect-corrected: x multiplied by width/height). */
  img: {
    nose: Vec2;
    shoulderMid: Vec2;
    hipMid: Vec2 | null;
    /** Shoulder width in image-height units. */
    shoulderWidth: number;
    /** Torso bounding center (for lane assignment), normalized 0..1 in x. */
    centerX: number;
  };
  /** Metric shoulder width (m). */
  shoulderWidth: number;
  /** Upper arm + forearm length (m), averaged over both arms. */
  armLength: number;
}

const DEFAULT_SHOULDER_WIDTH_M = 0.37;

const toBody = (p: Landmark, origin: Vec3): Vec3 => ({
  x: p.x - origin.x,
  y: -(p.y - origin.y),
  z: -(p.z - origin.z),
});

/**
 * Estimates metric coordinates when a source provides only 2D landmarks, by scaling image space with an
 * assumed (or calibrated) metric shoulder width. MediaPipe image z has roughly the same scale as x.
 */
function pseudoWorld(lms: readonly Landmark[], aspect: number, shoulderWidthM: number): Landmark[] {
  const ls = lms[LM.leftShoulder]!;
  const rs = lms[LM.rightShoulder]!;
  const swImg = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y) || 1e-3;
  const m = shoulderWidthM / swImg;
  return lms.map((p) => ({ x: p.x * aspect * m, y: p.y * m, z: p.z * aspect * m, visibility: p.visibility }));
}

export function computeBodyFeatures(
  pose: Pose,
  time: number,
  aspect: number,
  opts: { shoulderWidthM?: number; minVisibility?: number } = {},
): BodyFeatures {
  const lms = pose.landmarks;
  const world =
    pose.world && pose.world.length >= 33
      ? pose.world
      : pseudoWorld(lms, aspect, opts.shoulderWidthM ?? DEFAULT_SHOULDER_WIDTH_M);
  const origin = mid3(world[LM.leftShoulder]!, world[LM.rightShoulder]!);
  const minVis = opts.minVisibility ?? 0.5;

  const arm = (hand: Hand): ArmFeatures => {
    const ids = ARM[hand];
    const s = toBody(world[ids.shoulder]!, origin);
    const e = toBody(world[ids.elbow]!, origin);
    const w = toBody(world[ids.wrist]!, origin);
    const ang = (angleAt(s, e, w) * 180) / Math.PI;
    const len = dist3(s, e) + dist3(e, w);
    const vis = (lms[ids.shoulder]!.visibility + lms[ids.elbow]!.visibility + lms[ids.wrist]!.visibility) / 3;
    return {
      shoulder: s,
      elbow: e,
      wrist: w,
      elbowAngle: ang,
      extension: clamp((ang - 60) / 110),
      forward: w.z - s.z,
      reach: len > 1e-4 ? dist3(s, w) / len : 0,
      visibility: vis,
      wristImg: { x: lms[ids.wrist]!.x, y: lms[ids.wrist]!.y },
    };
  };

  const left = arm('left');
  const right = arm('right');
  const armLength =
    (dist3(left.shoulder, left.elbow) +
      dist3(left.elbow, left.wrist) +
      dist3(right.shoulder, right.elbow) +
      dist3(right.elbow, right.wrist)) /
    2;

  const n = lms[LM.nose]!;
  const ls = lms[LM.leftShoulder]!;
  const rs = lms[LM.rightShoulder]!;
  const lh = lms[LM.leftHip]!;
  const rh = lms[LM.rightHip]!;
  const hipsVisible = lh.visibility > minVis && rh.visibility > minVis;
  const shoulderMid = { x: ((ls.x + rs.x) / 2) * aspect, y: (ls.y + rs.y) / 2 };
  const shoulderWidth = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  const coreVis = Math.min(n.visibility, ls.visibility, rs.visibility);
  const xs = [ls.x, rs.x, n.x];
  if (hipsVisible) xs.push(lh.x, rh.x);

  return {
    time,
    valid: coreVis > minVis && shoulderWidth > 0.02,
    arms: { left, right },
    head: toBody(world[LM.nose]!, origin),
    img: {
      nose: { x: n.x * aspect, y: n.y },
      shoulderMid,
      hipMid: hipsVisible ? { x: ((lh.x + rh.x) / 2) * aspect, y: (lh.y + rh.y) / 2 } : null,
      shoulderWidth,
      centerX: xs.reduce((a, b) => a + b, 0) / xs.length,
    },
    shoulderWidth: dist3(world[LM.leftShoulder]!, world[LM.rightShoulder]!),
    armLength,
  };
}

/** Relative wrist position of `hand` w.r.t. the shoulder midpoint (body frame). */
export const wristRel = (b: BodyFeatures, hand: Hand): Vec3 => b.arms[hand].wrist;
export const elbowRel = (b: BodyFeatures, hand: Hand): Vec3 =>
  sub3(b.arms[hand].elbow, b.arms[hand].shoulder);
