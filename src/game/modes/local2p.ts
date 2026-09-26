/**
 * Local 2 players on one camera: poses are assigned to left/right lanes (with identity retention through
 * crossings), each player has their own calibration profile, tracker and fighter. Rendered from ringside.
 * Player 1 (left lane) drives the blue boxer, player 2 (right lane) the red one.
 */
import { Fighter, resolvePunch } from '../../core/combat';
import { Match } from '../../core/match';
import type { MatchEvent } from '../../core/match';
import { DefenseHistory } from '../../core/netcode';
import type { PunchEvent } from '../../core/types';
import { trackedPose } from '../../render/animators';
import type { Boxer } from '../../render/boxer';
import { FightHud } from '../../ui/hud';
import type { GameContext, Mode } from '../context';
import { boxerImpact, PUNCH_LABEL, RESULT_LABEL } from '../feel';
import type { FrameInfo } from '../world';
import { wait } from './single';

const TRAVEL_MS = 90;
const GRACE_MS = 70;

export class LocalTwoPlayerMode implements Mode {
  readonly id = 'local2p';
  fighters: [Fighter, Fighter];
  match: Match;
  private hud!: FightHud;
  private hist = [new DefenseHistory(), new DefenseHistory()] as const;
  private pending: Array<{ from: 0 | 1; p: PunchEvent; sf: number; at: number }> = [];
  private unsub: (() => void) | null = null;
  private finished = false;
  private guardSince: [number, number] = [0, 0];
  private missing: [number, number] = [0, 0];

  constructor(
    private ctx: GameContext,
    private names: [string, string] = ['Player 1', 'Player 2'],
    private onDone?: (winner: 0 | 1 | null, method: string) => void,
  ) {
    this.fighters = [new Fighter(names[0]), new Fighter(names[1])];
    this.match = new Match(this.fighters);
  }

  private boxer(i: 0 | 1): Boxer {
    return i === 0 ? this.ctx.world.second : this.ctx.world.opponent;
  }

  async start(): Promise<void> {
    const { world, input } = this.ctx;
    input.setPlayers(2);
    world.setTwoBoxers(true);
    world.cameraMode = 'side';
    world.opponent.reset();
    world.second.reset();
    this.hud = new FightHud(this.ctx.hudRoot, this.names, { showSecondCombo: true });
    this.unsub = input.onUpdate((i, u) => {
      const now = performance.now();
      this.hist[i].push(now, u.defenseKind);
      for (const p of u.punches) {
        this.ctx.debug.onPunch(p.time);
        if (!this.match.fighting || this.fighters[i].down) continue;
        const sf = this.fighters[i].throwPunch(p);
        this.ctx.sound.whoosh(p.speed / 5);
        this.pending.push({ from: i, p, sf, at: now + TRAVEL_MS });
      }
      if (this.match.phase === 'knockdown' && this.match.downFighter === i && u.defense.guard) {
        if (!this.guardSince[i]) this.guardSince[i] = now;
        else if (now - this.guardSince[i] > 700) this.handle(this.match.requestGetUp(i));
      } else this.guardSince[i] = 0;
    });
    this.ctx.sound.crowd(0.4);
    this.hud.call('2 PLAYER');
    this.ctx.sound.announce('Two fighters, one ring. Let us get ready to rumble!', true);
  }

  private handle(events: MatchEvent[]): void {
    const { sound, world } = this.ctx;
    for (const e of events) {
      if (e.type === 'bell') sound.bell(e.kind === 'start' ? 1 : 3);
      else if (e.type === 'phase') {
        if (e.phase === 'countdown') {
          this.hud.call(`ROUND ${e.round}`);
          sound.announce(`Round ${e.round}!`);
        } else if (e.phase === 'fight' && this.match.downFighter === null && this.match.count === 0)
          this.hud.call('FIGHT!', true);
        else if (e.phase === 'knockdown') {
          const f = this.match.downFighter!;
          this.pending = [];
          this.boxer(f).knockDown();
          world.slowMo(0.3, 900);
          sound.cheer(1.3);
          this.hud.call('KNOCKDOWN!', true);
          sound.announce(`${this.names[f]} is down!`, true);
        } else if (e.phase === 'roundEnd') this.hud.call('END OF ROUND');
      } else if (e.type === 'count') {
        this.hud.call(String(e.n));
        sound.announce(String(e.n), true);
      } else if (e.type === 'getUp') {
        this.boxer(e.fighter).getUp();
        this.hud.call('BACK UP!');
      } else if (e.type === 'finished') void this.finish(e.winner, e.method);
    }
  }

