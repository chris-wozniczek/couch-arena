/** Boxing glove geometry + leather materials, shared by the first-person gloves and the 3D boxers. */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { noiseNormalMap, noiseRoughness } from './textures';

/**
 * A sculpted glove with its knuckles pointing along +z, back of the hand toward +y, thumb on −x (right
 * glove; mirror x for the left). Sized in meters (~0.3 m long like a 14 oz glove).
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
  g.computeVertexNormals();
  return g;
}

let leatherNormal: THREE.Texture | null = null;
let leatherRough: THREE.Texture | null = null;

export function leatherMaterial(color: number): THREE.MeshPhysicalMaterial {
  leatherNormal ??= noiseNormalMap(512, 48, 2.2, 9);
  leatherRough ??= noiseRoughness(512, 24, 0.4, 0.25, 4);
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.42,
    roughnessMap: leatherRough,
    normalMap: leatherNormal,
    normalScale: new THREE.Vector2(0.25, 0.25),
    clearcoat: 0.55,
    clearcoatRoughness: 0.3,
    sheen: 0.3,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.4),
  });
  return m;
}

export function cuffMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color: 0xf2efe8, roughness: 0.5, clearcoat: 0.3 });
}

/** Glove mesh (groups: fist, thumb → leather; cuff → trim). */
export function makeGlove(color: number, left: boolean): THREE.Mesh {
  const geo = gloveGeometry();
  const leather = leatherMaterial(color);
  const trim = cuffMaterial();
  const mesh = new THREE.Mesh(geo, [leather, leather, trim, trim]);
  if (left) mesh.scale.x = -1;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
