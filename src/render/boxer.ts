/**
 * Rigged 3D boxer: a CC0 Quaternius character + Universal Animation Library clips, extended with a
 * procedural layer on top of the mixer (aim-based two-bone arm IK for guard/jab/cross/hook/uppercut,
 * spine lean for slips/ducks, spring-damped hit reactions) and a clip-driven KO/celebration layer.
 *
 * Fighter frame (used by every driver): origin at the shoulder midpoint, x = fighter's right,
 * y = up, z = toward the opponent — the same convention as `core/body` features, so tracked players
 * and network snapshots drive the rig directly.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  exp,
  float,
  materialColor,
  mix,
  mx_noise_float,
  positionGeometry,
  smoothstep as tslSmoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { solveElbow } from '../core/synthetic';
import type { Hand, PunchType, Target, Vec3 } from '../core/types';
import { makeGlove } from './gloves';

interface Assets {
  character: GLTF;
  clips: Map<string, THREE.AnimationClip>;
}

let assetsPromise: Promise<Assets> | null = null;

export function loadBoxerAssets(base: string): Promise<Assets> {
  assetsPromise ??= (async () => {
    const loader = new GLTFLoader();
    const [character, anims] = await Promise.all([
      loader.loadAsync(`${base}models/boxer.glb`),
      loader.loadAsync(`${base}models/boxer-anims.glb`),
    ]);
    const clips = new Map(anims.animations.map((c) => [c.name, c]));
    // Get-up pieces cut from the kneeling clip: a hand-on-canvas kneel and the push up to standing.
    const kneel = clips.get('Fixing_Kneeling');
    if (kneel) {
      const fps = 30;
      const f = (u: number) => Math.round(u * kneel.duration * fps);
      clips.set('Kneel_Hold', THREE.AnimationUtils.subclip(kneel, 'Kneel_Hold', f(0.15), f(0.3), fps));
      clips.set('Kneel_Stand', THREE.AnimationUtils.subclip(kneel, 'Kneel_Stand', f(0.82), f(1), fps));
    }
    return { character, clips };
  })();
  return assetsPromise;
}

export interface ArmPose {
  wrist: Vec3;
  /** Direction the elbow should bend toward (fighter frame). */
  pole: Vec3;
  /** Glove roll (radians) — palm down for hooks. */
  roll: number;
}

export interface BoxerPose {
  left: ArmPose;
  right: ArmPose;
  /** Head/torso lateral offset (m, +right) and duck (m, down). */
  lean: number;
  duck: number;
  /** Torso yaw (radians, + turns right shoulder forward). */
  twist: number;
  /** Forward lunge (m). */
  lunge: number;
}

export const GUARD_POSE = (stance: 'orthodox' | 'southpaw' = 'orthodox'): BoxerPose => {
  const leadRight = stance === 'southpaw';
  return {
    left: {
      wrist: { x: -0.11, y: 0.12, z: leadRight ? 0.24 : 0.32 },
      pole: { x: -0.6, y: -1, z: -0.1 },
      roll: 0,
    },
    right: {
      wrist: { x: 0.11, y: 0.11, z: leadRight ? 0.32 : 0.24 },
      pole: { x: 0.6, y: -1, z: -0.1 },
      roll: 0,
    },
    lean: 0,
    duck: 0,
    twist: 0,
    lunge: 0,
  };
};

/** A resolved punch landing on this boxer, as seen by the renderer. */
export interface HitSpec {
  type: PunchType;
  /** Attacker's punching hand. */
  hand: Hand;
  target: Target;
  /** 0..1 visual strength. */
  strength: number;
  blocked: boolean;
}

/**
 * Bruise sites in the character's bind pose (meters, model faces +z, +x = boxer's left):
 * eyes, cheekbones, mouth/chin, and ribs.
 */
