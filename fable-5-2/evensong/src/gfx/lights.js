// The lights. Their number never changes after this is built (a change would recompile every shader):
//   - the moon: one directional light with a shadow over the whole hall (a fixed frustum, so the shadow of
//     anything that stands still never crawls), smooth filtering (shaders/chunks.js);
//   - a low ambient with a direction: the moonlit sky and haze light what faces the moon and the sky, and what
//     faces away from both gets almost nothing (the candles' warmth from below is in shaders/chunks.js, 4); and a
//     weak cool fill from the west with no shadow (what comes back off the far end of the hall);
//   - eight candle lights with no shadows, aimed by the candles' owner through setCandle();
//   - four lights for things that move: 'lantern', 'boss', and two 'flash'.
//   - one spot light, the rescue's lamp (src/cine/rescue_props.js): at nothing except while he is being rescued; and
//     `dim` (1 = as it is), which the rescue lowers to darken the hall round it.
import * as THREE from 'three';
import { decayFor } from './shaders/chunks.js';

const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);
// Phase two (the "Gold" entries: what each turns into as gfx.mood.gold rises) is a dark hall lit by HER: the moon and
// its shafts turn pale gold, and everything that is not a light source turns toward blue-violet, the colour that
// stands opposite her gold, so that her light is the only warm thing and the stone it does not reach stays deep
// and cool. (Gold mixed into the ambient, as it was first, made the whole hall olive.)
const C = {
  moon: rgb(0.72, 0.83, 1.0), moonGold: rgb(1.0, 0.86, 0.62),
  sky: rgb(0.074, 0.116, 0.226), skyGold: rgb(0.066, 0.070, 0.235),                    // what faces the moon and the sky
  ground: rgb(0.016, 0.024, 0.044), groundWarm: rgb(0.006, 0.003, 0.001), groundGold: rgb(0.012, 0.002, 0.036),   // what faces away
  fill: rgb(0.42, 0.58, 1.0), fillGold: rgb(0.50, 0.48, 1.0),
  candle: rgb(1.0, 0.56, 0.23), lantern: rgb(1.0, 0.62, 0.28), boss: rgb(1.0, 0.86, 0.58), flash: rgb(1.0, 0.92, 0.78),
};
const _v = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
const addScaled = (to, c, k) => { to.r += c.r * k; to.g += c.g * k; to.b += c.b * k; return to; };

