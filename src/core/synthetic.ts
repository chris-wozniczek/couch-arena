/**
 * Synthetic boxer: a parametric upper-body skeleton that produces BlazePose-compatible landmarks (image +
 * world) for scripted actions. Drives attract/demo mode, the AI "mirror" preview and unit-test fixtures
 * through exactly the same pipeline as camera tracking.
 */
import { LM, NUM_LANDMARKS } from './landmarks';
import { clamp, lerp, smoothstep } from './math';
import { Rng } from './rng';
import type { Hand, Landmark, Pose, Stance, Vec3 } from './types';

export type SynthAction =
  | 'jab'
  | 'cross'
  | 'leadHook'
  | 'rearHook'
  | 'leadUpper'
  | 'rearUpper'
  | 'slipLeft'
  | 'slipRight'
  | 'duck'
  | 'dropGuard';

export const ACTION_MS: Record<SynthAction, number> = {
  jab: 330,
  cross: 380,
  leadHook: 440,
  rearHook: 460,
  leadUpper: 460,
  rearUpper: 480,
  slipLeft: 560,
  slipRight: 560,
  duck: 650,
  dropGuard: 900,
};

export interface SynthOptions {
  stance: Stance;
  /** Horizontal body position in world meters (screen right +). */
  x: number;
  /** Camera distance (m). */
  distance: number;
  /** Horizontal field of view of the virtual camera (degrees). */
  hfov: number;
  aspect: number;
  upperArm: number;
  forearm: number;
  shoulderHalf: number;
  /** Landmark noise std-dev in meters. */
  noise: number;
  /** Punch speed scale (1 = default). */
  speed: number;
}

export const DEFAULT_SYNTH: SynthOptions = {
  stance: 'orthodox',
  x: 0,
  distance: 1.9,
  hfov: 70,
  aspect: 16 / 9,
  upperArm: 0.29,
  forearm: 0.29,
  shoulderHalf: 0.185,
  noise: 0,
  speed: 1,
};

interface Scheduled {
  action: SynthAction;
  start: number;
  dur: number;
}

/** Pulse envelope: 0 → 1 (extend) → hold → 0 (retract). */
function pulse(u: number, outFrac = 0.38, holdFrac = 0.12): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < outFrac) return smoothstep(0, 1, u / outFrac);
  if (u < outFrac + holdFrac) return 1;
  return 1 - smoothstep(0, 1, (u - outFrac - holdFrac) / (1 - outFrac - holdFrac));
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

/**
 * Two-bone IK: elbow position given shoulder S, wrist W, bone lengths and a pole direction.
 * Wrist is clamped to reach.
 */
export function solveElbow(S: Vec3, W: Vec3, a: number, b: number, pole: Vec3): { elbow: Vec3; wrist: Vec3 } {
  let d = v(W.x - S.x, W.y - S.y, W.z - S.z);
  let len = Math.hypot(d.x, d.y, d.z);
  const maxLen = (a + b) * 0.999;
  if (len > maxLen) {
    d = v((d.x / len) * maxLen, (d.y / len) * maxLen, (d.z / len) * maxLen);
    len = maxLen;
  }
  const wrist = add(S, d);
  const n = v(d.x / len, d.y / len, d.z / len);
  const cosA = clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
  const along = a * cosA;
  const perpLen = Math.sqrt(Math.max(0, a * a - along * along));
  // Pole component perpendicular to the S→W axis.
  const pd = pole.x * n.x + pole.y * n.y + pole.z * n.z;
  let p = v(pole.x - n.x * pd, pole.y - n.y * pd, pole.z - n.z * pd);
  const pl = Math.hypot(p.x, p.y, p.z) || 1;
  p = v(p.x / pl, p.y / pl, p.z / pl);
  return {
    elbow: v(
      S.x + n.x * along + p.x * perpLen,
      S.y + n.y * along + p.y * perpLen,
      S.z + n.z * along + p.z * perpLen,
    ),
    wrist,
  };
}

export class SyntheticBoxer {
  opts: SynthOptions;
  private queue: Scheduled[] = [];
  private rng: Rng;

  constructor(opts: Partial<SynthOptions> = {}, seed = 3) {
    this.opts = { ...DEFAULT_SYNTH, ...opts };
    this.rng = new Rng(seed);
  }

  /** Schedule an action at time `t` (ms). */
  schedule(action: SynthAction, t: number): void {
    this.queue.push({ action, start: t, dur: ACTION_MS[action] / this.opts.speed });
    this.queue.sort((a, b) => a.start - b.start);
  }

  busyUntil(): number {
    return this.queue.reduce((m, q) => Math.max(m, q.start + q.dur), -Infinity);
  }

