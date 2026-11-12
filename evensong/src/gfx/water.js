// The water: 7 cm of black water over the nave floor. A true mirror (water_mirror.js), a ripple field
// (water_ripples.js) and the surface that puts them together (water_surface.js).
//
// The contract (docs/engine.md, "Water"):
//   water.ripple(x, z, strength = 1, radius = 0.4)   a ring starts here (a step 0.3, a roll 0.8, the great blade 2 to 4);
//                                                    radius is the size of what struck the water
//   water.wake(x0, z0, x1, z1, strength = 1, radius = 0.35)   a line disturbance (a blade dragged through, a wave)
//   water.heightAt(x, z)                             the surface's height above rest, for floating things (metres, small)
//   water.update(dt), water.dispose()
// and beyond it (docs/modules/water.md):
//   water.sample(x, z, out)        out.h as heightAt, out.fx, out.fz: how hard passing rings shove a floating thing (m/s)
//   water.calm()                   still water at once (after a cut in a cutscene, a restart)
//   water.tune                     the look, as numbers (see TUNE below); &water=key:value,key:value sets them from the address
//
// The water disturbs itself from what happens, so nobody has to remember to: it listens to the bus (step, roll, land,
// boss-slam, hit, clash) and follows both fighters' feet, hips and blades every step, ringing where they enter the
// water and laying wakes where they move through it.
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { hash } from '../core/math.js';
import { Mirror } from './water_mirror.js';
import { Ripples } from './water_ripples.js';
import { makeWaterMaterial, waterUniforms } from './water_surface.js';

export const ASSETS = {};

const TUNE = {
  mirror: 1,          // 0 switches the reflection pass off (to measure it)
  mscale: 0,          // the mirror's size as a share of the picture's (0 = what the quality level says)
  msamples: -1,       // the mirror's multisampling (-1 = what the quality level says)
  every: 0,           // draw the mirror every so many frames (0 = what the quality level says: 2 on 'low', else 1)
  f0: 0.12,           // how much the water mirrors when you look straight down into it
  fpow: 3.5,          // how quickly it turns to a full mirror toward a glancing angle
  through: 0.07,      // the share of the floor's light that comes up through it where you look straight down (it falls away fast toward a glancing angle)
  contact: 0.6,       // strength of the dark line where water meets stone
  swell: 0.003,       // slope of the slow breathing
  fine: 0.0024,       // slope of the faint fine ripple
  gleam: 1.0,         // how brightly tilted water catches the lights
  rings: 1.0,         // how strongly the ripple field tilts the surface
  ringlight: 1.0,     // how brightly the near side of a ring catches the glow lying low over the water
  drips: 1,           // now and then a drop falls from the ruined vault (0 = never)
  sim: 1,             // 0 stops the ripple field (to measure it)
  bench: 0,           // 1: measure the mirror and the ripple field during a timing run (see bench())
  speed: 0.72,        // how fast rings travel, m/s
  life: 3.2,          // seconds for a ring to fall to about a third
};
const RING_LIFE = 7;                 // seconds a ring is remembered for floating things
const NRING = 64, RS = 7;            // remembered rings: x, z, born, amplitude, source radius, strength, 1 if it marks a wake
const TAU = Math.PI * 2;
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** One thing that can be in the water: a foot, the hips, a blade. */
class Probe {
  constructor(kind, a, b, scale, owner) {
    this.kind = kind; this.a = a; this.b = b || null; this.scale = scale; this.owner = owner;
    this.x = 0; this.y = 0; this.z = 0; this.lx = 0; this.lz = 0; this.wet = false; this.fresh = true; this.quiet = 0;
  }
}

