/**
 * Application shell: boots the renderer, owns the input hub, routes between menu screens and game modes,
 * and wires global controls (debug HUD, highlight recorder, mute, keyboard fallback).
 */
import { sound } from './audio/sound';
import { AI_PROFILES } from './core/ai';
import type { AiProfile } from './core/ai';
import { dailyChallenge, utcDay } from './core/daily';
import { computeScore } from './core/scoring';
import type { MatchSummary, ScoreMode } from './core/scoring';
import type { SynthAction } from './core/synthetic';
import type { GameContext, Mode, ResultInfo } from './game/context';
import { loadProfile } from './game/input';
import { InputHub } from './game/input';
import { FitnessMode } from './game/modes/fitness';
import { LocalTwoPlayerMode } from './game/modes/local2p';
import { OnlineMode } from './game/modes/online';
import { SingleMode } from './game/modes/single';
import { World } from './game/world';
import { api, backendAvailable, clientKey, convex, ensurePlayer, nickname, setNickname } from './net/backend';
import { PeerLink } from './net/peer';
import type { OpenCamera } from './tracking/camera';
import { DebugHud } from './ui/debug';
import { h, toast } from './ui/dom';
import { HighlightRecorder } from './ui/recorder';
import type { Clip } from './ui/recorder';
import * as screens from './ui/screens';
import type { Screen } from './ui/screens';
import { drawCamera, drawSkeleton, PLAYER_COLORS } from './ui/skeleton';

type InputKind = 'camera' | 'synthetic';

const KEYS_P1: Record<string, SynthAction> = {
  a: 'jab',
  s: 'cross',
  q: 'leadHook',
  w: 'rearHook',
  z: 'leadUpper',
  x: 'rearUpper',
  arrowleft: 'slipLeft',
  arrowright: 'slipRight',
  arrowdown: 'duck',
  e: 'dropGuard',
};
const KEYS_P2: Record<string, SynthAction> = {
  j: 'jab',
  k: 'cross',
  u: 'leadHook',
  i: 'rearHook',
  n: 'leadUpper',
  m: 'rearUpper',
  o: 'dropGuard',
};

export class App {
  world: World;
  input: InputHub;
  debug: DebugHud;
  recorder: HighlightRecorder;
  private ui: HTMLDivElement;
  private hudRoot: HTMLDivElement;
  private pip: HTMLDivElement;
  private pipCanvas: HTMLCanvasElement;
  private pipWarn: HTMLDivElement;
  private chrome: HTMLDivElement;
  private recBadge: HTMLDivElement;
  private screen: Screen | null = null;
  private mode: Mode | null = null;
  private cam: OpenCamera | null = null;
  private inputKind: InputKind | null = null;
  private params = new URLSearchParams(location.search);
  private link: PeerLink | null = null;
  private ctx: GameContext;

