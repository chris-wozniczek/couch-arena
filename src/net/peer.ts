/**
 * WebRTC peer link for online 1v1. Convex tables carry only signaling (offer/answer/ICE); gameplay flows
 * over two DataChannels: `pose` (unordered, no retransmits) and `events` (reliable, ordered).
 *
 * The host is always the offerer. Reconnect: when the connection fails or a channel closes, the host
 * bumps the room epoch (which discards stale signaling) and re-offers; the guest resets on epoch change.
 */
import type { ConvexClient } from 'convex/browser';
import { decodeMessage } from '../core/netcode';
import type { NetMessage, PoseSnapshot, ReliableMessage } from '../core/netcode';
import type { Id } from '../../convex/_generated/dataModel';
import { api, clientKey, convex } from './backend';

export type Role = 'host' | 'guest';
export type PeerState = 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface RoomView {
  epoch: number;
  guestNick: string | null;
  hostNick: string;
  status: string;
}

export class PeerLink {
  state: PeerState = 'waiting';
  onState: ((s: PeerState) => void) | null = null;
  onMessage: ((m: NetMessage) => void) | null = null;
  onRoom: ((r: RoomView) => void) | null = null;
  relay = false;
  rttMs = 0;
  private pc: RTCPeerConnection | null = null;
  private pose: RTCDataChannel | null = null;
  private events: RTCDataChannel | null = null;
  private ice: RTCIceServer[] = [];
  private epoch = -1;
  private room: RoomView | null = null;
  private unsubs: Array<() => void> = [];
  private pendingIce: RTCIceCandidateInit[] = [];
  private seen = new Set<Id<'signals'>>();
  private heartbeat = 0;
  private statsTimer = 0;
  private failTimer = 0;
  private c: ConvexClient;
  private key = clientKey();

  constructor(
    readonly code: string,
    readonly role: Role,
  ) {
    this.c = convex();
  }

  async start(): Promise<void> {
    const r = await this.c.action(api.turn.iceServers, { key: this.key });
    this.ice = r.iceServers as RTCIceServer[];
    this.unsubs.push(
      this.c.onUpdate(api.rooms.get, { code: this.code }, (room) => room && this.handleRoom(room)),
      this.c.onUpdate(
        api.signals.inbox,
        { key: this.key, code: this.code, as: this.role },
        (rows) => void this.handleSignals(rows),
      ),
    );
    this.heartbeat = window.setInterval(
      () => void this.c.mutation(api.rooms.heartbeat, { key: this.key, code: this.code, role: this.role }),
      5000,
    );
    this.statsTimer = window.setInterval(() => void this.pollStats(), 2000);
  }

  private setState(s: PeerState): void {
    if (this.state === s) return;
    this.state = s;
    this.onState?.(s);
  }

  private handleRoom(room: RoomView): void {
    this.room = room;
    this.onRoom?.(room);
    if (room.status === 'closed') {
      this.setState('closed');
      return;
    }
    if (room.epoch !== this.epoch) {
      const first = this.epoch < 0;
      this.epoch = room.epoch;
      this.resetPc();
      if (!first) this.setState('reconnecting');
      if (this.role === 'host' && room.guestNick) void this.makeOffer();
    } else if (this.role === 'host' && room.guestNick && !this.pc) void this.makeOffer();
  }

  private resetPc(): void {
    this.pose?.close();
    this.events?.close();
    this.pc?.close();
    this.pc = null;
    this.pose = null;
    this.events = null;
    this.pendingIce = [];
  }