const BRUISE_SITES = {
  eyeL: [0.036, 1.708, 0.078, 0.022],
  eyeR: [-0.036, 1.708, 0.078, 0.022],
  cheekL: [0.052, 1.668, 0.07, 0.028],
  cheekR: [-0.052, 1.668, 0.07, 0.028],
  mouth: [0, 1.622, 0.088, 0.026],
  ribsL: [0.13, 1.24, 0.08, 0.075],
  ribsR: [-0.13, 1.24, 0.08, 0.075],
} as const;
type BruiseSite = keyof typeof BRUISE_SITES;
const floatUniform = () => uniform(0);
type FloatUniform = ReturnType<typeof floatUniform>;

class Spring {
  x = 0;
  v = 0;
  constructor(
    private k = 120,
    private c = 14,
  ) {}
  kick(v: number): void {
    this.v += v;
  }
  update(dt: number, target = 0): number {
    // Semi-implicit Euler is only stable for small steps with stiff springs.
    const n = Math.ceil(dt / (1 / 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

/** Rotate `bone` (in world space) so that its child at `childWorld` points at `targetWorld`. */
function aimBone(
  bone: THREE.Object3D,
  childWorld: THREE.Vector3,
  targetWorld: THREE.Vector3,
  weight = 1,
): void {
  bone.getWorldPosition(tmpA);
  const cur = tmpB.copy(childWorld).sub(tmpA).normalize();
  const des = tmpC.copy(targetWorld).sub(tmpA).normalize();
  const delta = tmpQ.setFromUnitVectors(cur, des);
  if (weight < 1) delta.slerp(tmpQ2.identity(), 1 - weight);
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parentWorld = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  const next = delta.multiply(world);
  bone.quaternion.copy(parentWorld.invert().multiply(next));
  bone.updateMatrixWorld(true);
}

export class Boxer {
  root = new THREE.Group();
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  pose: BoxerPose;
  stance: 'orthodox' | 'southpaw' = 'orthodox';
  /** 0 = pure animation clip (KO), 1 = full procedural boxing layer. */
  proceduralWeight = 1;
  private procTarget = 1;
  /** Knockdown state: standing, on the canvas, or in the staged get-up. */
  private downState: 'up' | 'down' | 'rising' = 'up';
  private riseT = 0;
  private riseStage = 0;
  private bruise = {} as Record<BruiseSite, FloatUniform>;
  private sweat = floatUniform();
  private bones: Record<string, THREE.Bone> = {};
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private headSpringX = new Spring(160, 12);
  private headSpringY = new Spring(160, 12);
  private bodySpring = new Spring(90, 11);
  private shake = new Spring(200, 10);
  /** Head snap (yaw from hooks, pitch from straights/uppercuts, roll), torso twist/fold, arm drop. */
  private headYaw = new Spring(110, 9);
  private headPitch = new Spring(120, 10);
  private headRoll = new Spring(120, 10);
  private torsoTwist = new Spring(70, 9);
  private torsoFold = new Spring(55, 8);
  private armDrop = new Spring(40, 9);
  private shoulderLocal = new THREE.Vector3();
  private upperLen = 0.25;
  private foreLen = 0.245;
  private gloveL: THREE.Mesh;
  private gloveR: THREE.Mesh;
  private target = new THREE.Vector3(0, 1.6, 1);
  private breathe = Math.random() * 10;
  private fingerBones: THREE.Bone[] = [];
  /** Current arm-drop amount from body shots (0 = full guard). */
  private drop = 0;
  /** Visual state for hit flash. */
  hurtGlow = 0;
  private materials: Array<THREE.Material & { emissive?: THREE.Color }> = [];

  constructor(
    assets: Assets,
    opts: { gloveColor: number; trunkTint?: number; heightScale?: number } = { gloveColor: 0xb3122a },
  ) {
    this.model = cloneSkinned(assets.character.scene);
    this.model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        m.material = mats.map((mm) => {
          const src = mm as THREE.MeshStandardMaterial;
          const c = src.name === 'MI_Superhero_Male' ? this.skinMaterial(src, opts.trunkTint) : src.clone();
          c.envMapIntensity = 1.0;
          this.materials.push(c);
          return c;
        }) as unknown as THREE.Material;
        if (mats.length === 1) m.material = (m.material as unknown as THREE.Material[])[0]!;
      }
      const b = o as THREE.Bone;
      if (b.isBone) this.bones[b.name] = b;
    });
    for (const n of Object.keys(this.bones))
      if (/^(index|middle|ring|pinky|thumb)_0[123]_[lr]$/.test(n)) this.fingerBones.push(this.bones[n]!);
    this.root.add(this.model);
    this.model.scale.setScalar(opts.heightScale ?? 1);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const [name, clip] of assets.clips) this.actions.set(name, this.mixer.clipAction(clip));
    const idle = this.actions.get('Idle_Loop');
    idle?.play();
    this.current = idle ?? null;
    for (const n of ['Death01', 'Hit_Chest', 'Hit_Head', 'Punch_Jab', 'Punch_Cross', 'Kneel_Stand']) {
      const a = this.actions.get(n);
      if (a) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }
    this.pose = GUARD_POSE();
    this.gloveL = makeGlove(opts.gloveColor, true);
    this.gloveR = makeGlove(opts.gloveColor, false);
    this.gloveL.scale.multiplyScalar(1.4);
    this.gloveR.scale.multiplyScalar(1.4);
    this.root.add(this.gloveL, this.gloveR);
    this.measure();
  }