export class Water {
  constructor(ctx) {
    this.ctx = ctx; this.time = 0; this.disposed = false; this.steps = 0; this.cost = { update: 0 };
    this.sinceMirror = 0; this.lastCam = new Float32Array(7); this.settle = 0; this.calmAt = 0;
    const tune = this.tune = Object.assign({}, TUNE);
    for (const part of (ctx.params && ctx.params.get('water') || '').split(',')) { const [k, v] = part.split(':'); if (k in tune && v !== undefined && !Number.isNaN(+v)) tune[k] = +v; }
    const gfx = ctx.gfx, renderer = gfx.renderer, arena = ctx.arena, b = arena.bounds;
    this.quality = gfx.quality || 'high';

    // the ripple field covers the play area and three metres beyond it
    const m = 3;
    this.ripples = new Ripples(renderer, { x0: -b.hx - m, z0: -b.hz - m, x1: b.hx + m, z1: b.hz + m, long: { low: 1024, medium: 1440 }[this.quality] || 2048, speed: tune.speed, life: tune.life });
    this.speed = this.ripples.speed;
    // what stands in the water turns rings back: the arena's colliders, the piers' bases (when the arena says where they are), the dais
    const cols = (arena.colliders || []).map((c) => ({ x: c.x, z: c.z, r: c.r })), daisZ = arena.dais ? arena.dais.z : -1e9;
    for (const p of arena.piers || []) cols.push({ x: p.x, z: p.z, r: p.r || 1.2 });
    this.ripples.setSolids((x, z) => {
      if (z < daisZ) return true;
      for (let i = 0; i < cols.length; i++) { const c = cols[i], dx = x - c.x, dz = z - c.z; if (dx * dx + dz * dz < c.r * c.r) return true; }
      return false;
    });

    this.mirror = new Mirror(renderer, { y: WATER_Y });
    this.mirror.setQuality(this.quality, { scale: tune.mscale, samples: tune.msamples });
    this.mirror.enabled = tune.mirror !== 0;

    const u = this.uniforms = waterUniforms();
    u.tMirror.value = this.mirror.texture; u.tMirrorDepth.value = this.mirror.depthTexture; u.tRipple.value = this.ripples.texture;
    u.uMirrorVP.value = this.mirror.vp; u.uMirrorInvVP.value = this.mirror.invVp; u.uDepthMap.value = this.mirror.depthMap;
    u.uField.value = this.ripples.fieldUniform;
    this.mirror.onResize = (tex, depth) => { u.tMirror.value = tex; u.tMirrorDepth.value = depth; };
    this.applyTune();

    // the surface: one sheet over the whole floor, out under the piers to the walls. Layer 2 only: it is not in its own mirror.
    const r = arena.water || { x0: -30, x1: 30, z0: -40, z1: 40 };
    this.material = makeWaterMaterial(u);
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const mesh = this.mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'water'; mesh.position.set((r.x0 + r.x1) / 2, WATER_Y, (r.z0 + r.z1) / 2); mesh.scale.set(r.x1 - r.x0, 1, r.z1 - r.z0);
    mesh.layers.set(2); mesh.renderOrder = -100; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    ctx.scene.add(mesh);

    // remembered rings (for floating things), delayed disturbances (a splash is more than one ring), and probes
    this.rings = new Float32Array(NRING * RS); this.ringHead = 0; this.ringCount = 0;
    this.later = new Float32Array(64 * 6); this.laterCount = 0;        // t, x, z, radius, amplitude, shape
    this.probes = []; this.bound = [null, null]; this.lastStep = [-9, -9]; this.dripAt = 2.5; this.dripN = 0;
    this.own = false; this.lastWake = new Float32Array([-9, 0, 0]);    // the last wake someone else asked for: when, where it ended
    this.wakeN = 16; this.wakes = new Float32Array(this.wakeN * 7).fill(-9); this.wakeHead = 0;     // the last wakes: x0, z0, x1, z1, radius, strength, when
    this.wakeMark = new Float32Array([-9, 0, 0]);

    this._hook = () => { if (!this.disposed) this.beforeRender(); };
    this.unhook = gfx.onBeforeRender(this._hook);
    // the ripple field's two programs are compiled while the game loads, not on the first step of play
    if (gfx.onWarm) gfx.onWarm(() => { if (!this.disposed) this.ripples.step(); });
    const bus = ctx.bus;
    this.listeners = [
      ['step', (e) => this.onStep(e)], ['roll', (e) => this.onRoll(e)], ['land', (e) => this.onLand(e)],
      // her blade or her body on the floor. Every cut that touches down tells it now (power about 0.4), the cleave 1, the leap 1.3:
      // the ring is as strong and as wide as the blow (a cut 1.2 and 0.7 m, the cleave 3 and 2 m, the leap 3.9 and 2.4 m)
      ['boss-slam', (e) => { const p = e.power === undefined ? 1 : Math.max(0, e.power); this.ripple(e.pos.x, e.pos.z, Math.min(4, Math.max(0.6, 3 * p)), Math.min(2.4, Math.max(0.6, (e.radius || 3) * 0.4 * (0.6 + 0.4 * Math.min(1, p))))); }],
      ['hit', (e) => { if (e.point && e.point.y < WATER_Y + 0.6) this.ripple(e.point.x, e.point.z, e.heavy ? 0.6 : 0.35, 0.35); }],
      ['clash', (e) => { if (e.point && e.point.y < WATER_Y + 0.6) this.ripple(e.point.x, e.point.z, 0.35, 0.3); }],
      ['player-respawn', () => this.calm()],
      // a new scene is being set (fighters put in place, poses blended in): nothing rings for a moment, and the title opens on still water
      ['state', (e) => { if (e.to === 'title') { this.settle = 0.8; this.calmAt = this.time + 0.8; } else if (e.to !== 'dead') this.settle = Math.max(this.settle, 0.3); }],
      ['cine', (e) => { if (e.on) this.settle = Math.max(this.settle, 0.25); }],
      ['setting', (e) => { if (e.key === 'quality') this.setQuality(e.value); }],
    ];
    for (const [name, fn] of this.listeners) bus.on(name, fn);
  }