export class Lights {
  /** @param gfx the Gfx being built (needs gfx.renderer, gfx.scene) */
  constructor(gfx, o = {}) {
    this.gfx = gfx; const r = this.renderer = gfx.renderer, scene = this.scene = gfx.scene;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = true;
    this.group = new THREE.Group(); this.group.name = 'lights'; scene.add(this.group);
    this.moonIntensity = 3.0; this.ambient = 1; this.candleGain = 1.25;
    this.moonGold = 0.8;                       // the moon's strength in phase two, as a share of phase one's (her light is the key then)

    const moon = this.moon = new THREE.DirectionalLight(C.moon, this.moonIntensity); moon.name = 'moon';
    moon.castShadow = true; moon.shadow.mapSize.set(o.shadowSize || 4096, o.shadowSize || 4096); moon.shadow.radius = 1.5;
    moon.shadow.autoUpdate = true;
    this.group.add(moon, moon.target);
    this.hemi = new THREE.HemisphereLight(C.sky, C.ground, 1); this.hemi.name = 'ambient'; this.group.add(this.hemi);
    // the fill: moonlight coming back off the west end and the sky behind the camera's usual place. No shadow. It is
    // what gives form to the sides of things that face away from the moon (which is most of what the player sees).
    this.fillIntensity = 0.2;
    const fill = this.fill = new THREE.DirectionalLight(C.fill, this.fillIntensity); fill.name = 'fill'; fill.position.set(0.3, 0.62, 1).normalize().multiplyScalar(30);
    this.group.add(fill, fill.target);

    // what the shadow has to cover: the hall, generously
    this.box = new THREE.Box3(new THREE.Vector3(-21, -0.3, -31), new THREE.Vector3(21, 27, 25));
    this.moonDir = new THREE.Vector3(0, 13.3, -35.5).normalize();
    this.fit(this.moonDir);

    // candle lights: where they are and how bright is the candles owner's business
    this.pool = 8; this.candles = []; this.candleBase = new Float32Array(this.pool);
    for (let i = 0; i < this.pool; i++) { const l = new THREE.PointLight(C.candle, 0, 10, decayFor(0.3)); l.name = 'candle' + i; l.position.set(0, 0.4, 0); this.candles.push(l); this.group.add(l); }
    // lights for things that move
    // (the last number is the square of the light's size in metres: a lantern hangs a hand from a cloak and must not bleach it)
    const make = (name, color, distance, size2) => { const l = new THREE.PointLight(color, 0, distance, decayFor(size2)); l.name = name; l.position.set(0, 1, 0); this.group.add(l); return l; };
    // Her light stands for the whole fan of pipes (eight metres across) and hangs right behind her shoulders, so it
    // is a large soft source, 5.5 m: her own veil and pipes, a metre from it, take four times what a pier 13 m away
    // does, not forty times. It reaches 24 m (32 m put gold on every pier of the hall and left no stone for the
    // night's blue).
    this.managed = { lantern: [make('lantern', C.lantern, 11, 0.9)], boss: [make('boss', C.boss, 24, 30)], flash: [make('flash0', C.flash, 16, 0.2), make('flash1', C.flash, 16, 0.2)] };
    // ... and it is the key light of phase two: what its owner sets is multiplied by this (a larger, softer light gives
    // less close by than the point it replaced; and at the boss owner's 70 the piers, 13 m from the middle of the nave,
    // took as much of the night's blue as of her gold and came out grey).
    this.bossGain = 2.0;
    { const l = this.managed.boss[0], self = this; let own = l.intensity; Object.defineProperty(l, 'intensity', { get() { return own * self.bossGain; }, set(v) { own = v; }, enumerable: true, configurable: true }); }
    this.given = { lantern: 0, boss: 0, flash: 0 };
    // the rescue's lamp: a narrow stage spot high over him (made now, at nothing, so no shader changes when it comes on)
    const spot = this.spot = new THREE.SpotLight(C.flash, 0, 0, 0.09, 0.2, 2); spot.name = 'spot'; spot.castShadow = false;
    this.group.add(spot, spot.target);
    this.dim = 1;

    // a one-triangle "scene": drawing it gives three a live render state, inside which the shadow map can be drawn
    // on its own (see refreshShadow)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.trigger = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false, fog: false }));
    this.trigger.frustumCulled = false; this.triggerCam = new THREE.Camera();
    this.tiny = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.shadowLights = [moon]; this.viewCamera = null;
    this.trigger.onBeforeRender = () => { if (this.viewCamera) r.shadowMap.render(this.shadowLights, this.scene, this.viewCamera); };
    this.update(gfx.mood);
  }

  /** Aim the moon along `dir` (toward the moon) and fit its shadow to the hall. */
  fit(dir) {
    this.moonDir.copy(dir).normalize();
    const m = this.moonDir, moon = this.moon, cam = moon.shadow.camera, b = this.box;
    // the shadow camera's axes: it looks along -m with the world's up
    _x.set(0, 1, 0).cross(m); if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0); _x.normalize(); _y.copy(m).cross(_x).normalize();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      const x = _v.dot(_x), y = _v.dot(_y), z = _v.dot(m);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const size = moon.shadow.mapSize.x, half = Math.max(x1 - x0, y1 - y0) / 2, texel = (2 * half) / size;
    const hx = Math.ceil(half / texel) * texel, cx = Math.round(((x0 + x1) / 2) / texel) * texel, cy = Math.round(((y0 + y1) / 2) / texel) * texel;   // on the texel grid
    const near = 1, depth = z1 - z0 + 4;
    moon.target.position.set(0, 0, 0).addScaledVector(_x, cx).addScaledVector(_y, cy).addScaledVector(m, z0 - 2);
    moon.position.copy(moon.target.position).addScaledVector(m, depth + near);
    cam.left = -hx; cam.right = hx; cam.top = hx; cam.bottom = -hx; cam.near = near; cam.far = near + depth; cam.updateProjectionMatrix();
    moon.shadow.bias = -0.012 / depth; moon.shadow.normalBias = 0.012;
    this.texel = texel; this.depth = depth;
    moon.updateMatrixWorld(); moon.target.updateMatrixWorld();
    // the ambient's "up": between the sky and the moon, so that faces turned east and upward are the light ones
    const hl = Math.hypot(m.x, m.z) || 1; this.hemi.position.set((m.x / hl) * 0.67, 0.74, (m.z / hl) * 0.67); this.hemi.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** The size of the moon's shadow map (a side, in texels): 4096 on high, 2048 below. No shader changes. */
  setShadowSize(size) { if (this.moon.shadow.mapSize.x !== size) { this.moon.shadow.mapSize.set(size, size); this.fit(this.moonDir); } }

