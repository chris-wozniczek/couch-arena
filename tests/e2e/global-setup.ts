import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Converts the committed boxing clip into the raw Y4M file Chrome's fake camera expects
 * (--use-file-for-fake-video-capture). Y4M is uncompressed, so it is generated, not committed.
 */
export default function globalSetup(): void {
  const out = 'test-results/boxing.y4m';
  mkdirSync('test-results', { recursive: true });
  if (existsSync(out)) return;
  execFileSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-i',
      'tests/fixtures/boxing-training.webm',
      '-vf',
      'scale=960:540,fps=30',
      '-pix_fmt',
      'yuv420p',
      out,
    ],
    { stdio: 'inherit' },
  );
}