  applyTune() {
    const t = this.tune, u = this.uniforms;
    u.uOptics.value.set(t.f0, t.fpow, t.through, t.contact);
    u.uStill.value.set(t.swell, t.fine, t.gleam, t.rings);
    u.uRing.value.set(9, 1.6 * t.ringlight, 0.7 * t.ringlight, 3.0);
    this.mirror.enabled = t.mirror !== 0;
  }

  setQuality(q) { if (q === this.quality) return; this.quality = q; this.mirror.setQuality(q, { scale: this.tune.mscale, samples: this.tune.msamples }); }

  // ---- the contract

  /**
   * A ring starts at (x, z). strength: a step 0.3, a roll 0.8, the great blade 2 to 4. radius: the size of what struck
   * the water. The same blow is often reported twice (by whoever struck it, and by the bus): a second ring at the
   * same place within a quarter of a second is not added to the first; the stronger of the two is what the water gets.
   */
  ripple(x, z, strength = 1, radius = 0.4) {
    if (!(strength > 0)) return;
    const R = Math.max(0.03, radius * 0.3), g = this.rings, t = this.time;
    let amp = 0.3 * R * Math.pow(strength, 0.4);
    for (let k = this.ringCount - 1; k >= 0; k--) {                    // newest first
      const i = ((this.ringHead + k) % NRING) * RS;
      if (t - g[i + 2] > 0.25) break;
      if (g[i + 6]) continue;                                           // a wake's mark, not a ring
      const dx = x - g[i], dz = z - g[i + 1], near = Math.max(R, g[i + 4]) * 3.5 + 0.15;
      if (dx * dx + dz * dz > near * near) continue;
      if (amp <= g[i + 3] * 1.15) return;                               // it has rung at least this hard already
      amp -= g[i + 3]; g[i + 3] += amp; if (strength > g[i + 5]) g[i + 5] = strength;   // harder: add what is missing
      this.ripples.add(x, z, x, z, R, amp, 1);
      return;
    }
    this.ripples.add(x, z, x, z, R, amp, 1);
    // a splash is not one push: the hollow closes and opens again, each time throwing out a smaller ring
    const beat = 0.15 + R * 0.5;
    this.addLater(beat, x, z, R * 0.92, -amp * 0.6, 1);
    this.addLater(beat * 2, x, z, R * 0.85, amp * 0.38, 1);
    this.addLater(beat * 3, x, z, R * 0.8, -amp * 0.22, 1);
    this.addLater(beat * 4, x, z, R * 0.75, amp * 0.12, 1);
    this.remember(x, z, amp, R, strength, 0);
  }

