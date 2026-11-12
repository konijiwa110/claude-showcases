// Effects: what every effect file shares. A repeatable random source, one small tiling noise texture (made here, in
// code), the scene's lights gathered into uniforms so that spray, mist, dust and moths are lit by the same moon,
// candles and lantern as everything else, and the few lines of GLSL every effect shader ends with.
//
// Nothing here is part of the contract: other modules use ctx.vfx (src/gfx/vfx.js) only.
import * as THREE from 'three';

/** A repeatable random source (mulberry32): effects look the same on every run. */
export class Rng {
  constructor(seed = 1) { this.s = seed >>> 0; }
  next() { let t = (this.s += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  /** a..b */
  range(a, b) { return a + (b - a) * this.next(); }
  /** -1..1 */
  signed() { return this.next() * 2 - 1; }
}

const hash = (n) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

// ---------------------------------------------------------------------------------------------------------------
// The noise texture: 256 x 256, tiling in both directions, four different noises in its four channels.
//   r  soft cloud (fbm)                      puffs, mist
//   g  wisps (ridged, warped)                torn edges, erosion
//   b  streaks running along v (the y axis)  sheets of water, trails, curtains of light
//   a  speckle (scattered soft dots)         droplets inside a sheet, sparkle
let noisePixels = null;

function buildNoise(N = 256) {
  const px = new Uint8Array(N * N * 4);
  const lattice = (w, h, seed) => { const a = new Float32Array(w * h); for (let i = 0; i < a.length; i++) a[i] = hash(i * 31 + seed * 7919 + 17); return a; };
  const q = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  // value noise on a w x h lattice that wraps: x, y in 0..1 over the whole texture
  const sample = (a, w, h, x, y) => {
    const fx = x * w, fy = y * h, xi = Math.floor(fx), yi = Math.floor(fy), u = q(fx - xi), v = q(fy - yi);
    const x0 = ((xi % w) + w) % w, x1 = (x0 + 1) % w, y0 = ((yi % h) + h) % h, y1 = (y0 + 1) % h;
    const p = a[y0 * w + x0], r = a[y0 * w + x1], s = a[y1 * w + x0], t = a[y1 * w + x1];
    return p + (r - p) * u + (s - p + (p - r - s + t) * u) * v;
  };
  const cloud = [4, 8, 16, 32, 64].map((p, i) => lattice(p, p, 1 + i));
  const ridge = [4, 8, 16, 32, 64].map((p, i) => lattice(p, p, 11 + i));
  const warp = [lattice(4, 4, 21), lattice(4, 4, 22), lattice(8, 8, 23), lattice(8, 8, 24)];
  const streak = [[16, 2], [32, 3], [64, 6], [128, 12]].map((p, i) => lattice(p[0], p[1], 31 + i));
  // speckle: one soft dot in each cell of two grids
  const cells = [20, 44].map((n, k) => { const a = new Float32Array(n * n * 4); for (let i = 0; i < n * n; i++) { a[i * 4] = hash(i * 4 + k * 977 + 1); a[i * 4 + 1] = hash(i * 4 + k * 977 + 2); a[i * 4 + 2] = 0.12 + 0.3 * hash(i * 4 + k * 977 + 3); a[i * 4 + 3] = hash(i * 4 + k * 977 + 4) > 0.35 ? 0.35 + 0.65 * hash(i * 4 + k * 977 + 5) : 0; } return { n, a }; });
  const f = new Float32Array(N * N * 4);
  const lo = [1e9, 1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9, -1e9];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N, y = (j + 0.5) / N, o = (j * N + i) * 4;
    let c = 0, w = 0.5; for (let k = 0; k < 5; k++) { c += w * sample(cloud[k], 4 << k, 4 << k, x, y); w *= 0.5; }
    const wx = x + 0.07 * (sample(warp[0], 4, 4, x, y) - 0.5) + 0.03 * (sample(warp[2], 8, 8, x, y) - 0.5);
    const wy = y + 0.07 * (sample(warp[1], 4, 4, x, y) - 0.5) + 0.03 * (sample(warp[3], 8, 8, x, y) - 0.5);
    let r = 0; w = 0.5; for (let k = 0; k < 5; k++) { const n = 1 - Math.abs(2 * sample(ridge[k], 4 << k, 4 << k, wx, wy) - 1); r += w * n * n; w *= 0.55; }
    let s = 0; w = 0.5; const sp = [[16, 2], [32, 3], [64, 6], [128, 12]];
    for (let k = 0; k < 4; k++) { s += w * sample(streak[k], sp[k][0], sp[k][1], x + 0.02 * (c - 0.5), y); w *= 0.6; }
    let d = 0;
    for (const g of cells) {
      const n = g.n, cx = Math.floor(x * n), cy = Math.floor(y * n);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ix = (((cx + dx) % n) + n) % n, iy = (((cy + dy) % n) + n) % n, e = (iy * n + ix) * 4;
        const px_ = (cx + dx + g.a[e]) / n, py_ = (cy + dy + g.a[e + 1]) / n, rad = g.a[e + 2] / n;
        const dist = Math.hypot(x - px_, y - py_) / rad;
        if (dist < 1) { const k = 1 - dist; d = Math.max(d, k * k * (3 - 2 * k) * g.a[e + 3]); }
      }
    }
    f[o] = c; f[o + 1] = r; f[o + 2] = s; f[o + 3] = d;
    for (let k = 0; k < 4; k++) { if (f[o + k] < lo[k]) lo[k] = f[o + k]; if (f[o + k] > hi[k]) hi[k] = f[o + k]; }
  }
  for (let o = 0; o < f.length; o += 4) for (let k = 0; k < 4; k++) px[o + k] = Math.max(0, Math.min(255, Math.round(255 * (f[o + k] - lo[k]) / (hi[k] - lo[k]))));
  return px;
}

