/**
 * Local two-player tracking on a single camera: assigns detected poses to stable player identities.
 *
 * - New players are assigned by lane (left half → P1, right half → P2 in the mirrored view).
 * - Established players are tracked by continuity: a 2×2 assignment on predicted torso position plus a body
 *   proportion signature (shoulder width vs torso height), so crossing paths does not swap identities.
 * - Duplicate detections of the same person (overlapping skeletons) are suppressed.
 * - A player briefly lost (occlusion) keeps their slot for `holdMs`.
 */
import { LM } from './landmarks';
import type { Pose } from './types';

export interface LaneTrack {
  id: 0 | 1;
  pose: Pose | null;
  /** Normalized torso center x in [0,1]. */
  x: number;
  vx: number;
  signature: number;
  lastSeen: number;
  present: boolean;
}

export interface LaneOptions {
  holdMs: number;
  /** Max normalized distance a player may move between frames before we prefer lane assignment. */
  maxJump: number;
  /** Poses whose keypoints overlap closer than this (in shoulder widths) are duplicates. */
  duplicateDist: number;
}

const DEFAULT_OPTIONS: LaneOptions = { holdMs: 400, maxJump: 0.25, duplicateDist: 0.35 };

const torsoX = (p: Pose): number => {
  const l = p.landmarks;
  return (l[LM.leftShoulder]!.x + l[LM.rightShoulder]!.x + l[LM.nose]!.x) / 3;
};

const signature = (p: Pose): number => {
  const l = p.landmarks;
  const sw = Math.hypot(
    l[LM.leftShoulder]!.x - l[LM.rightShoulder]!.x,
    l[LM.leftShoulder]!.y - l[LM.rightShoulder]!.y,
  );
  const head = Math.hypot(
    l[LM.nose]!.x - (l[LM.leftShoulder]!.x + l[LM.rightShoulder]!.x) / 2,
    l[LM.nose]!.y - (l[LM.leftShoulder]!.y + l[LM.rightShoulder]!.y) / 2,
  );
  return head > 1e-4 ? sw / head : 0;
};

/** Mean distance between corresponding upper-body keypoints, in units of the first pose's shoulder width. */
export function poseOverlap(a: Pose, b: Pose): number {
  const ids = [
    LM.nose,
    LM.leftShoulder,
    LM.rightShoulder,
    LM.leftElbow,
    LM.rightElbow,
    LM.leftWrist,
    LM.rightWrist,
  ];
  const la = a.landmarks;
  const lb = b.landmarks;
  const sw = Math.max(
    1e-3,
    Math.hypot(
      la[LM.leftShoulder]!.x - la[LM.rightShoulder]!.x,
      la[LM.leftShoulder]!.y - la[LM.rightShoulder]!.y,
    ),
  );
  let d = 0;
  for (const i of ids) d += Math.hypot(la[i]!.x - lb[i]!.x, la[i]!.y - lb[i]!.y);
  return d / ids.length / sw;
}

export class LaneAssigner {
  tracks: [LaneTrack, LaneTrack];
  private opts: LaneOptions;

  constructor(opts: Partial<LaneOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    const mk = (id: 0 | 1): LaneTrack => ({
      id,
      pose: null,
      x: id === 0 ? 0.25 : 0.75,
      vx: 0,
      signature: 0,
      lastSeen: -1e9,
      present: false,
    });
    this.tracks = [mk(0), mk(1)];
  }

  /** Assign this frame's poses. Returns [p1Pose|null, p2Pose|null]. */
  update(posesIn: readonly Pose[], now: number): [Pose | null, Pose | null] {
    // Duplicate suppression.
    const poses: Pose[] = [];
    for (const p of posesIn) {
      if (!poses.some((q) => poseOverlap(q, p) < this.opts.duplicateDist)) poses.push(p);
    }
    const T = this.tracks;
    const active = T.map((t) => t.present && now - t.lastSeen < this.opts.holdMs);
    const xs = poses.map(torsoX);
    const sigs = poses.map(signature);

    const cost = (ti: 0 | 1, pi: number): number => {
      const t = T[ti];
      if (!active[ti]) {
        // Lane prior for new/lost tracks.
        return ti === 0 ? xs[pi]! : 1 - xs[pi]!;
      }
      const dt = Math.min(0.2, (now - t.lastSeen) / 1000);
      const pred = t.x + t.vx * dt;
      const dx = Math.abs(xs[pi]! - pred);
      const ds = t.signature > 0 && sigs[pi]! > 0 ? Math.abs(t.signature - sigs[pi]!) / t.signature : 0;
      return dx + 0.15 * ds + (dx > this.opts.maxJump ? 1 : 0);
    };

    const assign: [number, number] = [-1, -1];
    if (poses.length === 1) {
      const c0 = cost(0, 0);
      const c1 = cost(1, 0);
      // If only one track is active and near, keep it; otherwise pick cheaper.
      if (active[0] && !active[1]) assign[c0 < 0.35 || xs[0]! < 0.5 ? 0 : 1] = 0;
      else if (active[1] && !active[0]) assign[c1 < 0.35 || xs[0]! >= 0.5 ? 1 : 0] = 0;
      else assign[c0 <= c1 ? 0 : 1] = 0;
    } else if (poses.length >= 2) {
      // Keep the two most confident/central? Use the two with best total cost.
      const pairs: Array<[number, number]> = [];
      for (let a = 0; a < poses.length; a++)
        for (let b = 0; b < poses.length; b++) if (a !== b) pairs.push([a, b]);
      let best = pairs[0]!;
      let bestC = Infinity;
      for (const [a, b] of pairs) {
        const c = cost(0, a) + cost(1, b);
        if (c < bestC) {
          bestC = c;
          best = [a, b];
        }
      }
      assign[0] = best[0];
      assign[1] = best[1];
    }

    const out: [Pose | null, Pose | null] = [null, null];
    for (const ti of [0, 1] as const) {
      const t = T[ti];
      const pi = assign[ti];
      if (pi >= 0) {
        const x = xs[pi]!;
        if (active[ti]) {
          const dt = Math.max(1e-3, (now - t.lastSeen) / 1000);
          t.vx = 0.7 * t.vx + 0.3 * ((x - t.x) / dt);
        } else t.vx = 0;
        t.x = x;
        t.signature = t.signature > 0 ? 0.95 * t.signature + 0.05 * sigs[pi]! : sigs[pi]!;
        t.pose = poses[pi]!;
        t.lastSeen = now;
        t.present = true;
        out[ti] = t.pose;
      } else if (active[ti]) {
        out[ti] = t.pose; // hold through brief occlusion
      } else {
        t.present = false;
        t.pose = null;
      }
    }
    return out;
  }
}