  /** A line disturbance from (x0, z0) to (x1, z1): a blade dragged through the water, a wave. */
  wake(x0, z0, x1, z1, strength = 1, radius = 0.35) {
    if (!(strength > 0)) return;
    if (!this.own) { this.lastWake[0] = this.time; this.lastWake[1] = x1; this.lastWake[2] = z1; }      // someone else is drawing this line: the blade probes stand back
    const R = Math.max(0.03, radius * 0.3), amp = 0.22 * R * Math.pow(strength, 0.4), len = Math.hypot(x1 - x0, z1 - z0);
    this.ripples.add(x0, z0, x1, z1, R, amp, len > R ? 2 : 1 + len / R);
    // the last few wakes, for whatever floats near one (candles are shoved aside by what is dragged through the water)
    const w = this.wakes, i = this.wakeHead * 7; this.wakeHead = (this.wakeHead + 1) % this.wakeN;
    w[i] = x0; w[i + 1] = z0; w[i + 2] = x1; w[i + 3] = z1; w[i + 4] = radius; w[i + 5] = strength; w[i + 6] = this.time;
    // floating things also ride a strong one (a wave, a great blade) as a few rings along the line; hems and feet
    // lay too many, too weak, to be worth remembering
    if (strength < 0.9 || (this.time - this.wakeMark[0] < 0.2 && Math.hypot(x1 - this.wakeMark[1], z1 - this.wakeMark[2]) < 1.2)) return;
    this.wakeMark[0] = this.time; this.wakeMark[1] = x1; this.wakeMark[2] = z1;
    const n = Math.min(6, 1 + Math.floor(len / 1.5));
    for (let k = 0; k < n; k++) { const f = (k + 0.5) / n; this.remember(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, amp, R, strength * 0.7, 1); }
  }

  /** The surface's height above rest at (x, z), from the rings still travelling (metres; a few millimetres to a few centimetres). */
  heightAt(x, z) {
    const g = this.rings, t = this.time, c = this.speed, life = this.tune.life;
    let h = 0;
    for (let k = 0; k < this.ringCount; k++) {
      const i = ((this.ringHead + k) % NRING) * RS, age = t - g[i + 2];
      if (age > RING_LIFE) continue;
      const R = g[i + 4], lam = Math.PI * R, front = c * age, w = 1.7 * lam, dx = x - g[i], dz = z - g[i + 1], r2 = dx * dx + dz * dz;
      if (r2 > (front + w) * (front + w) || (front > w && r2 < (front - w) * (front - w))) continue;
      const r = Math.sqrt(r2), q = (r - front) / lam;
      h -= g[i + 3] * Math.exp(-age / life) / Math.sqrt(1 + r / (2 * R)) * Math.cos(TAU * q) * Math.exp(-1.4 * q * q);
    }
    return h;
  }

  /** As heightAt, and how hard the passing rings shove a floating thing: out = { h, fx, fz } (fx, fz in m/s, outward). */
  sample(x, z, out) {
    const g = this.rings, t = this.time, c = this.speed, life = this.tune.life;
    let h = 0, fx = 0, fz = 0;
    for (let k = 0; k < this.ringCount; k++) {
      const i = ((this.ringHead + k) % NRING) * RS, age = t - g[i + 2];
      if (age > RING_LIFE) continue;
      const R = g[i + 4], lam = Math.PI * R, front = c * age, w = 1.7 * lam, dx = x - g[i], dz = z - g[i + 1], r2 = dx * dx + dz * dz;
      if (r2 > (front + w) * (front + w) || (front > w && r2 < (front - w) * (front - w))) continue;
      const r = Math.sqrt(r2), q = (r - front) / lam, env = Math.exp(-age / life) / Math.sqrt(1 + r / (2 * R)), bell = Math.exp(-1.4 * q * q);
      h -= g[i + 3] * env * Math.cos(TAU * q) * bell;
      const s = g[i + 5];
      if (s > 0.5 && r > 1e-3) { const push = 0.9 * (s - 0.5) * env * bell / r; fx += dx * push; fz += dz * push; }   // only a real blow moves things
    }
    out.h = h; out.fx = fx; out.fz = fz;
    return out;
  }

  /** Still water, at once. */
  calm() { this.ripples.clear(); this.ringCount = 0; this.laterCount = 0; this.wakes.fill(-9); for (const p of this.probes) p.fresh = true; }

  // ---- inside

  remember(x, z, amp, R, strength, wake) {
    const g = this.rings;
    let slot;
    if (this.ringCount < NRING) slot = (this.ringHead + this.ringCount++) % NRING; else { slot = this.ringHead; this.ringHead = (this.ringHead + 1) % NRING; }
    const i = slot * RS; g[i] = x; g[i + 1] = z; g[i + 2] = this.time; g[i + 3] = amp; g[i + 4] = R; g[i + 5] = strength; g[i + 6] = wake;
  }
  addLater(delay, x, z, R, amp, shape) {
    if (this.laterCount >= 64) return;
    const i = this.laterCount++ * 6, l = this.later; l[i] = this.time + delay; l[i + 1] = x; l[i + 2] = z; l[i + 3] = R; l[i + 4] = amp; l[i + 5] = shape;
  }

