// VFX: game Niagara systems mapped to pooled instanced sprite particles, ribbon weapon trails, screen-space
// distortion, afterimages and camera shake. Mapping/textures/curves come from web/assets/vfx/vfx.json (built by
// extract/vfx/build_vfx.py from the decoded Niagara systems; textures exported from the game's material instances).
// Effects are purely visual: nothing here touches gameplay state or hit detection.
import * as THREE from "three";
import { Ghosts, ScreenPass, Arcs } from "./vfx_extra.js";
import { StoneFx } from "./stone.js";

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (v) => (Array.isArray(v) ? rand(v[0], v[1]) : v);
const shortName = (n) => (n || "").split("/").pop().split(".").pop().replace(/'$/, "");
/** "Class'Asset'" object names of data-asset references -> "Asset" */
const assetName = (n) => (n || "").match(/'([^']+)'/)?.[1]?.split(".").pop() ?? shortName(n);
// Staff sockets of SKEL_Wukong_Main: FX_Weapon_Trail_01 is the far tip, _08/_09 sit at the grip. (weapon_tou_1 /
// weapon_wei_1 lie ~3.5 m from the hand along the staff axis, well beyond the visible staff.)
const STAFF_TIP = "FX_Weapon_Trail_01";
const PLAYER_TRAIL_FALLBACK = ["FX_Weapon_Trail_01", "FX_Weapon_Trail_09"];
// notify classes the character spec does not turn into `vfx` events: polled here straight from clip notifies
const NOTIFY_FX = new Set(["BAN_GSPlayNiagaraFX_WithCondition", "BANS_GSTimedPlayNiagaraFX_WithCondition", "BAN_GSGhost",
  "BAN_GSSpawnStaticMeshActor", "BAN_GSPlayAtkFXOnGround"]);
// base layers (also listed in vfx.json `layers`; kept here so an older vfx.json still renders)
const DEFAULT_LAYERS = {
  liquid: { texture: "T_liquid_8x8_006", blend: "normal", max: 320, gain: 2.5, bright: 1.6 },
  ring: { texture: "T_Water_01", blend: "normal", ground: true, max: 48, gain: 3 },
  debris: { texture: "T_Concrete_ChunkSubUV_D", blend: "normal", max: 160 },
  smoke: { texture: "T_Smoke_Wisp", blend: "normal", max: 320, gain: 4 },
  glow: { texture: "T_Ring_001", blend: "additive", max: 64, gain: 2, bright: 2 },
  spark: { texture: "T_Streak_Soft_Trail_03", blend: "additive", max: 256, gain: 3, bright: 3, soft: true },
  splash: { texture: "T_WaterSpark001", blend: "normal", max: 32, gain: 3, bright: 1.5 },
  wisp: { texture: "T_Fire_SmokeWisps_Tile_Dup", blend: "normal", max: 160, gain: 2.5, bright: 1.5, soft: true },
};

const SPRITE_VS = /* glsl */ `
attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iColor; attribute vec4 iParams; // size, rot, frame, stretch
uniform vec2 uGrid; uniform float uGround;
varying vec2 vUv; varying vec4 vColor; varying vec2 vQuad;
void main() {
  vec2 corner = position.xy;
  float s = iParams.x;
  vec4 mv;
  if (uGround > 0.5) {
    float cr = cos(iParams.y), sr = sin(iParams.y);
    vec3 w = iPos + vec3(cr * corner.x - sr * corner.y, 0.0, sr * corner.x + cr * corner.y) * s;
    mv = modelViewMatrix * vec4(w, 1.0);
  } else {
    mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 c;
    if (iParams.w > 0.0) {
      vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
      vec2 d = normalize(vv.xy + vec2(1e-5, 0.0));
      vec2 n = vec2(-d.y, d.x);
      c = d * corner.x * s * (1.0 + iParams.w) + n * corner.y * s * 0.3;
    } else {
      float cr = cos(iParams.y), sr = sin(iParams.y);
      c = vec2(cr * corner.x - sr * corner.y, sr * corner.x + cr * corner.y) * s;
    }
    mv.xy += c;
  }
  gl_Position = projectionMatrix * mv;
  float f = floor(iParams.z);
  vec2 cell = vec2(mod(f, uGrid.x), floor(f / uGrid.x));
  vUv = (uv + vec2(cell.x, uGrid.y - 1.0 - cell.y)) / uGrid;
  vColor = iColor;
  vQuad = uv;
}`;
const SPRITE_FS = /* glsl */ `
uniform sampler2D map; uniform float uGain; uniform float uBright; uniform float uSoft;
#ifdef DISTORT
uniform sampler2D uScreen; uniform vec2 uRes; uniform float uDistort;
#endif
varying vec2 vUv; varying vec4 vColor; varying vec2 vQuad;
void main() {
  vec4 t = texture2D(map, vUv);
  // tileable textures (smoke wisps) have no alpha falloff at their borders: fade the quad radially
  float edge = uSoft > 0.5 ? 1.0 - smoothstep(0.22, 0.5, length(vQuad - 0.5)) : 1.0;
#ifdef DISTORT
  // refraction sprite (M_Radial_Blur_Refraction): normal map offsets the screen copy; alpha = particle alpha
  vec2 n = t.xy * 2.0 - 1.0;
  float m = clamp(vColor.a * uGain, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.5, length(vQuad - 0.5)));
  vec2 suv = gl_FragCoord.xy / uRes + n * uDistort * m;
  gl_FragColor = vec4(texture2D(uScreen, suv).rgb + vColor.rgb * uBright * m, m);
  if (m < 0.003) discard;
#else
  gl_FragColor = vec4(t.rgb * vColor.rgb * uBright, clamp(t.a * vColor.a * uGain, 0.0, 1.0) * edge);
  if (gl_FragColor.a < 0.003) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
#endif
}`;

/** pool of camera-facing (or ground-flat) textured particles drawn with one InstancedMesh.
 * Optional per-particle curves (alphaCurve / sizeCurve / colorCurve ids into `curves`, the Niagara curve LUTs of
 * vfx.json): alpha = alpha * A(k), size = s0 + (s1 - s0) * S(k), rgb *= C(k).rgb, alpha *= C(k).a (k = age / life). */
