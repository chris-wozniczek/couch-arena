/**
 * Renderer + post-processing stack.
 *
 * WebGPU when available (three's WebGPURenderer falls back to its WebGL2 backend automatically), one TSL
 * pipeline for both: scene MRT (color, normals, velocity) → GTAO → bloom → hit motion blur → optional
 * depth of field (KO replay) → color grade + vignette + grain → AgX tone mapping → SMAA.
 */
import * as THREE from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  normalView,
  velocity,
  uniform,
  vec3,
  vec4,
  float,
  screenUV,
  sample,
  packNormalToRGB,
  unpackRGBToNormal,
  builtinAOContext,
  renderOutput,
  mix,
  dot,
  time,
  fract,
  sin,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';
export const TIERS: readonly QualityTier[] = ['ultra', 'high', 'medium', 'low'];

export interface EngineInfo {
  backend: 'WebGPU' | 'WebGL2';
  tier: QualityTier;
}

export class Engine {
  renderer: THREE.WebGPURenderer;
  pipeline!: THREE.RenderPipeline;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.03, 120);
  info: EngineInfo = { backend: 'WebGL2', tier: 'ultra' };
  /** Post uniforms, animated by gameplay. */
  fx = {
    blur: uniform(0),
    dofAmount: uniform(0),
    focus: uniform(1.2),
    flash: uniform(0),
    damage: uniform(0),
    saturation: uniform(1.05),
    exposure: uniform(1),
    vignette: uniform(0.35),
  };
  private dofOn = false;
  private blurOn = false;
  private nodes: { normal: THREE.Node; blurOut: THREE.Node; dofOut: THREE.Node } | null = null;
  private aoPass: ReturnType<typeof ao> | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: { forceWebGL?: boolean } = {},
  ) {
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      forceWebGL: opts.forceWebGL ?? false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
  }

  async init(): Promise<void> {
    await this.renderer.init();
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean };
    this.info.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    this.buildPipeline();
    this.applyTier();
    window.addEventListener('resize', () => this.resize());
  }

  setTier(tier: QualityTier): void {
    if (tier === this.info.tier) return;
    this.info.tier = tier;
    this.applyTier();
  }

  private applyTier(): void {
    const { tier } = this.info;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const ratio = { ultra: dpr, high: Math.min(dpr, 1.5), medium: 1, low: 0.5 }[tier];
    this.renderer.setPixelRatio(ratio);
    if (this.aoPass) this.aoPass.resolutionScale = tier === 'low' ? 0.25 : tier === 'medium' ? 0.5 : 1;
    this.resize();
  }

  private buildPipeline(): void {
    const { scene, camera, fx } = this;
    const pipeline = new THREE.RenderPipeline(this.renderer);
    pipeline.outputColorTransform = false;

    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView), velocity }));
    const normalTex = scenePass.getTexture('normal');
    normalTex.type = THREE.UnsignedByteType;
    const depth = scenePass.getTextureNode('depth');
    const normal = sample((uv) => unpackRGBToNormal(scenePass.getTextureNode('normal').sample(uv)));
    const aoPass = ao(depth, normal, camera);
    aoPass.resolutionScale = 1;
    aoPass.radius.value = 0.35;
    aoPass.distanceExponent.value = 1.2;
    aoPass.scale.value = 1.1;
    this.aoPass = aoPass;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);

    const color = scenePass.getTextureNode('output');
    const vel = scenePass.getTextureNode('velocity').mul(fx.blur);
    const blurred = motionBlur(color, vel, float(12));
    const glow = bloom(color, 0.12, 0.12, 2.2);
    const lit = color.add(glow);
    const litBlurred = blurred.add(bloom(blurred, 0.12, 0.12, 2.2));

    const dofNode = dof(litBlurred, scenePass.getViewZNode(), fx.focus, float(0.9), fx.dofAmount);

    const grade = (c: THREE.Node) => {
      const rgb = vec3(c as THREE.Node<'vec4'>).mul(fx.exposure);
      const luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      // Saturation, cool shadows / warm highlights split-tone.
      let g = mix(vec3(luma), rgb, fx.saturation);
      g = g.mul(mix(vec3(0.94, 0.98, 1.06), vec3(1.05, 1.0, 0.94), luma.clamp(0, 1)));
      // Damage red pulse + white impact flash.
      const d = screenUV.distance(vec3(0.5, 0.5, 0).xy);
      g = mix(g, g.mul(vec3(1.4, 0.35, 0.3)), d.mul(1.6).mul(fx.damage).clamp(0, 1));
      g = g.add(vec3(fx.flash));
      const v = d.remap(0.35, 0.95).clamp(0, 1).mul(fx.vignette).oneMinus();
      const grain = fract(sin(dot(screenUV.add(fract(time)), vec3(12.9898, 78.233, 0).xy)).mul(43758.5453))
        .sub(0.5)
        .mul(0.018);
      return vec4(g.mul(v).add(grain), 1);
    };

    const toOutput = (n: THREE.Node) => smaa(renderOutput(grade(n)));
    this.nodes = { normal: toOutput(lit), blurOut: toOutput(litBlurred), dofOut: toOutput(dofNode) };
    pipeline.outputNode = this.nodes.normal;
    this.pipeline = pipeline;
  }

  /** Depth of field is only enabled during KO replays (switches the graph, no cost otherwise). */
  setDof(on: boolean): void {
    if (on === this.dofOn || !this.nodes) return;
    this.dofOn = on;
    this.applyOutput();
  }

  /** The 12-tap motion blur only runs while a hit is actually blurring the frame. */
  setMotionBlur(on: boolean): void {
    if (on === this.blurOn || !this.nodes) return;
    this.blurOn = on;
    this.applyOutput();
  }

  private applyOutput(): void {
    if (!this.nodes) return;
    const n = this.nodes;
    this.pipeline.outputNode = this.dofOn ? n.dofOut : this.blurOn ? n.blurOut : n.normal;
    this.pipeline.needsUpdate = true;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.pipeline.render();
  }
}
