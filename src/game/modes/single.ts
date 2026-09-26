/**
 * Single player (arcade / daily challenge / attract demo) vs the AI boxer, first-person view.
 * Player punches are recognized locally; the AI decides its reaction at recognition time (so the dodge is
 * visible) and the hit resolves after the glove travel time. AI punches resolve against the player's
 * tracked defense with a small defender-favoring grace window.
 */
import { OpponentAI } from '../../core/ai';
import type { AiProfile } from '../../core/ai';
import { Fighter, resolvePunch } from '../../core/combat';
import { Match } from '../../core/match';
import type { MatchEvent } from '../../core/match';
import { DefenseHistory } from '../../core/netcode';
import type { MatchSummary, ScoreMode } from '../../core/scoring';
import type { DefenseKind, PunchEvent } from '../../core/types';
import { AiAnimator } from '../../render/animators';
import type { Clip } from '../../ui/recorder';
import { FightHud } from '../../ui/hud';
import type { GameContext, Mode } from '../context';
import { boxerImpact, playerImpact, PUNCH_LABEL, RESULT_LABEL } from '../feel';
import type { FrameInfo } from '../world';

const TRAVEL_MS = 90;
const DEFENSE_GRACE_MS = 70;

export interface SingleOptions {
  profile: AiProfile;
  kind: ScoreMode | 'demo';
  playerName: string;
  ticket?: Promise<string | null>;
  onDone?: (summary: MatchSummary, clip: Clip | null, ticket: string | null) => void;
  /** Called when a demo bout ends; defaults to returning to the menu. */
  onDemoEnd?: () => void;
}

interface Pending {
  p: PunchEvent;
  sf: number;
  defense: DefenseKind;
  at: number;
}

export class SingleMode implements Mode {
  readonly id = 'single';
  player: Fighter;
  cpu: Fighter;
  match: Match;
  ai: OpponentAI;
  private anim = new AiAnimator();
  private hud!: FightHud;
  private pending: Pending[] = [];
  private history = new DefenseHistory();
  private unsub: (() => void) | null = null;
  private stepX = 0;
  private guardHeldSince = 0;
  private finished = false;
  private stopped = false;
  private koClip: Clip | null = null;
  private ticket: string | null = null;
  private lastDefense: DefenseKind = 'none';
  private demoCam = 0;

  constructor(
    private ctx: GameContext,
    private opts: SingleOptions,
  ) {
    this.player = new Fighter(opts.playerName);
    this.cpu = new Fighter(opts.profile.name);
    this.match = new Match([this.player, this.cpu]);
    this.ai = new OpponentAI(opts.profile, Math.floor(Math.random() * 1e6));
  }

  get demo(): boolean {
    return this.opts.kind === 'demo';
  }

  async start(): Promise<void> {
    const { world, input } = this.ctx;
    world.setTwoBoxers(false);
    world.cameraMode = this.demo ? 'corner' : 'firstPerson';
    world.gloves.visible = !this.demo;
    world.opponent.reset();
    this.hud = new FightHud(this.ctx.hudRoot, [this.opts.playerName, this.opts.profile.name]);
    this.ai.reset(performance.now());
    this.unsub = input.onUpdate((i, u) => {
      if (i !== 0) return;
      this.history.push(performance.now(), u.defenseKind);
      if (u.defenseKind !== this.lastDefense) {
        this.lastDefense = u.defenseKind;
        this.hud.setDefense(u.defenseKind === 'none' ? '' : DEF_LABEL[u.defenseKind]);
      }
      for (const p of u.punches) this.onPlayerPunch(p);
      if (this.match.phase === 'knockdown' && this.match.downFighter === 0 && u.defense.guard) {
        if (!this.guardHeldSince) this.guardHeldSince = performance.now();
        else if (performance.now() - this.guardHeldSince > 700) this.handle(this.match.requestGetUp(0));
      } else this.guardHeldSince = 0;
    });
    if (this.opts.ticket) void this.opts.ticket.then((t) => (this.ticket = t));
    this.ctx.sound.crowd(0.35);
    this.hud.call(this.demo ? 'DEMO' : this.opts.profile.name.toUpperCase());
    if (!this.demo) this.ctx.sound.announce(`Tonight's opponent: ${this.opts.profile.name}!`, true);
  }

