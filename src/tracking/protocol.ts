/** Messages exchanged between the main thread and the pose worker. */
import type { Pose } from '../core/types';

export type PoseModel = 'full' | 'heavy';
export type Delegate = 'GPU' | 'CPU';

export type ToWorker =
  | { type: 'init'; model: PoseModel; delegate: Delegate; numPoses: number; base: string }
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number; id: number }
  | { type: 'setPoses'; numPoses: number }
  | { type: 'close' };

export type FromWorker =
  | { type: 'ready'; model: PoseModel; delegate: Delegate }
  | {
      type: 'result';
      id: number;
      timestamp: number;
      poses: Pose[];
      width: number;
      height: number;
      inferenceMs: number;
    }
  | { type: 'error'; message: string; fatal: boolean };