  constructor(private root: HTMLElement) {
    const canvas = h('canvas', { id: 'gl' });
    const video = h('video', { id: 'cam', playsinline: true, muted: true, autoplay: true });
    this.hudRoot = h('div', { class: 'layer' });
    this.ui = h('div', { class: 'layer' });
    this.pipCanvas = h('canvas', { width: 480, height: 270 });
    this.pipWarn = h('div', { class: 'warn hidden' }, 'Step back into frame');
    this.pip = h('div', { class: 'pip hidden' }, this.pipCanvas, this.pipWarn);
    this.recBadge = h('div', { class: 'rec hidden' }, h('i'), 'REC');
    const mute = h('button', { class: 'icon-btn', title: 'Mute (M)', 'aria-label': 'Mute' }, '🔊');
    mute.addEventListener('click', () => {
      sound.setMuted(!sound.muted);
      mute.textContent = sound.muted ? '🔇' : '🔊';
    });
    const rec = h(
      'button',
      { class: 'icon-btn', title: 'Record 15 s highlight (R)', 'aria-label': 'Record highlight' },
      '⏺',
    );
    rec.addEventListener('click', () => this.toggleRecord());
    const dbg = h(
      'button',
      { class: 'icon-btn', title: 'Debug / performance HUD (D)', 'aria-label': 'Debug HUD' },
      '⚙',
    );
    dbg.addEventListener('click', () => this.debug.toggle());
    const home = h('button', { class: 'icon-btn', title: 'Menu (Esc)', 'aria-label': 'Menu' }, '☰');
    home.addEventListener('click', () => this.toMenu());
    this.chrome = h('div', { class: 'corner bl' }, home, mute, rec, dbg);
    root.append(video, canvas, this.hudRoot, this.pip, this.ui, this.chrome, this.recBadge);

    this.world = new World(canvas);
    this.input = new InputHub(video);
    this.recorder = new HighlightRecorder(canvas, () => sound.recordStream);
    this.recorder.onState = (on) => {
      this.recBadge.classList.toggle('hidden', !on);
      rec.classList.toggle('on', on);
    };
    this.debug = new DebugHud(root, {
      renderFps: () => this.world.stats.fps,
      frameMs: () => this.world.stats.frameMs,
      tracking: () => this.input.source?.stats ?? null,
      engine: () => this.world.engine.info,
      latencyMs: () => this.estimatedLatency(),
      net: () =>
        this.link ? { rtt: this.link.rttMs, relay: this.link.relay, state: this.link.state } : null,
    });
    this.ctx = {
      world: this.world,
      input: this.input,
      sound,
      debug: this.debug,
      recorder: this.recorder,
      hudRoot: this.hudRoot,
      showResults: (r) => this.showResults(r),
      toMenu: () => this.toMenu(),
      toast: (t) => toast(this.ui, t),
    };
    this.bindKeys();
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /** Perceived punch→screen latency estimate: capture→result pipeline + filter lag − prediction + 1 frame. */
  private estimatedLatency(): number {
    const s = this.input.source?.stats;
    if (!s || this.input.source?.kind === 'synthetic') return 0;
    const pipeline = s.pipelineMs;
    const filterLag = 12;
    const predicted = this.input.latencyMs;
    return Math.max(0, pipeline + filterLag - predicted * 0.7 + this.world.stats.frameMs + 8);
  }

  async boot(): Promise<void> {
    const bar = h('div');
    const label = h('div', { class: 'muted small' }, 'Loading arena…');
    this.show({
      el: h(
        'div',
        { class: 'screen' },
        h('h1', { class: 'logo' }, 'COUCH', h('br'), h('span', {}, 'ARENA')),
        h('div', { class: 'loader' }, bar),
        label,
      ),
      dispose: () => {},
    });
    await this.world.init((p, l) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      label.textContent = l;
    });
    this.world.onUpdate = (f) => this.mode?.update(f);
    this.world.onAfterRender = () => this.drawPip();
    if (this.params.get('input') === 'synthetic') this.inputKind = 'synthetic';
    const room = this.params.get('room');
    if (room) {
      await this.menu(true);
      void this.online(room);
    } else await this.menu();
  }

  // ---- routing ----------------------------------------------------------------------------------

  private show(s: Screen | null): void {
    this.screen?.dispose();
    this.screen?.el.remove();
    this.screen = s;
    if (s) this.ui.append(s.el);
  }

  private setMode(m: Mode | null): void {
    this.mode?.stop();
    this.mode = m;
  }

  private async startMode(m: Mode, showPip = true): Promise<void> {
    this.show(null);
    this.setMode(m);
    this.hudRoot.classList.remove('hidden');
    this.pip.classList.toggle('hidden', !showPip);
    await m.start();
  }

  toMenu(): void {
    void this.menu();
  }

