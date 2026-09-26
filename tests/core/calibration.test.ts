import { describe, expect, it } from 'vitest';
import { Calibrator } from '../../src/core/calibration';
import { runScript } from './helpers';

describe('Calibrator', () => {
  it('measures arm length, shoulder width, stance, distance and punch speed', () => {
    const cal = new Calibrator(16 / 9);
    const punches: Array<['jab' | 'cross', number]> = [];
    for (let t = 5400; t < 9800; t += 700) punches.push([punches.length % 2 ? 'cross' : 'jab', t]);
    for (const b of runScript(punches, 10_500)) cal.push(b);
    expect(cal.done).toBe(true);
    const p = cal.result();
    expect(p.armLength).toBeGreaterThan(0.5);
    expect(p.armLength).toBeLessThan(0.66);
    expect(p.shoulderWidth).toBeCloseTo(0.37, 1);
    expect(p.stance).toBe('orthodox');
    expect(p.distance).toBeGreaterThan(1.4);
    expect(p.distance).toBeLessThan(2.5);
    expect(p.punchSpeed).toBeGreaterThan(1.8);
  });
  it('detects southpaw', () => {
    const cal = new Calibrator(16 / 9);
    for (const b of runScript([], 10_500, { stance: 'southpaw' })) cal.push(b);
    expect(cal.result().stance).toBe('southpaw');
  });
});
