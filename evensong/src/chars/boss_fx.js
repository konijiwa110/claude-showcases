// What the Cantor fights with that is not her body: the rings of light of her Chorale (and the ring of water her
// leap throws out), the Hymn blades, the Tide's wave, the burst along her blade when it strikes the water.
// Each is a rule (where it is, whom it hits: decided here, step by step, exactly) and a picture.
//
// Pictures: rings are drawn by the effects owner (`ctx.vfx.shock`); if that returns nothing (the stand-in) a plain
// ring of our own is drawn instead, so a hazard is never invisible. Blades and the wave are drawn here: unlit,
// additive, HDR (bloom makes the glow), vertex colours only: no textures, no custom shaders, nothing to compile late.
// Everything is pooled and built once; idle things are parked below the floor at no size.
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { hash } from '../core/math.js';

const TAU = Math.PI * 2;
const GOLD = new THREE.Color(1.0, 0.8, 0.42), PALE = new THREE.Color(0.78, 0.88, 1.0), WHITE = new THREE.Color(1, 1, 1);
const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1), _up = new THREE.Vector3(0, 1, 0), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const PARK = new THREE.Matrix4().makeScale(1e-5, 1e-5, 1e-5).setPosition(0, -50, 0);

const glowMat = (opts = {}) => new THREE.MeshBasicMaterial(Object.assign({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }, opts));

// ---- rings -------------------------------------------------------------------------------------------------------
const RING_SEG = 96, RING_LOOPS = [[-1.7, 0, 0], [0, 0, 1], [0.45, 0, 0], [0, 1, 0]];        // [radial offset (widths), height (1 = top of the curtain), brightness]

function ringMesh() {
  const n = RING_SEG + 1, pos = new Float32Array(n * 4 * 3), col = new Float32Array(n * 4 * 4), idx = [];
  for (let l = 0; l < 4; l++) for (let i = 0; i < n; i++) { const k = (l * n + i) * 4, a = RING_LOOPS[l][2]; col[k] = col[k + 1] = col[k + 2] = a; col[k + 3] = a; }
  const strip = (l0, l1) => { for (let i = 0; i < RING_SEG; i++) { const a = l0 * n + i, b = l1 * n + i; idx.push(a, b, a + 1, b, b + 1, a + 1); } };
  strip(0, 1); strip(1, 2); strip(1, 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); g.setAttribute('color', new THREE.BufferAttribute(col, 4)); g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
  const m = new THREE.Mesh(g, glowMat()); m.frustumCulled = false; m.name = 'boss-ring'; m.scale.setScalar(1e-5); m.position.y = -50;
  return m;
}
function ringWrite(mesh, r, width, height) {
  const p = mesh.geometry.attributes.position, a = p.array, n = RING_SEG + 1;
  for (let l = 0; l < 4; l++) {
    const rr = Math.max(0.01, r + RING_LOOPS[l][0] * width), y = RING_LOOPS[l][1] * height;
    for (let i = 0; i < n; i++) { const t = (i / RING_SEG) * TAU, k = (l * n + i) * 3; a[k] = Math.cos(t) * rr; a[k + 1] = y; a[k + 2] = Math.sin(t) * rr; }
  }
  p.needsUpdate = true;
}

