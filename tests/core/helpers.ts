import { computeBodyFeatures } from '../../src/core/body';
import type { BodyFeatures } from '../../src/core/body';
import { LandmarkFilter } from '../../src/core/oneEuro';
import type { SynthAction, SynthOptions } from '../../src/core/synthetic';
import { SyntheticBoxer } from '../../src/core/synthetic';

/** Renders a synthetic action script at `fps` through the same smoothing + feature pipeline as the app. */
export function runScript(
  actions: Array<[SynthAction, number]>,
  durationMs: number,
  opts: Partial<SynthOptions> = {},
  fps = 30,
  filter = true,
): BodyFeatures[] {
  const boxer = new SyntheticBoxer(opts);
  for (const [a, t] of actions) boxer.schedule(a, t);
  const f = new LandmarkFilter(33);
  const fw = new LandmarkFilter(33);
  const out: BodyFeatures[] = [];
  for (let t = 0; t <= durationMs; t += 1000 / fps) {
    const p = boxer.pose(t);
    const pose = filter ? { landmarks: f.filter(p.landmarks, t), world: fw.filter(p.world!, t) } : p;
    out.push(computeBodyFeatures(pose, t, boxer.opts.aspect));
  }
  return out;
}