  /**
   * Skin: physical material with a subtle sheen and a sweat clearcoat that builds over the fight, plus
   * procedural bruising (reddening → purple swelling) painted in bind-pose space so it sticks to the rig.
   */
  private skinMaterial(src: THREE.MeshStandardMaterial, tint?: number): THREE.MeshPhysicalNodeMaterial {
    const m = new THREE.MeshPhysicalNodeMaterial();
    m.name = src.name;
    m.map = src.map;
    m.normalMap = src.normalMap;
    m.normalScale.copy(src.normalScale);
    m.roughnessMap = src.roughnessMap;
    m.metalnessMap = src.metalnessMap;
    m.roughness = src.roughness;
    m.metalness = src.metalness;
    m.color.set(tint ?? 0xffffff);
    m.sheen = 0.35;
    m.sheenRoughness = 0.55;
    m.sheenColor = new THREE.Color(0xd08a70);
    m.specularIntensity = 0.6;
    m.clearcoatNode = this.sweat.mul(0.5).add(0.05);
    m.clearcoatRoughnessNode = float(0.35);
    const p = positionGeometry;
    const grain = mx_noise_float(p.mul(70)).mul(0.35).add(0.75);
    let redness: THREE.Node<'float'> = float(0);
    let purple: THREE.Node<'float'> = float(0);
    for (const k of Object.keys(BRUISE_SITES) as BruiseSite[]) {
      const [x, y, z, r] = BRUISE_SITES[k];
      const u = floatUniform();
      this.bruise[k] = u;
      const d = p.sub(vec3(x, y, z));
      const mask = exp(d.dot(d).div(-r * r)).mul(grain);
      redness = redness.add(mask.mul(u.min(0.5).mul(2)));
      purple = purple.add(mask.mul(tslSmoothstep(0.35, 1, u)));
    }
    const base = materialColor.rgb;
    const red = mix(base, base.mul(vec3(1.05, 0.55, 0.5)), redness.clamp(0, 1).mul(0.75));
    m.colorNode = mix(red, base.mul(vec3(0.42, 0.26, 0.36)), purple.clamp(0, 1).mul(0.8));
    return m;
  }

  /** Where a punch lands: straights hit the eye opposite the punching hand, hooks the cheek. */
  private bruiseSite(h: HitSpec): BruiseSite {
    // The attacker's left hand lands on this boxer's right side.
    const side = h.hand === 'left' ? 'R' : 'L';
    if (h.target === 'body') return `ribs${side}`;
    if (h.type === 'uppercut') return 'mouth';
    if (h.type === 'hook') return `cheek${side}`;
    return `eye${side}`;
  }

  /** Clears bruises/sweat and stands the boxer up instantly (new match). */
  reset(): void {
    for (const u of Object.values(this.bruise)) u.value = 0;
    this.sweat.value = 0;
    this.downState = 'up';
    this.procTarget = this.proceduralWeight = 1;
    this.current?.fadeOut(0.3);
    this.current = null;
    this.play('Idle_Loop', 0.3);
  }

