/**
 * Online 1v1 over WebRTC DataChannels.
 * - Each client is authoritative over its own punches (sends `punch` with its local timestamp).
 * - The defender resolves the punch against its own defense history at the reconciled impact time,
 *   applies damage to itself and replies with `hit`.
 * - The host owns the match clock/phases (knockdowns, counts, rounds, result) and broadcasts `phase`.
 * - Pose snapshots at 30 Hz on the unreliable channel drive the remote boxer (with a playout buffer).
 */
import { Fighter, resolvePunch } from '../../core/combat';
import type { Resolution } from '../../core/combat';
import { Match } from '../../core/match';
import type { MatchEvent, MatchPhase } from '../../core/match';
import {
  ClockSync,
  DefenseHistory,
  encodeDefense,
  PROTOCOL_VERSION,
  reconcileImpact,
  SnapshotBuffer,
} from '../../core/netcode';
import type { NetMessage } from '../../core/netcode';
import type { PunchEvent } from '../../core/types';
import { snapshotPose } from '../../render/animators';
import { FightHud } from '../../ui/hud';
import type { PeerLink } from '../../net/peer';
import type { GameContext, Mode } from '../context';
import { boxerImpact, playerImpact, PUNCH_LABEL, RESULT_LABEL } from '../feel';
import type { FrameInfo } from '../world';
import { wait } from './single';

const LOST_MS = 20_000;

export interface OnlineResult {
  won: boolean | null;
  method: string;
  me: Fighter;
  them: Fighter;
}

export class OnlineMode implements Mode {
  readonly id = 'online';
  me: Fighter;
  them: Fighter;
  /** Host-only authoritative match. Guests mirror `phase`, `round`, `clock`. */
  match: Match | null = null;
  phase: MatchPhase | 'waiting' = 'waiting';
  round = 1;
  clockMs = 0;
  private hud!: FightHud;
  private clock = new ClockSync();
  private history = new DefenseHistory();
  private snaps = new SnapshotBuffer(70);
  private unsub: (() => void) | null = null;
  private seq = 0;
  private punchId = 0;
  private lastPoseSent = 0;
  private lastPing = 0;
  private lastState = 0;
  private helloSeen = false;
  private downSince = 0;
  private finished = false;
  private guardSince = 0;
  private downFighter: 'me' | 'them' | null = null;
  private inflight = new Map<number, PunchEvent>();

  constructor(
    private ctx: GameContext,
    private link: PeerLink,
    private myName: string,
    private onDone: (r: OnlineResult) => void,
  ) {
    this.me = new Fighter(myName);
    this.them = new Fighter(link.peerNick);
  }

  get isHost(): boolean {
    return this.link.role === 'host';
  }

  async start(): Promise<void> {
    const { world, input } = this.ctx;
    world.setTwoBoxers(false);
    world.cameraMode = 'firstPerson';
    world.gloves.visible = true;
    world.opponent.getUp();
    this.hud = new FightHud(this.ctx.hudRoot, [this.myName, this.link.peerNick]);
    this.hud.call('ONLINE');
    this.link.onMessage = (m) => this.onNet(m);
    this.link.onState = (s) => {
      if (s === 'connected') {
        this.ctx.toast('Connected');
        this.sendHello();
      } else if (s === 'reconnecting') this.ctx.toast('Connection lost — reconnecting…');
      else if (s === 'closed' && !this.finished) this.opponentLeft();
    };
    this.unsub = input.onUpdate((i, u) => {
      if (i !== 0) return;
      const now = performance.now();
      this.history.push(now, u.defenseKind);
      for (const p of u.punches) this.onMyPunch(p);
      if (this.phase === 'knockdown' && this.downFighter === 'me' && u.defense.guard) {
        if (!this.guardSince) this.guardSince = now;
        else if (now - this.guardSince > 700) this.requestGetUp();
      } else this.guardSince = 0;
    });
    if (this.isHost) this.match = new Match([this.me, this.them]);
    if (this.link.open) this.sendHello();
    this.ctx.sound.crowd(0.4);
  }

