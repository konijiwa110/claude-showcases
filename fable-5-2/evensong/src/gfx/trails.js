// Effects: the ribbon a blade leaves in the air.
//
// Every step the blade's two ends (weapon.base, weapon.tip: Object3D) are sampled in the world. The samples are
// joined by a smooth curve (a swing is an arc, sixty samples a second would draw a polygon), and the ribbon is
// drawn from the blade back along its own path: a hot line where the tip went, a wash thinning toward the hilt,
// threads of light that hang where the blade passed and tear away as they fade.
//
// How much of a ribbon there is follows how fast the tip moves, so a blade carried at a walk draws nothing and a
// cut draws its whole arc, with no switch to flip. start() and stop() are there for owners who want to say when.
//
// The same samples tell where a blade cuts the water's surface and how fast that point runs (trail.dip): vfx.js
// throws spray there.
//
// Not part of the contract beyond vfx.trail(weapon, opts): other modules use ctx.vfx (src/gfx/vfx.js).
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { GLSL_OUT, PREMULTIPLIED } from './fx_common.js';

const MAX = 72, SUB = 4, CROSS = (MAX - 1) * SUB + 1;
const _b = new THREE.Vector3(), _t = new THREE.Vector3();
const TAIL_TINT = new THREE.Color(1.0, 0.62, 0.42);

const VERT = /* glsl */`
attribute vec4 aI;     // birth time, across (0 hilt side .. 1 tip), strength, metres along the path
varying vec4 vI;
void main() { vI = aI; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`;

const FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform float uTime, uLife, uGlow, uEdge, uEdgeW, uBody, uReach, uStreak, uThreads, uWidth, uSeed, uUnder, uUnderW;
uniform vec3 uHead, uTail;
varying vec4 vI;
void main() {
  float age = (uTime - vI.x) / uLife;
  if (age >= 1.0 || age < 0.0) discard;
  float v = vI.y, along = 1.0 - age, in_ = (1.0 - v) * uWidth;                  // how far in from the tip, in blade lengths
  // where the tip itself went: a thin hot line, and the glow just inside it
  float line = exp(-in_ * in_ / (uEdgeW * uEdgeW));
  float under = uUnder * exp(-in_ / (uEdgeW * uUnderW));
  // threads of light left hanging where the blade passed: they run along the path
  float n = texture2D(tNoise, vec2(in_ * uThreads + uSeed, vI.w * 0.06)).b;
  float n2 = texture2D(tNoise, vec2(in_ * uThreads * 2.7 + 0.37, vI.w * 0.15 + uSeed)).b;
  float threads = 1.5 * smoothstep(0.42, 0.8, n) + 0.8 * smoothstep(0.55, 0.9, n2);
  float body = exp(-in_ / uReach) * mix(1.0, 0.05 + threads, uStreak);
  float worn = smoothstep(0.15, 1.0, age) * 1.15;                                // the tail tears rather than dims
  float tear = smoothstep(worn - 0.12, worn + 0.3, n * 0.65 + n2 * 0.35 + along * 0.62);
  // the line follows the blade's speed as it is; the glow and the wash behind it follow its square, so the slow turn
  // at the start of a cut (where a pivoting blade folds its own ribbon over itself) leaves a line and no sheet
  float i = (line * uEdge * pow(along, 1.3) + (under * uEdge * along * along + body * uBody * along * along * along) * vI.z) * tear;
  i *= smoothstep(0.0, 0.08, v);
  vec3 col = mix(uTail, uHead, along * along);
  gl_FragColor = vec4(col * (i * vI.z * uGlow), 0.0);
  ${GLSL_OUT}
}`;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// A cubic B-spline through four neighbouring samples: it does not pass exactly through them, it rounds them. A clip
// is keyed thirty times a second, so the tip's true path has a small corner at every key; a curve that went through
// every sample would keep the corners.
const cr = (p0, p1, p2, p3, t) => { const u = 1 - t, t2 = t * t, t3 = t2 * t; return (u * u * u * p0 + (3 * t3 - 6 * t2 + 4) * p1 + (-3 * t3 + 3 * t2 + 3 * t + 1) * p2 + t3 * p3) / 6; };

/** The two looks the fight uses. Everything here can be overridden through vfx.trail(weapon, opts). */
export const TRAIL_LOOKS = {
  // the pilgrim's: thin and cool, the line his point draws and very little behind it (a wash here reads as a sheet of glass on a dark picture)
  pilgrim: { color: 0xcfe2ff, tail: 0x6f93e6, width: 0.3, life: 0.17, glow: 1.2, edge: 2.3, edgeW: 0.02, under: 0.12, underW: 3, body: 0.07, reach: 0.07, streak: 0.7, threads: 4, speed: [6.5, 13], motes: 0 },
  // the Cantor's: wide and pale gold, threads of light hanging where five metres of blade went by
  cantor: { color: 0xfff0c8, tail: 0xffa040, width: 0.6, life: 0.45, glow: 1.8, edge: 2.6, edgeW: 0.011, under: 0.16, underW: 7, body: 0.25, reach: 0.17, streak: 1.0, threads: 5, speed: [12, 24], motes: 26 },
};

export class Trail {
  /**
   * @param ctx     the game's context
   * @param noise   the shared noise texture
   * @param weapon  { base, tip } (Object3D on the blade)
   * @param opts    { color, tail, width (share of the blade the ribbon may cover, from the tip), life (s), glow,
   *                  edge (the line the tip draws), edgeW (its width), under and underW (the glow just inside the
   *                  line: its strength, and its reach as a multiple of edgeW), body (the wash behind it), reach (how far in
   *                  from the tip the wash goes), streak (how much the wash is threads, 0..1), threads (how many),
   *                  speed: [none below, full above] (m/s at the tip), motes (shed per second) }.
   *                  edgeW, reach and threads are in blade lengths, so a look stays the same whatever `width` is.
   */
  constructor(ctx, noise, weapon, opts = {}) {
    this.ctx = ctx; this.weapon = weapon; this.o = Object.assign({}, TRAIL_LOOKS.pilgrim, opts);
    if (opts.color !== undefined && opts.tail === undefined) this.o.tail = null;
    this.manual = false; this.on = false; this.boost = 1;
    // samples, oldest first, in a ring
    this.s = new Float32Array(MAX * 9);               // tip xyz, base xyz, time, strength, distance
    this.first = 0; this.count = 0; this.dist = 0; this.fresh = true; this.prevG = 0; this.speed = 0; this.changed = false; this.run = 0;
    this.pTip = new THREE.Vector3(); this.pBase = new THREE.Vector3(); this.tip = new THREE.Vector3(); this.base = new THREE.Vector3();
    this.dip = { was: false, enter: false, x: 0, z: 0, vx: 0, vz: 0, speed: 0, travel: 0 }; this.length = 1;
    const geo = this.geometry = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(CROSS * 2 * 3), 3); this.pos.setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(CROSS * 2 * 4), 4); this.info.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos); geo.setAttribute('aI', this.info);
    const idx = new Uint16Array((CROSS - 1) * 6);
    for (let i = 0; i < CROSS - 1; i++) { const a = i * 2, o = i * 6; idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 3; idx[o + 3] = a; idx[o + 4] = a + 3; idx[o + 5] = a + 2; }
    geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.setDrawRange(0, 0);
    this.material = Object.assign(new THREE.ShaderMaterial({
      name: 'fx.trail',
      uniforms: {
        tNoise: { value: noise }, uTime: { value: 0 }, uLife: { value: 0.3 }, uGlow: { value: 1 }, uEdge: { value: 1 }, uEdgeW: { value: 0.1 }, uBody: { value: 0.5 },
        uReach: { value: 0.15 }, uStreak: { value: 0.5 }, uThreads: { value: 4 }, uWidth: { value: 0.5 }, uSeed: { value: 0.37 }, uUnder: { value: 0.3 }, uUnderW: { value: 7 }, uHead: { value: new THREE.Color() }, uTail: { value: new THREE.Color() },
      },
      vertexShader: VERT, fragmentShader: FRAG,
    }), PREMULTIPLIED);
    const mesh = this.mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'fx.trail'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = 15; mesh.visible = false;
    this.apply();
    // what the owner holds
    this.handle = { start: () => { this.manual = true; this.on = true; }, stop: () => { this.manual = true; this.on = false; }, set: (o) => this.set(o), trail: this };
  }

  /** Change the look: any of the options. A new colour without a tail colour gets a warmer, deeper tail of its own. */
  set(o) { Object.assign(this.o, o); if (o.color !== undefined && o.tail === undefined) this.o.tail = null; this.apply(); }
  apply() {
    const u = this.material.uniforms, c = this.o;
    u.uHead.value.set(c.color); if (c.tail === null || c.tail === undefined) u.uTail.value.set(c.color).multiply(TAIL_TINT); else u.uTail.value.set(c.tail);
    u.uLife.value = c.life; u.uEdge.value = c.edge; u.uEdgeW.value = c.edgeW; u.uBody.value = c.body; u.uReach.value = c.reach; u.uStreak.value = c.streak; u.uThreads.value = c.threads; u.uWidth.value = Math.min(1, c.width);
    u.uUnder.value = c.under !== undefined ? c.under : 0.3; u.uUnderW.value = c.underW !== undefined ? c.underW : 7;
  }

  /** Once per step, after the fighters have moved. */
  update(time, dt) {
    const w = this.weapon, c = this.o, s = this.s;
    w.base.getWorldPosition(_b); w.tip.getWorldPosition(_t);
    this.length = _b.distanceTo(_t);
    this.tip.copy(_t); this.base.copy(_t).lerp(_b, Math.min(1, c.width));           // the share of the blade the ribbon covers
    if (this.fresh) { this.pTip.copy(this.tip); this.pBase.copy(this.base); this.fresh = false; }
    const step = this.tip.distanceTo(this.pTip), jumped = step > this.length * 2 + 2;   // put somewhere else at once
    this.speed = step / dt;
    let g = smooth(c.speed[0], c.speed[1], this.speed);
    if (this.manual) g = this.on ? Math.max(g, smooth(c.speed[0] * 0.3, c.speed[1] * 0.4, this.speed)) : 0;
    if (jumped) g = 0;
    while (this.count && time - s[this.first * 9 + 6] > c.life) { this.first = (this.first + 1) % MAX; this.count--; this.changed = true; }
    if (g > 0.01 || this.prevG > 0.01) {
      if (this.prevG <= 0.01) { this.push(this.pTip, this.pBase, time - dt, 0, 0); this.run = 0; }     // a run begins from nothing, where the blade just was
      // ... and comes in over a tenth of a second: a blade already at speed when its owner says start() would otherwise
      // begin its ribbon with a straight edge across the picture (the blade's own line at that instant)
      this.run += dt;
      this.push(this.tip, this.base, time, g * Math.min(1, this.run / 0.12), step);
    }
    this.prevG = g;
    // the water: where the blade crosses the surface, and how fast that point runs
    const d = this.dip, yb = _b.y - WATER_Y, yt = _t.y - WATER_Y, under = (yt < 0.015 || yb < 0.015) && !jumped;
    if (under) {
      const k = yt < 0.015 && yb < 0.015 ? 0.75 : Math.min(1, Math.max(0, yb / (Math.abs(yb - yt) > 1e-5 ? yb - yt : 1e-5)));
      const x = _b.x + (_t.x - _b.x) * k, z = _b.z + (_t.z - _b.z) * k;
      if (d.was) { d.vx = (x - d.x) / dt; d.vz = (z - d.z) / dt; d.speed = Math.hypot(d.vx, d.vz); d.enter = false; d.travel += d.speed * dt; }
      else { d.vx = d.vz = 0; d.speed = Math.max(0, (this.pTip.y - this.tip.y) / dt); d.enter = true; d.travel = 0; }
      d.x = x; d.z = z; d.was = true;
    } else { d.was = false; d.enter = false; d.speed = 0; }
    this.pTip.copy(this.tip); this.pBase.copy(this.base);
    if (this.changed) { this.changed = false; this.build(); }
  }

  push(tip, base, time, strength, step) {
    const s = this.s;
    if (this.count === MAX) { this.first = (this.first + 1) % MAX; this.count--; }
    const o = ((this.first + this.count) % MAX) * 9;
    this.dist += step;
    s[o] = tip.x; s[o + 1] = tip.y; s[o + 2] = tip.z; s[o + 3] = base.x; s[o + 4] = base.y; s[o + 5] = base.z; s[o + 6] = time; s[o + 7] = strength; s[o + 8] = this.dist;
    this.count++; this.changed = true;
  }

  put(c, tx, ty, tz, bx, by, bz, t, g, d) {
    const P = this.pos.array, I = this.info.array, p = c * 6, q = c * 8;
    P[p] = bx; P[p + 1] = by; P[p + 2] = bz; P[p + 3] = tx; P[p + 4] = ty; P[p + 5] = tz;
    I[q] = t; I[q + 1] = 0; I[q + 2] = g; I[q + 3] = d; I[q + 4] = t; I[q + 5] = 1; I[q + 6] = g; I[q + 7] = d;
  }

  /** The ribbon's vertices from the samples. */
  build() {
    const n = this.count, s = this.s;
    if (n < 2) { this.mesh.visible = false; this.geometry.setDrawRange(0, 0); return; }
    let c = 0;
    for (let i = 0; i < n - 1; i++) {
      const i0 = ((this.first + Math.max(0, i - 1)) % MAX) * 9, i1 = ((this.first + i) % MAX) * 9, i2 = ((this.first + i + 1) % MAX) * 9, i3 = ((this.first + Math.min(n - 1, i + 2)) % MAX) * 9;
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB;
        this.put(c++, cr(s[i0], s[i1], s[i2], s[i3], t), cr(s[i0 + 1], s[i1 + 1], s[i2 + 1], s[i3 + 1], t), cr(s[i0 + 2], s[i1 + 2], s[i2 + 2], s[i3 + 2], t),
          cr(s[i0 + 3], s[i1 + 3], s[i2 + 3], s[i3 + 3], t), cr(s[i0 + 4], s[i1 + 4], s[i2 + 4], s[i3 + 4], t), cr(s[i0 + 5], s[i1 + 5], s[i2 + 5], s[i3 + 5], t),
          s[i1 + 6] + (s[i2 + 6] - s[i1 + 6]) * t, s[i1 + 7] + (s[i2 + 7] - s[i1 + 7]) * t, s[i1 + 8] + (s[i2 + 8] - s[i1 + 8]) * t);
      }
    }
    const l = ((this.first + n - 1) % MAX) * 9;
    this.put(c++, s[l], s[l + 1], s[l + 2], s[l + 3], s[l + 4], s[l + 5], s[l + 6], s[l + 7], s[l + 8]);
    this.pos.needsUpdate = true; this.info.needsUpdate = true;
    this.geometry.setDrawRange(0, (c - 1) * 6);
    this.mesh.visible = true;
  }

  /** A place on the fading ribbon (for motes shed from it). `k` 0..1 picks how far back, `across` where on the blade. */
  pick(k, across, out) {
    const n = this.count; if (n < 3) return false;
    const o = ((this.first + Math.min(n - 1, Math.floor(k * n))) % MAX) * 9, s = this.s;
    if (s[o + 7] < 0.2) return false;
    out.set(s[o + 3] + (s[o] - s[o + 3]) * across, s[o + 4] + (s[o + 1] - s[o + 4]) * across, s[o + 5] + (s[o + 2] - s[o + 5]) * across);
    return true;
  }

  frame(time, glow = 1) { const u = this.material.uniforms; u.uTime.value = time; u.uGlow.value = this.o.glow * glow * this.boost; }
  rebase(by) { const s = this.s; for (let o = 6; o < s.length; o += 9) s[o] -= by; this.changed = true; }
  clear() { this.count = 0; this.first = 0; this.prevG = 0; this.fresh = true; this.dip.was = false; this.mesh.visible = false; this.geometry.setDrawRange(0, 0); }
  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}