  private async finish(winner: 0 | 1 | null, method: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const { world, sound } = this.ctx;
    const ko = method === 'KO' || method === 'TKO';
    this.hud.call(winner === null ? 'DRAW' : `${this.names[winner].toUpperCase()} WINS`, true);
    sound.announce(
      winner === null ? 'It is a draw!' : `${this.names[winner]} wins by ${ko ? 'knockout' : 'decision'}!`,
      true,
    );
    sound.cheer(1.5);
    if (winner !== null) this.boxer(winner).celebrate();
    await wait(1400);
    if (ko) {
      this.hud.el.classList.add('hidden');
      await world.playReplay(0.3);
      this.hud.el.classList.remove('hidden');
    }
    this.onDone?.(winner, method);
  }

  update(f: FrameInfo): void {
    const { world, input } = this.ctx;
    const now = f.now;
    const dtMs = f.dt * 1000;
    this.handle(this.match.update(dtMs));
    for (const i of [0, 1] as const) {
      const t = input.trackers[i];
      this.fighters[i].tick(dtMs, now, t.defense.state.guard);
      const feat = t.predicted(now, input.latencyMs);
      const b = this.boxer(i);
      if (feat) b.pose = trackedPose(feat, 0.62, t.defense.state.headOffset);
      b.lookAt(this.boxer((1 - i) as 0 | 1).headWorld());
      this.missing[i] = t.present ? 0 : this.missing[i] + f.realDt;
    }
    while (this.pending.length && this.pending[0]!.at <= now) {
      const { from, p, sf } = this.pending.shift()!;
      if (!this.match.fighting) continue;
      const to = (1 - from) as 0 | 1;
      const def = this.hist[to].bestAround(now, GRACE_MS);
      const r = resolvePunch(this.fighters[from], this.fighters[to], p, def, sf, now);
      boxerImpact(this.ctx, this.boxer(to), p, r);
      this.hud.chip(
        `P${from + 1} ${PUNCH_LABEL[p.type]} · ${RESULT_LABEL[r.result]}`,
        r.result === 'landed' ? 'landed' : r.result === 'blocked' ? 'blocked' : 'evaded',
      );
      if (r.result === 'landed') this.hud.combo(from, r.combo);
      this.handle(this.match.recordDamage(from, r.damage));
    }
    const lost = this.missing.findIndex((m) => m > 1.5);
    this.hud.setDefense(lost >= 0 ? `Player ${lost + 1}: step back into your lane` : '');
    world.arena.excitement.value +=
      (Math.min(1, 0.35 + (this.fighters[0].combo + this.fighters[1].combo) * 0.15) -
        world.arena.excitement.value) *
      f.realDt;
    this.hud.update({
      health: [this.fighters[0].health, this.fighters[1].health],
      stamina: [this.fighters[0].stamina, this.fighters[1].stamina],
      knockdowns: [this.fighters[0].knockdowns, this.fighters[1].knockdowns],
      clockMs: this.match.phase === 'rest' ? this.match.clock : this.match.roundClock,
      round: this.match.round,
      rounds: this.match.cfg.rounds,
      label: this.match.phase === 'rest' ? 'REST' : undefined,
    });
  }

  stop(): void {
    this.unsub?.();
    this.hud?.destroy();
    this.ctx.input.setPlayers(1);
    this.ctx.world.setTwoBoxers(false);
  }
}
