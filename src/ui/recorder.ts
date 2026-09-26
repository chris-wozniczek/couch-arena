/**
 * Highlight clips: canvas + game audio → MediaRecorder. Prefers MP4/H.264 (Safari, Chrome 126+) and falls
 * back to WebM. Clips are capped at 15 s.
 */
export const CLIP_MS = 15_000;

const MIME_PREFS = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_PREFS.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export interface Clip {
  blob: Blob;
  url: string;
  mime: string;
  ext: 'mp4' | 'webm';
  durationMs: number;
}

export class HighlightRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timer = 0;
  onClip: ((c: Clip) => void) | null = null;
  onState: ((recording: boolean) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private audio: () => MediaStream | null,
  ) {}

  get recording(): boolean {
    return this.rec?.state === 'recording';
  }

  get elapsed(): number {
    return this.recording ? performance.now() - this.startedAt : 0;
  }

  start(maxMs = CLIP_MS): boolean {
    if (this.recording) return true;
    const mime = pickMime();
    if (!mime) return false;
    const stream = this.canvas.captureStream(60);
    this.audio()
      ?.getAudioTracks()
      .forEach((t) => stream.addTrack(t));
    this.chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: mime.split(';')[0] });
      const clip: Clip = {
        blob,
        url: URL.createObjectURL(blob),
        mime,
        ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm',
        durationMs: performance.now() - this.startedAt,
      };
      this.onState?.(false);
      this.onClip?.(clip);
    };
    rec.start(500);
    this.rec = rec;
    this.startedAt = performance.now();
    this.timer = window.setTimeout(() => this.stop(), maxMs);
    this.onState?.(true);
    return true;
  }

  stop(): void {
    clearTimeout(this.timer);
    if (this.recording) this.rec!.stop();
  }
}

export async function shareClip(clip: Clip, text: string): Promise<'shared' | 'downloaded'> {
  const file = new File([clip.blob], `couch-arena-highlight.${clip.ext}`, { type: clip.blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text, title: 'Couch Arena highlight' });
      return 'shared';
    } catch {
      // fall through to download
    }
  }
  const a = document.createElement('a');
  a.href = clip.url;
  a.download = file.name;
  a.click();
  return 'downloaded';
}

export const xIntent = (text: string, url: string): string =>
  `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
