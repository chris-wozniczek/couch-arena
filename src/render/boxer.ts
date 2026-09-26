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
import { solveElbow } from '../core/synthetic';
import type { Hand, Vec3 } from '../core/types';
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
    const a = -this.k * (this.x - target) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
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
  private bones: Record<string, THREE.Bone> = {};
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private headSpringX = new Spring(160, 12);
  private headSpringY = new Spring(160, 12);
  private bodySpring = new Spring(90, 11);
  private shake = new Spring(200, 10);
  private shoulderLocal = new THREE.Vector3();
  private upperLen = 0.25;
  private foreLen = 0.245;
  private gloveL: THREE.Mesh;
  private gloveR: THREE.Mesh;
  private target = new THREE.Vector3(0, 1.6, 1);
  private breathe = Math.random() * 10;
  private fingerBones: THREE.Bone[] = [];
  /** Visual state for hit flash. */
  hurtGlow = 0;
  private materials: THREE.MeshStandardMaterial[] = [];

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
          const c = (mm as THREE.MeshStandardMaterial).clone();
          if (c.name === 'MI_Superhero_Male' && opts.trunkTint !== undefined)
            c.color = new THREE.Color(opts.trunkTint);
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
    for (const n of ['Death01', 'Hit_Chest', 'Hit_Head', 'Punch_Jab', 'Punch_Cross']) {
      const a = this.actions.get(n);
      if (a) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }
    this.pose = GUARD_POSE();
    this.gloveL = makeGlove(opts.gloveColor, true);
    this.gloveR = makeGlove(opts.gloveColor, false);
    this.gloveL.scale.multiplyScalar(1.1);
    this.gloveR.scale.multiplyScalar(1.1);
    this.root.add(this.gloveL, this.gloveR);
    this.measure();
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

  play(name: 'Death01' | 'Idle_Loop' | 'Dance_Loop' | 'Hit_Head' | 'Hit_Chest', fade = 0.25): void {
    const a = this.actions.get(name);
    if (!a || a === this.current) return;
    a.reset().play();
    if (this.current) a.crossFadeFrom(this.current, fade, true);
    this.current = a;
  }

  knockDown(): void {
    this.play('Death01', 0.18);
  }

  getUp(): void {
    this.play('Idle_Loop', 0.6);
  }

  celebrate(): void {
    this.play('Dance_Loop', 0.5);
  }

  /** Hit reaction impulse. dir: -1..1 lateral (from attacker's view), strength 0..1. */
  hit(lateral: number, up: number, strength: number, head: boolean): void {
    if (head) {
      this.headSpringX.kick(lateral * 9 * strength);
      this.headSpringY.kick(-(1 + up) * 7 * strength);
    }
    this.bodySpring.kick(-3.2 * strength);
    this.hurtGlow = Math.min(1, this.hurtGlow + strength);
  }

  update(dt: number): void {
    this.breathe += dt;
    this.mixer.update(dt);
    // Face the opponent (yaw only).
    const rp = this.root.position;
    const yaw = Math.atan2(this.target.x - rp.x, this.target.z - rp.z);
    this.root.rotation.y = yaw;
    for (const b of this.fingerBones) b.scale.setScalar(0.35);
    const hx = this.headSpringX.update(dt);
    const hy = this.headSpringY.update(dt);
    const body = this.bodySpring.update(dt);
    this.shake.update(dt);
    this.hurtGlow = Math.max(0, this.hurtGlow - dt * 3);
    for (const m of this.materials) m.emissive?.setRGB(this.hurtGlow * 0.25, 0, 0);

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
      spine2.rotateX((0.12 + P.duck * 1.3 - body * 0.4) * w);
      spine2.rotateZ(P.lean * 0.9 * w);
      spine3.rotateY(P.twist * w);
      pelvis.rotateY(P.twist * 0.4 * w);
      const head = this.bone('Head');
      head.rotateZ(hx * 0.5 * w);
      head.rotateX((hy * 0.6 - 0.08) * w);
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
    const Wt = this.toWorld(arm.wrist);
    const poleEnd = this.toWorld({
      x: arm.wrist.x + arm.pole.x,
      y: arm.wrist.y + arm.pole.y,
      z: arm.wrist.z + arm.pole.z,
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
    const pos = hp.clone().addScaledVector(fwd, 0.06);
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
