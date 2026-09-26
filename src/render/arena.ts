/**
 * The boxing arena: ring (mat, apron, posts, turnbuckles, sagging ropes), hanging light rig with shadowed
 * spotlights and volumetric light cones, stepped seating with an animated instanced crowd and camera
 * flashes, fog haze and HDRI image-based lighting.
 */
import * as THREE from 'three/webgpu';
import {
  positionLocal,
  positionWorld,
  cameraPosition,
  instanceIndex,
  time,
  uniform,
  vec3,
  float,
  sin,
  hash,
  normalWorld,
  uv,
  step,
  floor,
  mix,
  color,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { bannerTexture, floorTexture, matTexture, noiseNormalMap, noiseRoughness } from './textures';

export const RING_HALF = 3.05;
export const RING_FLOOR = 0;
const PLATFORM_H = 1.1;
const ROPE_HEIGHTS = [0.46, 0.77, 1.08, 1.39];

export class Arena {
  group = new THREE.Group();
  /** Crowd excitement 0..1 (animates bounce + flash rate). */
  excitement = uniform(0.3);
  private keyLights: THREE.SpotLight[] = [];

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    scene.background = new THREE.Color(0x020306);
    scene.fog = new THREE.FogExp2(0x05070c, 0.009);
    this.buildRing();
    this.buildLights();
    this.buildSeatingAndCrowd();
    this.buildFloorAndScreens();
  }

  async loadEnvironment(renderer: THREE.WebGPURenderer, url: string): Promise<void> {
    const hdr = await new HDRLoader().loadAsync(url);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(hdr).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.12;
    this.scene.environmentRotation.set(0, 1.2, 0);
    hdr.dispose();
    pmrem.dispose();
  }

  private buildRing(): void {
    const g = this.group;
    const S = RING_HALF;
    // Mat with slight padding lift.
    const matTex = matTexture();
    const matNormal = noiseNormalMap(512, 32, 1.6, 3);
    matNormal.repeat.set(6, 6);
    const mat = new THREE.MeshPhysicalMaterial({
      map: matTex,
      color: 0xc9c4bc,
      roughness: 0.82,
      roughnessMap: noiseRoughness(512, 16, 0.85, 0.3),
      normalMap: matNormal,
      normalScale: new THREE.Vector2(0.35, 0.35),
      sheen: 0.4,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(0x8a8680),
    });
    const top = new THREE.Mesh(new RoundedBoxGeometry(S * 2 + 0.7, 0.12, S * 2 + 0.7, 4, 0.05), mat);
    top.position.y = RING_FLOOR - 0.06;
    top.receiveShadow = true;
    g.add(top);

    // Apron skirt with banners.
    const apronMat = (text: string) =>
      new THREE.MeshStandardMaterial({
        map: bannerTexture(text, '#131a33', '#e8e2d0'),
        roughness: 0.6,
        metalness: 0.05,
      });
    const sides = [
      'COUCH ARENA|WEBCAM BOXING',
      'ROUND ONE|FIGHT NIGHT',
      'COUCH ARENA|NO CONTROLLER',
      'JAB|CROSS|HOOK|UPPERCUT',
    ];
    for (let i = 0; i < 4; i++) {
      const skirt = new THREE.Mesh(new THREE.PlaneGeometry(S * 2 + 0.7, PLATFORM_H), apronMat(sides[i]!));
      const a = (i * Math.PI) / 2;
      skirt.position.set(Math.sin(a) * (S + 0.351), -PLATFORM_H / 2 - 0.1, Math.cos(a) * (S + 0.351));
      skirt.rotation.y = a;
      skirt.receiveShadow = true;
      g.add(skirt);
    }

    // Corner posts + turnbuckle pads.
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dce4, metalness: 1, roughness: 0.18 });
    const padColors = [0xb3122a, 0xf2f2f2, 0x1b3fa6, 0xf2f2f2];
    const corners: THREE.Vector3[] = [
      new THREE.Vector3(S, 0, S),
      new THREE.Vector3(-S, 0, S),
      new THREE.Vector3(-S, 0, -S),
      new THREE.Vector3(S, 0, -S),
    ];
    const post = new THREE.CylinderGeometry(0.055, 0.065, 1.65, 32);
    corners.forEach((c, i) => {
      const p = new THREE.Mesh(post, chrome);
      p.position.set(c.x * 1.03, 0.82, c.z * 1.03);
      p.castShadow = true;
      g.add(p);
      const padMat = new THREE.MeshPhysicalMaterial({
        color: padColors[(i + 2) % 4],
        roughness: 0.32,
        clearcoat: 0.8,
        clearcoatRoughness: 0.25,
      });
      const pad = new THREE.Mesh(new RoundedBoxGeometry(0.2, 1.1, 0.2, 5, 0.07), padMat);
      pad.position.set(c.x * 0.995, 0.93, c.z * 0.995);
      pad.rotation.y = Math.atan2(c.x, c.z);
      pad.castShadow = true;
      g.add(pad);
    });

    // Ropes: slightly sagging tubes, alternating colors, glossy vinyl.
    const ropeMats = [0xb3122a, 0xf0f0f0, 0x1b3fa6, 0xf0f0f0].map(
      (c) =>
        new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.2 }),
    );
    for (let side = 0; side < 4; side++) {
      const a = corners[side]!;
      const b = corners[(side + 1) % 4]!;
      ROPE_HEIGHTS.forEach((h, k) => {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          const p = a.clone().lerp(b, t).multiplyScalar(0.985);
          p.y = h - Math.sin(t * Math.PI) * 0.035;
          pts.push(p);
        }
        const rope = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.021, 12),
          ropeMats[k]!,
        );
        rope.castShadow = true;
        g.add(rope);
      });
    }

    // Steps, stools and a timekeeper table silhouette.
    const wood = new THREE.MeshStandardMaterial({ color: 0x3a2518, roughness: 0.55 });
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.5, 24), wood);
    stool.position.set(S - 0.35, 0.25, S - 0.35);
    stool.castShadow = true;
    g.add(stool);
    const stool2 = stool.clone();
    stool2.position.set(-S + 0.35, 0.25, -S + 0.35);
    g.add(stool2);
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.8), wood);
    table.position.set(0, -0.35, S + 1.6);
    g.add(table);
  }

  private buildLights(): void {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x7080a0, 0x100808, 0.18));

    // Light rig: truss square over the ring.
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x1a1c22, metalness: 0.9, roughness: 0.45 });
    const beam = new THREE.BoxGeometry(7.4, 0.18, 0.18);
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(beam, trussMat);
      const a = (i * Math.PI) / 2;
      b.position.set(Math.sin(a) * 3.6, 6.2, Math.cos(a) * 3.6);
      b.rotation.y = a;
      s.add(b);
    }

    const coneMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    coneMat.blending = THREE.AdditiveBlending;
    // Fade toward cone edges (fresnel on view angle) and toward the floor.
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const edge = normalWorld.dot(viewDir).abs().pow(2.2);
    const along = uv().y;
    coneMat.colorNode = color(0xfff1d8);
    coneMat.opacityNode = edge.mul(along.pow(1.4)).mul(0.022);

    const fixtureGeo = new THREE.CylinderGeometry(0.16, 0.22, 0.34, 24);
    const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x0c0c10, metalness: 0.8, roughness: 0.4 });
    const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0d0).multiplyScalar(3.5) });

    const spots: Array<[number, number, number, boolean]> = [
      [0, 6.0, 0.6, true],
      [2.2, 6.0, 2.2, false],
      [-2.2, 6.0, 2.2, false],
      [2.2, 6.0, -2.2, false],
      [-2.2, 6.0, -2.2, true],
    ];
    for (const [x, y, z, shadow] of spots) {
      const L = new THREE.SpotLight(0xffe9cc, shadow ? 150 : 70, 16, 0.5, 0.65, 1.6);
      L.position.set(x, y, z);
      L.target.position.set(x * 0.25, 0, z * 0.25);
      if (shadow) {
        L.castShadow = true;
        L.shadow.mapSize.set(2048, 2048);
        L.shadow.bias = -0.0002;
        L.shadow.normalBias = 0.02;
        L.shadow.radius = 5;
        L.shadow.camera.near = 2;
        L.shadow.camera.far = 12;
        this.keyLights.push(L);
      }
      s.add(L, L.target);
      const f = new THREE.Mesh(fixtureGeo, fixtureMat);
      f.position.set(x, y + 0.05, z);
      s.add(f);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.15, 24), lensMat);
      lens.position.set(x, y - 0.121, z);
      lens.rotation.x = Math.PI / 2;
      s.add(lens);
      // Volumetric cone.
      const dir = L.target.position.clone().sub(L.position);
      const len = dir.length();
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, Math.tan(0.5) * len * 0.9, len, 48, 1, true),
        coneMat,
      );
      cone.position.copy(L.position).addScaledVector(dir, 0.5);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
      cone.renderOrder = 10;
      s.add(cone);
    }

    // Cool rim lights from the stands to separate fighters from the background.
    const rimA = new THREE.SpotLight(0x5f7dff, 60, 20, 0.6, 0.9, 1.5);
    rimA.position.set(-7, 4, -6);
    rimA.target.position.set(0, 1.4, 0);
    const rimB = new THREE.SpotLight(0xff5f7a, 45, 20, 0.6, 0.9, 1.5);
    rimB.position.set(7, 4, -6);
    rimB.target.position.set(0, 1.4, 0);
    s.add(rimA, rimA.target, rimB, rimB.target);
  }

  private buildSeatingAndCrowd(): void {
    // Stepped seating banks on all four sides.
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.8 });
    const rows = 14;
    for (let side = 0; side < 4; side++) {
      const a = (side * Math.PI) / 2;
      for (let r = 0; r < rows; r++) {
        const d = 6.2 + r * 0.9;
        const step = new THREE.Mesh(new THREE.BoxGeometry(2 * d + 2, 0.45 + r * 0.42, 0.9), seatMat);
        step.position.set(Math.sin(a) * d, -PLATFORM_H + (0.45 + r * 0.42) / 2, Math.cos(a) * d);
        step.rotation.y = a;
        this.group.add(step);
      }
    }

    // Crowd: instanced people (torso + head), bouncing and hue-varied in TSL.
    const torso = new THREE.CapsuleGeometry(0.19, 0.42, 4, 10);
    torso.translate(0, 0.4, 0);
    const head = new THREE.SphereGeometry(0.11, 12, 10);
    head.translate(0, 0.86, 0);
    const person = mergeGeometries([torso, head])!;
    const count = 2600;
    const crowdMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    const h = hash(instanceIndex);
    const h2 = hash(instanceIndex.add(911));
    const bounce = sin(time.mul(float(6).add(h.mul(5))).add(h2.mul(40)))
      .max(0)
      .mul(this.excitement.mul(0.16).add(0.015));
    crowdMat.positionNode = positionLocal.add(vec3(0, bounce, 0));
    const shirt = mix(
      vec3(0.05, 0.06, 0.09),
      vec3(h.mul(0.5), h2.mul(0.3), h.mul(h2).mul(0.6)).add(0.05),
      step(0.35, h2),
    );
    crowdMat.colorNode = shirt;
    const crowd = new THREE.InstancedMesh(person, crowdMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const rng = (() => {
      let s = 7;
      return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    })();
    let n = 0;
    while (n < count) {
      const side = Math.floor(rng() * 4);
      const r = Math.floor(rng() * rows);
      const d = 6.2 + r * 0.9;
      const along = (rng() * 2 - 1) * (d + 0.8);
      const a = (side * Math.PI) / 2;
      const y = -PLATFORM_H + 0.45 + r * 0.42;
      const x = Math.sin(a) * d + Math.cos(a) * along;
      const z = Math.cos(a) * d - Math.sin(a) * along;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + Math.PI + (rng() - 0.5) * 0.6);
      const sc = 0.9 + rng() * 0.25;
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sc, sc, sc));
      crowd.setMatrixAt(n++, m);
    }
    crowd.frustumCulled = false;
    this.group.add(crowd);

    // Camera flashes: tiny emissive quads that pop randomly; bloom turns them into sparkles.
    const flashGeo = new THREE.SphereGeometry(0.03, 6, 4);
    const flashMat = new THREE.MeshBasicNodeMaterial();
    const slot = floor(time.mul(float(7)).add(hash(instanceIndex).mul(100)));
    const pop = step(float(0.985).sub(this.excitement.mul(0.03)), hash(slot.add(instanceIndex.mul(13))));
    flashMat.colorNode = vec3(pop.mul(40));
    const flashes = new THREE.InstancedMesh(flashGeo, flashMat, 500);
    for (let i = 0; i < 500; i++) {
      const side = Math.floor(rng() * 4);
      const r = Math.floor(rng() * rows);
      const d = 6.2 + r * 0.9 - 0.2;
      const along = (rng() * 2 - 1) * d;
      const a = (side * Math.PI) / 2;
      m.makeTranslation(
        Math.sin(a) * d + Math.cos(a) * along,
        -PLATFORM_H + 0.45 + r * 0.42 + 1.0,
        Math.cos(a) * d - Math.sin(a) * along,
      );
      flashes.setMatrixAt(i, m);
    }
    flashes.frustumCulled = false;
    this.group.add(flashes);
  }

  private buildFloorAndScreens(): void {
    const ft = floorTexture();
    ft.repeat.set(8, 8);
    const floorMat = new THREE.MeshStandardMaterial({ map: ft, roughness: 0.35, metalness: 0.1 });
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
    fl.rotation.x = -Math.PI / 2;
    fl.position.y = -PLATFORM_H - 0.1;
    fl.receiveShadow = true;
    this.group.add(fl);

    // Glowing LED ribbon boards around the first row.
    const led = bannerTexture('COUCH ARENA|★|FIGHT NIGHT|★', '#1a0610', '#ff3b5c', 2048, 128);
    led.wrapS = THREE.RepeatWrapping;
    const ledMat = new THREE.MeshBasicNodeMaterial();
    ledMat.colorNode = mix(vec3(0.02), vec3(1.6, 0.5, 0.6), float(1)).mul(vec3(1).mul(float(0.9)));
    for (let side = 0; side < 4; side++) {
      const a = (side * Math.PI) / 2;
      const t = led.clone();
      t.repeat.set(3, 1);
      t.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(2.2, 2.2, 2.2) });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(12, 0.5), mat);
      board.position.set(Math.sin(a) * 5.7, -PLATFORM_H + 0.3, Math.cos(a) * 5.7);
      board.rotation.y = a + Math.PI;
      this.group.add(board);
    }
    ledMat.dispose();
  }

  update(dt: number, excitementTarget: number): void {
    this.excitement.value += (excitementTarget - this.excitement.value) * Math.min(1, dt * 1.5);
  }
}