  private active(t: number): Array<{ action: SynthAction; u: number }> {
    this.queue = this.queue.filter((q) => q.start + q.dur > t - 2000);
    return this.queue
      .filter((q) => t >= q.start && t < q.start + q.dur)
      .map((q) => ({ action: q.action, u: (t - q.start) / q.dur }));
  }

  /** World-space skeleton (mirror-view meters, +y down, +z away from camera) at time t. */
  skeleton(t: number): Landmark[] {
    const o = this.opts;
    const lead: Hand = o.stance === 'orthodox' ? 'left' : 'right';
    const act = this.active(t);
    const amt = (a: SynthAction): number => {
      const e = act.find((q) => q.action === a);
      if (!e) return 0;
      if (a === 'slipLeft' || a === 'slipRight' || a === 'duck' || a === 'dropGuard')
        return pulse(e.u, 0.3, 0.3);
      return pulse(e.u);
    };
    const phase = (a: SynthAction): number => act.find((q) => q.action === a)?.u ?? -1;

    const bob = Math.sin(t / 380) * 0.012;
    const sway = Math.sin(t / 900) * 0.025;
    const slip = (amt('slipRight') - amt('slipLeft')) * 0.2;
    const duck = amt('duck') * 0.24;
    const crossTwist = amt('cross') + amt('rearHook') * 0.7 + amt('rearUpper') * 0.5;
    const leadTwist = amt('leadHook') * 0.6;
    const twist = (crossTwist - leadTwist) * 0.1; // rear shoulder forward (−z) when positive

    const bx = o.x + sway;
    const hipY = 0;
    const shY = -0.5 + bob + duck;
    const shoulder = (h: Hand): Vec3 => {
      const sx = h === 'left' ? -o.shoulderHalf : o.shoulderHalf;
      const isLead = h === lead;
      // Orthodox stance: lead shoulder slightly forward.
      const z = (isLead ? -0.05 : 0.05) + (isLead ? twist : -twist);
      return v(bx + sx + slip * 0.85, shY + (isLead ? 0.01 : 0), z);
    };
    const S = { left: shoulder('left'), right: shoulder('right') };
    const headBase = v(bx + slip, shY - 0.24, -0.06);

    const L = o.upperArm + o.forearm;
    const wristFor = (h: Hand): { target: Vec3; pole: Vec3 } => {
      const isLead = h === lead;
      const sx = h === 'left' ? -1 : 1;
      const sh = S[h];
      const guardDrop = amt('dropGuard') * 0.3;
      const guard = v(headBase.x + sx * 0.1, headBase.y + 0.14 + guardDrop, sh.z - (isLead ? 0.3 : 0.24));
      let target = guard;
      let pole = v(sx * 0.4, 1, 0.25);
      const straight = isLead ? amt('jab') : amt('cross');
      if (straight > 0) {
        const ext = v(headBase.x + sx * 0.03 * -1, shY - 0.04, sh.z - L * 0.98);
        target = lerp3(target, ext, straight);
        pole = v(sx * 0.6, 1, 0);
      }
      const hookU = phase(isLead ? 'leadHook' : 'rearHook');
      if (hookU >= 0) {
        // Arc: cock out wide, sweep across at shoulder height with the elbow up.
        const wide = v(sh.x + sx * 0.3, shY - 0.03, sh.z - 0.34);
        const across = v(headBase.x - sx * 0.14, shY - 0.05, sh.z - 0.38);
        let p: Vec3;
        if (hookU < 0.25) p = lerp3(guard, wide, smoothstep(0, 1, hookU / 0.25));
        else if (hookU < 0.55) p = lerp3(wide, across, smoothstep(0, 1, (hookU - 0.25) / 0.3));
        else p = lerp3(across, guard, smoothstep(0, 1, (hookU - 0.55) / 0.45));
        target = p;
        pole = v(sx, -0.2, 0.3);
      }
      const upU = phase(isLead ? 'leadUpper' : 'rearUpper');
      if (upU >= 0) {
        const dip = v(sh.x - sx * 0.02, shY + 0.26, sh.z - 0.26);
        const top = v(headBase.x + sx * 0.04, shY - 0.2, sh.z - 0.36);
        let p: Vec3;
        if (upU < 0.25) p = lerp3(guard, dip, smoothstep(0, 1, upU / 0.25));
        else if (upU < 0.55) p = lerp3(dip, top, smoothstep(0, 1, (upU - 0.25) / 0.3));
        else p = lerp3(top, guard, smoothstep(0, 1, (upU - 0.55) / 0.45));
        target = p;
        pole = v(sx * 0.5, 1, 0.4);
      }
      return { target, pole };
    };

    const lms: Landmark[] = [];
    for (let i = 0; i < NUM_LANDMARKS; i++) lms.push({ x: 0, y: 0, z: 0, visibility: 0.99 });
    const set = (i: number, p: Vec3, vis = 0.99): void => {
      lms[i] = { x: p.x, y: p.y, z: p.z, visibility: vis };
    };
    const H = headBase;
    set(LM.nose, v(H.x, H.y, H.z - 0.1));
    for (const [idx, dx, dy] of [
      [1, -0.02, -0.035],
      [2, -0.035, -0.035],
      [3, -0.05, -0.034],
      [4, 0.02, -0.035],
      [5, 0.035, -0.035],
      [6, 0.05, -0.034],
    ] as const)
      set(idx, v(H.x + dx, H.y + dy, H.z - 0.08));
    set(7, v(H.x - 0.075, H.y - 0.02, H.z));
    set(8, v(H.x + 0.075, H.y - 0.02, H.z));
    set(9, v(H.x - 0.025, H.y + 0.04, H.z - 0.08));
    set(10, v(H.x + 0.025, H.y + 0.04, H.z - 0.08));
    set(LM.leftShoulder, S.left);
    set(LM.rightShoulder, S.right);
    for (const h of ['left', 'right'] as const) {
      const { target, pole } = wristFor(h);
      const { elbow, wrist } = solveElbow(S[h], target, o.upperArm, o.forearm, pole);
      const base = h === 'left' ? LM.leftElbow : LM.rightElbow;
      set(base, elbow);
      set(base + 2, wrist);
      // Fist: pinky (17/18), index (19/20), thumb (21/22).
      const sx = h === 'left' ? -1 : 1;
      const dz = wrist.z - elbow.z;
      const dirz = dz < 0 ? -1 : 1;
      set(base + 4, v(wrist.x + sx * 0.03, wrist.y - 0.02, wrist.z + dirz * 0.07));
      set(base + 6, v(wrist.x - sx * 0.02, wrist.y - 0.04, wrist.z + dirz * 0.08));
      set(base + 8, v(wrist.x - sx * 0.03, wrist.y - 0.03, wrist.z + dirz * 0.04));
    }
    set(LM.leftHip, v(bx - 0.14 + slip * 0.2, hipY, 0));
    set(LM.rightHip, v(bx + 0.14 + slip * 0.2, hipY, 0));
    for (let i = 25; i < NUM_LANDMARKS; i++) {
      const left = i % 2 === 1;
      const y = i < 27 ? 0.45 : 0.85;
      set(i, v(bx + (left ? -0.16 : 0.16), y, 0), 0.2);
    }
    if (o.noise > 0) {
      for (const p of lms) {
        p.x += this.rng.gauss() * o.noise;
        p.y += this.rng.gauss() * o.noise;
        p.z += this.rng.gauss() * o.noise;
      }
    }
    return lms;
  }