  /** Main menu over an attract-mode demo bout driven by synthetic poses. */
  private async menu(silent = false): Promise<void> {
    this.link?.close();
    this.link = null;
    this.pip.classList.add('hidden');
    this.hudRoot.classList.add('hidden');
    this.input.setPlayers(1);
    if (!this.input.synthetic) await this.input.useSynthetic(1);
    this.input.synthetic!.autoplay = true;
    this.setMode(
      new SingleMode(this.ctx, { profile: AI_PROFILES.contender, kind: 'demo', playerName: 'Demo' }),
    );
    await this.mode!.start();
    if (silent) return;
    const nick = h('input', {
      type: 'text',
      value: nickname(),
      placeholder: 'Nickname',
      maxlength: 20,
      'aria-label': 'Nickname',
    });
    nick.addEventListener('change', () => {
      setNickname(nick.value.trim());
      if (backendAvailable())
        void ensurePlayer()
          .then((p) => (nick.value = p.nick))
          .catch(() => {});
    });
    const daily = dailyChallenge(utcDay());
    const inputSel = h(
      'select',
      { 'aria-label': 'Input' },
      h('option', { value: 'camera', selected: this.inputKind !== 'synthetic' }, 'Webcam'),
      h(
        'option',
        { value: 'synthetic', selected: this.inputKind === 'synthetic' },
        'Keyboard (synthetic poses)',
      ),
    );
    inputSel.addEventListener('change', () => (this.inputKind = inputSel.value as InputKind));
    const diff = h(
      'select',
      { 'aria-label': 'Difficulty' },
      ...Object.values(AI_PROFILES).map((p) =>
        h('option', { value: p.id, selected: p.id === 'contender' }, p.name),
      ),
    );
    const card = (t: string, d: string, fn: () => void, cls = '', badge?: string) =>
      h(
        'button',
        { class: `card ${cls}`, onclick: fn, 'data-testid': `menu-${t.toLowerCase().replace(/\s+/g, '-')}` },
        badge ? h('div', { class: 'badge' }, badge) : null,
        h('div', { class: 't' }, t),
        h('div', { class: 'd' }, d),
      );
    this.show({
      el: h(
        'div',
        { class: 'screen' },
        h('h1', { class: 'logo' }, 'COUCH ', h('span', {}, 'ARENA')),
        h('div', { class: 'tagline' }, 'Webcam boxing · no controllers'),
        h(
          'div',
          { class: 'menu' },
          card(
            'Fight',
            'Three rounds vs an AI boxer. Jab, cross, hook, uppercut — slip, duck and guard for real.',
            () => void this.single(AI_PROFILES[diff.value as keyof typeof AI_PROFILES], 'arcade'),
            'primary',
          ),
          card(
            'Daily',
            `${daily.opponent.name}: ${daily.description}`,
            () => void this.single(daily.opponent, 'daily'),
            '',
            'Today',
          ),
          card(
            '2 Players',
            'Two boxers, one camera. Stand side by side — left lane vs right lane.',
            () => void this.local2p(),
          ),
          card(
            'Online',
            'Challenge a friend with a room link or QR code. Peer-to-peer, video stays local.',
            () => void this.online(null),
          ),
          card(
            'Training',
            'Combo caller, punch count, speed and calories. 3 × 60 s rounds.',
            () => void this.fitness(),
          ),
          card('Leaderboards', 'Arcade, daily challenge and training boards.', () =>
            this.show(screens.leaderboard(() => this.toMenu())),
          ),
          card('Demo', 'Watch an exhibition bout driven by synthetic poses.', () => void this.watchDemo()),
          card(
            'Camera setup',
            'Pick a camera, check framing and lighting, recalibrate.',
            () => void this.setupCamera(() => this.toMenu(), true),
          ),
        ),
        h(
          'div',
          { class: 'row small' },
          h('span', { class: 'muted' }, 'Name'),
          nick,
          h('span', { class: 'muted' }, 'Opponent'),
          diff,
          h('span', { class: 'muted' }, 'Input'),
          inputSel,
        ),
        h(
          'div',
          { class: 'muted small' },
          'Keyboard: A jab · S cross · Q/W hooks · Z/X uppercuts · ←/→ slip · ↓ duck · R record · D debug · Esc menu',
        ),
      ),
      dispose: () => {},
    });
  }

  // ---- input ------------------------------------------------------------------------------------

  /** Ensures the chosen input is live (camera → setup + calibration if needed). */
  private async ensureInput(players: 1 | 2): Promise<boolean> {
    this.input.setPlayers(players);
    if (this.inputKind === 'synthetic') {
      const s = await this.input.useSynthetic(players);
      s.autoplay = false;
      return true;
    }
    this.inputKind = 'camera';
    const needCal = [0, 1].slice(0, players).some((i) => !loadProfile(i));
    if (!this.cam || !this.input.mediapipe || needCal) {
      const ok = await new Promise<boolean>((resolve) =>
        this.setupCamera(
          () => resolve(true),
          needCal || !this.cam,
          () => resolve(false),
        ),
      );
      if (!ok) return false;
    }
    await this.input.useCamera();
    this.input.setPlayers(players);
    return true;
  }