  private newPc(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    const epoch = this.epoch;
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.signal('ice', JSON.stringify(e.candidate.toJSON()), epoch);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (pc !== this.pc) return;
      if (s === 'connected') clearTimeout(this.failTimer);
      if (s === 'failed') void this.restart();
      if (s === 'disconnected') {
        this.setState('reconnecting');
        clearTimeout(this.failTimer);
        this.failTimer = window.setTimeout(
          () => pc.connectionState !== 'connected' && void this.restart(),
          4000,
        );
      }
    };
    pc.ondatachannel = (e) => this.bindChannel(e.channel);
    this.pc = pc;
    this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    return pc;
  }

  private bindChannel(ch: RTCDataChannel): void {
    if (ch.label === 'pose') this.pose = ch;
    else this.events = ch;
    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = decodeMessage(e.data);
      if (m) this.onMessage?.(m);
    };
    ch.onopen = () => {
      if (this.events?.readyState === 'open' && this.pose?.readyState === 'open') this.setState('connected');
    };
    ch.onclose = () => {
      if (this.state === 'connected' && this.pc && ch.label === 'events') void this.restart();
    };
  }

  /** Host-driven renegotiation from scratch under a new epoch. */
  private async restart(): Promise<void> {
    if (this.state === 'closed') return;
    this.setState('reconnecting');
    if (this.role === 'host') await this.c.mutation(api.rooms.bumpEpoch, { key: this.key, code: this.code });
  }

  private async makeOffer(): Promise<void> {
    const pc = this.newPc();
    this.bindChannel(pc.createDataChannel('pose', { ordered: false, maxRetransmits: 0 }));
    this.bindChannel(pc.createDataChannel('events', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.signal('offer', JSON.stringify(pc.localDescription), this.epoch);
  }

  private async signal(
    kind: 'offer' | 'answer' | 'ice' | 'bye',
    payload: string,
    epoch: number,
  ): Promise<void> {
    try {
      await this.c.mutation(api.signals.send, {
        key: this.key,
        code: this.code,
        from: this.role,
        kind,
        payload,
        epoch,
      });
    } catch (e) {
      console.warn('signal failed', e);
    }
  }

  private async handleSignals(
    rows: Array<{ id: Id<'signals'>; kind: string; payload: string; epoch: number }>,
  ): Promise<void> {
    const fresh = rows.filter((r) => !this.seen.has(r.id));
    if (!fresh.length) return;
    for (const r of fresh) this.seen.add(r.id);
    for (const r of fresh) {
      if (r.epoch !== this.epoch) continue;
      try {
        if (r.kind === 'offer' && this.role === 'guest') {
          this.resetPc();
          const pc = this.newPc();
          await pc.setRemoteDescription(JSON.parse(r.payload) as RTCSessionDescriptionInit);
          for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          await this.signal('answer', JSON.stringify(pc.localDescription), this.epoch);
        } else if (r.kind === 'answer' && this.role === 'host' && this.pc) {
          await this.pc.setRemoteDescription(JSON.parse(r.payload) as RTCSessionDescriptionInit);
          for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
        } else if (r.kind === 'ice') {
          const c = JSON.parse(r.payload) as RTCIceCandidateInit;
          if (this.pc?.remoteDescription) await this.pc.addIceCandidate(c);
          else this.pendingIce.push(c);
        } else if (r.kind === 'bye') this.setState('closed');
      } catch (e) {
        console.warn('signal handling failed', e);
      }
    }
    void this.c.mutation(api.signals.ack, {
      key: this.key,
      code: this.code,
      as: this.role,
      ids: fresh.map((r) => r.id),
    });
  }

  private async pollStats(): Promise<void> {
    if (!this.pc || this.state !== 'connected') return;
    const stats = await this.pc.getStats();
    stats.forEach(
      (
        s: RTCStats & {
          state?: string;
          nominated?: boolean;
          currentRoundTripTime?: number;
          localCandidateId?: string;
        },
      ) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
          if (s.currentRoundTripTime) this.rttMs = s.currentRoundTripTime * 1000;
          const local = s.localCandidateId
            ? (stats.get(s.localCandidateId) as { candidateType?: string } | undefined)
            : undefined;
          this.relay = local?.candidateType === 'relay';
        }
      },
    );
  }

  sendPose(s: PoseSnapshot): void {
    if (this.pose?.readyState === 'open' && this.pose.bufferedAmount < 16_000)
      this.pose.send(JSON.stringify(s));
  }

  send(m: ReliableMessage): void {
    if (this.events?.readyState === 'open') this.events.send(JSON.stringify(m));
  }

  get open(): boolean {
    return this.events?.readyState === 'open';
  }

  get peerNick(): string {
    return (this.role === 'host' ? this.room?.guestNick : this.room?.hostNick) ?? 'Opponent';
  }

  async close(): Promise<void> {
    this.send({ t: 'bye' });
    clearInterval(this.heartbeat);
    clearInterval(this.statsTimer);
    this.unsubs.forEach((u) => u());
    this.resetPc();
    this.setState('closed');
    try {
      await this.c.mutation(api.rooms.leave, { key: this.key, code: this.code });
    } catch {
      // ignore
    }
  }
}
