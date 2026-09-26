/** Cheap scene checks on the camera feed: brightness, contrast and back-lighting. */
export interface LightingReport {
  /** Mean luma 0..1. */
  luma: number;
  /** Std-dev of luma 0..1. */
  contrast: number;
  /** Center (subject) darker than the edges by this much 0..1. */
  backlight: number;
  verdict: 'ok' | 'dark' | 'backlit' | 'flat';
}

export class LightingProbe {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  constructor(
    private w = 48,
    private h = 27,
  ) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  sample(video: HTMLVideoElement): LightingReport | null {
    if (video.readyState < 2) return null;
    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
    let sum = 0;
    let sq = 0;
    let center = 0;
    let nc = 0;
    let edge = 0;
    let ne = 0;
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        const l = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
        sum += l;
        sq += l * l;
        const cx = Math.abs(x / this.w - 0.5);
        const cy = Math.abs(y / this.h - 0.5);
        if (cx < 0.2 && cy < 0.3) {
          center += l;
          nc++;
        } else if (cx > 0.38 || cy > 0.42) {
          edge += l;
          ne++;
        }
      }
    const n = this.w * this.h;
    const luma = sum / n;
    const contrast = Math.sqrt(Math.max(0, sq / n - luma * luma));
    const backlight = Math.max(0, edge / Math.max(1, ne) - center / Math.max(1, nc));
    const verdict = luma < 0.16 ? 'dark' : backlight > 0.25 ? 'backlit' : contrast < 0.04 ? 'flat' : 'ok';
    return { luma, contrast, backlight, verdict };
  }
}