// ---- blades of light -----------------------------------------------------------------------------------------------
const BLADES = 8, BLADE_LEN = 3.4;
function bladeGeometry() {
  // a long slim diamond along +z: point at +z. Bright along its spine, dim at the edges (additive: it reads as a blade of light).
  const L = BLADE_LEN / 2, w = 0.2, t = 0.05, zc = -L * 0.45;
  const v = [[0, 0, L], [0, 0, -L], [w, 0, zc], [-w, 0, zc], [0, t, zc], [0, -t, zc]], c = [1, 0.55, 0.16, 0.16, 0.9, 0.9];
  const f = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]];
  const pos = [], col = [];
  for (const tri of f) for (const i of tri) { pos.push(...v[i]); col.push(c[i], c[i], c[i], c[i]); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return g;
}
function haloGeometry() {
  const seg = 20, pos = [0, 0, 0], col = [1, 1, 1, 1], idx = [];
  for (let i = 0; i <= seg; i++) { const a = (i / seg) * TAU; pos.push(Math.cos(a), Math.sin(a), 0); col.push(0, 0, 0, 0); if (i) idx.push(0, i, i + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); g.setIndex(idx);
  return g;
}

// ---- the wave --------------------------------------------------------------------------------------------------------
const WAVE_SEG = 48, WAVE_ROWS = 4;
function waveMesh() {
  // across x (-0.5..0.5); four rows: the wash behind (z = -1), nearer (z = -0.22), the crest's foot (z = 0: the bright line),
  // the crest's top (y = 1, leaning back). It is a thin line of light with a little standing on it, not a slab.
  const n = WAVE_SEG + 1, pos = new Float32Array(n * WAVE_ROWS * 3), col = new Float32Array(n * WAVE_ROWS * 4), idx = [];
  for (let i = 0; i < n; i++) {
    const x = i / WAVE_SEG - 0.5;
    pos.set([x, 0, -1], i * 3); pos.set([x, 0, -0.22], (n + i) * 3); pos.set([x, 0, 0], (2 * n + i) * 3); pos.set([x, 1, -0.1], (3 * n + i) * 3);
  }
  for (let i = 0; i < WAVE_SEG; i++) for (let r = 0; r < WAVE_ROWS - 1; r++) { const a = r * n + i, b = (r + 1) * n + i; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage)); g.setIndex(idx);
  const m = new THREE.Mesh(g, glowMat()); m.frustumCulled = false; m.name = 'boss-wave'; m.scale.setScalar(1e-5); m.position.y = -50;
  return m;
}

export class BossFx {
  constructor(ctx, boss) {
    this.ctx = ctx; this.boss = boss; this.time = 0; this.spared = -9;
    this.group = new THREE.Group(); this.group.name = 'boss-fx'; ctx.scene.add(this.group);

    this.rings = [];
    for (let i = 0; i < 8; i++) this.rings.push({ on: false, x: 0, z: 0, r: 0, v: 0, max: 0, band: 0.5, damage: 0, heavy: false, done: false, t: 0, quiet: 0, handle: null, mesh: null, color: GOLD, power: 1, name: '' });
    this.ringMeshes = [];                                        // our own picture of a ring, used only when vfx.shock gives none

    this.blades = [];
    for (let i = 0; i < BLADES; i++) this.blades.push({ state: 0, t: 0, wait: 0, flight: 1, spent: false, pos: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), dir: new THREE.Vector3(0, -1, 0), prev: new THREE.Vector3(), size: 0, seed: i });
    this.bladeMesh = new THREE.InstancedMesh(bladeGeometry(), glowMat(), BLADES); this.bladeMesh.name = 'boss-hymn-blades'; this.bladeMesh.frustumCulled = false;
    this.haloMesh = new THREE.InstancedMesh(haloGeometry(), glowMat({ depthTest: true }), BLADES); this.haloMesh.name = 'boss-hymn-halos'; this.haloMesh.frustumCulled = false;
    this.haloMesh.layers.set(2);                                  // screen-facing glows: not for the water's mirror
    for (let i = 0; i < BLADES; i++) { this.bladeMesh.setMatrixAt(i, PARK); this.haloMesh.setMatrixAt(i, PARK); this.bladeMesh.setColorAt(i, WHITE); this.haloMesh.setColorAt(i, WHITE); }
    this.group.add(this.bladeMesh, this.haloMesh);
    this.bladesLive = 0; this.bladeSeq = new Int8Array(BLADES); this.bladeSeqN = 0;

