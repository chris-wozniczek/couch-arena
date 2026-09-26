/** Procedurally generated textures (canvas) so the arena needs no large texture downloads. */
import * as THREE from 'three/webgpu';

const canvas = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
};

function hash(x: number, y: number, s: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Tileable value noise height field 0..1. */
function noiseField(size: number, cells: number, seed: number, octaves = 4): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const c = cells << o;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * c;
        const fy = (y / size) * c;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const h = (i: number, j: number) => hash(((x0 + i) % c) + o * 17, ((y0 + j) % c) + o * 31, seed);
        const v = (h(0, 0) * (1 - sx) + h(1, 0) * sx) * (1 - sy) + (h(0, 1) * (1 - sx) + h(1, 1) * sx) * sy;
        out[y * size + x] = out[y * size + x]! + v * amp;
      }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

/** Normal map from a noise height field. */
export function noiseNormalMap(size: number, cells: number, strength: number, seed = 1): THREE.CanvasTexture {
  const hgt = noiseField(size, cells, seed);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = (i: number, j: number) => hgt[((j + size) % size) * size + ((i + size) % size)]!;
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * size + x) * 4;
      img.data[k] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[k + 2] = (1 / len) * 255;
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Roughness variation map (grayscale). */
export function noiseRoughness(
  size: number,
  cells: number,
  base: number,
  range: number,
  seed = 2,
): THREE.CanvasTexture {
  const hgt = noiseField(size, cells, seed);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < hgt.length; i++) {
    const v = Math.max(0, Math.min(1, base + (hgt[i]! - 0.5) * range)) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Ring canvas: off-white canvas weave with a big center logo and worn scuffs. */
export function matTexture(size = 2048): THREE.CanvasTexture {
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = '#d9d4c8';
  ctx.fillRect(0, 0, size, size);
  // weave
  for (let i = 0; i < 40000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '60,55,50' : '255,255,250'},${0.03 + Math.random() * 0.04})`;
    ctx.fillRect(x, y, 2 + Math.random() * 6, 1.2);
  }
  // scuffs around the center
  for (let i = 0; i < 260; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * size * 0.35;
    ctx.fillStyle = `rgba(80,70,60,${0.02 + Math.random() * 0.05})`;
    ctx.beginPath();
    ctx.ellipse(
      size / 2 + Math.cos(a) * r,
      size / 2 + Math.sin(a) * r,
      10 + Math.random() * 60,
      4 + Math.random() * 14,
      Math.random() * 3,
      0,
      7,
    );
    ctx.fill();
  }
  const cx = size / 2;
  ctx.save();
  ctx.translate(cx, cx);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#b3122a';
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = size * 0.012;
  ctx.strokeStyle = '#f1d27a';
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.185, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#fff6e0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${size * 0.075}px "Arial Black", Impact, sans-serif`;
  ctx.fillText('COUCH', 0, -size * 0.04);
  ctx.fillText('ARENA', 0, size * 0.045);
  ctx.font = `700 ${size * 0.018}px Arial, sans-serif`;
  ctx.fillText('WORLD WEBCAM BOXING', 0, size * 0.12);
  ctx.restore();
  // corner marks
  ctx.globalAlpha = 0.85;
  const corner = (x: number, y: number, col: string) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (x ? -1 : 1) * size * 0.14, y);
    ctx.lineTo(x, y + (y ? -1 : 1) * size * 0.14);
    ctx.fill();
  };
  corner(0, 0, '#1b3fa6');
  corner(size, size, '#b3122a');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

/** Apron / banner texture with repeated sponsor-style text. */
export function bannerTexture(text: string, bg: string, fg: string, w = 2048, h = 256): THREE.CanvasTexture {
  const [c, ctx] = canvas(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, bg);
  g.addColorStop(1, '#05060a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = `900 ${h * 0.46}px "Arial Black", Impact, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const parts = text.split('|');
  parts.forEach((p, i) => ctx.fillText(p, ((i + 0.5) / parts.length) * w, h / 2));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Concrete-ish arena floor. */
export function floorTexture(size = 1024): THREE.CanvasTexture {
  const hgt = noiseField(size, 8, 5);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < hgt.length; i++) {
    const v = 22 + hgt[i]! * 30;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v * 1.02;
    img.data[i * 4 + 2] = v * 1.08;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