  private sendHello(): void {
    this.link.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      name: this.myName.slice(0, 24),
      stance: this.ctx.input.trackers[0].profile.stance,
    });
  }

  // ---- networking -------------------------------------------------------------------------------

  private onNet(m: NetMessage): void {
    const now = performance.now();
    switch (m.t) {
      case 'pose':
        this.snaps.push(m, now);
        break;
      case 'hello':
        this.them.name = m.name;
        this.hud.setNames([this.myName, m.name]);
        if (!this.helloSeen) {
          this.helloSeen = true;
          this.sendHello();
          if (this.isHost && this.phase === 'waiting') {
            this.phase = 'intro';
            this.broadcastPhase('intro');
          }
        }
        break;
      case 'ping':
        this.link.send({ t: 'pong', t0: m.t0, t1: now });
        break;
      case 'pong':
        this.clock.addSample(m.t0, m.t1, now);
        break;
      case 'punch':
        this.onTheirPunch(
          { hand: m.hand, type: m.type, target: m.target, power: m.power, speed: m.speed, time: m.ts },
          m.id,
          now,
        );
        break;
      case 'hit':
        this.onHitReport(m);
        break;
      case 'state':
        this.them.health = Math.min(100, Math.max(0, m.health));
        this.them.stamina = m.stamina;
        break;
      case 'phase':
        if (!this.isHost) this.applyHostPhase(m.phase, m.round, m.clock);
        else if (m.phase === 'getupReq') this.handleHost(this.match!.requestGetUp(1));
        break;
      case 'clock':
        if (!this.isHost && this.phase === 'fight') {
          const age = this.clock.ready ? now - this.clock.toLocal(m.hostTs) : this.clock.rtt / 2;
          this.clockMs = m.clock - Math.max(0, age);
        }
        break;
      case 'finished':
        if (!this.isHost)
          void this.finish(m.winner === null ? null : (m.winner === 'guest') === !this.isHost, m.method);
        break;
      case 'bye':
        this.opponentLeft();
        break;
      default:
        break;
    }
  }

  private broadcastPhase(
    phase: string,
    round = this.match?.round ?? 1,
    clock = this.match?.clock ?? 0,
  ): void {
    this.link.send({ t: 'phase', phase, round, clock, hostTs: performance.now() });
  }

  /** Guest: mirror host phase events. Host fighter index 0 is the host (= `them` for a guest). */
  private applyHostPhase(phase: string, round: number, clock: number): void {
    const who = (i: number): 'me' | 'them' => (i === 0 ? 'them' : 'me');
    if (phase === 'count') return this.onCount(clock);
    if (phase === 'knockdown') return this.onKnockdown(who(round));
    if (phase === 'getup') return this.onGetUp(who(round));
    if (phase === 'bellStart') return this.ctx.sound.bell(1);
    if (phase === 'bellEnd') return this.ctx.sound.bell(3);
    this.round = round;
    this.clockMs = clock;
    this.enterPhase(phase as MatchPhase);
  }

  private handleHost(events: MatchEvent[]): void {
    const m = this.match!;
    for (const e of events) {
      if (e.type === 'bell') {
        this.ctx.sound.bell(e.kind === 'start' ? 1 : 3);
        this.broadcastPhase(e.kind === 'start' ? 'bellStart' : 'bellEnd');
      } else if (e.type === 'phase') {
        this.round = m.round;
        if (e.phase === 'knockdown') {
          this.broadcastPhase('knockdown', m.downFighter!, 0);
          this.onKnockdown(m.downFighter === 0 ? 'me' : 'them', true);
        } else {
          this.broadcastPhase(e.phase, m.round, e.phase === 'fight' ? m.roundClock : m.clock);
          this.enterPhase(e.phase);
        }
      } else if (e.type === 'count') {
        this.broadcastPhase('count', e.fighter, e.n);
        this.onCount(e.n);
      } else if (e.type === 'getUp') {
        this.broadcastPhase('getup', e.fighter, 0);
        this.onGetUp(e.fighter === 0 ? 'me' : 'them', true);
      } else if (e.type === 'finished') {
        const winner = e.winner === null ? null : e.winner === 0 ? 'host' : 'guest';
        this.link.send({ t: 'finished', winner, method: e.method });
        void this.finish(e.winner === null ? null : e.winner === 0, e.method);
      }
    }
  }

  private enterPhase(p: MatchPhase): void {
    const prev = this.phase;
    this.phase = p;
    const { sound } = this.ctx;
    if (p === 'countdown') {
      this.hud.call(`ROUND ${this.round}`);
      sound.announce(`Round ${this.round}!`);
    } else if (p === 'fight' && prev !== 'knockdown') {
      this.hud.call('FIGHT!', true);
      sound.crowd(0.55);
    } else if (p === 'roundEnd') this.hud.call('END OF ROUND');
    else if (p === 'intro') {
      this.hud.call(`VS ${this.them.name.toUpperCase()}`);
      sound.announce(`${this.myName} versus ${this.them.name}!`, true);
    }
  }

  private onKnockdown(who: 'me' | 'them', hostSide = false): void {
    this.phase = 'knockdown';
    this.downFighter = who;
    if (!hostSide) (who === 'me' ? this.me : this.them).knockdowns++;
    if (who === 'them') this.ctx.world.opponent.knockDown();
    this.ctx.world.slowMo(0.3, 900);
    this.ctx.sound.cheer(1.3);
    this.hud.call('KNOCKDOWN!', true);
  }

  private onCount(n: number): void {
    this.hud.call(String(n));
    this.ctx.sound.announce(String(n), true);
  }

  private onGetUp(who: 'me' | 'them', hostSide = false): void {
    this.downFighter = null;
    this.phase = 'fight';
    const f = who === 'me' ? this.me : this.them;
    if (!hostSide) f.health = Math.max(15, 100 * (0.55 - 0.15 * f.knockdowns));
    if (who === 'them') this.ctx.world.opponent.getUp();
    this.hud.call('BACK UP!');
    this.sendState();
  }

  private requestGetUp(): void {
    if (this.isHost) this.handleHost(this.match!.requestGetUp(0));
    else this.link.send({ t: 'phase', phase: 'getupReq', round: 0, clock: 0, hostTs: performance.now() });
  }

  private sendState(): void {
    this.link.send({
      t: 'state',
      health: this.me.health,
      stamina: this.me.stamina,
      knockdowns: this.me.knockdowns,
    });
  }

  // ---- combat -----------------------------------------------------------------------------------

  private onMyPunch(p: PunchEvent): void {
    this.ctx.debug.onPunch(p.time);
    if (this.phase !== 'fight' || this.me.down) return;
    this.me.throwPunch(p);
    this.ctx.sound.whoosh(p.speed / 5);
    const id = ++this.punchId;
    this.inflight.set(id, p);
    this.link.send({
      t: 'punch',
      id,
      ts: p.time,
      hand: p.hand,
      type: p.type,
      target: p.target,
      power: Math.min(1.5, p.power),
      speed: Math.min(19.9, p.speed),
    });
  }

  /** Defender side: lag-compensated resolution against my own defense history. */
  private onTheirPunch(p: PunchEvent, id: number, now: number): void {
    if (this.phase !== 'fight') return;
    const { defense } = reconcileImpact(p.time, this.clock, this.history, now);
    const sf = 0.45 + 0.55 * (this.them.stamina / 100);
    const r = resolvePunch(this.them, this.me, { ...p, time: now }, defense, sf, now);
    playerImpact(this.ctx, p, r);
    if (r.result === 'slipped' || r.result === 'ducked')
      this.hud.chip(`${RESULT_LABEL[r.result]}!`, 'evaded');
    this.link.send({
      t: 'hit',
      id,
      result: r.result,
      damage: Math.min(39, r.damage),
      health: this.me.health,
      combo: r.combo,
    });
    if (this.isHost) this.handleHost(this.match!.recordDamage(1, r.damage));
  }

  /** Attacker side: the defender told us what our punch did. */
  private onHitReport(m: Extract<NetMessage, { t: 'hit' }>): void {
    const p = this.inflight.get(m.id);
    this.inflight.delete(m.id);
    if (!p) return;
    this.them.health = Math.max(0, Math.min(100, m.health));
    const r: Resolution = {
      result: m.result,
      damage: m.damage,
      combo: m.combo,
      counter: false,
      impact: Math.min(1, Math.max(m.result === 'blocked' ? 0.05 : 0.2, m.damage / 12)),
    };
    if (m.result === 'landed') {
      this.me.stats.landed++;
      this.me.combo = m.combo;
      this.me.stats.maxCombo = Math.max(this.me.stats.maxCombo, m.combo);
      this.hud.combo(0, m.combo);
    }
    this.me.stats.damageDealt += m.damage;
    boxerImpact(this.ctx, this.ctx.world.opponent, p, r);
    this.hud.chip(
      `${PUNCH_LABEL[p.type]} · ${RESULT_LABEL[m.result]}`,
      m.result === 'landed' ? 'landed' : m.result === 'blocked' ? 'blocked' : 'evaded',
    );
    if (this.isHost) this.handleHost(this.match!.recordDamage(0, m.damage));
  }

  private opponentLeft(): void {
    if (this.finished) return;
    this.ctx.toast('Opponent left the ring');
    if (this.isHost && this.match) this.handleHost(this.match.forfeit(1));
    else void this.finish(true, 'forfeit');
  }

  private async finish(won: boolean | null, method: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'finished';
    const { sound, world } = this.ctx;
    this.hud.call(won === null ? 'DRAW' : won ? 'YOU WIN' : 'YOU LOSE', true);
    sound.announce(won === null ? 'A draw!' : won ? 'Victory!' : 'Defeat.', true);
    sound.cheer(1.4);
    if (won === false) world.opponent.celebrate();
    await wait(1400);
    if (method === 'KO' || method === 'TKO') {
      this.hud.el.classList.add('hidden');
      await world.playReplay(0.3);
      this.hud.el.classList.remove('hidden');
    }
    this.onDone({ won, method, me: this.me, them: this.them });
  }

  // ---- frame ------------------------------------------------------------------------------------

  update(f: FrameInfo): void {
    const { world, input } = this.ctx;
    const now = f.now;
    const dtMs = f.dt * 1000;
    const connected = this.link.state === 'connected';
    if (!connected && this.link.state !== 'waiting') {
      if (!this.downSince) this.downSince = now;
      else if (now - this.downSince > LOST_MS) this.opponentLeft();
    } else this.downSince = 0;

    if (this.isHost && this.match && connected && this.phase !== 'waiting')
      this.handleHost(this.match.update(dtMs));
    else if (
      !this.isHost &&
      connected &&
      (this.phase === 'fight' ||
        this.phase === 'countdown' ||
        this.phase === 'rest' ||
        this.phase === 'intro' ||
        this.phase === 'roundEnd')
    )
      this.clockMs -= dtMs;
    if (this.isHost && this.match)
      this.clockMs =
        this.match.phase === 'fight' || this.match.phase === 'knockdown'
          ? this.match.roundClock
          : this.match.clock;

    const tracker = input.trackers[0];
    this.me.tick(dtMs, now, tracker.defense.state.guard);
    if (connected && now - this.lastPing > 1000) {
      this.lastPing = now;
      this.link.send({ t: 'ping', t0: now });
      if (this.isHost && this.match?.phase === 'fight')
        this.link.send({ t: 'clock', clock: this.match.roundClock, hostTs: now });
    }
    if (connected && now - this.lastState > 250) {
      this.lastState = now;
      this.sendState();
    }
    const feat = tracker.features;
    if (connected && feat && now - this.lastPoseSent > 33) {
      this.lastPoseSent = now;
      const k = 0.6 / Math.max(0.35, feat.armLength);
      const r3 = (x: number) => Math.round(x * k * 1000) / 1000;
      const ho = tracker.defense.state.headOffset;
      const d = tracker.defense.state;
      this.link.sendPose({
        t: 'pose',
        seq: ++this.seq,
        ts: now,
        w: [
          feat.arms.left.wrist.x,
          feat.arms.left.wrist.y,
          feat.arms.left.wrist.z,
          feat.arms.right.wrist.x,
          feat.arms.right.wrist.y,
          feat.arms.right.wrist.z,
        ].map(r3),
        e: [
          feat.arms.left.elbow.x,
          feat.arms.left.elbow.y,
          feat.arms.left.elbow.z,
          feat.arms.right.elbow.x,
          feat.arms.right.elbow.y,
          feat.arms.right.elbow.z,
        ].map(r3),
        h: [Math.round(ho.x * 100) / 100, Math.round(ho.y * 100) / 100],
        d: encodeDefense(d),
      });
    }
    const snap = this.snaps.sample(now);
    if (snap) world.opponent.pose = snapshotPose(snap, 0.62);
    world.opponent.lookAt(world.camera.position);
    world.gloves.update(tracker.predicted(now, input.latencyMs));
    const ho = tracker.defense.state.headOffset;
    const downed = this.phase === 'knockdown' && this.downFighter === 'me';
    world.headOffset.x += (-ho.x * 0.18 - world.headOffset.x) * Math.min(1, f.realDt * 14);
    world.headOffset.y +=
      ((downed ? -0.75 : -Math.max(0, ho.y) * 0.2) - world.headOffset.y) * Math.min(1, f.realDt * 10);
    this.hud.setDefense(
      this.phase === 'waiting'
        ? 'Waiting for opponent…'
        : !connected
          ? 'Reconnecting…'
          : `${Math.round(this.clock.rtt)} ms${this.link.relay ? ' · relay' : ''}`,
    );
    this.hud.update({
      health: [this.me.health, this.them.health],
      stamina: [this.me.stamina, this.them.stamina],
      knockdowns: [this.me.knockdowns, this.them.knockdowns],
      clockMs: Math.max(0, this.clockMs),
      round: this.round,
      rounds: 3,
      label: this.phase === 'rest' ? 'REST' : undefined,
    });
  }

  stop(): void {
    this.unsub?.();
    this.link.onMessage = null;
    this.link.onState = null;
    this.hud?.destroy();
    this.ctx.world.headOffset.set(0, 0, 0);
  }
}
