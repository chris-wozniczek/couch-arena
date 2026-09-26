/**
 * Online 1v1 netcode primitives (transport-agnostic, pure).
 *
 * Model
 * - Each client is authoritative over *its own punches* (it decides when it threw what).
 * - The defender is authoritative over *whether it got hit*: it resolves incoming punches against its own
 *   defense history at the reconciled impact time, applies damage to itself, and reports the result.
 * - The host (room creator) owns the match clock and broadcasts phase changes.
 * - Pose snapshots (for rendering the remote boxer) travel on an unreliable/unordered channel; everything
 *   else on a reliable ordered channel.
 */
import type { DefenseKind, Hand, PunchType, Target } from './types';

export const PROTOCOL_VERSION = 1;

/** Compact pose snapshot for rendering the opponent (~30 Hz, unreliable). */
export interface PoseSnapshot {
  t: 'pose';
  seq: number;
  /** Sender local time (ms). */
  ts: number;
  /** Wrist positions relative to shoulder midpoint in meters [lx,ly,lz,rx,ry,rz], rounded to mm. */
  w: number[];
  /** Elbow positions relative to shoulder midpoint [lx,ly,lz,rx,ry,rz]. */
  e: number[];
  /** Head offset [x,y] in shoulder widths. */
  h: [number, number];
  /** Defense bitfield: 1 guard, 2 slipL, 4 slipR, 8 duck. */
  d: number;
}

export type ReliableMessage =
  | { t: 'hello'; v: number; name: string; stance: 'orthodox' | 'southpaw' }
  | { t: 'ready' }
  | { t: 'ping'; t0: number }
  | { t: 'pong'; t0: number; t1: number }
  | {
      t: 'punch';
      id: number;
      ts: number;
      hand: Hand;
      type: PunchType;
      target: Target;
      power: number;
      speed: number;
    }
  | {
      t: 'hit';
      id: number;
      result: 'landed' | 'blocked' | 'slipped' | 'ducked';
      damage: number;
      health: number;
      combo: number;
    }
  | { t: 'state'; health: number; stamina: number; knockdowns: number }
  | { t: 'phase'; phase: string; round: number; clock: number; hostTs: number }
  /** Host's round clock (ms left), sent every second so the guest's display doesn't drift. */
  | { t: 'clock'; clock: number; hostTs: number }
  | { t: 'finished'; winner: 'host' | 'guest' | null; method: string }
  | { t: 'rematch' }
  | { t: 'bye' };

export type NetMessage = PoseSnapshot | ReliableMessage;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const HANDS = new Set(['left', 'right']);
const TYPES = new Set(['jab', 'cross', 'hook', 'uppercut']);
const TARGETS = new Set(['head', 'body']);
const RESULTS = new Set(['landed', 'blocked', 'slipped', 'ducked']);