  onStep(e) {
    const boss = e.who === 'boss', k = boss ? 1 : 0;
    if (this.time - this.lastStep[k] < 0.22) return;                    // the foot probe has rung for this footfall already
    this.lastStep[k] = this.time;
    if (boss) this.ripple(e.pos.x, e.pos.z, 1.3, 1.5); else this.ripple(e.pos.x, e.pos.z, e.run ? 0.5 : 0.35, 0.34);
  }
  onRoll(e) {
    const d = e.dir, x = e.pos.x + (d ? d.x * 0.5 : 0), z = e.pos.z + (d ? d.z * 0.5 : 0);
    this.ripple(x, z, 0.8, 0.7);
    for (const p of this.probes) if (p.kind === 'hips' && p.owner === 0) p.quiet = 0.6;   // the roll's own splash is this one
  }
  onLand(e) {
    if (e.who === 'boss') this.ripple(e.pos.x, e.pos.z, e.hard ? 3 : 1.8, e.hard ? 2.2 : 1.6);
    else this.ripple(e.pos.x, e.pos.z, e.hard ? 0.9 : 0.5, 0.5);
    this.lastStep[e.who === 'boss' ? 1 : 0] = this.time;
  }

  /** Find the fighters' feet, hips and blades (again, if a fighter was replaced). */
  bind() {
    const ctx = this.ctx, fs = [ctx.player, ctx.boss];
    if (fs[0] === this.bound[0] && fs[1] === this.bound[1]) return;
    this.bound[0] = fs[0]; this.bound[1] = fs[1]; this.probes.length = 0;
    for (let k = 0; k < 2; k++) {
      const f = fs[k]; if (!f) continue;
      const ch = f.char, bones = ch && ch.bones, scale = (ch && ch.scale) || (k ? 3.6 : 1);
      if (bones && bones.LeftFoot && bones.RightFoot) { this.probes.push(new Probe('foot', bones.LeftFoot, null, scale, k), new Probe('foot', bones.RightFoot, null, scale, k)); if (bones.Hips) this.probes.push(new Probe('hips', bones.Hips, null, scale, k)); }
      else if (f.root || f.pos) this.probes.push(new Probe('body', f.root || null, null, scale, k));
      const sword = f.kit && f.kit.sword;
      if (sword && sword.base && sword.tip) this.probes.push(new Probe('blade', sword.base, sword.tip, scale, k));
    }
  }