    this.waves = [];
    for (let i = 0; i < 2; i++) { const mesh = waveMesh(); this.group.add(mesh); this.waves.push({ on: false, x: 0, z: 0, dx: 0, dz: 1, v: 0, width: 0, travelled: 0, max: 0, damage: 0, done: false, mesh, t: 0 }); }
  }

  // ---- rings ----
  /** A ring of light (or water) starts at (x, z) and runs out. Returns the ring. o: { speed, max, damage, heavy, color, band, r0, power, name, quiet (seconds before it can hurt) } */
  ring(x, z, o = {}) {
    let g = null; for (const r of this.rings) if (!r.on) { g = r; break; }
    if (!g) return null;
    g.on = true; g.x = x; g.z = z; g.r = o.r0 || 0.6; g.v = o.speed || 8; g.max = o.max || 20; g.band = o.band || 0.4; g.damage = o.damage || 18; g.heavy = !!o.heavy;
    g.done = this.time - this.spared < 0.4; g.t = 0; g.color = o.color || GOLD; g.power = o.power || 1; g.name = o.name || 'ring'; g.quiet = o.quiet || 0;
    const vfx = this.ctx.vfx; _p.set(x, WATER_Y, z);
    let h = null;
    try { h = vfx && vfx.shock ? vfx.shock(_p, g.max, g.color, (g.max - g.r) / g.v, g.r) : null; } catch (e) { h = null; }      // from g.r to g.max at g.v: the picture runs with the rule
    g.handle = h && typeof h === 'object' ? h : null;
    if (!g.handle) {                                             // nobody drew it: draw it ourselves
      let m = null; for (const k of this.ringMeshes) if (!k.userData.busy) { m = k; break; }
      if (!m) { m = ringMesh(); this.group.add(m); this.ringMeshes.push(m); }
      m.userData.busy = true; g.mesh = m; m.scale.setScalar(1); m.position.set(x, WATER_Y + 0.02, z);
    }
    return g;
  }
  ringsUpdate(dt) {
    const ctx = this.ctx, p = ctx.player;
    for (const g of this.rings) {
      if (!g.on) continue;
      g.t += dt; g.r += g.v * dt;
      if (g.handle) {                                            // keep the rule on the picture; their handle is reused once its ring has ended
        if (g.handle.alive === false) g.handle = null; else if (typeof g.handle.radius === 'number' && g.handle.radius > g.r - 1.5) g.r = g.handle.radius;
      }
      const fade = Math.min(1, Math.max(0, (g.max - g.r) / (g.max * 0.25)));
      if (g.mesh) {
        ringWrite(g.mesh, g.r, 0.55, 0.9 * fade + 0.1);
        g.mesh.material.color.copy(g.color).multiplyScalar(5 * g.power * (0.25 + 0.75 * fade));
      }
      if (!g.done && p && p.alive && fade > 0.05 && g.t >= g.quiet) {
        const d = Math.hypot(p.pos.x - g.x, p.pos.z - g.z);
        if (Math.abs(d - g.r) < g.band + g.v * dt * 0.5) {
          _d.set(p.pos.x - g.x, 0, p.pos.z - g.z); if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1); _d.normalize();
          _p.set(p.pos.x, 0.9, p.pos.z);
          const hit = ctx.combat.strike({ attacker: this.boss, target: p, point: _p.clone(), dir: _d.clone(), damage: g.damage, poise: 20, heavy: g.heavy, unblockable: true, kind: g.name });      // light and water pass a shield: roll through it
          if (hit) g.done = true;                                  // refused (he is rolling through it): it may still catch him if he comes out of the roll inside the band
        }
      }
      if (g.r >= g.max) this.ringOff(g);
    }
  }
  ringOff(g) { g.on = false; if (g.mesh) { g.mesh.userData.busy = false; g.mesh.scale.setScalar(1e-5); g.mesh.position.y = -50; g.mesh = null; } if (g.handle && g.handle.stop) { try { g.handle.stop(); } catch (e) { /* theirs */ } } g.handle = null; }

  // ---- hymn blades ----
  /** Blades appear one after another in a fan above and behind her. n <= 8. */
  hymn(n = 7, damage = 12) {
    this.hymnDamage = damage;
    const b = this.boss, s = b.char.scale;
    n = Math.min(BLADES, n); this.bladesLive = n;
    const f = b.yaw, cx = b.pos.x, cz = b.pos.z;
    for (let i = 0; i < BLADES; i++) {
      const k = this.blades[i];
      if (i >= n) { k.state = 0; continue; }
      const u = n > 1 ? i / (n - 1) - 0.5 : 0, ang = u * 2.5, rad = 4.6, h = 8.6 - Math.abs(u) * 5.2;     // a fan: highest above her head, lowest at her sides
      const side = Math.sin(ang) * rad, back = -1.4 - Math.cos(ang) * 0.8;
      k.pos.set(cx + Math.cos(f) * side + Math.sin(f) * back, h * (s / 3.667), cz - Math.sin(f) * side + Math.cos(f) * back);
      k.from.copy(k.pos); k.dir.set(0, -1, 0); k.state = 1; k.t = 0; k.wait = 0.1 + i * 0.11; k.size = 0; k.spent = false;
    }
    // they are loosed from the outside in, alternating sides: the eye can follow which one is next
    let m = 0; for (let a = 0, z = n - 1; a <= z; a++, z--) { this.bladeSeq[m++] = a; if (z !== a) this.bladeSeq[m++] = z; }
    this.bladeSeqN = m;
  }
  /** Start loosing them at him, one every `gap` seconds. */
  hymnLoose(gap = 0.46, first = 0.25) {
    for (let j = 0; j < this.bladeSeqN; j++) { const k = this.blades[this.bladeSeq[j]]; if (k.state === 1 || k.state === 2) { k.state = 2; k.wait = first + j * gap; k.t = 0; } }
  }
  bladesUpdate(dt) {
    const ctx = this.ctx, p = ctx.player, cam = ctx.camera, TELL = 0.36, SPEED = 30;
    let any = false;
    for (let i = 0; i < BLADES; i++) {
      const k = this.blades[i];
      if (k.state === 0) { continue; }
      any = true; k.t += dt;
      let bright = 1, halo = 0.6, len = 1;
      if (k.state === 1) {                                       // appearing, then hanging
        if (k.wait > 0) { k.wait -= dt; k.size = 0; if (k.wait <= 0) { k.t = 0; if (this.boss.kit.wings.pulse) this.boss.kit.wings.pulse(0.5); } }
        else k.size = Math.min(1, k.t / 0.3);
        bright = 0.5 + 0.5 * k.size; halo = 0.8 * k.size;
        k.pos.y = k.from.y + Math.sin(this.time * 1.7 + k.seed * 1.3) * 0.12;
      } else if (k.state === 2) {                                // hanging, waiting its turn; in the last TELL seconds it flares and turns on him
        k.wait -= dt; k.size = 1;
        k.pos.y = k.from.y + Math.sin(this.time * 1.7 + k.seed * 1.3) * 0.12;
        const tell = k.wait < TELL ? 1 - Math.max(0, k.wait) / TELL : 0;
        if (tell > 0 && p) { _d.set(p.pos.x - k.pos.x, 0.9 - k.pos.y, p.pos.z - k.pos.z).normalize(); k.dir.lerp(_d, Math.min(1, dt * 14)).normalize(); }
        bright = 0.9 + tell * 2.6; halo = 0.6 + tell * 2.2;
        if (k.wait <= 0) {                                       // loosed: at where he stands now, not where he will be
          k.state = 3; k.t = 0; k.from.copy(k.pos);
          if (p) k.to.set(p.pos.x, 0.05, p.pos.z); else k.to.set(k.pos.x, 0.05, k.pos.z);
          k.dir.subVectors(k.to, k.from); k.flight = k.dir.length() / SPEED; k.dir.normalize(); k.prev.copy(k.pos);
          ctx.bus.emit('boss-move', { name: 'hymn', stage: 'active', n: i, of: this.bladesLive });
        }
      } else if (k.state === 3) {                                // in flight
        k.prev.copy(k.pos); const u = Math.min(1, k.t / k.flight); k.pos.lerpVectors(k.from, k.to, u); bright = 3.2; halo = 1.6; len = 1.5;
        if (p && p.alive && !k.spent) {                          // the stretch flown this step against a standing man
          const ax = k.prev.x, ay = k.prev.y, az = k.prev.z, bx = k.pos.x, by = k.pos.y, bz = k.pos.z;
          let hitNow = false;
          for (let j = 0; j <= 4 && !hitNow; j++) { const w = j / 4, x = ax + (bx - ax) * w, y = ay + (by - ay) * w, z = az + (bz - az) * w; if (y < 1.95 && Math.hypot(x - p.pos.x, z - p.pos.z) < 0.55) hitNow = true; }
          if (hitNow) {
            _p.set(p.pos.x, Math.min(1.5, Math.max(0.4, k.pos.y)), p.pos.z); _d.copy(k.dir).setY(0); if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1); _d.normalize();
            const hit = ctx.combat.strike({ attacker: this.boss, target: p, point: _p.clone(), dir: _d.clone(), damage: this.hymnDamage || 12, poise: 10, heavy: false, kind: 'hymn' });
            k.spent = true;                                       // one chance each: a roll through it is a roll through it
            if (hit) {                                            // struck: the ones still hanging wait until he has his feet again
              k.state = 4; k.t = 0;
              for (let j = 0; j < BLADES; j++) { const o = this.blades[j]; if (o.state === 2) o.wait += 0.75; }
            }
          }
        }
        if (u >= 1 && k.state === 3) {                           // it stands in the floor a moment and goes out
          k.state = 4; k.t = 0;
          if (ctx.water) ctx.water.ripple(k.pos.x, k.pos.z, 1.2, 0.5);
          if (ctx.vfx) { _p.set(k.pos.x, WATER_Y, k.pos.z); if (ctx.vfx.spray) ctx.vfx.spray(_p, _up, 8, 0.6); if (ctx.vfx.motes) ctx.vfx.motes(_p, 6, GOLD); }
        }
      } else if (k.state === 4) {
        const u = k.t / 0.55; bright = 1.6 * (1 - u); halo = 1.2 * (1 - u); k.size = 1 - u * 0.5;
        if (u >= 1) { k.state = 0; k.spent = false; this.bladeMesh.setMatrixAt(i, PARK); this.haloMesh.setMatrixAt(i, PARK); continue; }
      }
      const sz = Math.max(1e-4, k.size);
      _q.setFromUnitVectors(_z, k.dir); _s.set(sz, sz, sz * len); _p.copy(k.pos).addScaledVector(k.dir, -BLADE_LEN * 0.5 * sz * len);      // its point is at k.pos
      _m.compose(_p, _q, _s); this.bladeMesh.setMatrixAt(i, _m);
      _c.copy(GOLD).multiplyScalar(2.2 * bright); this.bladeMesh.setColorAt(i, _c);
      const hs = Math.max(1e-4, (0.9 + 0.5 * Math.min(2, halo)) * sz); _s.set(hs, hs, hs); _m.compose(_p, cam.quaternion, _s); this.haloMesh.setMatrixAt(i, _m);
      _c.copy(GOLD).multiplyScalar(0.55 * halo); this.haloMesh.setColorAt(i, _c);
    }
    if (any || this._bladesDirty) { this.bladeMesh.instanceMatrix.needsUpdate = true; this.haloMesh.instanceMatrix.needsUpdate = true; if (this.bladeMesh.instanceColor) this.bladeMesh.instanceColor.needsUpdate = true; if (this.haloMesh.instanceColor) this.haloMesh.instanceColor.needsUpdate = true; }
    this._bladesDirty = any;
  }
  /** Are blades still hanging or flying? */
  get hymnBusy() { for (const k of this.blades) if (k.state === 1 || k.state === 2 || k.state === 3) return true; return false; }

  // ---- the tide ----
  /** A wave starts on the line through (x, z) square to (dx, dz) and crosses the hall. */
  tide(x, z, dx, dz, o = {}) {
    let w = null; for (const k of this.waves) if (!k.on) { w = k; break; }
    if (!w) return null;
    const l = Math.hypot(dx, dz) || 1;
    w.on = true; w.x = x; w.z = z; w.dx = dx / l; w.dz = dz / l; w.v = o.speed || 11; w.width = o.width || 44; w.travelled = 0; w.max = o.max || 42; w.damage = o.damage || 22; w.done = this.time - this.spared < 0.4; w.t = 0;
    w.mesh.rotation.y = Math.atan2(w.dx, w.dz); w.mesh.scale.set(w.width, 1.2, 2.4);
    return w;
  }
  wavesUpdate(dt) {
    const ctx = this.ctx, p = ctx.player;
    for (const w of this.waves) {
      if (!w.on) continue;
      w.t += dt; const step = w.v * dt; w.x += w.dx * step; w.z += w.dz * step; w.travelled += step;
      const rise = Math.min(1, w.t / 0.35), fade = Math.min(1, Math.max(0, (w.max - w.travelled) / 8)) * rise;
      w.mesh.position.set(w.x, WATER_Y + 0.02, w.z); w.mesh.scale.y = 0.5 + 0.8 * rise;
      const col = w.mesh.geometry.attributes.color, a = col.array, n = WAVE_SEG + 1;
      for (let i = 0; i < n; i++) {
        const x = i / WAVE_SEG, edge = Math.min(1, Math.min(x, 1 - x) * 8);
        const live = 0.7 + 0.3 * Math.sin(x * 61 + w.t * 9) * Math.sin(x * 23 - w.t * 5);
        const f = fade * edge * live;
        a.fill(0, i * 4, i * 4 + 4);                                               // the wash behind fades to nothing
        const m = (n + i) * 4; a[m] = 0.3 * f; a[m + 1] = 0.26 * f; a[m + 2] = 0.2 * f; a[m + 3] = 0.3 * f;
        const k = (2 * n + i) * 4; a[k] = 3.4 * f; a[k + 1] = 2.7 * f; a[k + 2] = 1.5 * f; a[k + 3] = f;       // the foot of the crest: the brightest line
        a.fill(0, (3 * n + i) * 4, (3 * n + i) * 4 + 4);                           // the curtain standing on it fades upward
      }
      col.needsUpdate = true;
      if (ctx.water && ((w.t * 60) | 0) % 9 === 0) {                               // it is a real wave on the water too (a line laid every metre and a half: more often and it rules the hall with stripes)
        const hx = -w.dz * w.width * 0.5, hz = w.dx * w.width * 0.5;
        ctx.water.wake(w.x - hx, w.z - hz, w.x + hx, w.z + hz, 0.9 * fade);
      }
      if (!w.done && p && p.alive && fade > 0.1) {
        const rx = p.pos.x - w.x, rz = p.pos.z - w.z, ahead = rx * w.dx + rz * w.dz, side = Math.abs(-rx * w.dz + rz * w.dx);
        if (Math.abs(ahead) < 0.5 + step * 0.5 && side < w.width * 0.5) {
          _p.set(p.pos.x, 0.7, p.pos.z); _d.set(w.dx, 0, w.dz);
          const hit = ctx.combat.strike({ attacker: this.boss, target: p, point: _p.clone(), dir: _d.clone(), damage: w.damage, poise: 30, heavy: false, unblockable: true, kind: 'tide' });
          if (hit) w.done = true;
        }
      }
      if (w.travelled >= w.max) this.waveOff(w);
    }
  }
  waveOff(w) { w.on = false; w.mesh.scale.setScalar(1e-5); w.mesh.position.y = -50; }

  // ---- where the blade strikes the water ----
  /** The water bursts along a line on the floor (the cleave): from (x0, z0) to (x1, z1). */
  burst(x0, z0, x1, z1, power = 1) {
    const ctx = this.ctx, n = 6;
    if (ctx.water) { ctx.water.wake(x0, z0, x1, z1, 3 * power); ctx.water.ripple(x1, z1, 3 * power, 0.9); }
    if (ctx.vfx && ctx.vfx.spray) {
      for (let i = 0; i <= n; i++) {
        const u = i / n; _p.set(x0 + (x1 - x0) * u, WATER_Y, z0 + (z1 - z0) * u);
        _d.set((hash(i * 7 + 1) - 0.5) * 0.5, 1, (hash(i * 7 + 2) - 0.5) * 0.5).normalize();
        ctx.vfx.spray(_p, _d, 14, (0.7 + 0.5 * u) * power);
      }
    }
  }

  /** Her blade has just struck him: the ring or wave that the same blow threw out does not strike him as well. */
  spare(maxAge = 0.6) { for (const g of this.rings) if (g.on && g.t < maxAge) g.done = true; for (const w of this.waves) if (w.on && w.t < maxAge) w.done = true; this.spared = this.time; }

  update(dt) { this.time += dt; this.ringsUpdate(dt); this.bladesUpdate(dt); this.wavesUpdate(dt); }

  /** Is anything of hers still loose in the hall? */
  get busy() { for (const r of this.rings) if (r.on) return true; for (const w of this.waves) if (w.on) return true; return this.hymnBusy; }

  /** Take everything out of the hall at once (reset, a cutscene, her death). */
  clear() {
    for (const g of this.rings) if (g.on) this.ringOff(g);
    for (let i = 0; i < BLADES; i++) { const k = this.blades[i]; k.state = 0; k.spent = false; this.bladeMesh.setMatrixAt(i, PARK); this.haloMesh.setMatrixAt(i, PARK); }
    this.bladeMesh.instanceMatrix.needsUpdate = true; this.haloMesh.instanceMatrix.needsUpdate = true; this._bladesDirty = false;
    for (const w of this.waves) if (w.on) this.waveOff(w);
  }

  dispose() {
    this.clear();
    this.ctx.scene.remove(this.group);
    this.bladeMesh.geometry.dispose(); this.bladeMesh.material.dispose(); this.bladeMesh.dispose();
    this.haloMesh.geometry.dispose(); this.haloMesh.material.dispose(); this.haloMesh.dispose();
    for (const m of this.ringMeshes) { m.geometry.dispose(); m.material.dispose(); }
    for (const w of this.waves) { w.mesh.geometry.dispose(); w.mesh.material.dispose(); }
  }
}

export const COLORS = { GOLD, PALE, WHITE };