  private setupCamera(done: () => void, calibrate: boolean, cancel: () => void = () => this.toMenu()): void {
    this.hudRoot.classList.add('hidden');
    this.show(
      screens.cameraSetup(
        this.input,
        this.cam,
        (c) => (this.cam = c),
        () => (calibrate ? this.calibrate(0, done) : done()),
        cancel,
      ),
    );
  }

  private calibrate(slot: 0 | 1, done: () => void): void {
    const next = () => (slot === 0 && this.input.players === 2 ? this.calibrate(1, done) : done());
    this.show(screens.calibration(this.input, slot, next, next));
  }

  // ---- modes ------------------------------------------------------------------------------------

  private ticket(mode: ScoreMode): Promise<string | null> {
    if (!backendAvailable()) return Promise.resolve(null);
    return ensurePlayer()
      .then(() => convex().mutation(api.results.begin, { key: clientKey(), mode }))
      .then((r) => r.ticket as string)
      .catch(() => null);
  }

  private async single(profile: AiProfile, kind: ScoreMode): Promise<void> {
    if (!(await this.ensureInput(1))) return;
    const name = nickname() || 'You';
    await this.startMode(
      new SingleMode(this.ctx, {
        profile,
        kind,
        playerName: name,
        ticket: this.ticket(kind),
        onDone: (s, clip, ticket) =>
          this.fightResults(s, clip, ticket, () => void this.single(profile, kind)),
      }),
    );
  }

  private fightResults(s: MatchSummary, clip: Clip | null, ticket: string | null, again: () => void): void {
    const acc = s.thrown ? Math.round((s.landed / s.thrown) * 100) : 0;
    this.showResults({
      title: s.won ? 'VICTORY' : s.method === 'draw' ? 'DRAW' : 'DEFEAT',
      subtitle: `${s.method} · ${Math.round(s.durationMs / 1000)} s of fighting · score ${computeScore(s).toLocaleString()}`,
      stats: [
        ['Landed', `${s.landed}/${s.thrown}`],
        ['Accuracy', `${acc}%`],
        ['Max combo', String(s.maxCombo)],
        ['Knockdowns', String(s.knockdownsScored)],
        ['Peak speed', `${s.peakSpeed.toFixed(1)} m/s`],
        ['Damage', `${Math.round(s.damageDealt)} / ${Math.round(s.damageTaken)}`],
      ],
      summary: s,
      ticket,
      clip,
      again,
    });
  }

  private showResults(r: ResultInfo): void {
    this.setMode(null);
    this.pip.classList.add('hidden');
    this.hudRoot.classList.add('hidden');
    this.world.cameraMode = 'orbit';
    this.show(screens.results(r, () => this.toMenu()));
  }

  private async local2p(): Promise<void> {
    if (!(await this.ensureInput(2))) return;
    await this.startMode(
      new LocalTwoPlayerMode(this.ctx, ['Player 1', 'Player 2'], (winner, method) =>
        this.showResults({
          title: winner === null ? 'DRAW' : `PLAYER ${winner + 1} WINS`,
          subtitle: method,
          stats: [],
          again: () => void this.local2p(),
        }),
      ),
    );
  }

  private async fitness(): Promise<void> {
    if (!(await this.ensureInput(1))) return;
    const ticket = this.ticket('fitness');
    await this.startMode(
      new FitnessMode(this.ctx, {
        level: 1,
        rounds: 3,
        onDone: (s, extra) =>
          void ticket.then((t) =>
            this.showResults({
              title: 'SESSION COMPLETE',
              subtitle: `${s.thrown} punches · peak ${s.peakSpeed.toFixed(1)} m/s`,
              stats: [['Punches', String(s.thrown)], ['Correct', String(s.landed)], ...extra],
              summary: s,
              ticket: t,
              again: () => void this.fitness(),
            }),
          ),
      }),
    );
  }

  private async watchDemo(): Promise<void> {
    this.input.setPlayers(1);
    const s = await this.input.useSynthetic(1);
    s.autoplay = true;
    await this.startMode(
      new SingleMode(this.ctx, { profile: AI_PROFILES.champion, kind: 'demo', playerName: 'Synthetic' }),
    );
  }

