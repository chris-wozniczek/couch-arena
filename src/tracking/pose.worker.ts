/**
 * MediaPipe PoseLandmarker running off the main thread. Receives transferred ImageBitmaps, returns
 * mirrored landmarks (selfie view) so every downstream consumer sees the same convention as `core/types`.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, Pose } from '../core/types';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope & {
  importScripts: (...urls: string[]) => void;
};

// The Tasks runtime loads its WASM glue with importScripts(), which module workers do not support.
// Emulate it with a synchronous fetch + global eval so both dev (module) and prod workers behave the same.
scope.importScripts = (...urls: string[]) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    if (xhr.status >= 400) throw new Error(`importScripts failed for ${url}: ${xhr.status}`);
    (0, eval)(xhr.responseText);
  }
};

let landmarker: PoseLandmarker | null = null;
let lastTs = -1;

const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

function mirror(
  list: { x: number; y: number; z: number; visibility?: number }[],
  image: boolean,
): Landmark[] {
  return list.map((p) => ({
    x: image ? 1 - p.x : -p.x,
    y: p.y,
    z: p.z,
    visibility: p.visibility ?? 1,
  }));
}

async function init(m: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  landmarker?.close();
  landmarker = null;
  const fileset = await FilesetResolver.forVisionTasks(`${m.base}mediapipe`);
  const opts = {
    baseOptions: { modelAssetPath: `${m.base}models/pose_landmarker_${m.model}.task`, delegate: m.delegate },
    runningMode: 'VIDEO' as const,
    numPoses: m.numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  };
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    ...opts,
    ...(m.delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
  });
  lastTs = -1;
  post({ type: 'ready', model: m.model, delegate: m.delegate });
}

function detect(m: Extract<ToWorker, { type: 'frame' }>): void {
  const bmp = m.bitmap;
  if (!landmarker) {
    bmp.close();
    post({ type: 'skipped', id: m.id });
    return;
  }
  // MediaPipe requires strictly increasing timestamps (integer ms).
  const ts = Math.max(Math.round(m.timestamp), lastTs + 1);
  lastTs = ts;
  const t0 = performance.now();
  const r = landmarker.detectForVideo(bmp, ts);
  const inferenceMs = performance.now() - t0;
  const poses: Pose[] = r.landmarks.map((lm, i) => ({
    landmarks: mirror(lm, true),
    world: r.worldLandmarks[i] ? mirror(r.worldLandmarks[i], false) : undefined,
  }));
  post({
    type: 'result',
    id: m.id,
    timestamp: m.timestamp,
    poses,
    width: bmp.width,
    height: bmp.height,
    inferenceMs,
  });
  bmp.close();
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      init(m).catch((err: unknown) => post({ type: 'error', message: String(err), fatal: true }));
    } else if (m.type === 'frame') detect(m);
    else if (m.type === 'setPoses') void landmarker?.setOptions({ numPoses: m.numPoses });
    else if (m.type === 'close') {
      landmarker?.close();
      landmarker = null;
    }
  } catch (err) {
    if (m.type === 'frame') m.bitmap.close();
    post({ type: 'error', message: String(err), fatal: false });
  }
};
