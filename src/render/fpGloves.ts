/**
 * First-person gloves driven by the tracked (and latency-predicted) arm positions. Forearms are wrapped
 * capsules from elbow to wrist; gloves orient along the forearm and roll for hooks.
 */
import * as THREE from 'three/webgpu';
import type { BodyFeatures } from '../core/body';
import type { Hand } from '../core/types';
import { makeGlove } from './gloves';

const SHOULDER_OFFSET = new THREE.Vector3(0, -0.3, -0.12);

export class FirstPersonGloves {
  group = new THREE.Group();
  private gloves: Record<Hand, THREE.Mesh>;
  private arms: Record<Hand, THREE.Mesh>;
  private reach = 0.66;
  visible = true;
  /** Last glove world positions (for impact FX). */
  world: Record<Hand, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() };

  constructor(camera: THREE.Camera, color = 0x1b3fa6) {
    this.gloves = { left: makeGlove(color, true), right: makeGlove(color, false) };
    const armMat = new THREE.MeshPhysicalMaterial({
      color: 0x7a5540,
      roughness: 0.7,
      sheen: 0.25,
      sheenColor: new THREE.Color(0xc89878),
    });
    const armGeo = new THREE.CapsuleGeometry(0.038, 1, 6, 20);
    this.arms = { left: new THREE.Mesh(armGeo, armMat), right: new THREE.Mesh(armGeo, armMat) };
    for (const h of ['left', 'right'] as const) {
      this.gloves[h].castShadow = false;
      this.gloves[h].scale.multiplyScalar(0.78);
      this.group.add(this.gloves[h], this.arms[h]);
    }
    camera.add(this.group);
  }

  /** Body frame (x right, y up, z toward camera=forward for the player) → camera local (−z forward). */
  private toCam(p: { x: number; y: number; z: number }, k: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(p.x * k, p.y * k, -p.z * k).add(SHOULDER_OFFSET);
  }

  update(f: BodyFeatures | null): void {
    this.group.visible = this.visible && !!f;
    if (!f) return;
    const k = this.reach / Math.max(0.35, f.armLength);
    const w = new THREE.Vector3();
    const e = new THREE.Vector3();
    for (const h of ['left', 'right'] as const) {
      const a = f.arms[h];
      this.toCam(a.wrist, k, w);
      this.toCam(a.elbow, k, e);
      // Keep gloves in front of the near plane and slightly below eye line at guard.
      w.z = Math.min(w.z, -0.3);
      const dir = w.clone().sub(e);
      const len = Math.max(0.05, dir.length());
      dir.normalize();
      const g = this.gloves[h];
      g.position.copy(w).addScaledVector(dir, 0.07);
      const lateral = Math.abs(a.wrist.x - a.shoulder.x);
      const roll = lateral > 0.28 && a.extension > 0.4 ? 1.3 : 0.15;
      const up = new THREE.Vector3(Math.sin(roll) * (h === 'left' ? 1 : -1), Math.cos(roll), 0);
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().negate(), up);
      g.quaternion.setFromRotationMatrix(m);
      const arm = this.arms[h];
      arm.position.copy(e).addScaledVector(dir, len / 2);
      arm.scale.set(1, len * 0.9, 1);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.getWorldPosition(this.world[h]);
    }
  }
}