  /** Follow everything that can be in the water; ring where it enters, lay a wake where it moves. */
  follow(dt) {
    this.bind();
    const fs = this.bound;
    for (let n = 0; n < this.probes.length; n++) {
      const p = this.probes[n], f = fs[p.owner], s = p.scale, boss = p.owner === 1;
      let x, y, z, wetIn, wetOut, R, ring, ringR, drag;
      if (p.kind === 'blade') {
        // where the blade passes through the surface, if it does
        p.a.getWorldPosition(_a); p.b.getWorldPosition(_b);
        const da = _a.y - WATER_Y, db = _b.y - WATER_Y;
        if (da * db < 0) { const k = da / (da - db); x = _a.x + (_b.x - _a.x) * k; z = _a.z + (_b.z - _a.z) * k; y = 0; } else { x = _b.x; z = _b.z; y = 1; }
        wetIn = 0.5; wetOut = 0.5; R = boss ? 0.55 : 0.16; ring = boss ? 1.6 : 0.3; ringR = boss ? 1.1 : 0.3; drag = boss ? 1.5 : 0.5;
      } else {
        if (p.kind === 'body') { const q = f.pos || f.root.position; x = q.x; z = q.z; y = 0; } else { p.a.getWorldPosition(_v); x = _v.x; y = _v.y; z = _v.z; }
        if (p.kind === 'foot') { wetIn = 0.13 * s + 0.09; wetOut = wetIn + 0.05 * s; R = 0.2 * s; ring = boss ? 1.3 : 0.4; ringR = boss ? 1.5 : 0.34; drag = boss ? 0.9 : 0.28; }
        else if (p.kind === 'hips') { wetIn = 0.45 * s; wetOut = 0.55 * s; R = 0.5 * s; ring = boss ? 2.2 : 0.8; ringR = boss ? 2.0 : 0.7; drag = boss ? 1.2 : 0.5; }
        else { wetIn = 1; wetOut = 2; R = 0.45 * s; ring = 0; ringR = 0; drag = boss ? 0.8 : 0.25; }
      }
      const jump = Math.hypot(x - p.x, z - p.z);
      // Placed somewhere else at once, or put into another pose at once (no body drops that far in a sixtieth of a
      // second), or the scene is still being set: that is a cut, not a splash.
      const hop = p.kind !== 'blade' && Math.abs(y - p.y) > 0.2 * s + 0.1;
      if (p.fresh || jump > 1.5 + s || hop || this.settle > 0) { p.fresh = false; p.x = x; p.y = y; p.z = z; p.lx = x; p.lz = z; p.wet = y < wetIn; continue; }
      if (p.quiet > 0) p.quiet -= dt;
      const was = p.wet;
      p.wet = was ? y < wetOut : y < wetIn;
      if (p.wet && !was && ring > 0) {
        const fall = Math.min(1.5, Math.max(0.6, (p.y - y) / dt / (1.6 * Math.sqrt(s))));       // a foot set down gently rings less than one stamped
        if (p.kind === 'foot') { if (this.time - this.lastStep[p.owner] > 0.22) { this.lastStep[p.owner] = this.time; this.ripple(x, z, ring * fall, ringR); } }
        else if (p.quiet <= 0) this.ripple(x, z, ring * fall, ringR);
        p.lx = x; p.lz = z;
      } else if (p.wet) {
        const moved = Math.hypot(x - p.lx, z - p.lz);
        if (moved > R * 0.45) {
          const v = jump / dt, k = Math.min(1, v / (boss ? 9 : 5)), lw = this.lastWake;
          // a blade whose owner is already drawing its wake (within the last tenth of a second, within reach) is left to them
          const theirs = p.kind === 'blade' && this.time - lw[0] < 0.1 && Math.hypot(x - lw[1], z - lw[2]) < 0.6 + 0.5 * s;
          if (k > 0.04 && !theirs) { this.own = true; this.wake(p.lx, p.lz, x, z, drag * (0.25 + 0.75 * k), R); this.own = false; }
          p.lx = x; p.lz = z;
        }
      }
      p.x = x; p.y = y; p.z = z;
    }
  }

  /** A drop from the ruined vault, now and then, somewhere on the floor: the only sound of the place made visible. */
  drip() {
    const n = ++this.dripN, b = this.ctx.arena.bounds;
    this.dripAt = this.time + 1.6 + hash(n * 3 + 7) * 3.2;
    this.ripple((hash(n * 3 + 1) * 2 - 1) * (b.hx + 1), (hash(n * 3 + 2) * 2 - 1) * (b.hz + 1), 0.16, 0.2);
  }

  update(dt) {
    const t0 = performance.now();
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.follow(dt);
    if (this.settle > 0) this.settle -= dt;
    if (this.calmAt && this.time >= this.calmAt) { this.calmAt = 0; this.calm(); }
    if (this.tune.drips && this.time >= this.dripAt) this.drip();
    // delayed disturbances whose time has come
    const l = this.later;
    for (let k = 0; k < this.laterCount;) {
      const i = k * 6;
      if (l[i] <= this.time) {
        this.ripples.add(l[i + 1], l[i + 2], l[i + 1], l[i + 2], l[i + 3], l[i + 4], l[i + 5]);
        const j = --this.laterCount * 6; for (let c = 0; c < 6; c++) l[i + c] = l[j + c];
      } else k++;
    }
    // forget rings that have died away
    while (this.ringCount > 0 && this.time - this.rings[this.ringHead * RS + 2] > RING_LIFE) { this.ringHead = (this.ringHead + 1) % NRING; this.ringCount--; }
    if (this.tune.sim) this.ripples.step();
    this.steps++;
    this.cost.update += (performance.now() - t0 - this.cost.update) * 0.05;
  }

