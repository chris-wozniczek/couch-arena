/**
 * Defensive posture recognition: guard (hands up near face), slip left/right (head lateral lean relative
 * to the hips or calibrated neutral) and duck (head drops). All with enter/exit hysteresis.
 */
import type { BodyFeatures } from './body';
import type { CalibrationProfile } from './calibration';
import { DEFAULT_PROFILE } from './calibration';
import type { DefenseKind, DefenseState } from './types';

export interface DefenseTuning {
  slipEnter: number;
  slipExit: number;
  duckEnter: number;
  duckExit: number;
  /** Guard: max wrist distance below the nose (shoulder widths). */
  guardLow: number;
  /** Guard: max wrist horizontal distance from the nose (shoulder widths). */
  guardWide: number;
  /** Extra margin to leave guard. */
  guardHyst: number;
}

export const DEFAULT_DEFENSE_TUNING: DefenseTuning = {
  slipEnter: 0.42,
  slipExit: 0.26,
  duckEnter: 0.45,
  duckExit: 0.28,
  guardLow: 0.95,
  guardWide: 0.9,
  guardHyst: 0.15,
};

export class DefenseDetector {
  state: DefenseState = { guard: false, slip: 0, duck: false, headOffset: { x: 0, y: 0 } };
  constructor(
    public profile: CalibrationProfile = DEFAULT_PROFILE,
    public tuning: DefenseTuning = DEFAULT_DEFENSE_TUNING,
  ) {}

  reset(): void {
    this.state = { guard: false, slip: 0, duck: false, headOffset: { x: 0, y: 0 } };
  }

  update(b: BodyFeatures): DefenseState {
    if (!b.valid) return this.state;
    const T = this.tuning;
    const P = this.profile;
    const S = Math.max(0.02, P.shoulderWidthImg || b.img.shoulderWidth);
    // Scale for distance changes since calibration.
    const k = b.img.shoulderWidth / S;
    const Sn = S * k;
    let ox: number;
    if (b.img.hipMid && P.neutralNoseRelHip)
      ox = (b.img.nose.x - b.img.hipMid.x - P.neutralNoseRelHip.x) / Sn;
    else ox = (b.img.nose.x - P.neutralNose.x) / Sn;
    const oy = (b.img.nose.y - P.neutralNose.y) / Sn;
    const st = this.state;
    st.headOffset = { x: ox, y: oy };

    if (st.slip === 0) {
      if (ox > T.slipEnter) st.slip = 1;
      else if (ox < -T.slipEnter) st.slip = -1;
    } else if (Math.abs(ox) < T.slipExit || Math.sign(ox) !== st.slip) st.slip = 0;

    if (!st.duck && oy > T.duckEnter) st.duck = true;
    else if (st.duck && oy < T.duckExit) st.duck = false;

    const hyst = st.guard ? T.guardHyst : 0;
    const nose = b.img.nose;
    const handUp = (h: 'left' | 'right'): boolean => {
      const w = b.arms[h].wristImg;
      const dy = (w.y - nose.y) / Sn;
      return dy < T.guardLow + hyst && dy > -0.9 - hyst && b.arms[h].forward < 0.6 * P.armLength;
    };
    const wide = (h: 'left' | 'right'): boolean =>
      Math.abs(b.arms[h].wrist.x - b.head.x) / P.shoulderWidth < T.guardWide + hyst;
    st.guard = handUp('left') && handUp('right') && wide('left') && wide('right');
    return st;
  }

  /** Dominant defense for resolution purposes (slip/duck beat guard). */
  kind(): DefenseKind {
    const s = this.state;
    if (s.duck) return 'duck';
    if (s.slip < 0) return 'slipLeft';
    if (s.slip > 0) return 'slipRight';
    if (s.guard) return 'guard';
    return 'none';
  }
}

export function defenseKind(s: DefenseState): DefenseKind {
  if (s.duck) return 'duck';
  if (s.slip < 0) return 'slipLeft';
  if (s.slip > 0) return 'slipRight';
  if (s.guard) return 'guard';
  return 'none';
}
