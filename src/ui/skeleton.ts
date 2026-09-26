/** Draws the camera image and tracked skeletons (mirrored) onto a 2D canvas. */
import type { Pose } from '../core/types';

const EDGES: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [15, 17],
  [15, 19],
  [16, 18],
  [16, 20],
  [0, 11],
  [0, 12],
  [23, 25],
  [24, 26],
];
export const PLAYER_COLORS = ['#ff4d64', '#5b8cff'];

export function drawCamera(ctx: CanvasRenderingContext2D, video: HTMLVideoElement | null, dim = 1): void {
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (video && video.readyState >= 2) {
    ctx.globalAlpha = dim;
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const s = Math.max(w / vw, h / vh);
    ctx.drawImage(video, (w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s);
  }
  ctx.restore();
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, pose: Pose, color: string, label?: string): void {
  const { width: w, height: h } = ctx.canvas;
  const l = pose.landmarks;
  ctx.save();
  ctx.lineWidth = Math.max(2, w / 260);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.lineCap = 'round';
  for (const [a, b] of EDGES) {
    const p = l[a];
    const q = l[b];
    if (!p || !q || (p.visibility ?? 1) < 0.4 || (q.visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(p.x * w, p.y * h);
    ctx.lineTo(q.x * w, q.y * h);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const i of [0, 11, 12, 13, 14, 15, 16]) {
    const p = l[i];
    if (!p || (p.visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, ctx.lineWidth * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (label && l[0]) {
    ctx.shadowBlur = 0;
    ctx.font = `600 ${Math.round(w / 30)}px system-ui`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, l[0].x * w, Math.max(20, l[0].y * h - w / 20));
  }
  ctx.restore();
}
