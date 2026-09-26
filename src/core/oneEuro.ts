/**
 * One Euro filter (Casiez, Roussel, Vogel — CHI 2012): an adaptive low-pass filter whose cutoff rises with
 * speed, so slow movement is steady (low jitter) and fast movement follows tightly (low lag).
 *
 * Also exposes the filtered derivative so callers can extrapolate a short horizon ahead to hide latency.
 */
import type { Landmark, Vec3 } from './types';

export interface OneEuroParams {
  /** Minimum cutoff frequency (Hz). Lower = smoother at rest. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag during fast motion. */
  beta: number;
  /** Cutoff for the derivative (Hz). */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.5, beta: 8, dCutoff: 1.0 };

const alpha = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private lastT = -1;
  constructor(public params: OneEuroParams = DEFAULT_ONE_EURO) {}

  get value(): number {
    return this.x;
  }
  /** Filtered derivative in units per second. */
  get velocity(): number {
    return this.dx;
  }
  get initialized(): boolean {
    return this.lastT >= 0;
  }

  reset(): void {
    this.lastT = -1;
    this.dx = 0;
  }

  /** @param t timestamp in ms */
  filter(value: number, t: number): number {
    if (this.lastT < 0) {
      this.x = value;
      this.dx = 0;
      this.lastT = t;
      return value;
    }
    const dt = Math.max(1e-4, (t - this.lastT) / 1000);
    this.lastT = t;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.params.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  /** Value extrapolated `horizonMs` ahead using the filtered velocity. */
  predict(horizonMs: number): number {
    return this.x + this.dx * (horizonMs / 1000);
  }
}

/** Filters a whole landmark array (x, y, z per point) with shared parameters. */
export class LandmarkFilter {
  private fx: OneEuroFilter[] = [];
  private fy: OneEuroFilter[] = [];
  private fz: OneEuroFilter[] = [];
  constructor(
    private count: number,
    params: OneEuroParams = DEFAULT_ONE_EURO,
  ) {
    for (let i = 0; i < count; i++) {
      this.fx.push(new OneEuroFilter(params));
      this.fy.push(new OneEuroFilter(params));
      this.fz.push(new OneEuroFilter(params));
    }
  }

  reset(): void {
    for (let i = 0; i < this.count; i++) {
      this.fx[i]!.reset();
      this.fy[i]!.reset();
      this.fz[i]!.reset();
    }
  }

  /** Returns a new filtered array; `visibility` is passed through. */
  filter(points: readonly Landmark[], t: number): Landmark[] {
    const out: Landmark[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const p = points[i] ?? { x: 0, y: 0, z: 0, visibility: 0 };
      out[i] = {
        x: this.fx[i]!.filter(p.x, t),
        y: this.fy[i]!.filter(p.y, t),
        z: this.fz[i]!.filter(p.z, t),
        visibility: p.visibility,
      };
    }
    return out;
  }

  velocity(i: number): Vec3 {
    return { x: this.fx[i]!.velocity, y: this.fy[i]!.velocity, z: this.fz[i]!.velocity };
  }

  /** Predicted positions `horizonMs` ahead (capped extrapolation to avoid overshoot on noisy velocity). */
  predict(horizonMs: number, maxStep = 0.08): Landmark[] {
    const out: Landmark[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const cap = (f: OneEuroFilter): number => {
        const d = f.predict(horizonMs) - f.value;
        return f.value + Math.max(-maxStep, Math.min(maxStep, d));
      };
      out[i] = { x: cap(this.fx[i]!), y: cap(this.fy[i]!), z: cap(this.fz[i]!), visibility: 1 };
    }
    return out;
  }
}