/** Validates an untrusted message from a peer. Returns null when malformed. */
export function decodeMessage(raw: string): NetMessage | null {
  if (raw.length > 4096) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'pose':
      return isNum(o.seq) &&
        isNum(o.ts) &&
        Array.isArray(o.w) &&
        o.w.length === 6 &&
        o.w.every(isNum) &&
        Array.isArray(o.e) &&
        o.e.length === 6 &&
        o.e.every(isNum) &&
        Array.isArray(o.h) &&
        o.h.length === 2 &&
        o.h.every(isNum) &&
        isNum(o.d)
        ? (o as unknown as PoseSnapshot)
        : null;
    case 'hello':
      return isNum(o.v) && isStr(o.name, 24) && (o.stance === 'orthodox' || o.stance === 'southpaw')
        ? (o as unknown as NetMessage)
        : null;
    case 'ready':
    case 'rematch':
    case 'bye':
      return { t: o.t } as NetMessage;
    case 'ping':
      return isNum(o.t0) ? { t: 'ping', t0: o.t0 } : null;
    case 'pong':
      return isNum(o.t0) && isNum(o.t1) ? { t: 'pong', t0: o.t0, t1: o.t1 } : null;
    case 'punch':
      return isNum(o.id) &&
        isNum(o.ts) &&
        HANDS.has(o.hand as string) &&
        TYPES.has(o.type as string) &&
        TARGETS.has(o.target as string) &&
        isNum(o.power) &&
        o.power >= 0 &&
        o.power <= 1.5 &&
        isNum(o.speed) &&
        o.speed >= 0 &&
        o.speed < 20
        ? (o as unknown as NetMessage)
        : null;
    case 'hit':
      return isNum(o.id) &&
        RESULTS.has(o.result as string) &&
        isNum(o.damage) &&
        o.damage >= 0 &&
        o.damage < 40 &&
        isNum(o.health) &&
        isNum(o.combo)
        ? (o as unknown as NetMessage)
        : null;
    case 'state':
      return isNum(o.health) && isNum(o.stamina) && isNum(o.knockdowns) ? (o as unknown as NetMessage) : null;
    case 'phase':
      return isStr(o.phase, 16) && isNum(o.round) && isNum(o.clock) && isNum(o.hostTs)
        ? (o as unknown as NetMessage)
        : null;
    case 'clock':
      return isNum(o.clock) && isNum(o.hostTs) ? { t: 'clock', clock: o.clock, hostTs: o.hostTs } : null;
    case 'finished':
      return (o.winner === 'host' || o.winner === 'guest' || o.winner === null) && isStr(o.method, 16)
        ? (o as unknown as NetMessage)
        : null;
    default:
      return null;
  }
}

export const encodeDefense = (k: { guard: boolean; slip: -1 | 0 | 1; duck: boolean }): number =>
  (k.guard ? 1 : 0) | (k.slip < 0 ? 2 : 0) | (k.slip > 0 ? 4 : 0) | (k.duck ? 8 : 0);

export const decodeDefense = (d: number): { guard: boolean; slip: -1 | 0 | 1; duck: boolean } => ({
  guard: (d & 1) !== 0,
  slip: d & 2 ? -1 : d & 4 ? 1 : 0,
  duck: (d & 8) !== 0,
});

/**
 * NTP-style clock offset estimation. `offset` converts remote time to local time: local ≈ remote + offset.
 * Uses the samples with the lowest round-trip time, which have the least queuing asymmetry.
 */
export class ClockSync {
  private samples: Array<{ offset: number; rtt: number }> = [];
  constructor(private maxSamples = 16) {}

  /** @param t0 local send time, t1 remote time at receipt, t2 local receive time */
  addSample(t0: number, t1: number, t2: number): void {
    const rtt = t2 - t0;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ offset: t0 + rtt / 2 - t1, rtt });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get ready(): boolean {
    return this.samples.length >= 3;
  }

  get rtt(): number {
    if (!this.samples.length) return 0;
    return Math.min(...this.samples.map((s) => s.rtt));
  }

  get offset(): number {
    if (!this.samples.length) return 0;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    return offs[offs.length >> 1]!;
  }

  toLocal(remoteTs: number): number {
    return remoteTs + this.offset;
  }
}

/** Ring buffer of the local player's defense over time, for lag-compensated hit resolution. */
export class DefenseHistory {
  private buf: Array<{ t: number; kind: DefenseKind }> = [];
  constructor(private spanMs = 1500) {}

  push(t: number, kind: DefenseKind): void {
    const last = this.buf[this.buf.length - 1];
    if (last && last.kind === kind) return;
    this.buf.push({ t, kind });
    while (this.buf.length > 2 && t - this.buf[1]!.t > this.spanMs) this.buf.shift();
  }

  /** Defense that was active at local time `t`. */
  at(t: number): DefenseKind {
    let k: DefenseKind = 'none';
    for (const e of this.buf) {
      if (e.t <= t) k = e.kind;
      else break;
    }
    return k;
  }