  private onPlayerPunch(p: PunchEvent): void {
    this.ctx.debug.onPunch(p.time);
    if (!this.match.fighting || this.player.down) return;
    const now = performance.now();
    const sf = this.player.throwPunch(p);
    const defense = this.ai.reactToPunch(p, now, this.cpu);
    this.ctx.sound.whoosh(p.speed / 5);
    this.pending.push({ p, sf, defense, at: now + TRAVEL_MS });
  }

  private resolvePending(now: number): void {
    const { world } = this.ctx;
    while (this.pending.length && this.pending[0]!.at <= now) {
      const { p, sf, defense } = this.pending.shift()!;
      if (!this.match.fighting) continue;
      const r = resolvePunch(this.player, this.cpu, p, defense, sf, now, 1 / this.opts.profile.toughness);
      boxerImpact(this.ctx, world.opponent, p, r);
      this.hud.chip(
        `${PUNCH_LABEL[p.type]} · ${RESULT_LABEL[r.result]}`,
        r.result === 'landed' ? 'landed' : r.result === 'blocked' ? 'blocked' : 'evaded',
      );
      if (r.result === 'landed') {
        this.ai.onHit(now, r.impact > 0.55);
        this.hud.combo(0, r.combo);
        if (r.counter) this.hud.call('COUNTER!', true);
      }
      this.handle(this.match.recordDamage(0, r.damage));
    }
  }

  private aiPunch(e: PunchEvent, now: number): void {
    const sf = this.cpu.throwPunch(e);
    const def = this.history.bestAround(now, DEFENSE_GRACE_MS);
    const r = resolvePunch(
      this.cpu,
      this.player,
      e,
      this.demo ? 'guard' : def,
      sf,
      now,
      this.opts.profile.damageScale,
    );
    playerImpact(this.ctx, e, r);
    if (r.result === 'slipped' || r.result === 'ducked')
      this.hud.chip(`${RESULT_LABEL[r.result]}!`, 'evaded');
    else if (r.result === 'blocked') {
      this.hud.chip('Blocked', 'blocked');
      this.hud.blocked();
    }
    this.handle(this.match.recordDamage(1, r.damage));
  }

  private handle(events: MatchEvent[]): void {
    const { sound, world } = this.ctx;
    for (const e of events) {
      if (e.type === 'bell') sound.bell(e.kind === 'start' ? 1 : 3);
      else if (e.type === 'phase') {
        if (e.phase === 'countdown') {
          this.hud.call(`ROUND ${e.round}`);
          sound.announce(e.round === this.match.cfg.rounds ? 'Final round!' : `Round ${e.round}!`);
        } else if (e.phase === 'fight' && this.match.downFighter === null && this.match.count === 0) {
          this.hud.call('FIGHT!', true);
          sound.crowd(0.55);
        } else if (e.phase === 'knockdown') {
          const f = this.match.downFighter;
          this.pending = [];
          sound.cheer(1.3);
          sound.announce('Down goes the fighter!', true);
          this.hud.call('KNOCKDOWN!', true);
          world.slowMo(0.3, 900);
          if (f === 1) world.opponent.knockDown();
        } else if (e.phase === 'roundEnd') this.hud.call('END OF ROUND');
        else if (e.phase === 'rest') sound.crowd(0.3);
      } else if (e.type === 'count') {
        // Start the staged get-up two counts early so he is on his feet when the fight resumes.
        const up = this.match.getUpCount;
        if (e.fighter === 1 && up !== null && e.n === up - 2) world.opponent.getUp();
        this.hud.call(String(e.n));
        sound.announce(String(e.n), true);
      } else if (e.type === 'getUp') {
        if (e.fighter === 1) world.opponent.getUp();
        this.hud.call('BACK UP!');
        sound.cheer(0.8);
      } else if (e.type === 'finished') void this.finish(e.winner, e.method);
    }
  }

  private async finish(winner: 0 | 1 | null, method: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const { world, sound, recorder } = this.ctx;
    const ko = method === 'KO' || method === 'TKO';
    const title = winner === 0 ? 'YOU WIN' : winner === 1 ? 'YOU LOSE' : 'DRAW';
    this.hud.call(ko ? method : title, true);
    sound.announce(
      ko ? `It's a knockout!` : winner === null ? 'The judges call it a draw.' : `Winner by decision!`,
      true,
    );
    sound.cheer(1.5);
    if (winner === 1) world.opponent.celebrate();
    if (ko && !this.demo) {
      await wait(1400);
      this.hud.el.classList.add('hidden');
      const clipPromise = new Promise<Clip | null>((resolve) => {
        recorder.onClip = (c) => resolve(c);
        if (!recorder.start(14_000)) resolve(null);
      });
      await world.playReplay(0.3);
      recorder.stop();
      this.koClip = await Promise.race([clipPromise, wait(1500).then(() => null)]);
      recorder.onClip = null;
      this.hud.el.classList.remove('hidden');
    } else await wait(2200);
    if (this.stopped) return;
    if (this.demo) {
      if (this.opts.onDemoEnd) this.opts.onDemoEnd();
      else this.ctx.toMenu();
      return;
    }
    const s = this.summary();
    this.opts.onDone?.(s, this.koClip, this.ticket);
  }

