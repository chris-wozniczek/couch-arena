/**
 * Fitness / training: interval rounds with a combo caller (1 jab, 2 cross, 3 lead hook, 4 rear hook,
 * 5 lead uppercut, 6 rear uppercut), live punch count, speed, punches-per-minute and calories. The AI
 * boxer acts as a sparring partner who absorbs the punches.
 */
import { COMBO_NAMES, FitnessSession } from '../../core/fitness';
import type { ComboNumber } from '../../core/fitness';
import type { MatchSummary } from '../../core/scoring';
import type { PunchEvent } from '../../core/types';
import { AiAnimator } from '../../render/animators';
import { fmtClock, h } from '../../ui/dom';
import type { GameContext, Mode } from '../context';
import type { FrameInfo } from '../world';

export class FitnessMode implements Mode {
  readonly id = 'fitness';
  session: FitnessSession;
  private el!: HTMLDivElement;
  private callEl!: HTMLDivElement;
  private clock!: HTMLDivElement;
  private label!: HTMLDivElement;
  private stats: Record<string, HTMLDivElement> = {};
  private anim = new AiAnimator();
  private unsub: (() => void) | null = null;
  private correct = 0;
  private startedAt = 0;
  private done = false;

  constructor(
    private ctx: GameContext,
    private opts: {
      level: 0 | 1 | 2;
      rounds: number;
      onDone: (s: MatchSummary, extra: Array<[string, string]>) => void;
    },
  ) {
    const stance = ctx.input.trackers[0].profile.stance;
    this.session = new FitnessSession(
      { rounds: opts.rounds, workMs: 60_000, restMs: 20_000, level: opts.level },
      stance,
      Date.now() % 1e6,
    );
  }

  async start(): Promise<void> {
    const { world, input } = this.ctx;
    world.setTwoBoxers(false);
    world.cameraMode = 'firstPerson';
    world.opponent.reset();
    const stat = (k: string, label: string) => {
      const v = h('div', { class: 'v' }, '0');
      this.stats[k] = v;
      return h('div', { class: 'stat' }, v, h('div', { class: 'k' }, label));
    };
    this.clock = h('div', { class: 'time' }, '0:03');
    this.label = h('div', { class: 'round' }, 'GET READY');
    this.callEl = h('div', { class: 'fit-call' });
    this.el = h(
      'div',
      { class: 'hud' },
      h(
        'div',
        { class: 'top', style: 'grid-template-columns:1fr auto 1fr' },
        h('div'),
        h('div', { class: 'clock' }, this.label, this.clock),
        h('div'),
      ),
      this.callEl,
      h(
        'div',
        { class: 'fit-stats' },
        stat('punches', 'Punches'),
        stat('speed', 'Peak m/s'),
        stat('avg', 'Avg m/s'),
        stat('ppm', 'Per min'),
        stat('combos', 'Combos'),
        stat('kcal', 'kcal'),
      ),
    );
    this.ctx.hudRoot.append(this.el);
    this.unsub = input.onUpdate((i, u) => {
      if (i === 0) for (const p of u.punches) this.onPunch(p);
    });
    this.startedAt = performance.now();
    this.ctx.sound.crowd(0.15);
    this.ctx.sound.announce('Training session. Follow the calls!', true);
  }

  private onPunch(p: PunchEvent): void {
    this.ctx.debug.onPunch(p.time);
    this.ctx.sound.impact(p.type, 0.5 + Math.min(0.5, p.power * 0.4), false);
    this.ctx.world.opponent.hit({ ...p, strength: 0.25, blocked: false });
    this.ctx.world.shake(0.004);
    for (const e of this.session.onPunch(p)) {
      if (e.type === 'progress') {
        const cell = this.callEl.children[e.index];
        if (e.correct) {
          this.correct++;
          cell?.classList.add('done');
        } else if (cell) {
          cell.classList.remove('miss');
          void (cell as HTMLElement).offsetWidth;
          cell.classList.add('miss');
        }
      } else if (e.type === 'comboDone') {
        this.ctx.sound.bell(1);
        this.ctx.world.impactFx(0.4, false);
        this.ctx.toast(
          e.perfect ? `Perfect! ${(e.ms / 1000).toFixed(2)} s` : `Done in ${(e.ms / 1000).toFixed(2)} s`,
        );
        setTimeout(() => this.renderCall([]), 350);
      }
    }
  }

  private renderCall(combo: ComboNumber[]): void {
    this.callEl.replaceChildren(
      ...combo.map((n) =>
        h('div', { class: 'p' }, h('div', {}, String(n), h('small', {}, COMBO_NAMES[n].toUpperCase()))),
      ),
    );
  }

  update(f: FrameInfo): void {
    const { world, input, sound } = this.ctx;
    for (const e of this.session.update(f.dt * 1000, f.now)) {
      if (e.type === 'phase') {
        if (e.phase === 'work') {
          sound.bell(1);
          sound.announce(`Round ${e.round}. Work!`);
        } else if (e.phase === 'rest') {
          sound.bell(3);
          sound.announce('Rest. Breathe.');
          this.renderCall([]);
        } else if (e.phase === 'done') this.finish();
      } else if (e.type === 'call') {
        this.renderCall(e.combo);
        sound.announce(e.combo.join(', '), true);
      }
    }
    const s = this.session;
    this.clock.textContent = fmtClock(s.clock);
    this.label.textContent =
      s.phase === 'work'
        ? `ROUND ${s.round}/${s.cfg.rounds}`
        : s.phase === 'rest'
          ? 'REST'
          : s.phase === 'ready'
            ? 'GET READY'
            : 'DONE';
    this.stats.punches!.textContent = String(s.stats.punches);
    this.stats.speed!.textContent = s.stats.peakSpeed.toFixed(1);
    this.stats.avg!.textContent = s.avgSpeed.toFixed(1);
    this.stats.ppm!.textContent = String(s.punchesPerMinute);
    this.stats.combos!.textContent = `${s.stats.combosCompleted}/${s.stats.combosCalled}`;
    this.stats.kcal!.textContent = s.stats.kcal.toFixed(1);
    world.opponent.pose = this.anim.update({ kind: 'idle', start: 0, end: 0 }, f.now, f.dt, true);
    world.opponent.lookAt(world.camera.position);
    world.gloves.update(input.trackers[0].predicted(f.now, input.latencyMs), f.realDt);
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    const s = this.session.stats;
    const summary: MatchSummary = {
      mode: 'fitness',
      opponent: `level${this.opts.level + 1}`,
      durationMs: Math.round(performance.now() - this.startedAt),
      thrown: s.punches,
      landed: Math.min(this.correct, s.punches),
      damageDealt: 0,
      damageTaken: 0,
      knockdownsScored: 0,
      maxCombo: 0,
      peakSpeed: Math.round(s.peakSpeed * 10) / 10,
      won: true,
      method: 'fitness',
    };
    this.opts.onDone(summary, [
      ['Combos', `${s.combosCompleted}/${s.combosCalled}`],
      ['Avg reaction', s.reactionCount ? `${Math.round(s.reactionSum / s.reactionCount)} ms` : '—'],
      ['Avg speed', `${this.session.avgSpeed.toFixed(1)} m/s`],
      ['Calories', `${s.kcal.toFixed(1)} kcal`],
    ]);
  }

  stop(): void {
    this.unsub?.();
    this.el?.remove();
  }
}
