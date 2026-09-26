/**
 * The 3D world: engine, arena, boxers, first-person gloves, camera rigs and game-feel effects
 * (camera shake, hit-stop, slow motion, KO replay with depth of field). Owns the display-rate loop;
 * modes plug in via `onUpdate` and run on the (time-scaled) game clock.
 */
import * as THREE from 'three/webgpu';
import { Arena } from '../render/arena';
import { Boxer, loadBoxerAssets } from '../render/boxer';
import { Engine, TIERS, type QualityTier } from '../render/engine';
import { FirstPersonGloves } from '../render/fpGloves';

export type CameraMode = 'firstPerson' | 'side' | 'orbit' | 'replay' | 'corner';

export interface FrameInfo {
  /** Real time (performance.now). */
  now: number;
  /** Real delta seconds. */
  realDt: number;
  /** Game delta seconds after hit-stop/slow-mo. */
  dt: number;
}

const REPLAY_SECONDS = 3.2;

interface ReplayFrame {
  t: number;
  boxers: Float32Array[];
  gloves: Float32Array;
}

export class World {
  engine: Engine;
  arena!: Arena;
  opponent!: Boxer;
  second!: Boxer;
  gloves!: FirstPersonGloves;
  cameraMode: CameraMode = 'orbit';
  /** Player head offset in first person (m). */
  headOffset = new THREE.Vector3();
  timeScale = 1;
  onUpdate: ((f: FrameInfo) => void) | null = null;
  onAfterRender: (() => void) | null = null;
  stats = { fps: 0, frameMs: 0 };
  private hitStopUntil = 0;
  private slowUntil = 0;
  private slowScale = 1;
  private shakeAmt = 0;
  private last = 0;
  private lastRender = 0;
  /** `?maxfps=N` caps render rate (game logic still runs every frame); for software-GL CI runs. */
  private readonly minFrameMs =
    1000 / (Number(new URLSearchParams(location.search).get('maxfps')) || Infinity);
  private orbitT = 0;
  private replay: ReplayFrame[] = [];
  private replaying: { start: number; frames: ReplayFrame[]; speed: number; done: () => void } | null = null;
  private frameTimes: number[] = [];
  private tierCooldown = 0;
  private fixedTier = false;
  private camTarget = new THREE.Vector3();
  paused = false;

  constructor(canvas: HTMLCanvasElement) {
    const forceWebGL =
      new URLSearchParams(location.search).has('webgl') || sessionStorage.getItem('ca.webgl') === '1';
    this.engine = new Engine(canvas, { forceWebGL });
    const q = new URLSearchParams(location.search).get('quality') as QualityTier | null;
    if (q && TIERS.includes(q)) this.engine.setTier(q);
    this.fixedTier = !!q || new URLSearchParams(location.search).has('noadapt');
    this.engine.renderer.onDeviceLost = () => {
      if (forceWebGL) return;
      sessionStorage.setItem('ca.webgl', '1');
      location.reload();
    };
  }

  get scene(): THREE.Scene {
    return this.engine.scene;
  }

  get camera(): THREE.PerspectiveCamera {
    return this.engine.camera;
  }

  async init(onProgress: (p: number, label: string) => void): Promise<void> {
    const base = import.meta.env.BASE_URL;
    onProgress(0.05, 'Starting renderer');
    await this.engine.init();
    onProgress(0.2, 'Building arena');
    this.arena = new Arena(this.scene);
    this.scene.add(this.camera);
    onProgress(0.35, 'Loading fighters');
    const [assets] = await Promise.all([
      loadBoxerAssets(base),
      this.arena.loadEnvironment(this.engine.renderer, `${base}env/arena.hdr`),
    ]);
    onProgress(0.75, 'Rigging');
    this.opponent = new Boxer(assets, { gloveColor: 0xb3122a, trunkTint: 0xffffff });
    this.opponent.root.position.set(0, 0, -0.5);
    this.second = new Boxer(assets, { gloveColor: 0x1b3fa6, trunkTint: 0xc8d4ff });
    this.second.root.position.set(0, 0, 0.5);
    this.second.root.visible = false;
    this.scene.add(this.opponent.root, this.second.root);
    this.gloves = new FirstPersonGloves(this.camera);
    onProgress(0.9, 'Compiling shaders');
    await this.engine.renderer.compileAsync(this.scene, this.camera);
    onProgress(1, 'Ready');
    this.engine.renderer.setAnimationLoop(() => this.frame());
  }

