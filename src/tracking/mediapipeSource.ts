/**
 * `PoseSource` backed by MediaPipe PoseLandmarker in a Web Worker.
 *
 * - Frames are grabbed with requestVideoFrameCallback (exact capture timestamps where available) and
 *   transferred as ImageBitmaps; at most one frame is in flight so latency never queues up.
 * - Model 'auto' benchmarks HEAVY on the live feed and keeps it when it sustains real-time, otherwise
 *   falls back to FULL. The decision is cached per device/GPU.
 * - GPU delegate first, CPU fallback if the GPU context can't be created in the worker.
 */
import type { PoseFrame, PoseSource, PoseSourceStats } from '../core/types';
import type { Delegate, FromWorker, PoseModel } from './protocol';

export type ModelChoice = PoseModel | 'auto';

export interface MediapipeOptions {
  model: ModelChoice;
  numPoses: number;
  /** Heavy is kept when its p90 inference time is below this budget (ms). */
  heavyBudgetMs: number;
}

export interface BenchResult {
  model: PoseModel;
  p50: number;
  p90: number;
  frames: number;
}

const CACHE_KEY = 'ca.pose.bench.v1';

const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

type VideoFrameCb = (now: number, meta: { captureTime?: number; expectedDisplayTime?: number }) => void;
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: VideoFrameCb) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export class MediapipeSource implements PoseSource {
  readonly kind = 'mediapipe' as const;
  stats: PoseSourceStats = { fps: 0, inferenceMs: 0, pipelineMs: 0, backend: 'loading' };
  model: PoseModel = 'heavy';
  delegate: Delegate = 'GPU';
  bench: BenchResult[] = [];
  private worker: Worker | null = null;
  private listeners = new Set<(f: PoseFrame) => void>();
  private inFlight = false;
  private paused = false;
  private running = false;
  private frameId = 0;
  private rvfc = 0;
  private lastResultAt = 0;
  private frameErrors = 0;
  private sentAt = 0;
  /** Most recent worker error (shown in camera setup). */
  lastError: string | null = null;
  private benchSink: ((ms: number) => void) | null = null;
  private opts: MediapipeOptions;
  private readyResolve: ((m: FromWorker) => void) | null = null;

  constructor(
    private video: HTMLVideoElement,
    opts: Partial<MediapipeOptions> = {},
  ) {
    this.opts = { model: 'auto', numPoses: 1, heavyBudgetMs: 24, ...opts };
  }

  onFrame(cb: (f: PoseFrame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  setNumPoses(n: number): void {
    this.opts.numPoses = n;
    this.worker?.postMessage({ type: 'setPoses', numPoses: n });
  }

  private base(): string {
    return new URL(import.meta.env.BASE_URL, location.href).href;
  }

  private init(model: PoseModel, delegate: Delegate): Promise<FromWorker> {
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      this.worker!.postMessage({
        type: 'init',
        model,
        delegate,
        numPoses: this.opts.numPoses,
        base: this.base(),
      });
    });
  }

  private async initWithFallback(model: PoseModel): Promise<void> {
    let r = await this.init(model, 'GPU');
    if (r.type === 'error') {
      console.warn('[pose] GPU delegate failed, using CPU:', r.message);
      r = await this.init(model, 'CPU');
    }
    if (r.type === 'error') {
      this.lastError = r.message;
      this.stats.backend = 'failed';
      throw new Error(r.message);
    }
    if (r.type === 'ready') {
      this.model = r.model;
      this.delegate = r.delegate;
      this.stats.backend = `${r.model.toUpperCase()} · ${r.delegate}`;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('[pose] worker error', e.message);
      this.onMessage({ type: 'error', message: e.message || 'Pose worker failed to load', fatal: true });
    };
    const cacheKey = `${CACHE_KEY}:${navigator.userAgent}`;
    let model: PoseModel = this.opts.model === 'auto' ? 'heavy' : this.opts.model;
    const cached = this.opts.model === 'auto' ? localStorage.getItem(cacheKey) : null;
    if (cached === 'full' || cached === 'heavy') model = cached;
    await this.initWithFallback(model);
    this.loop();
    if (this.opts.model === 'auto' && !cached) {
      const heavy = await this.benchmark(45);
      this.bench.push(heavy);
      if (heavy.p90 > this.opts.heavyBudgetMs) {
        await this.initWithFallback('full');
        this.bench.push(await this.benchmark(45));
      }
      localStorage.setItem(cacheKey, this.model);
    }
  }

  /** Measures inference time over `frames` live frames with the currently loaded model. */
  benchmark(frames: number): Promise<BenchResult> {
    return new Promise((resolve) => {
      const xs: number[] = [];
      const warmup = 8;
      let seen = 0;
      this.benchSink = (ms) => {
        if (++seen <= warmup) return;
        xs.push(ms);
        if (xs.length >= frames) {
          this.benchSink = null;
          resolve({ model: this.model, p50: percentile(xs, 0.5), p90: percentile(xs, 0.9), frames });
        }
      };
    });
  }

  /** Re-benchmark both models on demand (settings screen). */
  async benchmarkBoth(): Promise<BenchResult[]> {
    const out: BenchResult[] = [];
    for (const m of ['full', 'heavy'] as const) {
      await this.initWithFallback(m);
      out.push(await this.benchmark(60));
    }
    this.bench = out;
    return out;
  }

  async setModel(m: PoseModel): Promise<void> {
    await this.initWithFallback(m);
    localStorage.setItem(`${CACHE_KEY}:${navigator.userAgent}`, m);
  }

  private loop(): void {
    const v = this.video as RvfcVideo;
    const onVideoFrame: VideoFrameCb = (now, meta) => {
      if (!this.running) return;
      this.rvfc = v.requestVideoFrameCallback!(onVideoFrame);
      // captureTime can be on a different clock on some platforms; only trust it when plausible.
      const cap = meta.captureTime ?? 0;
      this.grab(cap > now - 500 && cap <= now ? cap : now);
    };
    if (v.requestVideoFrameCallback) this.rvfc = v.requestVideoFrameCallback(onVideoFrame);
    else {
      const tick = () => {
        if (!this.running) return;
        this.grab(performance.now());
        this.rvfc = window.setTimeout(tick, 1000 / 60);
      };
      tick();
    }
  }

  private grab(ts: number): void {
    // Watchdog: never let a lost worker reply stall tracking for good.
    if (this.inFlight && performance.now() - this.sentAt > 2000) this.inFlight = false;
    if (this.inFlight || this.paused || !this.worker || this.video.readyState < 2) return;
    this.inFlight = true;
    this.sentAt = performance.now();
    const w = this.video.videoWidth;
    const scale = w > 1280 ? 1280 / w : 1;
    const id = ++this.frameId;
    createImageBitmap(
      this.video,
      scale < 1
        ? {
            resizeWidth: Math.round(w * scale),
            resizeHeight: Math.round(this.video.videoHeight * scale),
            resizeQuality: 'high',
          }
        : {},
    )
      .then((bitmap) => {
        if (!this.worker) {
          bitmap.close();
          return;
        }
        this.worker.postMessage({ type: 'frame', bitmap, timestamp: ts, id }, [bitmap]);
      })
      .catch(() => {
        this.inFlight = false;
      });
  }

  private onMessage(m: FromWorker): void {
    if (m.type === 'ready' || (m.type === 'error' && m.fatal)) {
      const r = this.readyResolve;
      this.readyResolve = null;
      r?.(m);
      return;
    }
    if (m.type === 'skipped') {
      this.inFlight = false;
      return;
    }
    if (m.type === 'error') {
      this.inFlight = false;
      console.warn('[pose]', m.message);
      this.lastError = m.message;
      if (++this.frameErrors === 10 && this.delegate === 'GPU') {
        console.warn('[pose] GPU inference keeps failing, switching to CPU');
        this.delegate = 'CPU';
        void this.init(this.model, 'CPU').then((r) => {
          if (r.type === 'ready') this.stats.backend = `${r.model.toUpperCase()} · CPU`;
        });
      }
      return;
    }
    this.frameErrors = 0;
    this.inFlight = false;
    const now = performance.now();
    const a = 0.1;
    const dt = now - this.lastResultAt;
    this.lastResultAt = now;
    if (dt > 0 && dt < 1000) this.stats.fps += a * (1000 / dt - this.stats.fps);
    this.stats.inferenceMs += a * (m.inferenceMs - this.stats.inferenceMs);
    this.stats.pipelineMs += a * (now - m.timestamp - this.stats.pipelineMs);
    this.benchSink?.(m.inferenceMs);
    const frame: PoseFrame = { timestamp: m.timestamp, poses: m.poses, width: m.width, height: m.height };
    for (const l of this.listeners) l(frame);
  }

  stop(): void {
    this.running = false;
    const v = this.video as RvfcVideo;
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.rvfc);
    else clearTimeout(this.rvfc);
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.worker = null;
    this.listeners.clear();
  }
}
