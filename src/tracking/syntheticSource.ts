/**
 * Synthetic `PoseSource` for attract/demo mode and camera-less testing. Emits BlazePose-compatible
 * landmarks from parametric boxers, through exactly the same pipeline as the webcam.
 */
import { DemoScript, SyntheticBoxer } from '../core/synthetic';
import type { SynthAction } from '../core/synthetic';
import type { PoseFrame, PoseSource, PoseSourceStats } from '../core/types';

export class SyntheticSource implements PoseSource {
  readonly kind = 'synthetic' as const;
  stats: PoseSourceStats = { fps: 30, inferenceMs: 0, pipelineMs: 0, backend: 'synthetic' };
  boxers: SyntheticBoxer[];
  scripts: DemoScript[];
  /** When false, boxers only act on `trigger()` (used by tests and keyboard control). */
  autoplay = true;
  private listeners = new Set<(f: PoseFrame) => void>();
  private timer = 0;
  private paused = false;

  constructor(
    players = 1,
    private hz = 30,
  ) {
    const xs = players === 1 ? [0] : [-0.42, 0.42];
    this.boxers = xs.map(
      (x, i) =>
        new SyntheticBoxer(
          { x, noise: 0.002, stance: i === 1 ? 'southpaw' : 'orthodox', distance: 2.1 },
          3 + i,
        ),
    );
    this.scripts = this.boxers.map((b, i) => new DemoScript(b, 11 + i * 7));
  }

  onFrame(cb: (f: PoseFrame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  trigger(action: SynthAction, player = 0): void {
    const b = this.boxers[player];
    if (b) b.schedule(action, Math.max(performance.now(), b.busyUntil()));
  }

  async start(): Promise<void> {
    const step = 1000 / this.hz;
    let last = performance.now();
    // Parametric poses can be sampled at any time, so a late timer tick (busy main thread) emits the
    // missed frames too; otherwise fast punches would fall between samples.
    const tick = () => {
      const now = performance.now();
      if (this.paused) {
        last = now;
        return;
      }
      const from = Math.max(last + step, now - 5000);
      for (let t = Math.min(from, now); t <= now; t += step) {
        last = t;
        if (this.autoplay) this.scripts.forEach((s) => s.update(t));
        const frame: PoseFrame = {
          timestamp: t,
          poses: this.boxers.map((b) => b.pose(t)),
          width: 1280,
          height: 720,
        };
        for (const l of this.listeners) l(frame);
      }
    };
    this.timer = window.setInterval(tick, 1000 / this.hz);
  }

  stop(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }
}
