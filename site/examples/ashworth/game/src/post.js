import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { POST } from './constants.js';
import { clamp } from './utils.js';

export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, resolution: { value: new THREE.Vector2(1, 1) }, time: { value: 0 },
    hurt: { value: 0 }, health: { value: 0 }, lowHealth: { value: 0 }, dead: { value: 0 },
    vignette: { value: POST.vignette }, grain: { value: POST.grain }, ca: { value: POST.ca }, saturation: { value: POST.saturation },
    lift: { value: new THREE.Vector3(0.0016, 0.0031, 0.0025) }, gamma: { value: new THREE.Vector3(1, 1, 1) }, gain: { value: new THREE.Vector3(0.98, 1, 0.985) },
  },
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time,hurt,health,lowHealth,dead,vignette,grain,ca,saturation;
    uniform vec3 lift,gamma,gain;
    varying vec2 vUv;
    float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
    void main(){
      vec2 delta=vUv-0.5; float r=length(delta);
      vec2 shift=delta*r*ca*2.0;
      vec3 original=texture2D(tDiffuse,vUv).rgb;
      vec3 c=vec3(texture2D(tDiffuse,vUv+shift).r,original.g,texture2D(tDiffuse,vUv-shift).b);
      float l=dot(c,vec3(0.2126,0.7152,0.0722));
      c=pow(max(vec3(0.0),c+lift*(1.0-l)),1.0/gamma)*mix(vec3(1.0),gain,l);
      c=mix(vec3(l),c,saturation*(1.0-0.4*max(health,lowHealth)));
      c.r=max(c.r,original.r*0.9);
      c=mix(c,vec3(dot(c,vec3(0.2126,0.7152,0.0722))),dead);
      c+=vec3(0.35,0.02,0.02)*hurt*smoothstep(0.2,0.9,r);
      c+=(hash(floor(vUv*resolution)+vec2(time*67.0,time*31.0))-0.5)*grain*(1.0+2.0*dead)*(1.0-l);
      c*=1.0-0.35*smoothstep(0.2,0.71,r)*(vignette/0.45);
      gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);
    }`,
};
const _size = new THREE.Vector2();
function displayChannel(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; }
function aces(r, g, b, exposure) {
  r *= exposure / 0.6; g *= exposure / 0.6; b *= exposure / 0.6;
  const a = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const c = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const d = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fit = x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
  const x = fit(a), y = fit(c), z = fit(d);
  return 0.2126 * displayChannel(clamp(1.60475 * x - 0.53108 * y - 0.07367 * z, 0, 1))
    + 0.7152 * displayChannel(clamp(-0.10208 * x + 1.10813 * y - 0.00605 * z, 0, 1))
    + 0.0722 * displayChannel(clamp(-0.00327 * x - 0.07276 * y + 1.07602 * z, 0, 1));
}
export class Post {
  constructor(G) { this.G = G; }
  init() {
    const { renderer, scene, camera } = this.G;
    this.quality = this.G.opts.lowfx ? 'low' : 'high';
    this.grade = new ShaderPass(GradeShader); this.composer = null;
    this.info = { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0, programs: 0 };
    renderer.info.autoReset = false;
    if (!this.G.opts.nopost) {
      renderer.getDrawingBufferSize(_size);
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(scene, camera));
      this.bloom = new UnrealBloomPass(_size, POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold);
      this.composer.addPass(this.bloom); this.composer.addPass(new OutputPass());
      this.smaa = new SMAAPass(); this.composer.addPass(this.smaa); this.composer.addPass(this.grade);
    }
    this.sampleType = renderer.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
    this.sampleTarget = new THREE.WebGLRenderTarget(64, 36, { type: this.sampleType, format: THREE.RGBAFormat, depthBuffer: true });
    this.samplePixels = this.sampleType === THREE.FloatType ? new Float32Array(64 * 36 * 4) : new Uint16Array(64 * 36 * 4);
    this.sampleCamera = camera.clone(); this.sampleCamera.layers.set(0);
    this.lastLinear = 0; this.lastDisplay = 0;
    this.resize(innerWidth, innerHeight);
  }
  resize(w, h) {
    const ratio = this.G.renderer.getPixelRatio();
    this.composer?.setPixelRatio(ratio); this.composer?.setSize(w, h);
    if (this.bloom && this.quality === 'low') this.bloom.setSize(w * ratio / 2, h * ratio / 2);
    if (this.smaa) this.smaa.enabled = this.quality !== 'low';
    this.grade.uniforms.resolution.value.set(w * ratio, h * ratio);
  }
  setQuality(quality) {
    if (quality !== 'low' && quality !== 'high') throw new RangeError('Quality must be low or high');
    this.quality = quality;
    const { opts, renderer } = this.G;
    const dpr = devicePixelRatio || 1;
    renderer.setPixelRatio(quality === 'low' || opts.headless || innerWidth * dpr > POST.maxPixelWidth ? 1 : Math.min(dpr, POST.maxPixelRatio));
    this.resize(innerWidth, innerHeight); this.G.renderDirty = true;
  }
  setHurt(v) { this.grade.uniforms.hurt.value = clamp(v, 0, 1); }
  setLowHealth(v) { this.grade.uniforms.health.value = this.grade.uniforms.lowHealth.value = clamp(v, 0, 1); }
  setDead(v) { this.grade.uniforms.dead.value = clamp(v, 0, 1); }
  render() {
    const { renderer, scene, camera } = this.G;
    this.grade.uniforms.time.value = this.G.time;
    renderer.info.reset();
    if (this.composer) this.composer.render(); else renderer.render(scene, camera);
    const r = renderer.info;
    Object.assign(this.info, { calls: r.render.calls, triangles: r.render.triangles, points: r.render.points, lines: r.render.lines, geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs.length });
  }
  sampleLuminance() {
    const { renderer, scene, camera } = this.G, previous = renderer.getRenderTarget();
    this.sampleCamera.copy(camera, false); this.sampleCamera.layers.set(0); this.sampleCamera.updateMatrixWorld(true);
    renderer.setRenderTarget(this.sampleTarget);
    try {
      renderer.render(scene, this.sampleCamera);
      renderer.readRenderTargetPixels(this.sampleTarget, 0, 0, 64, 36, this.samplePixels);
    } finally { renderer.setRenderTarget(previous); }
    let linear = 0, display = 0;
    for (let i = 0; i < this.samplePixels.length; i += 4) {
      let r = this.samplePixels[i], g = this.samplePixels[i + 1], b = this.samplePixels[i + 2];
      if (this.sampleType !== THREE.FloatType) { r = THREE.DataUtils.fromHalfFloat(r); g = THREE.DataUtils.fromHalfFloat(g); b = THREE.DataUtils.fromHalfFloat(b); }
      linear += r * 0.2126 + g * 0.7152 + b * 0.0722;
      display += aces(r, g, b, renderer.toneMappingExposure);
    }
    this.lastLinear = linear / (64 * 36); this.lastDisplay = display / (64 * 36); return this.lastDisplay;
  }
  sampleLuminanceLinear() { this.sampleLuminance(); return this.lastLinear; }
  renderInfo() { return { ...this.info }; }
  update() {}
  reset() { this.setHurt(0); this.setLowHealth(0); this.setDead(0); }
  dispose() { this.sampleTarget.dispose(); if (this.composer) { for (const pass of this.composer.passes) pass.dispose?.(); this.composer.dispose(); } else this.grade.dispose(); }
}