  /** Candle light i (0..pool-1) to a place and a brightness (about 4 for a cluster of a dozen flames; 0 = off). */
  setCandle(i, x, y, z, intensity) {
    const l = this.candles[i]; if (!l) return;
    l.position.set(x, y, z); this.candleBase[i] = intensity > 0 ? intensity : 0;
    l.intensity = this.candleBase[i] * this.candleScale;
  }

  /** A light for something that moves: 'lantern' | 'boss' | 'flash'. They were made when the renderer was built. */
  add(kind) {
    const list = this.managed[kind] || this.managed.flash, k = this.managed[kind] ? kind : 'flash';
    const l = list[this.given[k] % list.length]; this.given[k]++;
    return l;
  }

  /** Once a frame: colours and strengths that follow the mood. */
  update(mood) {
    const c = Math.min(1, Math.max(0, mood.candle)), g = Math.min(1, Math.max(0, mood.gold)), dim = this.dim;
    this.moon.color.copy(C.moon).lerp(C.moonGold, g); this.moon.intensity = this.moonIntensity * (1 - (1 - this.moonGold) * g) * dim;
    this.fill.color.copy(C.fill).lerp(C.fillGold, g); this.fill.intensity = this.fillIntensity * (1 - 0.3 * g) * dim;
    this.hemi.color.copy(C.sky).lerp(C.skyGold, g);
    addScaled(addScaled(this.hemi.groundColor.copy(C.ground), C.groundWarm, c), C.groundGold, g);
    this.hemi.intensity = this.ambient * dim;
    this.candleScale = (0.35 + 0.65 * c) * this.candleGain * dim;
    for (let i = 0; i < this.pool; i++) this.candles[i].intensity = this.candleBase[i] * this.candleScale;
  }

  /**
   * Draw the moon's shadow map now, for `camera`'s layers, without drawing the scene. Called once at the start of a
   * frame, before the hooks, so that the water's mirror pass and the scene pass share one fresh map.
   */
  refreshShadow(camera) {
    const r = this.renderer;
    r.shadowMap.needsUpdate = true;
    if (this.scene.matrixWorldAutoUpdate) this.scene.updateMatrixWorld();      // (gfx.render has done it for the whole frame already)
    this.viewCamera = camera;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.tiny); r.render(this.trigger, this.triggerCam); r.setRenderTarget(prev);
    this.viewCamera = null;
    r.shadowMap.needsUpdate = false;
  }

  /** The moon's shadow map (a depth texture to sample with sampler2DShadow) and its matrix, for the light shafts. */
  get shadowMap() { const m = this.moon.shadow.map; return m ? m.depthTexture : null; }
  get shadowMatrix() { return this.moon.shadow.matrix; }

  dispose() {
    this.scene.remove(this.group);
    for (const l of [this.moon, this.fill, this.hemi, ...this.candles, ...this.managed.lantern, ...this.managed.boss, ...this.managed.flash, this.spot]) { if (l.parent) l.parent.remove(l); l.dispose(); }
    this.trigger.geometry.dispose(); this.trigger.material.dispose(); this.tiny.dispose();
  }
}
