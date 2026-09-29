/** Boxing glove geometry + leather materials, shared by the first-person gloves and the 3D boxers. */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { photoTexture } from './textures';

/**
 * A sculpted glove with its knuckles pointing along +z, back of the hand toward +y, thumb on −x. In a
 * right-handed frame with +x = y × z that is the wearer's right side, i.e. a left glove; mirror x for the right. Sized in meters (~0.3 m long like a 14 oz glove).
 */
export function gloveGeometry(): THREE.BufferGeometry {
  // Main fist: a sphere deformed into a rounded mitt, fuller at the knuckles.
  const fist = new THREE.SphereGeometry(0.075, 64, 48);
  const p = fist.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const front = Math.max(0, v.z / 0.075);
    v.x *= 1.0 + 0.1 * front;
    v.y *= 0.92 + 0.12 * front - (v.y < 0 ? 0.12 : 0);
    v.z *= 1.28;
    // Knuckle ridge.
    if (v.y > 0 && v.z > 0.04) v.y += 0.008 * Math.sin(((v.x + 0.08) / 0.16) * Math.PI * 4) * front;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  fist.computeVertexNormals();
  fist.translate(0, 0, 0.03);

  // Thumb: a capsule tucked along the side.
  const thumb = new THREE.CapsuleGeometry(0.026, 0.07, 8, 24);
  thumb.rotateX(Math.PI / 2);
  thumb.rotateY(-0.35);
  thumb.translate(-0.066, -0.02, 0.04);

  // Cuff: tapered cylinder toward the wrist.
  const cuff = new THREE.CylinderGeometry(0.055, 0.06, 0.12, 48, 4, true);
  cuff.rotateX(Math.PI / 2);
  cuff.translate(0, -0.005, -0.1);
  const cuffCap = new THREE.CircleGeometry(0.055, 48);
  cuffCap.rotateY(Math.PI);
  cuffCap.translate(0, -0.005, -0.16);

  const g = mergeGeometries(
    [fist, thumb, cuff, cuffCap].map((x) => x.toNonIndexed()),
    true,
  )!;
  // Keep each part's smooth normals; recomputing on the non-indexed merge would facet the leather.
  return g;
}

/** Grained, lightly waxed leather (photo-scanned grain normal/roughness) with a glossy top coat. */
export function leatherMaterial(color: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.6,
    roughnessMap: photoTexture('leather_red_02_rough', false, 2),
    normalMap: photoTexture('leather_red_02_nor_gl', false, 2),
    normalScale: new THREE.Vector2(0.7, 0.7),
    clearcoat: 0.6,
    clearcoatRoughness: 0.22,
    sheen: 0.25,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35),
  });
}

export function cuffMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xeeeae2,
    roughness: 0.55,
    normalMap: photoTexture('leather_red_02_nor_gl', false, 3),
    normalScale: new THREE.Vector2(0.4, 0.4),
    clearcoat: 0.35,
    clearcoatRoughness: 0.3,
  });
}

/** Glove mesh (groups: fist, thumb → leather; cuff → trim). */
export function makeGlove(color: number, left: boolean): THREE.Mesh {
  const geo = gloveGeometry();
  const leather = leatherMaterial(color);
  const trim = cuffMaterial();
  const mesh = new THREE.Mesh(geo, [leather, leather, trim, trim]);
  if (!left) mesh.scale.x = -1;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const gx = new THREE.Vector3();
const gy = new THREE.Vector3();
const gz = new THREE.Vector3();
const gm = new THREE.Matrix4();

/**
 * Orients a glove with its knuckles along `fwd` (forearm direction). The back of the hand starts facing
 * `up` for a level forearm and `forward` (toward the opponent) as the forearm turns vertical (guard,
 * uppercut), then rolls about the forearm: roll 0 = palm down / knuckles to the opponent, positive turns
 * the back of the hand outward (π/2 = vertical thumb-up fist). `up`, `forward` and `fwd` share one
 * right-handed frame.
 */
export function orientGlove(
  out: THREE.Quaternion,
  fwd: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3,
  roll: number,
  hand: 'left' | 'right',
): THREE.Quaternion {
  gz.copy(fwd).normalize();
  const vert = Math.abs(gz.dot(up));
  const a = Math.min(1, Math.max(0, (vert - 0.5) / 0.4));
  const k = a * a * (3 - 2 * a);
  gy.copy(up)
    .multiplyScalar(1 - k)
    .addScaledVector(forward, k);
  gy.addScaledVector(gz, -gy.dot(gz));
  if (gy.lengthSq() < 1e-6) gy.copy(forward).addScaledVector(gz, -forward.dot(gz));
  gy.normalize().applyAxisAngle(gz, hand === 'right' ? roll : -roll);
  gx.crossVectors(gy, gz);
  return out.setFromRotationMatrix(gm.makeBasis(gx, gy, gz));
}
