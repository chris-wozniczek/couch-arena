import { describe, expect, it } from 'vitest';
import { LaneAssigner } from '../../src/core/lanes';
import { SyntheticBoxer } from '../../src/core/synthetic';
import type { Pose } from '../../src/core/types';

const at = (x: number, t: number, shoulder = 0.185): Pose =>
  new SyntheticBoxer({ x, shoulderHalf: shoulder }).pose(t);

describe('LaneAssigner', () => {
  it('assigns left lane to P1 and right lane to P2 regardless of detection order', () => {
    const l = new LaneAssigner();
    const [p1, p2] = l.update([at(0.6, 0), at(-0.6, 0)], 0);
    expect(p1!.landmarks[0]!.x).toBeLessThan(0.5);
    expect(p2!.landmarks[0]!.x).toBeGreaterThan(0.5);
  });
  it('keeps identities when players cross paths', () => {
    const l = new LaneAssigner();
    let t = 0;
    // A (narrow shoulders) walks left→right, B (wide) right→left, crossing mid-frame.
    for (let i = 0; i <= 60; i++, t += 33) {
      const xa = -0.6 + (1.2 * i) / 60;
      const xb = 0.6 - (1.2 * i) / 60;
      const a = at(xa, t, 0.16);
      const b = at(xb, t, 0.21);
      const poses = Math.abs(xa - xb) < 0.1 ? [a] : i % 2 ? [a, b] : [b, a]; // overlap → one detection
      const [p1, p2] = l.update(poses, t);
      if (i > 45) {
        // After crossing, P1 (A) is now on the right.
        expect(p1!.landmarks[0]!.x).toBeGreaterThan(0.5);
        expect(p2!.landmarks[0]!.x).toBeLessThan(0.5);
      }
    }
  });
  it('holds a briefly occluded player then releases', () => {
    const l = new LaneAssigner({ holdMs: 300 });
    l.update([at(-0.6, 0), at(0.6, 0)], 0);
    expect(l.update([at(-0.6, 100)], 100)[1]).not.toBeNull();
    expect(l.update([at(-0.6, 500)], 500)[1]).toBeNull();
  });
  it('suppresses duplicate detections of the same person', () => {
    const l = new LaneAssigner();
    const p = at(-0.5, 0);
    const [a, b] = l.update([p, { landmarks: p.landmarks.map((q) => ({ ...q, x: q.x + 0.003 })) }], 0);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});