export class SpriteLayer {
  constructor(scene, tex, { blend = "normal", grid = [1, 1], ground = false, max = 256, gain = 1, bright = 1, soft = false, distort = 0, curves = null, screen = null }) {
    this.max = max; this.n = 0; this.grid = grid; this.curves = curves || [];
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index; g.attributes.position = quad.attributes.position; g.attributes.uv = quad.attributes.uv;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4); this.par = new Float32Array(max * 4);
    const ia = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("iPos", this.aPos = ia(this.pos, 3)); g.setAttribute("iVel", this.aVel = ia(this.vel, 3));
    g.setAttribute("iColor", this.aCol = ia(this.col, 4)); g.setAttribute("iParams", this.aPar = ia(this.par, 4));
    g.instanceCount = 0;
    this.geo = g;
    const uniforms = { map: { value: tex }, uGrid: { value: new THREE.Vector2(grid[0], grid[1]) }, uGround: { value: ground ? 1 : 0 },
      uGain: { value: gain }, uBright: { value: bright }, uSoft: { value: soft ? 1 : 0 } };
    if (distort) Object.assign(uniforms, { uScreen: { value: screen?.texture ?? null }, uRes: { value: screen?.res ?? new THREE.Vector2(1, 1) }, uDistort: { value: distort } });
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS, transparent: true, depthWrite: false,
      defines: distort ? { DISTORT: 1 } : {},
      blending: blend === "additive" && !distort ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = distort ? 14 : blend === "additive" ? 12 : 11;
    if (distort && screen) this.mesh.onBeforeRender = (r) => screen.grab(r);
    scene.add(this.mesh);
    // simulation state (struct of arrays)
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.rotV = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.a0 = new Float32Array(max);
    this.frame0 = new Float32Array(max); this.frames = new Float32Array(max); this.rgb = new Float32Array(max * 3);
    this.ac = new Int16Array(max).fill(-1); this.sc = new Int16Array(max).fill(-1); this.cc = new Int16Array(max).fill(-1);
    this.vecArrs = [[this.pos, 3], [this.vel, 3], [this.col, 4], [this.par, 4], [this.rgb, 3]];
    this.scalArrs = [this.age, this.life, this.s0, this.s1, this.rotV, this.grav, this.drag, this.a0, this.frame0, this.frames, this.ac, this.sc, this.cc];
  }

  /** o: {size:[s0,s1], life, color:[r,g,b], alpha, gravity, drag, rot, rotSpeed, stretch, frame, frames,
   *  alphaCurve, sizeCurve, colorCurve (curve ids)} */
  spawn(px, py, pz, vx, vy, vz, o) {
    if (this.n >= this.max) return;
    const i = this.n++, i3 = i * 3, i4 = i * 4;
    this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.age[i] = 0; this.life[i] = o.life; this.s0[i] = o.size[0]; this.s1[i] = o.size[1];
    this.rotV[i] = o.rotSpeed ?? 0; this.grav[i] = o.gravity ?? 0; this.drag[i] = o.drag ?? 0; this.a0[i] = o.alpha ?? 1;
    this.frame0[i] = o.frame ?? 0; this.frames[i] = o.frames ?? 0;
    this.rgb[i3] = o.color[0]; this.rgb[i3 + 1] = o.color[1]; this.rgb[i3 + 2] = o.color[2];
    this.ac[i] = o.alphaCurve ?? -1; this.sc[i] = o.sizeCurve ?? -1; this.cc[i] = o.colorCurve ?? -1;
    this.par[i4 + 1] = o.rot ?? Math.random() * 6.283; this.par[i4 + 3] = o.stretch ?? 0;
  }

  /** LUT sample (component c of a stride-s curve) at normalized time k */
  curve(id, k, c = 0) {
    const cv = this.curves[id];
    const n = cv.n, x = Math.min(1, Math.max(0, k)) * (n - 1), j = x | 0, f = x - j, s = cv.stride, L = cv.lut;
    return j >= n - 1 ? L[(n - 1) * s + c] : L[j * s + c] + (L[(j + 1) * s + c] - L[j * s + c]) * f;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.copy(--n, i); i--; continue; }
      const i3 = i * 3, i4 = i * 4, k = this.age[i] / this.life[i];
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const sc = this.sc[i], ac = this.ac[i], cc = this.cc[i];
      this.par[i4] = this.s0[i] + (this.s1[i] - this.s0[i]) * (sc >= 0 ? this.curve(sc, k) : Math.sqrt(k));
      this.par[i4 + 1] += this.rotV[i] * dt;
      this.par[i4 + 2] = this.frames[i] > 0 ? this.frame0[i] + Math.min(this.frames[i] - 1, Math.floor(k * this.frames[i])) : this.frame0[i];
      let a = this.a0[i] * (ac >= 0 ? this.curve(ac, k) : k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9);
      let r = this.rgb[i3], g = this.rgb[i3 + 1], b = this.rgb[i3 + 2];
      if (cc >= 0) { r *= this.curve(cc, k, 0); g *= this.curve(cc, k, 1); b *= this.curve(cc, k, 2); a *= this.curve(cc, k, 3); }
      this.col[i4] = r; this.col[i4 + 1] = g; this.col[i4 + 2] = b; this.col[i4 + 3] = a;
    }
    this.n = n;
    this.geo.instanceCount = n;
    if (n) { this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aPar.needsUpdate = true; }
  }

  copy(from, to) {
    if (from === to) return;
    for (const [arr, k] of this.vecArrs) for (let j = 0; j < k; j++) arr[to * k + j] = arr[from * k + j];
    for (const arr of this.scalArrs) arr[to] = arr[from];
  }
}

/** weapon ribbon: ring buffer of (edge A, edge B) samples; quads fade with sample age. Modes:
 * - "ghost": the Destined One's 棍影 (GunYing emitter, M_swk_gunying_Inst): translucent, T_swk_gunying (five staff
 *   afterimages) tiled `tileU` times along the trail, V across the staff, opacity = tex.a * mask (zhezhaoqiangdu),
 *   colour = tex.rgb * particle colour * gain, alpha over normalized age from the emitter's "Scale Alpha" curve LUT.
 * - "mask": additive, texture used as a mask (wipe/streak textures), colour = tint * gain [INFERENCE].
 * - "color": normal blend, texture colour (tileable smoke wisps, both borders faded).
 * - "distort": screen refraction (M_WuKong_Trail / M_HeatDistort_Master): normal map `texture` (tiled along the
 *   trail) offsets a copy of the frame; `maskTexture` (U = age, V = across) shapes it; tint adds the emissive part. */
