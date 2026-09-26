/**
 * Input hub: owns the active `PoseSource` (webcam MediaPipe or synthetic), assigns poses to players
 * (lanes for local 2P), and runs each player's `PlayerTracker`. Pauses tracking when the tab is hidden.
 */
import type { CalibrationProfile } from '../core/calibration';
import { LaneAssigner } from '../core/lanes';
import type { PoseFrame, PoseSource } from '../core/types';
import { MediapipeSource } from '../tracking/mediapipeSource';
import type { ModelChoice } from '../tracking/mediapipeSource';
import { SyntheticSource } from '../tracking/syntheticSource';
import { PlayerTracker } from './playerTracker';
import type { TrackerUpdate } from './playerTracker';

const PROFILE_KEY = (slot: number) => `ca.profile.p${slot + 1}`;

export function loadProfile(slot: number): CalibrationProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY(slot));
    return raw ? (JSON.parse(raw) as CalibrationProfile) : null;
  } catch {
    return null;
  }
}

export function saveProfile(slot: number, p: CalibrationProfile): void {
  localStorage.setItem(PROFILE_KEY(slot), JSON.stringify(p));
}

export type UpdateListener = (player: 0 | 1, u: TrackerUpdate, frame: PoseFrame) => void;

export class InputHub {
  source: PoseSource | null = null;
  trackers: [PlayerTracker, PlayerTracker];
  lanes = new LaneAssigner();
  players: 1 | 2 = 1;
  lastFrame: PoseFrame | null = null;
  /** Poses as assigned to players for the latest frame. */
  assigned: [PoseFrame['poses'][number] | null, PoseFrame['poses'][number] | null] = [null, null];
  private listeners = new Set<UpdateListener>();
  private unsub: (() => void) | null = null;

  constructor(public video: HTMLVideoElement) {
    this.trackers = [
      new PlayerTracker(loadProfile(0) ?? undefined),
      new PlayerTracker(loadProfile(1) ?? undefined),
    ];
    document.addEventListener('visibilitychange', () => this.source?.setPaused(document.hidden));
  }

  get synthetic(): SyntheticSource | null {
    return this.source instanceof SyntheticSource ? this.source : null;
  }

  get mediapipe(): MediapipeSource | null {
    return this.source instanceof MediapipeSource ? this.source : null;
  }

  onUpdate(cb: UpdateListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Estimated latency (ms) from capture to what's on screen, used as prediction horizon. */
  get latencyMs(): number {
    const s = this.source?.stats;
    if (!s || this.source?.kind === 'synthetic') return 16;
    return Math.min(80, s.pipelineMs + 16);
  }

  async useCamera(model: ModelChoice = 'auto'): Promise<MediapipeSource> {
    if (this.mediapipe) {
      this.mediapipe.setNumPoses(this.players);
      return this.mediapipe;
    }
    this.stop();
    const src = new MediapipeSource(this.video, { model, numPoses: this.players });
    this.attach(src);
    await src.start();
    return src;
  }

  async useSynthetic(players: 1 | 2): Promise<SyntheticSource> {
    this.stop();
    const src = new SyntheticSource(players);
    this.attach(src);
    await src.start();
    return src;
  }

  setPlayers(n: 1 | 2): void {
    this.players = n;
    this.lanes = new LaneAssigner();
    this.mediapipe?.setNumPoses(n);
    for (const t of this.trackers) t.reset();
  }

  private attach(src: PoseSource): void {
    this.source = src;
    this.unsub = src.onFrame((f) => this.handle(f));
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.source?.stop();
    this.source = null;
  }

  private handle(f: PoseFrame): void {
    this.lastFrame = f;
    const aspect = f.width / f.height;
    const t = f.timestamp;
    let assigned: [PoseFrame['poses'][number] | null, PoseFrame['poses'][number] | null];
    if (this.players === 2) assigned = this.lanes.update(f.poses, t);
    else {
      // Single player: the most central, largest pose.
      const best = [...f.poses].sort((a, b) => score(b) - score(a))[0] ?? null;
      assigned = [best, null];
    }
    this.assigned = assigned;
    for (let i = 0; i < this.players; i++) {
      const u = this.trackers[i]!.update(assigned[i] ?? null, t, aspect);
      for (const l of this.listeners) l(i as 0 | 1, u, f);
    }
  }
}

function score(p: PoseFrame['poses'][number]): number {
  const l = p.landmarks;
  const ls = l[11]!;
  const rs = l[12]!;
  const w = Math.abs(ls.x - rs.x);
  const cx = (ls.x + rs.x) / 2;
  return w - Math.abs(cx - 0.5) * 0.3;
}
