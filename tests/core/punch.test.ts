import { describe, expect, it } from 'vitest';
import { PunchDetector } from '../../src/core/punch';
import type { SynthAction } from '../../src/core/synthetic';
import type { PunchEvent } from '../../src/core/types';
import { runScript } from './helpers';

const detect = (actions: Array<[SynthAction, number]>, dur = 1500, opts = {}, fps = 30): PunchEvent[] => {
  const d = new PunchDetector();
  return runScript(actions, dur, opts, fps).flatMap((b) => d.update(b));
};

describe('PunchDetector', () => {
  it('stays silent while idling in guard', () => {
    expect(detect([], 4000)).toEqual([]);
  });

  it.each([
    ['jab', 'jab', 'left'],
    ['cross', 'cross', 'right'],
    ['leadHook', 'hook', 'left'],
    ['rearHook', 'hook', 'right'],
    ['leadUpper', 'uppercut', 'left'],
    ['rearUpper', 'uppercut', 'right'],
  ] as const)('classifies %s', (action, type, hand) => {
    const ev = detect([[action, 300]]);
    expect(ev.map((e) => [e.type, e.hand])).toEqual([[type, hand]]);
  });

  it('works at 60 fps and with landmark noise', () => {
    const ev = detect(
      [
        ['jab', 300],
        ['cross', 800],
        ['leadHook', 1400],
      ],
      2200,
      { noise: 0.004 },
      60,
    );
    expect(ev.map((e) => e.type)).toEqual(['jab', 'cross', 'hook']);
  });

  it('mirrors hands for southpaw', () => {
    const d = new PunchDetector({ ...new PunchDetector().profile, stance: 'southpaw' });
    const ev = runScript([['jab', 300]], 1200, { stance: 'southpaw' }).flatMap((b) => d.update(b));
    expect(ev.map((e) => [e.type, e.hand])).toEqual([['jab', 'right']]);
  });

  it('fires once per punch in a fast combo', () => {
    const ev = detect(
      [
        ['jab', 200],
        ['jab', 540],
        ['cross', 880],
      ],
      1900,
    );
    expect(ev.map((e) => e.type)).toEqual(['jab', 'jab', 'cross']);
  });

  it('ignores defensive movement', () => {
    expect(
      detect(
        [
          ['slipLeft', 200],
          ['slipRight', 900],
          ['duck', 1600],
        ],
        2600,
      ),
    ).toEqual([]);
  });

  it('latency from motion start to recognition is short', () => {
    const ev = detect([['jab', 300]]);
    expect(ev[0]!.time - 300).toBeLessThan(200);
  });
});
