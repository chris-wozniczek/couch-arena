/**
 * Core data types shared by every layer (tracking, game logic, rendering, netcode).
 *
 * Conventions
 * - Time is always in milliseconds on the `performance.now()` clock of the local device.
 * - Image landmarks are normalized to [0, 1] with the origin at the top-left of the *mirrored*
 *   (selfie) view, so a user moving to their right moves toward +x on screen, like a mirror.
 * - World landmarks are in meters, hip-centered, +x = the subject's left in mirrored view (screen right),
 *   +y = down, +z = away from the camera (MediaPipe convention).
 * - Anatomical names (left/right wrist) always refer to the *subject's* body, never to the screen.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Landmark extends Vec3 {
  /** Likelihood the landmark is visible and not occluded, 0..1. */
  visibility: number;
}

/** A single detected person. Both arrays follow the 33-point BlazePose topology (see `landmarks.ts`). */
export interface Pose {
  landmarks: Landmark[];
  /** Metric 3D landmarks (meters, hip-centered). Optional: some native sources only provide 2D. */
  world?: Landmark[];
}

export interface PoseFrame {
  /** Capture timestamp of the video frame this result belongs to. */
  timestamp: number;
  poses: Pose[];
  /** Source image size in pixels (used for aspect-correct geometry). */
  width: number;
  height: number;
}

export interface PoseSourceStats {
  /** Detections completed per second. */
  fps: number;
  /** Mean inference duration in ms. */
  inferenceMs: number;
  /** Mean delay from frame capture to result availability, in ms. */
  pipelineMs: number;
  /** Human readable model / backend description. */
  backend: string;
}

/**
 * Anything that produces poses: MediaPipe in a worker, a synthetic demo generator, a network peer,
 * or (later) a native Apple Vision bridge inside a WKWebView. Game logic only depends on this.
 */
export interface PoseSource {
  readonly kind: 'mediapipe' | 'synthetic' | 'native' | 'replay';
  start(): Promise<void>;
  stop(): void;
  /** Subscribe to new frames. Returns an unsubscribe function. */
  onFrame(cb: (frame: PoseFrame) => void): () => void;
  /** Pause/resume work (e.g. tab hidden). */
  setPaused(paused: boolean): void;
  readonly stats: PoseSourceStats;
}

export type Hand = 'left' | 'right';
export type PunchType = 'jab' | 'cross' | 'hook' | 'uppercut';
export type Target = 'head' | 'body';
export type Stance = 'orthodox' | 'southpaw';

export interface PunchEvent {
  hand: Hand;
  type: PunchType;
  target: Target;
  /** Peak wrist speed in m/s. */
  speed: number;
  /** Normalized power 0..1.5 (speed relative to the player's calibrated punch speed). */
  power: number;
  /** Local timestamp at which the punch was recognized. */
  time: number;
}

export type DefenseKind = 'none' | 'guard' | 'slipLeft' | 'slipRight' | 'duck';

export interface DefenseState {
  guard: boolean;
  /** -1 slip to the subject's left (screen left in mirror view), +1 to the right, 0 none. */
  slip: -1 | 0 | 1;
  duck: boolean;
  /** Continuous head offset relative to calibrated neutral, in shoulder widths (for rendering). */
  headOffset: Vec2;
}