/** The noise texture (a new texture object each call; the pixels are worked out once per page). */
export function makeNoiseTexture() {
  if (!noisePixels) noisePixels = buildNoise(256);
  const t = new THREE.DataTexture(noisePixels, 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; t.name = 'fx.noise';
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// The scene's lights, gathered once a step into uniforms. Effects that are lit rather than glowing (water thrown
// up, mist, dust, moths) use them, so a splash beside the lantern is warm on that side and the gold of phase two
// reaches the mist without anybody telling the effects about it.
export const MAX_LIGHTS = 12;
const _v = new THREE.Vector3(), _c = new THREE.Color();

export class LightProbe {
  constructor(ctx) {
    this.ctx = ctx;
    this.pos = new Float32Array(MAX_LIGHTS * 4);          // xyz, reach (0 = no limit)
    this.col = new Float32Array(MAX_LIGHTS * 4);          // colour x intensity
    this.count = 0;
    this.moonDir = new THREE.Vector3(0, 0.35, -0.94); this.moonCol = new THREE.Color(0.75, 0.83, 1.0); this.ambCol = new THREE.Color(0.1, 0.14, 0.22);
    this.fogCol = new THREE.Color(0.04, 0.07, 0.12); this.fogDensity = 0.018;
    this.points = []; this.moon = null; this.ambient = []; this.nextScan = 0; this.scans = 0;
    this.skip = null;                                     // one point light left out (effects' own flash: it must not light their own spray)
    this.uniforms = {
      uLPos: { value: this.pos }, uLCol: { value: this.col }, uLCount: { value: 0 },
      uMoonDir: { value: this.moonDir }, uMoonCol: { value: this.moonCol }, uAmbCol: { value: this.ambCol },
      uFogCol: { value: this.fogCol }, uFogDensity: { value: this.fogDensity },
      uMood: { value: new THREE.Vector2(1, 0) },          // gfx.mood: candle, gold
    };
    // The air between the eye and an effect. When the renderer offers its own (gfx.air: the height fog every lit
    // material gets), effects sink into exactly that; otherwise a plain distance fog from scene.fog.
    //   fxAir(eye, place)  rgb = light the air adds, a = how much of what is there is left
    //   fxMistCol()        what thick mist looks like here and now;  fxMoonGlow()  what it gains looking moonward
    const air = ctx.gfx && ctx.gfx.air;
    if (air && air.glsl && air.uniforms) {
      Object.assign(this.uniforms, air.uniforms);
      this.glsl = GLSL_LIGHTS + air.glsl + `
vec4 fxAir(vec3 eye, vec3 place) { return evAirBetween(eye, place); }
vec3 fxMistCol() { return evAir[1].rgb; }
vec3 fxMoonGlow() { return evAir[3].rgb; }
`;
    } else {
      this.glsl = GLSL_LIGHTS + `
vec4 fxAir(vec3 eye, vec3 place) { float f = uFogDensity * distance(eye, place); float k = exp(-f * f); return vec4(uFogCol * (1.0 - k), k); }
vec3 fxMistCol() { return uFogCol * 1.5; }
vec3 fxMoonGlow() { return uMoonCol * 0.012; }
`;
    }
    this._visit = (o) => {
      if (!o.isLight) return;
      if (o.isPointLight) this.points.push(o);
      else if (o.isDirectionalLight) { if (!this.moon || o.intensity > this.moon.intensity) this.moon = o; }
      else if (o.isHemisphereLight || o.isAmbientLight) this.ambient.push(o);
    };
  }
  /** Find the lights again (they are made by other modules after this one; their number does not change in play). */
  scan() { this.points.length = 0; this.ambient.length = 0; this.moon = null; this.ctx.scene.traverse(this._visit); this.scans++; }

  update(time) {
    const ctx = this.ctx, u = this.uniforms;
    if (time >= this.nextScan) { this.scan(); this.nextScan = time + (this.scans < 3 ? 0.5 : 6); }
    let n = 0;
    for (let i = 0; i < this.points.length && n < MAX_LIGHTS; i++) {
      const l = this.points[i];
      if (!(l.intensity > 1e-3) || !l.visible || l === this.skip || l.userData.noAir) continue;      // (noAir: a light that lights things, not the air: the rescue's light off the water)
      l.getWorldPosition(_v);
      const o = n * 4;
      this.pos[o] = _v.x; this.pos[o + 1] = _v.y; this.pos[o + 2] = _v.z; this.pos[o + 3] = l.distance || 0;
      this.col[o] = l.color.r * l.intensity; this.col[o + 1] = l.color.g * l.intensity; this.col[o + 2] = l.color.b * l.intensity; this.col[o + 3] = 1;
      n++;
    }
    this.count = n; u.uLCount.value = n;
    const mood = ctx.gfx && ctx.gfx.mood ? ctx.gfx.mood : null, gold = mood ? mood.gold : 0;
    u.uMood.value.set(mood ? mood.candle : 1, gold);
    if (this.moon) {
      const m = this.moon;
      _v.setFromMatrixPosition(m.matrixWorld); this.moonDir.setFromMatrixPosition(m.target.matrixWorld).sub(_v).negate();
      if (this.moonDir.lengthSq() < 1e-6) this.moonDir.set(0, 0.35, -0.94);
      this.moonDir.normalize();
      this.moonCol.copy(m.color).multiplyScalar(m.intensity);
    } else {
      if (ctx.arena && ctx.arena.moonDir) this.moonDir.copy(ctx.arena.moonDir);
      this.moonCol.setRGB(0.75 + 0.25 * gold, 0.83, 1.0 - 0.45 * gold).multiplyScalar(1.6);
    }
    if (this.ambient.length) {
      this.ambCol.setRGB(0, 0, 0);
      for (const a of this.ambient) {
        if (a.isHemisphereLight) { _c.copy(a.color).add(a.groundColor).multiplyScalar(0.5 * a.intensity); this.ambCol.add(_c); }
        else { _c.copy(a.color).multiplyScalar(a.intensity); this.ambCol.add(_c); }
      }
    } else this.ambCol.copy(this.moonCol).multiplyScalar(0.12);
    const fog = ctx.scene.fog;
    if (fog) { this.fogCol.copy(fog.color); this.fogDensity = fog.isFogExp2 ? fog.density : 1.6 / Math.max(10, fog.far || 100); }
    else { this.fogCol.copy(this.ambCol).multiplyScalar(0.35); this.fogDensity = 0.012; }
    u.uFogDensity.value = this.fogDensity;
  }
}

/** GLSL: the gathered lights. fxPoints(p) is the light arriving at a place from every point light (not the moon). Use probe.glsl, which adds the air. */
const GLSL_LIGHTS = /* glsl */`
#define FX_MAX_LIGHTS ${MAX_LIGHTS}
uniform vec4 uLPos[FX_MAX_LIGHTS];
uniform vec4 uLCol[FX_MAX_LIGHTS];
uniform int uLCount;
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uAmbCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec2 uMood;
/* the glow of hundreds of small flames on the water, for things that fly low over it (the candle lights themselves are few) */
vec3 fxCandleGlow(float y) { return vec3(1.0, 0.56, 0.23) * (uMood.x * exp(-max(y - 0.1, 0.0) / 0.9)); }
vec3 fxPoints(vec3 p) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < FX_MAX_LIGHTS; i++) {
    if (i >= uLCount) break;
    vec3 d = uLPos[i].xyz - p;
    float d2 = dot(d, d), att = 1.0 / (d2 + 0.08), reach = uLPos[i].w;
    if (reach > 0.0) { float q = d2 / (reach * reach); float w = clamp(1.0 - q * q, 0.0, 1.0); att *= w * w; }
    sum += uLCol[i].rgb * att;
  }
  return sum;
}
`;

/** GLSL: the last lines of every effect's fragment shader (tone mapping and output space, when drawing to the screen). */
export const GLSL_OUT = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/** Blending for effects that mix glow and veil in one draw: colour is already multiplied by alpha; alpha 0 = pure glow. */
export const PREMULTIPLIED = {
  transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

/** Per-pass facts a shader needs: the size of what is being drawn into, and whether the scene's depth can be used. */
const _size = new THREE.Vector2();
export function passInfo(renderer, camera, ctx, uniforms) {
  const rt = renderer.getRenderTarget();
  if (rt) uniforms.uRes.value.set(rt.width, rt.height); else { renderer.getDrawingBufferSize(_size); uniforms.uRes.value.copy(_size); }
  if (uniforms.uSoft) {
    const depth = ctx.gfx ? ctx.gfx.sceneDepth : null, main = camera === ctx.camera;
    if (depth && main && depth !== (rt && rt.depthTexture)) { uniforms.tDepth.value = depth; uniforms.uSoft.value = 1; uniforms.uNearFar.value.set(camera.near, camera.far); }
    else uniforms.uSoft.value = 0;
  }
}

let blankDepth = null;
/** A one-pixel stand-in for the scene's depth, bound while there is none. */
export function blankTexture() {
  if (!blankDepth) { blankDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType); blankDepth.needsUpdate = true; blankDepth.name = 'fx.blank'; }
  return blankDepth;
}
