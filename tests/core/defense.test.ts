import { describe, expect, it } from 'vitest';
import { Calibrator } from '../../src/core/calibration';
import { DefenseDetector } from '../../src/core/defense';
import type { DefenseKind } from '../../src/core/types';
import { runScript } from './helpers';

const kinds = (actions: Parameters<typeof runScript>[0], dur: number): DefenseKind[] => {
  const d = new DefenseDetector();
  const frames = runScript(actions, dur);
  // Calibrate neutral from the first second (guard idle).
  const cal = new Calibrator(16 / 9);
  for (const b of runScript([], 10_500)) cal.push(b);
  d.profile = cal.result();
  return frames.map((b) => {
    d.update(b);
    return d.kind();
  });
};

describe('DefenseDetector', () => {
  it('detects guard while idle', () => {
    const k = kinds([], 1000);
    expect(k.slice(5).every((x) => x === 'guard')).toBe(true);
  });
  it('detects slips and duck', () => {
    const k = kinds(
      [
        ['slipLeft', 200],
        ['slipRight', 1000],
        ['duck', 1800],
      ],
      2600,
    );
    expect(k).toContain('slipLeft');
    expect(k).toContain('slipRight');
    expect(k).toContain('duck');
    const at = (ms: number): DefenseKind => k[Math.round(ms / (1000 / 30))]!;
    expect(at(480)).toBe('slipLeft');
    expect(at(1280)).toBe('slipRight');
    expect(at(2130)).toBe('duck');
  });
  it('drops guard when hands are lowered', () => {
    const k = kinds([['dropGuard', 200]], 1200);
    const at = (ms: number): DefenseKind => k[Math.round(ms / (1000 / 30))]!;
    expect(at(600)).toBe('none');
  });
});