  /**
   * Dev (&water=bench:1 with &perf=): what the mirror, the ripple field and the surface cost, measured inside one run. The parts
   * take turns, eight frames each, round and round, so whatever else the machine is doing falls on all of them alike.
   * The times are from one frame's hook to the next (the timing run reads a pixel back each frame, so that is the
   * whole frame, graphics card included). The answer is posted as perf_water_parts.json and kept in water.benchResult.
   * &water=bench:2 does the same for the candles' parts (bowls, the flames' streaks on the water, flames and smoke): perf_candle_parts.json.
   */
  bench() {
    const b = this._bench || (this._bench = { last: 0, n: 0, sums: [[], [], [], []], done: false, steps: 0 });
    const now = performance.now(), single = this.steps - b.steps === 1; b.steps = this.steps;
    if (b.done) return;
    if (!single) { b.last = 0; return; }                               // not yet the timing run (frames are still being skipped)
    const variant = Math.floor(b.n / 8) % 4, at = b.n % 8, parts = this.tune.bench === 2, candles = this.ctx.candles;
    if (b.last && at >= 3) b.sums[variant].push(now - b.last);         // the first frames after a change are left out
    b.last = now; b.n++;
    const next = Math.floor(b.n / 8) % 4, end = b.n >= 8 * 4 * 7;
    if (parts) { if (candles) candles.benchHide = end ? 0 : [0, 1, 2, 4][next]; }      // 0 everything, 1 no bowls, 2 no streaks, 3 no flames or smoke
    else { this.mirror.enabled = end || next !== 1; this.tune.sim = end || next !== 2 ? 1 : 0; this.mesh.visible = end || next !== 3; }      // 0 everything, 1 no mirror pass, 2 no ripple field, 3 no surface
    if (end) {
      b.done = true;
      const med = (a) => { const c = a.slice().sort((x, y) => x - y); return c.length ? c[c.length >> 1] : 0; };
      const full = med(b.sums[0]), r = (v) => +v.toFixed(2), d = (k) => r(full - med(b.sums[k]));
      const cost = { waterUpdateCpuMs: +this.cost.update.toFixed(3), candlesUpdateCpuMs: candles && candles.cost ? +candles.cost.update.toFixed(3) : null, candlesPrepareCpuMs: candles && candles.cost && candles.cost.prepare !== undefined ? +candles.cost.prepare.toFixed(3) : null, drawn: candles && candles.drawn ? Object.assign({}, candles.drawn) : null };
      this.benchResult = parts ? Object.assign({ frameMs: r(full), bowlsMs: d(1), streaksMs: d(2), flamesMs: d(3), samples: b.sums[0].length }, cost)
        : Object.assign({ frameMs: r(full), mirrorMs: d(1), ripplesMs: d(2), surfaceMs: d(3), samples: b.sums[0].length, mirrorSize: [this.mirror.w, this.mirror.h], field: [this.ripples.nx, this.ripples.nz] }, cost);
      fetch('/__shot/' + (parts ? 'perf_candle_parts.json' : 'perf_water_parts.json'), { method: 'POST', body: JSON.stringify(this.benchResult) }).catch(() => {});
    }
  }

  /** The reflection for this frame (a hook the renderer calls before it draws; the shadow map is already fresh). */
  beforeRender() {
    const gfx = this.ctx.gfx, candles = this.ctx.candles;
    if (gfx.quality && gfx.quality !== this.quality) this.setQuality(gfx.quality);
    // the candles choose what is drawn of each bowl for this frame's camera: before the mirror, which draws them too
    if (candles && candles.prepare) candles.prepare(this.ctx.camera);
    if (this.tune.bench) this.bench();
    // On 'low' the mirror is drawn every other frame. The frame between reads the last picture where the world was
    // (the surface looks it up by place in the world, not by place on the screen), so the hall's reflection holds
    // still; only what moved since lags a frame. A cut or a fast turn draws it at once.
    const every = this.tune.every > 0 ? this.tune.every : (this.quality === 'low' ? 2 : 1), cam = this.ctx.camera;
    if (every > 1 && this.mirror.ready) {
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements, l = this.lastCam, p5 = cam.projectionMatrix.elements[5];
      const moved = Math.hypot(e[12] - l[0], e[13] - l[1], e[14] - l[2]), turned = 1 - (e[8] * l[3] + e[9] * l[4] + e[10] * l[5]);
      if (++this.sinceMirror < every && moved < 0.3 && turned < 0.001 && Math.abs(p5 - l[6]) < 0.01) return;
      l[0] = e[12]; l[1] = e[13]; l[2] = e[14]; l[3] = e[8]; l[4] = e[9]; l[5] = e[10]; l[6] = p5;
    }
    this.sinceMirror = 0;
    this.mirror.render(this.ctx.scene, this.ctx.camera, gfx.resolution);
  }

  dispose() {
    this.disposed = true;
    if (typeof this.unhook === 'function') this.unhook();
    for (const [name, fn] of this.listeners) this.ctx.bus.off(name, fn);
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); this.material.dispose();
    this.mirror.dispose(); this.ripples.dispose();
  }
}