  hitStop(ms: number): void {
    this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + ms);
  }

  slowMo(scale: number, ms: number): void {
    this.slowScale = scale;
    this.slowUntil = performance.now() + ms;
  }

  shake(amount: number): void {
    this.shakeAmt = Math.min(0.08, this.shakeAmt + amount);
  }

  /** Motion blur + flash kick on hits. */
  impactFx(strength: number, onPlayer: boolean): void {
    const fx = this.engine.fx;
    fx.blur.value = Math.max(fx.blur.value, 0.6 + strength * 1.2);
    this.engine.setMotionBlur(true);
    if (onPlayer) fx.damage.value = Math.min(1, fx.damage.value + 0.5 + strength * 0.6);
    else fx.flash.value = Math.max(fx.flash.value, 0.03 + strength * 0.05);
  }

  setTwoBoxers(on: boolean): void {
    this.second.root.visible = on;
    this.gloves.visible = !on;
    if (on) {
      this.second.root.position.set(0, 0, 0.55);
      this.opponent.root.position.set(0, 0, -0.55);
    } else this.opponent.root.position.set(0, 0, -0.5);
  }

  /** Plays back the last few seconds in slow motion from a dramatic angle with depth of field. */
  playReplay(speed = 0.3): Promise<void> {
    if (this.replay.length < 10) return Promise.resolve();
    return new Promise((resolve) => {
      this.replaying = { start: performance.now(), frames: [...this.replay], speed, done: resolve };
      this.engine.setDof(true);
    });
  }

  private record(now: number): void {
    const boxers = [this.opponent.snapshot(), this.second.snapshot()];
    const g = new Float32Array(14);
    const gl = this.gloves.group.children;
    [gl[0], gl[2]].forEach((o, i) => {
      if (!o) return;
      o.position.toArray(g, i * 7);
      o.quaternion.toArray(g, i * 7 + 3);
    });
    this.replay.push({ t: now, boxers, gloves: g });
    while (this.replay.length && now - this.replay[0]!.t > REPLAY_SECONDS * 1000) this.replay.shift();
  }

  private frame(): void {
    const now = performance.now();
    const realDt = this.last ? Math.min(1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.trackPerf(realDt);
    if (this.paused) return;
    let scale = this.timeScale;
    if (now < this.hitStopUntil) scale = 0.04;
    else if (now < this.slowUntil) scale *= this.slowScale;
    const dt = realDt * scale;
    const fx = this.engine.fx;
    fx.blur.value *= Math.exp(-realDt * 9);
    if (fx.blur.value < 0.03) this.engine.setMotionBlur(false);
    fx.flash.value *= Math.exp(-realDt * 14);
    fx.damage.value *= Math.exp(-realDt * 3.5);

    if (this.replaying) this.updateReplay(now);
    else {
      // Fixed-size substeps keep match time real-time even when rendering is very slow.
      const steps = Math.ceil(realDt / 0.1);
      for (let i = 0; i < steps; i++) {
        this.onUpdate?.({ now, realDt: realDt / steps, dt: dt / steps });
        this.opponent.update(dt / steps);
        if (this.second.root.visible) this.second.update(dt / steps);
      }
      this.record(now);
    }
    this.updateCamera(realDt, now);
    this.arena.update(realDt, this.arena.excitement.value);
    if (now - this.lastRender >= this.minFrameMs) {
      this.lastRender = now;
      this.engine.render();
    }
    this.onAfterRender?.();
  }

  private updateReplay(now: number): void {
    const r = this.replaying!;
    const frames = r.frames;
    const t0 = frames[0]!.t;
    const span = frames[frames.length - 1]!.t - t0;
    const pt = t0 + (now - r.start) * r.speed;
    if (pt - t0 >= span) {
      this.replaying = null;
      this.engine.setDof(false);
      this.engine.fx.dofAmount.value = 0;
      r.done();
      return;
    }
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1]!.t < pt) i++;
    const a = frames[i]!;
    const b = frames[i + 1]!;
    const k = Math.min(1, Math.max(0, (pt - a.t) / Math.max(1, b.t - a.t)));
    this.opponent.applySnapshot(a.boxers[0]!, b.boxers[0]!, k);
    if (this.second.root.visible) this.second.applySnapshot(a.boxers[1]!, b.boxers[1]!, k);
    const fx = this.engine.fx;
    fx.dofAmount.value = 0.9;
    const head = this.opponent.headWorld();
    fx.focus.value = this.camera.position.distanceTo(head);
  }

  private updateCamera(dt: number, now: number): void {
    const cam = this.camera;
    const opp = this.opponent.headWorld();
    const s = this.shakeAmt;
    this.shakeAmt *= Math.exp(-dt * 10);
    const shake = new THREE.Vector3(
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s * 0.5,
    );
    const mode = this.replaying ? 'replay' : this.cameraMode;
    const desired = new THREE.Vector3();
    const look = new THREE.Vector3();
    let fov: number;
    if (mode === 'firstPerson') {
      desired.set(0, 1.64, 0.55).add(this.headOffset);
      look.copy(opp).lerp(new THREE.Vector3(0, 1.45, -0.5), 0.35);
      fov = 66;
      cam.position.copy(desired).add(shake);
      this.camTarget.lerp(look, Math.min(1, dt * 12));
    } else if (mode === 'side') {
      desired.set(3.5, 1.9, 0);
      look.set(0, 1.25, 0);
      fov = 44;
      cam.position.lerp(desired, Math.min(1, dt * 3)).add(shake);
      this.camTarget.lerp(look, Math.min(1, dt * 3));
    } else if (mode === 'corner') {
      desired.set(2.4, 2.2, 2.6);
      look.set(0, 1.2, -0.3);
      fov = 45;
      cam.position.lerp(desired, Math.min(1, dt * 2)).add(shake);
      this.camTarget.lerp(look, Math.min(1, dt * 2));
    } else if (mode === 'replay') {
      this.orbitT += dt * 0.35;
      const c = this.opponent.root.position;
      desired.set(
        c.x + Math.sin(this.orbitT + 0.8) * 2.1,
        1.25 + Math.sin(now / 2000) * 0.1,
        c.z + Math.cos(this.orbitT + 0.8) * 2.1,
      );
      look.copy(this.opponent.headWorld()).add(new THREE.Vector3(0, -0.35, 0));
      fov = 38;
      cam.position.lerp(desired, Math.min(1, dt * 4));
      this.camTarget.lerp(look, Math.min(1, dt * 6));
    } else {
      this.orbitT += dt * 0.08;
      desired.set(
        Math.sin(this.orbitT) * 4.6,
        2.2 + Math.sin(this.orbitT * 0.7) * 0.4,
        Math.cos(this.orbitT) * 4.6,
      );
      look.set(0, 1.25, 0);
      fov = 42;
      cam.position.lerp(desired, Math.min(1, dt * 1.5));
      this.camTarget.lerp(look, Math.min(1, dt * 2));
    }
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
      cam.updateProjectionMatrix();
    }
    cam.lookAt(this.camTarget);
  }

  /** Adaptive quality: only degrades if the machine sustains < 50 fps; recovers when there is headroom. */
  private trackPerf(dt: number): void {
    const ft = this.frameTimes;
    ft.push(dt * 1000);
    if (ft.length > 120) ft.shift();
    const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
    this.stats.frameMs = avg;
    this.stats.fps = 1000 / avg;
    this.tierCooldown -= dt;
    if (this.tierCooldown > 0 || ft.length < 60 || document.hidden || this.fixedTier) return;
    const i = TIERS.indexOf(this.engine.info.tier);
    if (avg > 20.5 && i < TIERS.length - 1) {
      this.engine.setTier(TIERS[i + 1]!);
      this.tierCooldown = 4;
      ft.length = 0;
    } else if (avg < 14 && i > 0 && this.tierCooldown < -20) {
      this.engine.setTier(TIERS[i - 1]!);
      this.tierCooldown = 6;
      ft.length = 0;
    }
  }
}