  /** Serializes the full visual state (bones + gloves) for KO replays. */
  snapshot(): Float32Array {
    const objs = this.replayObjects();
    const out = new Float32Array(objs.length * 7);
    objs.forEach((o, i) => {
      o.position.toArray(out, i * 7);
      o.quaternion.toArray(out, i * 7 + 3);
    });
    return out;
  }

  applySnapshot(a: Float32Array, b: Float32Array, t: number): void {
    const objs = this.replayObjects();
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    objs.forEach((o, i) => {
      o.position.fromArray(a, i * 7).lerp(tmpA.fromArray(b, i * 7), t);
      qa.fromArray(a, i * 7 + 3);
      qb.fromArray(b, i * 7 + 3);
      o.quaternion.copy(qa.slerp(qb, t));
    });
    this.root.updateMatrixWorld(true);
  }

  private replayList: THREE.Object3D[] | null = null;
  private replayObjects(): THREE.Object3D[] {
    this.replayList ??= [this.root, this.model, this.gloveL, this.gloveR, ...Object.values(this.bones)];
    return this.replayList;
  }

  private bone(n: string): THREE.Bone {
    const b = this.bones[n];
    if (!b) throw new Error(`missing bone ${n}`);
    return b;
  }

  private measure(): void {
    this.root.updateMatrixWorld(true);
    const p = (n: string) => this.bone(n).getWorldPosition(new THREE.Vector3());
    const ul = p('upperarm_l');
    const ur = p('upperarm_r');
    this.upperLen = ul.distanceTo(p('lowerarm_l'));
    this.foreLen = p('lowerarm_l').distanceTo(p('hand_l'));
    this.shoulderLocal.copy(ul).add(ur).multiplyScalar(0.5);
    this.root.worldToLocal(this.shoulderLocal);
    this.shoulderLocal.y -= 0.03;
  }

  get armLength(): number {
    return this.upperLen + this.foreLen;
  }

  /** World-space point the boxer faces (the opponent's head). */
  lookAt(world: THREE.Vector3): void {
    this.target.copy(world);
  }

  /** Fighter frame → world. */
  toWorld(p: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
    out.set(-p.x, p.y, p.z).add(this.shoulderLocal);
    return this.root.localToWorld(out);
  }

