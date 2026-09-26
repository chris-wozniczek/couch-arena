/**
 * Webcam negotiation. Picks the best capture mode the device offers for low-latency tracking:
 * 1280x720@60 when the camera supports ≥50 fps, otherwise 1920x1080@30 (or whatever is closest).
 */

export interface CameraInfo {
  deviceId: string;
  label: string;
  /** Heuristic: Continuity Camera / iPhone / external webcams get a friendly tag in the picker. */
  kind: 'builtin' | 'continuity' | 'external' | 'virtual';
}

export interface OpenCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  width: number;
  height: number;
  frameRate: number;
  deviceId: string;
  label: string;
}

const LAST_KEY = 'ca.camera.deviceId';

export function classifyCamera(label: string): CameraInfo['kind'] {
  const l = label.toLowerCase();
  if (/iphone|continuity|desk view/.test(l)) return 'continuity';
  if (/facetime|built-?in|integrated/.test(l)) return 'builtin';
  if (/virtual|obs|snap|mmhmm|fake/.test(l)) return 'virtual';
  return 'external';
}

export async function listCameras(): Promise<CameraInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
      kind: classifyCamera(d.label),
    }));
}

export const lastCameraId = (): string | null => localStorage.getItem(LAST_KEY);

type RangeCap = { max?: number; min?: number };

/** Chooses the capture mode from track capabilities. Exported for tests. */
export function chooseMode(caps: { width?: RangeCap; height?: RangeCap; frameRate?: RangeCap }): {
  width: number;
  height: number;
  frameRate: number;
} {
  const maxW = caps.width?.max ?? 1280;
  const maxH = caps.height?.max ?? 720;
  const maxFps = caps.frameRate?.max ?? 30;
  if (maxFps >= 50 && maxW >= 1280 && maxH >= 720) return { width: 1280, height: 720, frameRate: 60 };
  if (maxW >= 1920 && maxH >= 1080) return { width: 1920, height: 1080, frameRate: Math.min(30, maxFps) };
  return { width: Math.min(1280, maxW), height: Math.min(720, maxH), frameRate: Math.min(30, maxFps) };
}

export async function openCamera(deviceId?: string | null): Promise<OpenCamera> {
  const id = deviceId ?? lastCameraId() ?? undefined;
  const base: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60 },
    ...(id ? { deviceId: { ideal: id } } : { facingMode: 'user' }),
  };
  const stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
  const track = stream.getVideoTracks()[0]!;
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const mode = chooseMode(caps as Parameters<typeof chooseMode>[0]);
  try {
    await track.applyConstraints({
      width: { ideal: mode.width },
      height: { ideal: mode.height },
      frameRate: { ideal: mode.frameRate },
    });
  } catch {
    // Keep whatever the camera gave us.
  }
  const s = track.getSettings();
  if (s.deviceId) localStorage.setItem(LAST_KEY, s.deviceId);
  return {
    stream,
    track,
    width: s.width ?? mode.width,
    height: s.height ?? mode.height,
    frameRate: s.frameRate ?? mode.frameRate,
    deviceId: s.deviceId ?? id ?? '',
    label: track.label,
  };
}

export function stopCamera(c: OpenCamera | null): void {
  c?.stream.getTracks().forEach((t) => t.stop());
}