  /** Full pose: world landmarks (hip-centered) plus projected normalized image landmarks. */
  pose(t: number): Pose {
    const o = this.opts;
    const w = this.skeleton(t);
    const fx = 0.5 / Math.tan(((o.hfov / 2) * Math.PI) / 180); // image-width units per unit tan
    const fy = fx * o.aspect;
    const camY = -0.42;
    const image = w.map((p) => {
      const depth = o.distance + p.z;
      return {
        x: 0.5 + (fx * p.x) / depth,
        y: 0.5 + (fy * (p.y - camY)) / depth,
        z: (fx * p.z) / o.distance,
        visibility: p.visibility,
      };
    });
    // World landmarks are hip-centered in MediaPipe; re-center.
    const hc = { x: (w[LM.leftHip]!.x + w[LM.rightHip]!.x) / 2, y: 0, z: 0 };
    const world = w.map((p) => ({ x: p.x - hc.x, y: p.y, z: p.z, visibility: p.visibility }));
    return { landmarks: image, world };
  }
}

/** Randomized sparring script for attract/demo mode. */
export class DemoScript {
  private rng: Rng;
  private next = 600;
  constructor(
    public boxer: SyntheticBoxer,
    seed = 11,
  ) {
    this.rng = new Rng(seed);
  }

  update(t: number): void {
    if (t < this.next) return;
    const combos: SynthAction[][] = [
      ['jab'],
      ['jab', 'cross'],
      ['jab', 'jab', 'cross'],
      ['jab', 'cross', 'leadHook'],
      ['leadHook', 'cross'],
      ['rearUpper', 'leadHook'],
      ['slipLeft', 'cross'],
      ['slipRight', 'leadHook'],
      ['duck', 'rearUpper'],
      ['jab', 'cross', 'leadHook', 'cross'],
    ];
    const c = this.rng.pick(combos);
    let at = Math.max(t, this.boxer.busyUntil());
    for (const a of c) {
      this.boxer.schedule(a, at);
      at += ACTION_MS[a] * (a.startsWith('slip') || a === 'duck' ? 0.9 : 0.85);
    }
    this.next = at + this.rng.range(350, 1300);
  }
}
