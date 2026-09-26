// Copies the MediaPipe Tasks Vision WASM runtime into public/ so it is served same-origin.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dst = join(root, 'public/mediapipe');
mkdirSync(dst, { recursive: true });
for (const f of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
])
  cpSync(join(src, f), join(dst, f));
console.log('mediapipe wasm copied to public/mediapipe');