  /**
   * Most favorable defense for the defender within ±`graceMs` of `t`. Rewards defenders for reacting to
   * what they saw on screen despite latency, within a small bounded window.
   */
  bestAround(t: number, graceMs: number): DefenseKind {
    const rank: Record<DefenseKind, number> = { none: 0, guard: 1, slipLeft: 2, slipRight: 2, duck: 2 };
    let best = this.at(t - graceMs);
    for (const e of this.buf) {
      if (e.t > t + graceMs) break;
      if (e.t >= t - graceMs && rank[e.kind] > rank[best]) best = e.kind;
    }
    return best;
  }
}

export interface ReconcileOptions {
  /** Visual travel time of a punch from recognition to impact on the defender's screen (ms). */
  travelMs: number;
  /** Maximum lag compensation (ms); older punches resolve at now - maxRewind. */
  maxRewindMs: number;
  /** Defender-favoring grace window (ms). */
  graceMs: number;
}

export const DEFAULT_RECONCILE: ReconcileOptions = { travelMs: 90, maxRewindMs: 220, graceMs: 60 };

/**
 * Determines which of the defender's defenses applies to a remote punch.
 * Impact time = remote punch time converted to the local clock + visual travel, clamped to
 * [now - maxRewind, now] so a laggy attacker cannot rewrite too much history.
 */
export function reconcileImpact(
  remoteTs: number,
  clock: ClockSync,
  history: DefenseHistory,
  now: number,
  opts: ReconcileOptions = DEFAULT_RECONCILE,
): { impactAt: number; defense: DefenseKind; rewound: number } {
  const ideal = clock.toLocal(remoteTs) + opts.travelMs;
  const impactAt = Math.min(now, Math.max(now - opts.maxRewindMs, ideal));
  return { impactAt, defense: history.bestAround(impactAt, opts.graceMs), rewound: now - impactAt };
}

export type LinkState = 'connecting' | 'connected' | 'stalled' | 'lost';

/** Heartbeat-based link health: stalled after `stallMs` silence, lost after `lostMs`. */
export class LinkMonitor {
  private lastRecv = -1;
  state: LinkState = 'connecting';
  constructor(
    private stallMs = 2500,
    private lostMs = 20000,
  ) {}

  received(now: number): void {
    this.lastRecv = now;
    this.state = 'connected';
  }

  update(now: number): LinkState {
    if (this.lastRecv < 0) return this.state;
    const silent = now - this.lastRecv;
    this.state = silent > this.lostMs ? 'lost' : silent > this.stallMs ? 'stalled' : 'connected';
    return this.state;
  }
}

/** Interpolates remote pose snapshots with a small playout delay for smooth rendering. */
export class SnapshotBuffer {
  private buf: Array<{ at: number; s: PoseSnapshot }> = [];
  private lastSeq = -1;
  constructor(public delayMs = 60) {}

  push(s: PoseSnapshot, localArrival: number): void {
    if (s.seq <= this.lastSeq) return; // unordered channel: drop stale
    this.lastSeq = s.seq;
    this.buf.push({ at: localArrival, s });
    if (this.buf.length > 30) this.buf.shift();
  }

  sample(now: number): PoseSnapshot | null {
    if (!this.buf.length) return null;
    const t = now - this.delayMs;
    let i = this.buf.length - 1;
    while (i > 0 && this.buf[i]!.at > t) i--;
    const a = this.buf[i]!;
    const b = this.buf[i + 1];
    if (!b) return a.s;
    const k = Math.min(1, Math.max(0, (t - a.at) / Math.max(1, b.at - a.at)));
    const mix = (x: number[], y: number[]): number[] => x.map((v, j) => v + (y[j]! - v) * k);
    return { ...b.s, w: mix(a.s.w, b.s.w), e: mix(a.s.e, b.s.e), h: mix(a.s.h, b.s.h) as [number, number] };
  }
}