  summary(): MatchSummary {
    return {
      mode: this.opts.kind === 'demo' ? 'arcade' : this.opts.kind,
      opponent: this.opts.profile.id,
      durationMs: Math.round(this.match.elapsedFightMs),
      thrown: this.player.stats.thrown,
      landed: this.player.stats.landed,
      damageDealt: Math.round(this.player.stats.damageDealt * 10) / 10,
      damageTaken: Math.round(this.cpu.stats.damageDealt * 10) / 10,
      knockdownsScored: this.player.stats.knockdownsScored,
      maxCombo: this.player.stats.maxCombo,
      peakSpeed: Math.round(this.player.stats.peakSpeed * 10) / 10,
      won: this.match.winner === 0,
      method: this.match.method ?? 'decision',
    };
  }

  update(f: FrameInfo): void {
    const { world, input } = this.ctx;
    const now = f.now;
    const dtMs = f.dt * 1000;
    this.handle(this.match.update(dtMs));
    const tracker = input.trackers[0];
    const guarding = tracker.defense.state.guard;
    this.player.tick(dtMs, now, guarding);
    this.cpu.tick(dtMs, now, this.ai.guardUp);
    this.resolvePending(now);
    if (this.match.fighting) {
      const e = this.ai.update({
        now,
        self: this.cpu,
        playerDefense: this.demo ? 'none' : tracker.defense.kind(),
      });
      if (e) this.aiPunch(e, now);
    }
    // Opponent animation + footwork.
    const pose = this.anim.update(this.ai.action, now, f.dt, this.ai.guardUp);
    world.opponent.pose = pose;
    this.stepX += (this.ai.stepX * 0.6 - this.stepX) * Math.min(1, f.dt * 2);
    world.opponent.root.position.x = this.stepX;
    world.opponent.lookAt(world.camera.position);
    // First-person gloves + head from tracking (with latency-hiding prediction).
    const feat = tracker.predicted(now, input.latencyMs);
    world.gloves.update(this.demo ? null : feat, f.realDt);
    const ho = tracker.defense.state.headOffset;
    const downed = this.match.phase === 'knockdown' && this.match.downFighter === 0;
    const tx = this.demo ? 0 : -ho.x * 0.18;
    const ty = downed ? -0.75 : this.demo ? 0 : -Math.max(0, ho.y) * 0.2;
    world.headOffset.x += (tx - world.headOffset.x) * Math.min(1, f.realDt * 14);
    world.headOffset.y += (ty - world.headOffset.y) * Math.min(1, f.realDt * (downed ? 3 : 14));
    if (this.demo) {
      this.demoCam += f.realDt;
      const modes = ['corner', 'orbit', 'side'] as const;
      world.cameraMode = modes[Math.floor(this.demoCam / 9) % modes.length]!;
    }
    world.arena.excitement.value +=
      (Math.min(1, 0.3 + (this.player.combo + this.cpu.combo) * 0.15) - world.arena.excitement.value) *
      f.realDt;
    this.hud.update({
      health: [this.player.health, this.cpu.health],
      stamina: [this.player.stamina, this.cpu.stamina],
      knockdowns: [this.player.knockdowns, this.cpu.knockdowns],
      clockMs: this.match.phase === 'rest' ? this.match.clock : this.match.roundClock,
      round: this.match.round,
      rounds: this.match.cfg.rounds,
      label: this.match.phase === 'rest' ? 'REST' : undefined,
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsub?.();
    this.hud?.destroy();
    this.ctx.world.headOffset.set(0, 0, 0);
  }
}

const DEF_LABEL: Record<DefenseKind, string> = {
  none: '',
  guard: 'Guard',
  slipLeft: 'Slip ◀',
  slipRight: 'Slip ▶',
  duck: 'Duck',
};

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