  /** World head position (for aiming punches at this boxer). */
  headWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.bone('Head')
      .getWorldPosition(out)
      .add(tmpA.set(0, 0.08, 0));
  }

  gloveWorld(hand: Hand, out = new THREE.Vector3()): THREE.Vector3 {
    return (hand === 'left' ? this.gloveL : this.gloveR).getWorldPosition(out);
  }

  play(name: string, fade = 0.25): void {
    const a = this.actions.get(name);
    if (!a || a === this.current) return;
    a.reset().play();
    if (this.current) a.crossFadeFrom(this.current, fade, true);
    this.current = a;
  }

  /** Drop to the canvas. The procedural boxing layer fades out so the fall clip plays untouched. */
  knockDown(): void {
    this.downState = 'down';
    this.procTarget = 0;
    this.play('Death01', 0.18);
  }

  get isDown(): boolean {
    return this.downState !== 'up';
  }

  /**
   * Staged, boxer-like recovery (~1.8 s): roll onto a knee with a glove on the canvas, pause, push up to
   * standing, then settle back into the guard. No-op if already standing or rising.
   */
  getUp(): void {
    if (this.downState !== 'down') {
      if (this.downState === 'up') {
        this.procTarget = 1;
        this.play('Idle_Loop', 0.4);
      }
      return;
    }
    this.downState = 'rising';
    this.riseT = 0;
    this.riseStage = 0;
    const hold = this.actions.get('Kneel_Hold');
    if (hold) {
      hold.setLoop(THREE.LoopPingPong, Infinity);
      hold.timeScale = 0.6;
    }
    this.play(hold ? 'Kneel_Hold' : 'Idle_Loop', 0.8);
  }

  private updateRise(dt: number): void {
    if (this.downState !== 'rising') return;
    this.riseT += dt;
    if (this.riseStage === 0 && this.riseT > 0.95) {
      this.riseStage = 1;
      const stand = this.actions.get('Kneel_Stand');
      if (stand) stand.timeScale = 1.15;
      this.play(stand ? 'Kneel_Stand' : 'Idle_Loop', 0.3);
    } else if (this.riseStage === 1 && this.riseT > 1.65) {
      this.riseStage = 2;
      this.play('Idle_Loop', 0.4);
      this.procTarget = 1;
      this.downState = 'up';
    }
  }

  celebrate(): void {
    this.procTarget = 0.35;
    this.play('Dance_Loop', 0.5);
  }

  /** Physical hit reaction + bruising, shaped by punch type, side and target. */
  hit(h: HitSpec): void {
    const k = h.strength * (h.blocked ? 0.3 : 1);
    // +1 = the head/torso turns toward this boxer's left (away from the attacker's right hand).
    const side = h.hand === 'left' ? -1 : 1;
    if (h.target === 'head' && !h.blocked) {
      if (h.type === 'hook') {
        this.headYaw.kick(side * 14 * k);
        this.headRoll.kick(side * 7 * k);
        this.torsoTwist.kick(side * 3.5 * k);
      } else if (h.type === 'uppercut') {
        this.headPitch.kick(-16 * k);
        this.torsoFold.kick(-2.5 * k);
      } else {
        this.headPitch.kick(-(h.type === 'jab' ? 7 : 11) * k);
        this.headYaw.kick(side * 3 * k);
      }
      this.headSpringX.kick(side * 4 * k);
    } else if (h.target === 'body' && !h.blocked) {
      this.torsoFold.kick(6 * k);
      this.armDrop.kick(6 * k);
      this.torsoTwist.kick(side * 2 * k);
    }
    this.bodySpring.kick(-(h.target === 'body' ? 4.5 : 3.2) * k);
    this.shake.kick(k * 4);
    this.hurtGlow = Math.min(1, this.hurtGlow + k * 0.6);
    if (!h.blocked) {
      const u = this.bruise[this.bruiseSite(h)];
      if (u) u.value = Math.min(1, u.value + h.strength * (h.type === 'jab' ? 0.07 : 0.16));
      this.sweat.value = Math.min(1, this.sweat.value + 0.015);
    }
  }

  update(dt: number): void {
    this.breathe += dt;
    this.updateRise(dt);
    this.proceduralWeight += (this.procTarget - this.proceduralWeight) * Math.min(1, dt * 6);
    this.mixer.update(dt);
    // Face the opponent (yaw only); a fighter on the canvas stays where he fell.
    if (this.downState !== 'down') {
      const rp = this.root.position;
      const yaw = Math.atan2(this.target.x - rp.x, this.target.z - rp.z);
      const d = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
      this.root.rotation.y += this.downState === 'up' ? d : d * Math.min(1, dt * 3);
    }
    for (const b of this.fingerBones) b.scale.setScalar(0.35);
    const hx = this.headSpringX.update(dt);
    const hy = this.headSpringY.update(dt);
    const body = this.bodySpring.update(dt);
    const shake = this.shake.update(dt);
    const yawH = this.headYaw.update(dt);
    const pitchH = this.headPitch.update(dt);
    const rollH = this.headRoll.update(dt);
    const twistT = this.torsoTwist.update(dt);
    const fold = this.torsoFold.update(dt);
    this.drop = this.armDrop.update(dt);
    this.hurtGlow = Math.max(0, this.hurtGlow - dt * 3);
    for (const m of this.materials) m.emissive?.setRGB(this.hurtGlow * 0.12, 0, 0);

    const w = this.proceduralWeight;
    const P = this.pose;
    this.model.position.set(0, 0, 0);
    if (w > 0.001) {
      // Stance: slight crouch/bounce, lean, duck, lunge, knockback.
      const bounce = Math.sin(this.breathe * 5.2) * 0.012;
      this.model.position.set(-P.lean * 0.55 * w, (bounce - P.duck * 0.55) * w, (P.lunge + body * 0.12) * w);
      const spine2 = this.bone('spine_02');
      const spine3 = this.bone('spine_03');
      const pelvis = this.bone('pelvis');
      spine2.rotateX((0.12 + P.duck * 1.3 - body * 0.4 + fold * 0.5) * w);
      spine2.rotateZ((P.lean * 0.9 + shake * 0.03) * w);
      spine3.rotateY((P.twist + twistT * 0.35) * w);
      spine3.rotateX(fold * 0.25 * w);
      pelvis.rotateY(P.twist * 0.4 * w);
      const neck = this.bones['neck_01'];
      neck?.rotateY(yawH * 0.25 * w);
      neck?.rotateX(pitchH * 0.2 * w);
      const head = this.bone('Head');
      head.rotateY(yawH * 0.45 * w);
      head.rotateZ((hx * 0.5 + rollH * 0.4) * w);
      head.rotateX((hy * 0.6 + pitchH * 0.45 - 0.08) * w);
      this.model.updateMatrixWorld(true);
      this.solveArm('left', P.left, w);
      this.solveArm('right', P.right, w);
    } else this.model.updateMatrixWorld(true);
    this.placeGlove('left');
    this.placeGlove('right');
  }

  private solveArm(hand: Hand, arm: ArmPose, w: number): void {
    const s = hand === 'left' ? 'l' : 'r';
    const upper = this.bone(`upperarm_${s}`);
    const lower = this.bone(`lowerarm_${s}`);
    const handB = this.bone(`hand_${s}`);
    const S = upper.getWorldPosition(new THREE.Vector3());
    // Targets are relative to the shoulder midpoint in the fighter frame, but IK runs from the actual
    // shoulder joint; convert the target and pole into world space.
    const d = Math.max(0, Math.min(1, this.drop));
    const wr = { x: arm.wrist.x * (1 + d * 0.4), y: arm.wrist.y - d * 0.3, z: arm.wrist.z * (1 - d * 0.4) };
    const Wt = this.toWorld(wr);
    const poleEnd = this.toWorld({
      x: wr.x + arm.pole.x,
      y: wr.y + arm.pole.y,
      z: wr.z + arm.pole.z,
    });
    const poleDir = poleEnd.sub(Wt);
    const { elbow, wrist } = solveElbow(
      { x: S.x, y: S.y, z: S.z },
      { x: Wt.x, y: Wt.y, z: Wt.z },
      this.upperLen,
      this.foreLen,
      { x: poleDir.x, y: poleDir.y, z: poleDir.z },
    );
    const E = new THREE.Vector3(elbow.x, elbow.y, elbow.z);
    const W = new THREE.Vector3(wrist.x, wrist.y, wrist.z);
    aimBone(upper, lower.getWorldPosition(new THREE.Vector3()), E, w);
    aimBone(lower, handB.getWorldPosition(new THREE.Vector3()), W, w);
  }

  private placeGlove(hand: Hand): void {
    const s = hand === 'left' ? 'l' : 'r';
    const handB = this.bone(`hand_${s}`);
    const lower = this.bone(`lowerarm_${s}`);
    const g = hand === 'left' ? this.gloveL : this.gloveR;
    const hp = handB.getWorldPosition(new THREE.Vector3());
    const ep = lower.getWorldPosition(new THREE.Vector3());
    const fwd = hp.clone().sub(ep).normalize();
    const pos = hp.clone().addScaledVector(fwd, 0.08);
    this.root.worldToLocal(pos);
    g.position.copy(pos);
    // Orient glove +z along the forearm; back of the hand roughly "up" in the fighter frame with roll.
    const roll = (hand === 'left' ? this.pose.left.roll : this.pose.right.roll) * this.proceduralWeight;
    const fl = fwd.clone().transformDirection(new THREE.Matrix4().copy(this.root.matrixWorld).invert());
    const up = new THREE.Vector3(Math.sin(roll) * (hand === 'left' ? 1 : -1), Math.cos(roll), 0);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fl, up);
    g.quaternion.setFromRotationMatrix(m);
    // lookAt aims −z; flip to +z.
    g.quaternion.multiply(tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  }
}