  private async online(code: string | null): Promise<void> {
    if (!backendAvailable()) {
      toast(this.ui, 'Online play needs the backend (VITE_CONVEX_URL).');
      return;
    }
    const lobby = screens.lobby(code, {
      onBack: () => this.toMenu(),
      onRoom: (c, role) => void this.enterRoom(c, role),
    });
    this.show(lobby);
  }

  private async enterRoom(code: string, role: 'host' | 'guest'): Promise<void> {
    history.replaceState(null, '', `/?room=${code}`);
    const link = new PeerLink(code, role);
    this.link = link;
    const wr = screens.waitingRoom(code, role, () => {
      history.replaceState(null, '', '/');
      this.toMenu();
    });
    this.show(wr);
    link.onState = (s) =>
      wr.setStatus(
        s === 'connecting'
          ? 'Opponent found — connecting peer-to-peer…'
          : s === 'connected'
            ? 'Connected!'
            : s,
      );
    await link.start();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (link.open || this.link !== link) {
          clearInterval(t);
          resolve();
        }
      }, 100);
    });
    if (this.link !== link) return;
    if (!(await this.ensureInput(1))) return;
    this.startOnline(link);
  }

  private startOnline(link: PeerLink): void {
    const name = nickname() || 'You';
    void this.startMode(
      new OnlineMode(this.ctx, link, name, (r) =>
        this.showResults({
          title: r.won === null ? 'DRAW' : r.won ? 'VICTORY' : 'DEFEAT',
          subtitle: `${r.method} vs ${r.them.name}`,
          stats: [
            ['Landed', `${r.me.stats.landed}/${r.me.stats.thrown}`],
            ['Max combo', String(r.me.stats.maxCombo)],
            ['Damage', String(Math.round(r.me.stats.damageDealt))],
            ['Knockdowns', String(r.them.knockdowns)],
          ],
          again: () => (link.state === 'closed' ? this.toMenu() : this.startOnline(link)),
        }),
      ),
    );
  }

  // ---- global controls --------------------------------------------------------------------------

  private toggleRecord(): void {
    if (this.recorder.recording) {
      this.recorder.stop();
      return;
    }
    sound.unlock();
    this.recorder.onClip = (c) => this.showClip(c);
    if (!this.recorder.start()) toast(this.ui, 'Recording is not supported in this browser');
  }

  private showClip(c: Clip): void {
    const box = h('div', {
      class: 'panel',
      style: 'position:absolute;right:16px;bottom:16px;z-index:5;max-width:min(680px,92vw)',
    });
    box.append(
      screens.clipView(c, 'Highlight'),
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn small', onclick: () => box.remove() }, 'Close'),
      ),
    );
    this.root.append(box);
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') return this.toMenu();
      if (k === 'r' && !e.metaKey && !e.ctrlKey) return this.toggleRecord();
      if (k === 'm' && this.input.players === 1) {
        sound.setMuted(!sound.muted);
        return;
      }
      const syn = this.input.synthetic;
      if (!syn || syn.autoplay) return;
      const a1 = KEYS_P1[k];
      const a2 = KEYS_P2[k];
      if (a1) {
        e.preventDefault();
        syn.trigger(a1, 0);
      } else if (a2 && this.input.players === 2) syn.trigger(a2, 1);
    });
  }

  private pipFrame = 0;
  private lostSince = 0;
  private drawPip(): void {
    if (this.pip.classList.contains('hidden') || ++this.pipFrame % 2) return;
    const ctx = this.pipCanvas.getContext('2d')!;
    drawCamera(ctx, this.input.mediapipe ? this.input.video : null, 0.85);
    if (this.input.players === 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(this.pipCanvas.width / 2 - 1, 0, 2, this.pipCanvas.height);
    }
    if (this.debug.showSkeleton)
      this.input.assigned.forEach(
        (p, i) =>
          p && drawSkeleton(ctx, p, PLAYER_COLORS[i]!, this.input.players === 2 ? `P${i + 1}` : undefined),
      );
    const lost = this.input.trackers.slice(0, this.input.players).some((t) => !t.present);
    const now = performance.now();
    if (!lost) this.lostSince = 0;
    else if (!this.lostSince) this.lostSince = now;
    this.pipWarn.classList.toggle('hidden', !lost || now - this.lostSince < 1500);
  }
}