export class Ribbon {
  constructor(scene, tex, { mode, blend = "additive", tint = [1, 1, 1], life = 0.25, max = 48, gain = 1.8, tileU = 1, mask = 1, curve = null, distort = 0.02, maskTex = null, screen = null }) {
    this.max = max; this.life = life; this.curve = curve;
    this.tA = new Float32Array(max * 3); this.tB = new Float32Array(max * 3); this.tt = new Float32Array(max);
    this.count = 0; this.head = 0; this.time = 0;
    const g = new THREE.BufferGeometry();
    this.posArr = new Float32Array(max * 2 * 3); this.uvArr = new Float32Array(max * 2 * 2); this.alpha = new Float32Array(max * 2);
    g.setAttribute("position", new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("uv", new THREE.BufferAttribute(this.uvArr, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.geo = g;
    mode ??= blend === "additive" ? "mask" : "color";
    if (mode === "ghost" || mode === "distort") { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; tex.needsUpdate = true; }
    const define = { ghost: "GHOST_TRAIL", mask: "MASK_TRAIL", color: "COLOR_TRAIL", distort: "DISTORT_TRAIL" }[mode];
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uTint: { value: new THREE.Color().setRGB(...tint) }, uGain: { value: gain },
        uTileU: { value: tileU }, uMask: { value: mask }, uMaskTex: { value: maskTex }, uDistort: { value: distort },
        uScreen: { value: screen?.texture ?? null }, uRes: { value: screen?.res ?? new THREE.Vector2(1, 1) } },
      defines: { [define]: 1 },
      vertexShader: "attribute float aAlpha; varying vec2 vUv; varying float vA; void main(){ vUv = uv; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
      fragmentShader: `uniform sampler2D map; uniform vec3 uTint; uniform float uGain; uniform float uTileU; uniform float uMask;
        uniform sampler2D uMaskTex; uniform float uDistort; uniform sampler2D uScreen; uniform vec2 uRes;
        varying vec2 vUv; varying float vA;
        void main(){
        #if defined(DISTORT_TRAIL)
          vec2 n = texture2D(map, vec2(vUv.x * uTileU, vUv.y)).xy * 2.0 - 1.0;
          float m = texture2D(uMaskTex, vec2(vUv.x, vUv.y)).r * vA * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
          vec3 c = texture2D(uScreen, gl_FragCoord.xy / uRes + n * uDistort * m).rgb;
          gl_FragColor = vec4(c + uTint * uGain * m, m);
          if (m < 0.003) discard;
        #else
        #if defined(GHOST_TRAIL)
          vec4 t = texture2D(map, vec2(vUv.x * uTileU, vUv.y));
          gl_FragColor = vec4(t.rgb * uTint * uGain, clamp(t.a * uMask, 0.0, 1.0) * vA);
        #elif defined(MASK_TRAIL)
          float m = texture2D(map, vec2(vUv.y, vUv.x)).r;
          float a = vA * (0.25 + 0.75 * m) * smoothstep(0.0, 0.45, vUv.y);
          gl_FragColor = vec4(uTint * uGain, a);
        #else
          vec4 t = texture2D(map, vUv);
          float edge = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.7, vUv.y); // tileable texture: fade both borders
          gl_FragColor = vec4(t.rgb * uTint, t.a * vA * edge);
        #endif
          if (gl_FragColor.a < 0.003) discard;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #endif
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: mode === "mask" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = mode === "distort" ? 14 : 13;
    if (mode === "distort" && screen) this.mesh.onBeforeRender = (r) => screen.grab(r);
    scene.add(this.mesh);
  }

  /** alpha at normalized age u: the emitter's curve LUT when given ({maxTime, lut}), else a soft fall-off */
  alphaAt(u) {
    const c = this.curve;
    if (!c) return Math.pow(1 - u, 1.3);
    const x = Math.min(1, u / c.maxTime) * (c.lut.length - 1), i = Math.floor(x), f = x - i;
    return i >= c.lut.length - 1 ? c.lut[c.lut.length - 1] : c.lut[i] + (c.lut[i + 1] - c.lut[i]) * f;
  }

  update(dt, emitting, a, b) {
    this.time += dt;
    if (emitting) {
      const i = this.head;
      this.tA[i * 3] = a.x; this.tA[i * 3 + 1] = a.y; this.tA[i * 3 + 2] = a.z;
      this.tB[i * 3] = b.x; this.tB[i * 3 + 1] = b.y; this.tB[i * 3 + 2] = b.z;
      this.tt[i] = this.time;
      this.head = (i + 1) % this.max; this.count = Math.min(this.max, this.count + 1);
    }
    // newest -> oldest, drop samples older than life
    let n = 0;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - 1 - k + this.max) % this.max;
      const age = this.time - this.tt[i];
      if (age > this.life) break;
      const u = age / this.life, v = n * 2;
      this.posArr[v * 3] = this.tA[i * 3]; this.posArr[v * 3 + 1] = this.tA[i * 3 + 1]; this.posArr[v * 3 + 2] = this.tA[i * 3 + 2];
      this.posArr[v * 3 + 3] = this.tB[i * 3]; this.posArr[v * 3 + 4] = this.tB[i * 3 + 1]; this.posArr[v * 3 + 5] = this.tB[i * 3 + 2];
      this.uvArr[v * 2] = u; this.uvArr[v * 2 + 1] = 1; this.uvArr[v * 2 + 2] = u; this.uvArr[v * 2 + 3] = 0;
      const al = this.alphaAt(u);
      this.alpha[v] = al; this.alpha[v + 1] = al;
      n++;
    }
    this.count = n;
    this.geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    if (n > 1) {
      this.geo.attributes.position.needsUpdate = true; this.geo.attributes.uv.needsUpdate = true; this.geo.attributes.aAlpha.needsUpdate = true;
    }
  }
}

/** a copy of the frame drawn so far, taken once per frame by the first distortion mesh that renders */
class ScreenGrab {
  constructor() {
    this.res = new THREE.Vector2(1, 1);
    this.texture = null; this.frame = -1; this.failed = false;
  }
  grab(renderer, force = false) {
    const f = renderer.info.render.frame;
    if (this.failed || (!force && f === this.frame)) return;
    this.frame = f;
    renderer.getDrawingBufferSize(_v2);
    if (!this.texture || this.texture.image.width !== _v2.x || this.texture.image.height !== _v2.y) {
      this.texture?.dispose();
      this.texture = new THREE.FramebufferTexture(_v2.x, _v2.y);
      this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
      this.res.copy(_v2);
      for (const u of this.users) u.value = this.texture;
    }
    try { renderer.copyFramebufferToTexture(this.texture); } catch (e) { this.failed = true; console.warn("[vfx] screen copy failed", e); }
  }
}
const _v2 = new THREE.Vector2();

export class Vfx {
  constructor(game, data) {
    this.game = game; this.d = data;
    const scene = game.r.scene;
    this.loader = new THREE.TextureLoader();
    this.tex = {};
    this.recipes = new Map(); // extension burst recipes: layer name -> (vfx, p, s) => void
    this.screen = new ScreenGrab(); this.screen.users = [];
    data.curves ||= {};
    this.curveList = []; this.curveIds = {};
    for (const [k, c] of Object.entries(data.curves)) this.addCurve(k, c);
    this.addTextures(data.textures);
    this.layers = {}; this.layerList = [];
    // runtime particle layers (texture + blend from the mapped material instances; gain/bright stand in for the
    // game's HDR emissive multipliers [INFERENCE])
    for (const [name, L] of Object.entries(data.layers || DEFAULT_LAYERS)) this.addLayer(name, L.texture, L);
    this.ribbons = new Map(); // `${who}:${system}` -> Ribbon
    this.live = [];           // running emitter instances (rate / delayed emitters, timed notifies)
    this.notifyFired = new Map(); // character -> {stamp, set} for polled notify classes
    this.trauma = 0; this.shakeT = 0;
    this.shakeOffset = new THREE.Vector3();
    this.ghosts = new Ghosts(game, data.ghost || {});
    this.arcs = new Arcs(game, this.tex.T_Trail046_2_A);
    this.post = new ScreenPass(game, this.screen, data.post || {});
    this.focusLevel = 0;
    // tiger stone skin / decoy unit / death dissolves (material notifies are evaluated there)
    game.stoneFx = new StoneFx(game, this, data.stone);
  }

  // ------------------------------------------------------------------ extension API (skill modules)
  /** {name: {file (under assets/vfx/), flipbook?, linear?}}: loads each texture once and records it in the mapping */
  addTextures(textures) {
    for (const [k, t] of Object.entries(textures || {})) {
      if (this.tex[k]) continue;
      const tx = this.loader.load(`assets/vfx/${t.file}`);
      tx.colorSpace = t.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      this.tex[k] = tx;
      this.d.textures[k] = t;
    }
  }

  /** new pooled particle layer over a loaded texture (SpriteLayer options); returns it (also in this.layers[name]) */
  addLayer(name, texName, opts = {}) {
    const t = this.d.textures[texName];
    const layer = new SpriteLayer(this.game.r.scene, this.tex[texName], { grid: t?.flipbook || [1, 1], ...opts, curves: this.curveList, screen: this.screen });
    if (opts.distort) this.screen.users.push(layer.mesh.material.uniforms.uScreen);
    this.layers[name] = layer;
    this.layerList.push(layer);
    return layer;
  }

  /** burst recipe used by systems' `layers` lists (and burst()): fn(vfx, point, scale) */
  addRecipe(name, fn) { this.recipes.set(name, fn); }

  /** merges {eventName: system} into the mapping (montage "vfx" events resolve against it) */
  addSystems(systems) { Object.assign(this.d.systems, systems || {}); }

  /** named curve LUT {lut:[...], stride?} usable by emitters (alphaCurve/sizeCurve/colorCurve) */
  addCurve(name, c) {
    if (this.curveIds[name] != null) return this.curveIds[name];
    const stride = c.stride || 1, lut = Float32Array.from(c.lut);
    this.curveIds[name] = this.curveList.length;
    this.curveList.push({ lut, stride, n: lut.length / stride });
    this.d.curves[name] = c;
    return this.curveIds[name];
  }

  // ------------------------------------------------------------------ recipes (layer -> particle spawn)
  emitLayer(name, p, s) {
    const Ly = this.layers;
    switch (name) {
      case "bloodSplash":
        for (let i = 0; i < 10 * s; i++) {
          const a = Math.random() * 6.283, v = rand(2, 5) * s;
          Ly.liquid.spawn(p.x, p.y + 0.1, p.z, Math.cos(a) * v, rand(3, 6) * s, Math.sin(a) * v,
            { size: [0.5 * s, 1.3 * s], life: rand(0.45, 0.7), color: [0.45, 0.03, 0.03], alpha: 1, gravity: 14, drag: 1, frames: 64, frame: 0 });
        }
        break;
      case "groundRing":
        Ly.ring.spawn(p.x, p.y + 0.04, p.z, 0, 0, 0, { size: [0.6 * s, 3.2 * s], life: 0.45, color: [0.5, 0.08, 0.06], alpha: 0.9 });
        break;
      case "debris":
        for (let i = 0; i < 8 * s; i++) {
          const a = Math.random() * 6.283, v = rand(2, 6) * s;
          Ly.debris.spawn(p.x, p.y + 0.15, p.z, Math.cos(a) * v, rand(4, 8) * s, Math.sin(a) * v,
            { size: [0.28, 0.24], life: rand(0.8, 1.2), color: [0.55, 0.48, 0.42], gravity: 20, frame: Math.floor(Math.random() * 16), rotSpeed: rand(-8, 8) });
        }
        break;
      case "dust":
        for (let i = 0; i < 7 * s; i++) {
          const a = Math.random() * 6.283, v = rand(1, 3) * s;
          Ly.smoke.spawn(p.x + Math.cos(a) * 0.4, p.y + 0.3, p.z + Math.sin(a) * 0.4, Math.cos(a) * v, rand(0.4, 1.4), Math.sin(a) * v,
            { size: [1.2 * s, 3.8 * s], life: rand(1.0, 1.6), color: [0.62, 0.52, 0.42], alpha: 0.55, drag: 1.8, frames: 64, rotSpeed: rand(-0.6, 0.6) });
        }
        break;
      case "glow":
        Ly.glow.spawn(p.x, p.y + 0.5, p.z, 0, 0, 0, { size: [0.6 * s, 4.5 * s], life: 0.28, color: [1, 0.55, 0.35], alpha: 0.9 });
        break;
      case "goldSparks":
        for (let i = 0; i < 26 * s; i++) {
          _a.set(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize().multiplyScalar(rand(5, 13) * s);
          Ly.spark.spawn(p.x, p.y, p.z, _a.x, _a.y, _a.z, { size: [0.3, 0.1], life: rand(0.2, 0.45), color: [1, 0.72, 0.28], gravity: 7, drag: 2.5, stretch: 4 });
        }
        break;
      case "goldGlow":
        Ly.glow.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [0.4, 4.0], life: 0.35, color: [1, 0.78, 0.4], alpha: 1 });
        break;
      case "hitFlash":
        Ly.glow.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [0.3, 1.8 * s], life: 0.16, color: [1, 0.9, 0.7], alpha: 1 });
        break;
      case "impactSplash":
        for (let i = 0; i < 2; i++) Ly.splash.spawn(p.x, p.y, p.z, 0, 0.5, 0, { size: [0.5, 1.8], life: 0.3, color: [0.55, 0.05, 0.05], alpha: 0.95 });
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * 6.283;
          Ly.liquid.spawn(p.x, p.y, p.z, Math.cos(a) * 2.5, rand(1, 3), Math.sin(a) * 2.5, { size: [0.25, 0.6], life: 0.45, color: [0.45, 0.03, 0.03], gravity: 10, frames: 64 });
        }
        break;
      default:
        this.recipes.get(name)?.(this, p, s);
    }
  }

  /** fires a system at point p. ctx (optional): {ch, socket, fwd} for attached / body / oriented emitters */
  burst(sysName, p, scaleMul = 1, ctx = null) {
    const sys = this.d.systems[sysName];
    if (!sys) return null;
    const s = (sys.scale ?? 1) * scaleMul;
    if (Array.isArray(sys.emitters)) return this.startFx(sysName, sys, p, s, ctx);
    for (const l of sys.layers || []) this.emitLayer(l, p, s);
    return null;
  }

  /** combat hit connect (called after damage was applied). No hit-stop: FUStHitVEffectDesc FreezeFrameTime is 0 for
   * every player and tiger damage row of this fight and the HitSlow* fields have no reader (BUS_BeAttackedComp). */
  hit(kind, point) { this.burst(kind === "staff" ? "hit_staff" : "hit_tiger", point, kind === "staff" ? 0.6 : 1); }

  // ------------------------------------------------------------------ data-driven emitters (vfx.json systems[].emitters)
  /** resolves curve names to ids once per emitter spec */
  prep(em) {
    if (em._prep) return em;
    em._prep = true;
    for (const k of ["alphaCurve", "sizeCurve", "colorCurve"]) if (typeof em[k] === "string") em["_" + k] = this.curveIds[em[k]];
    return em;
  }

  startFx(name, sys, p, s, ctx) {
    let needsLive = !!sys.timed;
    if (sys.offsetY) p = _d.copy(p).setY(p.y + sys.offsetY * s);
    for (const em of sys.emitters) {
      this.prep(em);
      if (em.rate || em.delay) needsLive = true;
      if (em.count && !em.delay) this.emitN(em, em.count, p, s, ctx);
    }
    if (!needsLive) return null;
    const inst = { name, sys, p: p.clone(), s, ctx, t: 0, acc: new Float32Array(sys.emitters.length), fired: new Uint8Array(sys.emitters.length),
      dur: sys.dur ?? Math.max(0, ...sys.emitters.map((e) => (e.delay ?? 0) + (e.dur ?? (e.rate ? 0.5 : 0)))), alive: true, timed: !!sys.timed };
    this.live.push(inst);
    return inst;
  }

  updateLive(dt) {
    let w = 0;
    for (const inst of this.live) {
      const { sys, ctx } = inst;
      inst.t += dt;
      if (ctx?.ch && ctx.socket && sys.attach !== false) {
        const bp = ctx.ch.bonePos(ctx.socket, _d);
        if (bp) { inst.p.copy(bp); if (sys.ground) this.toGround(inst.p, ctx.ch); if (sys.offsetY) inst.p.y += sys.offsetY * inst.s; }
      }
      const emitting = inst.timed ? inst.alive : inst.t <= inst.dur;
      sys.emitters.forEach((em, k) => {
        if (em.delay && !inst.fired[k] && inst.t >= em.delay) { inst.fired[k] = 1; if (em.count) this.emitN(em, em.count, inst.p, inst.s, ctx); }
        if (!em.rate || !emitting || inst.t < (em.delay ?? 0)) return;
        if (!inst.timed && em.dur != null && inst.t > (em.delay ?? 0) + em.dur) return;
        inst.acc[k] += em.rate * dt;
        const n = inst.acc[k] | 0;
        if (n > 0) { inst.acc[k] -= n; this.emitN(em, n, inst.p, inst.s, ctx); }
      });
      if (emitting || inst.t < inst.dur) this.live[w++] = inst;
    }
    this.live.length = w;
  }

  /** n particles of one emitter spec at p (scale s) */
  emitN(em, n, p, s, ctx) {
    if (em.layer === "arc") return this.arcs.spawn(p, ctx?.fwd || ctx?.ch?.forward?.(), em, s);
    const L = this.layers[em.layer];
    if (!L) return;
    const fwd = ctx?.fwd || (ctx?.ch ? ctx.ch.forward?.() : null);
    const body = em.shape === "body" && ctx?.ch ? this.bodyPoints(ctx.ch) : null;
    for (let i = 0; i < n; i++) {
      // spawn location (shape modules: SphereLocation / CylinderLocation / ring / skinned-mesh reproduction)
      const r = (em.radius ?? 0) * s;
      let ox = 0, oy = 0, oz = 0;
      switch (em.shape) {
        case "sphere": { _a.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(r * Math.cbrt(Math.random())); ox = _a.x; oy = _a.y; oz = _a.z; break; }
        case "disc": { const a = Math.random() * 6.283, rr = r * Math.sqrt(Math.random()); ox = Math.cos(a) * rr; oz = Math.sin(a) * rr; oy = (em.height ?? 0) * s * Math.random(); break; }
        case "ring": { const a = Math.random() * 6.283; ox = Math.cos(a) * r; oz = Math.sin(a) * r; break; }
        case "body": if (body?.length) { const b = body[(Math.random() * body.length) | 0]; ctx.ch.bonePos(b, _b); ox = _b.x - p.x + rand(-r, r); oy = _b.y - p.y + rand(-r, r); oz = _b.z - p.z + rand(-r, r); } break;
      }
      // initial velocity (AddVelocity / AddVelocityInCone / InitialLocationtoVelocity)
      const sp = pick(em.speed ?? 0) * s;
      switch (em.dir) {
        case "up": _a.set(rand(-0.15, 0.15), 1, rand(-0.15, 0.15)).normalize(); break;
        case "cone": { const c = THREE.MathUtils.degToRad(em.cone ?? 45), a = Math.random() * 6.283, z = rand(Math.cos(c), 1), q = Math.sqrt(1 - z * z); _a.set(Math.cos(a) * q, z, Math.sin(a) * q); break; }
        case "radial": _a.set(ox, em.lift ?? 0, oz); if (_a.lengthSq() < 1e-6) _a.set(rand(-1, 1), 0, rand(-1, 1)); _a.normalize(); break;
        case "out": _a.set(ox, oy, oz); if (_a.lengthSq() < 1e-6) _a.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)); _a.normalize(); break;
        case "fwd": if (fwd) _a.copy(fwd).addScaledVector(_b.set(rand(-1, 1), rand(-0.5, 1), rand(-1, 1)), em.spread ?? 0.3).normalize(); else _a.set(0, 1, 0); break;
        case "down": _a.set(rand(-0.2, 0.2), -1, rand(-0.2, 0.2)).normalize(); break;
        case "none": _a.set(0, 0, 0); break;
        default: _a.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(); // sphere
      }
      const sz = em.size ?? [0.5, 0.5];
      const s0 = (Array.isArray(sz[0]) ? pick(sz[0]) : sz[0]) * s, s1 = (Array.isArray(sz[1]) ? pick(sz[1]) : sz[1]) * s;
      L.spawn(p.x + ox, p.y + oy + (em.offsetY ?? 0) * s, p.z + oz, _a.x * sp, _a.y * sp + (em.upBias ?? 0), _a.z * sp, {
        size: [s0, s1], life: pick(em.life ?? 1), color: em.color ?? [1, 1, 1], alpha: pick(em.alpha ?? 1),
        gravity: em.gravity ?? 0, drag: em.drag ?? 0, stretch: em.stretch ?? 0,
        frames: em.frames ?? 0, frame: em.frameRand ? Math.floor(Math.random() * em.frameRand) : (em.frame ?? 0),
        rot: em.rot, rotSpeed: em.rotSpeed ? pick(em.rotSpeed) : 0,
        alphaCurve: em._alphaCurve, sizeCurve: em._sizeCurve, colorCurve: em._colorCurve,
      });
    }
  }

  /** bones used as the skinned-mesh surface stand-in (Niagara SkeletalMeshLocation / MeshReproductionSprite) */
  bodyPoints(ch) {
    if (ch._fxBones) return ch._fxBones;
    const names = [];
    ch.model.traverse((o) => { if (o.isBone && !/finger|thumb|index|middle|ring_|pinky|twist|FX_|weapon|_end$|IK|root/i.test(o.name)) names.push(o.name); });
    return (ch._fxBones = names);
  }

  toGround(p, ch) {
    const gnd = this.game.world.groundAt(p.x, p.z, p.y + 1.5, 6);
    p.y = gnd ? gnd.point.y : ch?.position.y ?? p.y;
    return p;
  }

  // ------------------------------------------------------------------ bullets (visual only; hit volumes in hazards.js)
  bulletTick(h, dt) {
    const Ly = this.layers;
    h.vfxAcc = (h.vfxAcc ?? 0) + dt;
    if (h.def.shape.capsule) {
      // NG_HuStone_Atk07_Tornado: swirling smoke column + stone chunks. Particles inherit the bullet velocity (it
      // travels at 14 m/s and homes) with only a slow swirl and updraft on top, so the column stays together
      // instead of scattering into a sparse disc.
      const H = h.def.shape.capsule.halfHeight, vx = h.dir.x * h.speed, vz = h.dir.z * h.speed;
      while (h.vfxAcc > 1 / 110) {
        h.vfxAcc -= 1 / 110;
        const y = Math.random() * Math.min(H * 2, 9), a = Math.random() * 6.283, r = 0.35 + y * 0.16;
        const sw = 1.2 + y * 0.25;
        Ly.smoke.spawn(h.pos.x + Math.cos(a) * r, h.pos.y + y, h.pos.z + Math.sin(a) * r, vx - Math.sin(a) * sw, 1.2, vz + Math.cos(a) * sw,
          { size: [1.0 + y * 0.18, 1.9 + y * 0.32], life: 0.5, color: [0.68, 0.58, 0.46], alpha: 0.75, frames: 64, rotSpeed: 3 });
        if (Math.random() < 0.18) Ly.debris.spawn(h.pos.x + Math.cos(a) * r * 1.3, h.pos.y + y * 0.7, h.pos.z + Math.sin(a) * r * 1.3,
          vx - Math.sin(a) * 4, 2.5, vz + Math.cos(a) * 4,
          { size: [0.22, 0.18], life: 0.55, color: [0.5, 0.45, 0.4], frame: Math.floor(Math.random() * 16), rotSpeed: 9 });
      }
    } else if (h.def.shape.box) {
      // NG_HFM_HuStone_DG_Bullet: blood-wind wisps inside the blade volume
      const bx = h.def.shape.box, f = h.dir, rx = f.z, rz = -f.x;
      while (h.vfxAcc > 1 / 40) {
        h.vfxAcc -= 1 / 40;
        const u = rand(-1, 1) * bx[0], w = rand(-1, 1) * bx[1], y = rand(-1, 1) * bx[2];
        Ly.wisp.spawn(h.pos.x + f.x * u + rx * w, h.pos.y + y, h.pos.z + f.z * u + rz * w, f.x * 6, 0.3, f.z * 6,
          { size: [0.9, 1.8], life: 0.45, color: [0.5, 0.04, 0.04], alpha: 0.45, drag: 2, rotSpeed: rand(-2, 2) });
        if (Math.random() < 0.25) Ly.liquid.spawn(h.pos.x + rx * w, h.pos.y + y, h.pos.z + rz * w, f.x * 4, 1, f.z * 4,
          { size: [0.4, 0.9], life: 0.5, color: [0.45, 0.03, 0.03], gravity: 9, frames: 64 });
      }
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    const g = this.game;
    for (const inst of this.live) if (inst.timed) inst.alive = false; // re-flagged by the active notifies below
    this.pollCharacter("player", g.player.ch, g.player, dt);
    this.pollCharacter("tiger", g.boss.ch, g.boss, dt);
    this.focusGlow(g.player);
    this.updateLive(dt);
    for (const l of this.layerList) l.update(dt);
    this.ghosts.update(dt);
    this.arcs.update(dt);
    this.post.update(dt);
    this.game.stoneFx.update(dt);
    this.shakeT += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
  }

  pollCharacter(who, ch, actor, dt) {
    const sysTab = this.d.systems;
    // point systems (bursts) at the event socket, projected to the ground for ground systems
    for (const e of ch.crossed("vfx")) this.fireNotifySystem(shortName(e.name), e.socket, ch, actor, e);
    for (const e of ch.crossed("cameraShake")) this.shake(e.shake || e.name, who === "tiger" ? ch.position : null);
    this.pollNotifies(who, ch, actor);
    // charged heavy (xuli_attack, focus level >= 1): the game plays NG_WuKong_XuLiGun_BaoFa_01_burst only on the
    // ComboA_z follow-ups; here it fires at the heavy's hit-window start at the staff tip [INFERENCE]
    if (who === "player" && actor.action?.kind === "heavy" && actor.action.level >= 1)
      for (const e of ch.crossed("hit")) { const p = ch.bonePos(STAFF_TIP, _c); if (p) this.burst("NG_WuKong_XuLiGun_BaoFa_01_burst", p, 0.6 + 0.2 * actor.action.level); break; }
    // interval systems: ribbons / sprays / timed emitters run while their window is active
    const bones = who === "player" ? PLAYER_TRAIL_FALLBACK : ch.anims.bones.weapon;
    const active = actor.state === "action" || actor.state === "skill" || actor.state === "hit" || actor.state === "dead" ? ch.activeEvents("vfx") : null;
    for (const [key, rb] of this.ribbons) if (key.startsWith(who + ":")) rb.seen = false;
    if (active) for (const e of active) this.runInterval(who, ch, e, shortName(e.name), e.socket, bones, dt, ch.cur.meta.events.indexOf(e));
    if (this._activeNotify?.[who]) for (const x of this._activeNotify[who]) this.runInterval(who, ch, x.e, x.name, x.socket, bones, dt, "n" + x.idx);
    for (const [key, rb] of this.ribbons) {
      if (!key.startsWith(who + ":")) continue;
      const ends = rb.ends || bones;
      const a = rb.seen ? ch.bonePos(ends[0], _a) : null, b = rb.seen ? ch.bonePos(ends[1], _b) : null;
      rb.update(dt, !!(a && b), a, b);
    }
  }

  fireNotifySystem(name, socket, ch, actor, e) {
    const sys = this.d.systems[name];
    if (!sys || (sys.kind !== "burst" && sys.kind !== "fx")) return;
    if (sys.kind === "fx" && sys.timed) return; // interval systems run from runInterval
    const p = (socket && ch.bonePos(socket, _c)) || _c.copy(ch.position);
    // notify LocationOffset (cm, UE X forward / Y right / Z up, applied in the owner's frame) and Scale
    const pr = ch.anims.clips[ch.clipName]?.notifies?.[e?.notify]?.props || e?.props || {};
    const f = ch.forward?.();
    if (pr.LocationOffset && f) { const o = pr.LocationOffset; p.x += (f.x * o.X - f.z * o.Y) / 100; p.z += (f.z * o.X + f.x * o.Y) / 100; p.y += o.Z / 100; }
    if (sys.ground) this.toGround(p, ch);
    this.burst(name, p, pr.Scale?.X ?? 1, { ch, socket, fwd: f });
  }

  runInterval(who, ch, e, name, socket, bones, dt, idx) {
    const sys = this.d.systems[name];
    if (!sys) return;
    if (sys.kind === "ribbon") {
      // ribbon systems may list sub-ribbons (GunYing + refraction/heat-distortion emitters)
      for (const sub of sys.ribbons || [sys]) {
        const rb = this.ribbonFor(who, sub === sys ? name : `${name}.${sub.emitter}`, sub);
        rb.seen = true; rb.ends = this.trailEnds(ch, e) || bones;
      }
    } else if (sys.kind === "spray") this.spray(ch, bones, sys, dt);
    else if (sys.kind === "fx" && sys.timed) {
      const key = `${who}:${ch.cur.stamp}:${idx}`;
      let inst = this.live.find((x) => x.key === key);
      if (!inst) {
        const p = (socket && ch.bonePos(socket, _c)) || _c.copy(ch.position);
        if (sys.ground) this.toGround(p, ch);
        inst = this.burst(name, p, 1, { ch, socket, fwd: ch.forward?.() });
        if (inst) inst.key = key;
      }
      if (inst) inst.alive = true;
    }
  }

  /** notify classes outside the `vfx` events (see NOTIFY_FX), crossed / active on the current montage */
  pollNotifies(who, ch, actor) {
    const c = ch.cur;
    (this._activeNotify ||= {})[who] = [];
    if (!c?.meta?.notifies) return;
    let st = this.notifyFired.get(ch);
    if (!st || st.stamp !== c.stamp) { st = { stamp: c.stamp, set: new Set() }; this.notifyFired.set(ch, st); }
    const wrapped = c.prev > c.time;
    if (wrapped) st.set.clear();
    c.meta.notifies.forEach((nf, i) => {
      if (!NOTIFY_FX.has(nf.class)) return;
      const at = nf.start ?? 0, end = nf.end ?? at;
      const crossed = !st.set.has(i) && c.time >= at && (c.prev <= at || wrapped);
      const pr = nf.props || {};
      if (nf.class === "BANS_GSTimedPlayNiagaraFX_WithCondition") {
        if (c.time >= at && c.time < end && this.condition(pr.Condition, actor, ch))
          this._activeNotify[who].push({ e: { notify: i }, name: shortName(pr.Template?.AssetPathName), socket: pr.SocketName, idx: i });
        return;
      }
      if (!crossed) return;
      st.set.add(i);
      switch (nf.class) {
        case "BAN_GSPlayNiagaraFX_WithCondition":
          if (this.condition(pr.Condition, actor, ch)) this.fireNotifySystem(shortName(pr.Template?.AssetPathName), pr.SocketName, ch, actor, nf);
          break;
        case "BAN_GSGhost": this.ghosts.spawn(ch, assetName(pr.GhostSettings?.ObjectName)); break;
        case "BAN_GSSpawnStaticMeshActor": this.post.trigger(assetName(pr.StaticMeshActorSetting?.ObjectName), ch); break;
        case "BAN_GSPlayAtkFXOnGround": this.groundHit(ch, pr); break;
      }
    });
  }

  /** BGW detect-condition list of the *_WithCondition notifies. HasBuff: the actor's buffs (tiger) or, for the
   * player, buff windows (BANS_GSAddBuffByID) of the running montage; IsReverseCondition negates the result. */
  condition(cond, actor, ch) {
    if (!cond?.Conditions?.length) return true;
    const or = (cond.ConditionalRelation || "").endsWith("Or");
    const res = cond.Conditions.map((x) => {
      const t = (x.DetectedElementType || "").split("::").pop();
      if (t === "HasBuff") return this.hasBuff(actor, ch, x.BuffID);
      return false; // AbnormalState (burn/poison): never in this fight
    });
    const ok = or ? res.some(Boolean) : res.every(Boolean);
    return cond.IsReverseCondition ? !ok : ok;
  }

  hasBuff(actor, ch, id) {
    if (actor.hasBuff) return actor.hasBuff(String(id));
    const t = ch.clipTime;
    return (ch.cur?.meta?.notifies || []).some((n) => n.class === "BANS_GSAddBuffByID" && n.props?.BuffID === id && t >= n.start && t < (n.end ?? n.start));
  }

  /** BAN_GSPlayAtkFXOnGround: ground impact at the socket's ground point (LineTraceHeight cm down), ring radius
   * HitFXRadiusMin -> HitFXRadiusMax (cm) over HitFXRadiusExpandTime; SkillEffectID picks the surface FX table row */
  groundHit(ch, pr) {
    const p = ch.bonePos(pr.SocketName, _c);
    if (!p) return;
    const gnd = this.game.world.groundAt(p.x, p.z, p.y + 0.5, (pr.LineTraceHeight ?? 250) / 100 + 0.5);
    if (!gnd) return;
    p.y = gnd.point.y;
    const rMax = (pr.HitFXRadiusMax ?? 125) / 100, rMin = (pr.HitFXRadiusMin ?? 0) / 100;
    const sys = this.d.systems.groundHit;
    if (!Array.isArray(sys?.emitters)) return;
    for (const em of sys.emitters) this.prep(em);
    const ring = sys.emitters.find((e) => e.emitter === "ring");
    if (ring) this.layers[ring.layer]?.spawn(p.x, p.y + 0.04, p.z, 0, 0, 0, { size: [Math.max(0.3, rMin * 2), rMax * 2], life: Math.max(0.35, pr.HitFXRadiusExpandTime ?? 0.2) * (ring.lifeMul ?? 1.6), color: ring.color, alpha: ring.alpha ?? 0.7, alphaCurve: ring._alphaCurve });
    const k = Math.max(0.6, rMax / 1.25) * (pr.SkillEffectID === 99 ? 0.8 : 1);
    for (const em of sys.emitters) if (em !== ring) this.emitN(em, Math.round(em.count * k), p, k, { ch });
  }

  /** focus (棍势) level-up: FUStPotentialEnergyConfigDesc PELevelConfig -> DBC_XuLi_Baofa_<lv> plays
   * NG_WuKong_XuLiGun_Levelup_0<lv> on the staff (alias system `focusLevelUp`: levels[]); fired along the staff
   * whenever player.focus crosses the next threshold. The weapon emissive layer (ML_Emissive_JGB) is not reproduced. */
  focusGlow(player) {
    const lv = player.focusLevels ? player.focusLevels.filter((l) => player.focus >= l.threshold).length : 0;
    const alias = this.d.systems.focusLevelUp;
    if (lv > this.focusLevel && alias?.levels && player.state !== "dead") {
      const ch = player.ch, name = alias.levels[Math.min(lv, alias.levels.length) - 1];
      const a = ch.bonePos(PLAYER_TRAIL_FALLBACK[0]), b = ch.bonePos(PLAYER_TRAIL_FALLBACK[1]);
      if (a && b) for (let i = 0; i <= 6; i++) this.burst(name, a.clone().lerp(b, i / 6), 1, { ch });
    }
    this.focusLevel = lv;
  }

  /** the notify's own trail sockets (OverrideSKMSockets, e.g. FX_Weapon_Trail_01..09 on the staff): the game's
   * ribbon spans the first..last listed socket, so its width differs per attack */
  trailEnds(ch, e) {
    if (e._ends === undefined) {
      const s = ch.anims.clips[ch.clipName]?.notifies?.[e.notify]?.props?.OverrideSKMSockets;
      e._ends = s?.length >= 2 ? [s[0], s[s.length - 1]] : null;
    }
    return e._ends;
  }

  ribbonFor(who, name, sys) {
    const key = `${who}:${name}`;
    let rb = this.ribbons.get(key);
    if (!rb) {
      rb = new Ribbon(this.game.r.scene, this.tex[sys.texture], { mode: sys.mode, blend: sys.blend, tint: sys.tint, life: sys.life,
        gain: sys.gain, tileU: sys.tileU, mask: sys.mask, curve: sys.alphaCurve, distort: sys.distort, maskTex: this.tex[sys.maskTexture] ?? null, screen: this.screen });
      if (sys.mode === "distort") this.screen.users.push(rb.mesh.material.uniforms.uScreen);
      this.ribbons.set(key, rb);
    }
    return rb;
  }

  spray(ch, bones, sys, dt) {
    const a = ch.bonePos(bones[0], _a), b = ch.bonePos(bones[1], _b);
    if (!a || !b) return;
    const n = Math.random() < (sys.rate ?? 30) * dt ? 1 : 0;
    for (let i = 0; i < n; i++) {
      _c.copy(a).lerp(b, Math.random());
      this.layers.liquid.spawn(_c.x, _c.y, _c.z, rand(-1, 1), rand(-0.5, 1), rand(-1, 1),
        { size: [0.5, 1.2], life: 0.55, color: sys.tint, gravity: 8, frames: 64 });
    }
  }

  /** trauma from a shake class name (levels in vfx.json), attenuated with distance from the player */
  shake(cls, from) {
    const lv = this.d.cameraShake.levels;
    const key = Object.keys(lv).find((k) => k !== "default" && (cls || "").includes(k)) || "default";
    let amt = lv[key];
    if (from) amt *= Math.max(0.25, 1 - from.distanceTo(this.game.player.ch.position) / 30);
    this.trauma = Math.min(1, this.trauma + amt);
  }

  /** camera offset (trauma^2 model); call after the orbit camera has been placed */
  applyShake(camera) {
    const t = this.trauma * this.trauma;
    if (t <= 1e-4) return;
    const k = this.shakeT * 38;
    const ox = (Math.sin(k * 1.13) + Math.sin(k * 2.71) * 0.5) * 0.12 * t;
    const oy = (Math.sin(k * 1.37 + 1.3) + Math.sin(k * 3.1) * 0.5) * 0.10 * t;
    camera.getWorldQuaternion(_q);
    camera.position.add(_c.set(ox, oy, 0).applyQuaternion(_q));
  }

  clear() {
    for (const l of this.layerList) { l.n = 0; l.geo.instanceCount = 0; }
    for (const rb of this.ribbons.values()) { rb.count = 0; rb.geo.setDrawRange(0, 0); }
    this.live.length = 0;
    this.ghosts.clear(); this.post.clear(); this.arcs.clear(); this.game.stoneFx.clear();
    this.trauma = 0; this.focusLevel = 0;
  }
}
