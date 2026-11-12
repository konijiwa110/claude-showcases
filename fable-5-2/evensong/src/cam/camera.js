// The play camera (docs/engine.md, "Camera"; the reasoning and the numbers are in docs/modules/player.md).
//
//   cam.mode = 'free' | 'lock' | 'cine'      'cine': hands off, the cinematics module drives ctx.camera itself
//   cam.target (the Cantor), cam.follow (the pilgrim)
//   cam.yaw                                  the way the lens points over the ground (the pilgrim's stick is read against it)
//   cam.pitch                                how high the lens sits above his shoulder, as an angle (0 = level, + = above)
//   cam.lockPoint                            a Vector3 on her chest, for the interface's lock mark
//   cam.setLock(on), cam.snapBehind(), cam.shake(amount, seconds), cam.punch(fovDelta, seconds)
//
// Free: the mouse or the right stick turns the lens round him; left alone while he runs, it drifts round behind him.
// Lock (Q, middle click, right stick click): the lens stays behind him on the line from her to him and frames both:
// his feet near the bottom edge, her head inside the top. As he closes on her it pulls back, drops to his shoulder,
// tilts up and widens a little. It swings round at a limited rate, slower the nearer he is to her, so a roll past
// her legs never whips the picture. It keeps out of columns, inside the hall and above the water; pushed in by a
// wall it rises over his head, and it comes back out gently.
//
// It also answers the fight by itself: a shake on every blow (by how near it lands), a hit-stop on clean and heavy
// blows, a red pulse at the edges (gfx.post.hurt) when he is struck and a slow one when his health is low, a
// widening when he sprints, the gamepad's rumble. Shake is scaled down by ui.settings.reducedMotion.
import * as THREE from 'three';
import { clamp, lerp, smooth, damp, angleDiff } from '../core/math.js';
import { WATER_Y } from '../core/constants.js';

const DEG = Math.PI / 180;
/** Every number of the camera in one place. Metres, seconds, degrees where it says so. */
export const CAM = {
  fov: 50, fovClose: 8, fovSprint: 4,          // degrees: base; added at her feet when locked; added in a sprint
  dist: 5.2, pitch: 0.2, pitchMin: -0.3, pitchMax: 1.05,     // free: how far behind him, how high (radians)
  shoulder: 1.45, lookUp: 0.4,                 // the point the lens turns about (above his feet) and how far above it the free lens looks
  follow: 16,                                  // how tightly that point follows him (per second)
  drift: 0.9, driftWait: 1.0,                  // free: radians a second it may drift behind him, after this long without a touch
  regard: -0.14, regardWait: 0.6,              // free, left alone, close in front of her: it sinks to this angle so that her head stays in the picture
  lockMin: 5.2, lockMax: 9.5,                  // locked: how far behind him the lens may sit
  lockHigh: 2.3, lockLow: 1.55,                // locked: lens height far from her / at her feet
  marginTop: 3.5, marginBottom: 2.5,           // degrees kept free above her head and below his feet
  peek: 0.5, peekUp: 0.2, peekBack: 1.0,       // locked: the mouse may still lean the lens this far round him and up or down (radians); it settles back after so long untouched
  aim: 0.42,                                   // locked: where the lens points between him (0) and her (1), when they are not in one line
  swing: 0.9, swingPerM: 0.5, swingMax: 6.5,   // locked: radians a second the lens may swing round him: slow near her, fast far away
  wall: 0.8, wallWest: 1.48, wallEast: 1.2,    // how far outside the play area it may go: toward the piers (x), toward the doors (+z), over the dais (-z). Last polish: toward the doors it was 3.0 (the lens went to z = 19.7), and the two door leaves stand open into the nave as far as z = 18.56: the lens went behind a leaf and the whole picture was the dark inside of a door. Now it stops at z = 18.2, in front of the leaves' edges ...
  bay: { deep: 1.5, xl: -2.9, xr: 1.8, slant: 1.0 },      // ... except BETWEEN the leaves (the doorway): there it may still go `deep` further back, in a bay whose sides slant inward (by `slant` metres over that depth) so that it stays half a metre clear of both leaves and the lens slides along the edge instead of jumping. Leaves, from docs/modules/world.md: south, hinge (2.77, 21.25) to (2.10, 18.56); north, thrown back, hinge (-2.77, 21.25) to (-3.44, 18.56)
  radius: 0.28,                                // its own size
  squeezeIn: 22, squeezeOut: 2.5, squeezeLift: 0.5,     // pushed in by a wall: how fast in, how slowly out, how far it rises over his head
  slip: 2.2, slipStep: 0.26, slipMax: 4,       // locked, with no room behind him: it slides round him (radians a second; the angles it tries)
  shakeAngle: 0.036, shakeMove: 0.11,          // radians and metres at full shake
  // a blow, by its weight (docs/impact.md): how long the world holds still when HE strikes / when he is struck, how far
  // the lens is turned along the blow (radians), how hard the picture shakes, how far the field of view is punched
  stop: { light: [0.05, 0.06], heavy: [0.09, 0.1], colossal: [0.18, 0.17] },
  kick: { light: 0.004, heavy: 0.014, colossal: 0.03 }, kickBack: 11,     // ... and how fast the lens comes back from it (per second)
  slow: [0.45, 0.5],                           // after a colossal blow: the world runs at this rate for so many real seconds, counted from the blow (the hold eats the first 0.17: a third of a second of slow motion is left; not in picture runs)
  her: 0.25,                                   // metres the lens keeps clear of the Cantor's body (her radius grown by this)
  ghost: 1.0, ghostOver: 0.45,                 // the lens nearer to him than this: he fades, gone when it is nearer by so much
  autoLock: 0.3,                               // seconds into the fight (and after a respawn or a cutscene) at which it locks on by itself; 0 = never
};

const _o = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _lf = new THREE.Vector3(), _ll = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
const turnStep = (from, to, ease, cap, dt) => { const d = angleDiff(to, from); return from + clamp(d * (1 - Math.exp(-ease * dt)), -cap * dt, cap * dt); };

export class PlayCamera {
  constructor(ctx) {
    this.ctx = ctx; this._mode = 'free'; this.follow = ctx.player; this.target = ctx.boss; this._locked = false;
    this.yaw = Math.PI; this.orbit = Math.PI; this.pitch = CAM.pitch; this.dist = CAM.dist; this.fov = CAM.fov;
    this.pivot = new THREE.Vector3(); this.pos = new THREE.Vector3(); this.dir = new THREE.Vector3(0, 0, -1); this.lockPoint = new THREE.Vector3();
    this.lockK = 0; this.lockAge = 9; this.squeeze = 1; this.slip = 0; this.top = 6.6; this.idle = 9; this.aimEl = 0; this.aimAz = Math.PI;
    this.trauma = 0; this.decay = 2; this.punchV = 0; this.punchT = 0; this.punchT0 = 1; this.time = 0;
    this.flash = 0; this.sprintK = 0; this.wasCine = false; this.fresh = true; this.autoT = 0; this.peekX = 0; this.peekY = 0;
    this.kickX = 0; this.kickY = 0; this.ghost = 0; this.ghostSet = 0; this.jolt = null; this.joltT = 0; this.joltAmp = 0; this.joltX = 0; this.joltZ = 0; this.joltClock = 0;
    const bus = ctx.bus;
    if (ctx.params && ctx.params.has('oldlens')) { CAM.wallWest = 3.0; CAM.bay = null; }      // dev, to compare: the lens as it was before the last polish (it goes behind the open door leaves)
    this.offs = [
      bus.on('hit', (h) => this.onHit(h)),
      bus.on('boss-slam', (e) => this.onSlam(e)),
      bus.on('land', (e) => { if (e.who === 'boss') this.near(e.pos, e.hard ? 0.5 : 0.28, 0.4, 16); else if (e.hard) this.shake(0.16, 0.2); }),
      bus.on('step', (e) => { if (e.who === 'boss') this.near(e.pos, 0.12, 0.22, 9); }),
      bus.on('clash', (e) => this.onClash(e)),
      bus.on('charge', () => this.punch(-1.5, 0.3)),
      bus.on('roll', () => { if (this._mode !== 'cine') this.punch(1.6, 0.35); }),
      bus.on('state', (e) => { this.autoT = e.to === 'fight' && CAM.autoLock > 0 && !(ctx.params && ctx.params.has('nolock')) ? CAM.autoLock : 0; }),      // dev: &nolock leaves the lens free
    ];
    this.snapBehind();
  }

  get mode() { return this._mode; }
  set mode(v) {
    if (v === this._mode) return;
    const was = this._mode; this._mode = v;
    if (v === 'cine') return;                                              // whoever took the camera gives it back with mode = 'free' | 'lock'
    if (was === 'cine') this.fresh = true;
    if (was === 'lock') { this.orbit += this.slip + this.peekX; this.pitch = clamp(this.pitch + this.peekY, CAM.pitchMin, CAM.pitchMax); this.slip = 0; this.peekX = this.peekY = 0; }         // the free lens starts exactly where the locked one was
    this.setLocked(v === 'lock');
  }
  setLocked(on) {
    if (this.follow) this.follow.locked = on;
    if (on !== this._locked) { this._locked = on; if (on) this.lockAge = 0; this.ctx.bus.emit('lock', { on }); }
  }
  /** Lock on to the Cantor, or let go. */
  setLock(on) { if (this._mode === 'cine') return; if (on && !(this.target && this.target.alive)) on = false; this.mode = on ? 'lock' : 'free'; }

  /** Put the camera behind the pilgrim at once (after a cutscene, at a respawn). */
  snapBehind() {
    const f = this.follow; if (!f) return;
    this.orbit = this.yaw = f.yaw; this.pitch = CAM.pitch; this.dist = CAM.dist; this.squeeze = 1; this.slip = 0; this.idle = 9; this.sprintK = 0; this.peekX = this.peekY = 0;
    this.pivot.set(f.pos.x, f.pos.y + CAM.shoulder, f.pos.z); this.lockK = this._mode === 'lock' ? 1 : 0;
    this.fresh = true;
    if (this._mode !== 'cine') this.place(0, true);
  }
  /** Shake the picture: amount 0..1 (it is squared, so 0.3 is gentle and 0.8 is violent), dying away over `seconds`. */
  shake(amount = 0.5, seconds = 0.3) {
    const s = this.ctx.ui && this.ctx.ui.settings; if (s && s.reducedMotion) amount *= 0.3;
    if (amount > this.trauma) { this.trauma = Math.min(1, amount); this.decay = this.trauma / Math.max(0.05, seconds); }
  }
  /** Kick the field of view by so many degrees (negative = a punch in), easing back over `seconds`. */
  punch(fovDelta = -3, seconds = 0.2) {
    const s = this.ctx.ui && this.ctx.ui.settings; if (s && s.reducedMotion) fovDelta *= 0.3;
    this.punchV = fovDelta; this.punchT = this.punchT0 = Math.max(0.03, seconds);
  }
  /** A shake that is strong near `pos` and nothing beyond `reach` metres. */
  near(pos, amount, seconds, reach) {
    const d = pos ? Math.hypot(pos.x - this.pos.x, pos.z - this.pos.z) : 0, k = clamp(1 - d / reach);
    if (k > 0) this.shake(amount * (0.35 + 0.65 * k), seconds);
  }

  onHit(h) {
    const ctx = this.ctx, p = this.follow, game = ctx.game, input = ctx.input;
    if (this._mode === 'cine') return;
    const w = h.weight === 'colossal' || h.weight === 'heavy' ? h.weight : 'light', big = w !== 'light', huge = w === 'colossal';
    const mine = h.attacker === p, his = h.target === p; if (!mine && !his) return;
    // everything below starts in this step, the contact frame, and is scaled by the blow's weight
    let stop = CAM.stop[w][his ? 1 : 0];
    if (his) {
      if (h.blocked && !h.guardBreak) { stop = big ? 0.07 : 0.05; this.shake(big ? 0.42 : 0.3, 0.25); this.flash = Math.max(this.flash, h.damage > 0 ? 0.18 : 0); input.rumble(0.5, 0.3, big ? 0.16 : 0.1); }
      else {
        this.shake(huge ? 0.95 : big ? 0.72 : 0.45, huge ? 0.6 : big ? 0.42 : 0.28); this.flash = Math.max(this.flash, h.fatal ? 1 : clamp(0.3 + h.damage / 80));      // the red at the edges by what the blow cost him (her blows cost 16 to 48 since the fight polish: 0.5 to 0.9; only the killing blow is full)
        this.punch(huge ? 4.5 : big ? 3 : 1.2, huge ? 0.5 : 0.35); input.rumble(1, huge ? 1 : 0.8, huge ? 0.5 : big ? 0.3 : 0.16);
      }
    } else {
      // his own blow lands: a short hold of the world and a small punch in, more for the heavy ones, most for the one that fells her or breaks her poise
      this.shake(huge ? 0.6 : big ? 0.36 : 0.2, huge ? 0.4 : big ? 0.26 : 0.16); this.punch(huge ? -4 : big ? -2.6 : -1.2, huge ? 0.45 : big ? 0.3 : 0.18);
      input.rumble(huge ? 1 : big ? 0.7 : 0.35, huge ? 0.9 : big ? 0.6 : 0.4, huge ? 0.35 : big ? 0.16 : 0.08);
    }
    if (game.hitStop) game.hitStop(stop);
    if (huge && game.slow && !game.auto && !(h.fatal && mine)) game.slow(CAM.slow[0], CAM.slow[1]);      // a breath of slow motion (her death goes straight into its cutscene)
    // the lens is turned along the blow (more a turn than a slide), less far away, less with reduced motion
    if (h.dir && !(h.blocked && !big)) {
      const cam = ctx.camera, e = cam.matrixWorld.elements, s = ctx.ui && ctx.ui.settings, calm = s && s.reducedMotion ? 0.3 : 1;
      const d = h.point ? Math.hypot(h.point.x - this.pos.x, h.point.y - this.pos.y, h.point.z - this.pos.z) : 6, near = clamp(1.25 - d / 22, 0.35, 1);
      const k = CAM.kick[w] * near * calm * (h.blocked ? 0.5 : 1) * (his ? 1.3 : 1);
      const rx = h.dir.x * e[0] + h.dir.y * e[1] + h.dir.z * e[2], uy = h.dir.x * e[4] + h.dir.y * e[5] + h.dir.z * e[6], l = Math.hypot(rx, uy);
      if (l > 0.05) { this.kickX += rx / l * k; this.kickY += uy / l * k; } else this.kickY += k * 0.7;       // straight along the lens: a nod
    }
    // the struck body shakes a little while the world is held (frame(): the steps do not run then)
    if (this.jolt && this.jolt.char && this.jolt.char.model) { this.jolt.char.model.position.x = this.joltX; this.jolt.char.model.position.z = this.joltZ; }
    this.jolt = h.target && h.target.char && h.target.char.model ? h.target : null; this.joltT = stop; if (this.jolt) { this.joltX = this.jolt.char.model.position.x; this.joltZ = this.jolt.char.model.position.z; } this.joltAmp = (huge ? 0.05 : big ? 0.035 : 0.02) * (his ? 1 : (h.target.char ? Math.min(2.2, h.target.char.scale) : 1));
  }
  /** A blade on stone, by its weight: his tap, his charged blow, her five metres of steel on a pier. */
  onClash(e) {
    if (this._mode === 'cine' || !e || !e.stone) return;
    const big = e.heavy || e.weight === 'heavy' || e.weight === 'colossal', input = this.ctx.input;
    if (e.who === 'boss') { this.near(e.point, e.weight === 'colossal' ? 0.7 : 0.55, 0.4, 20); this.punch(1.5, 0.3); if (input.rumble) input.rumble(0.8, 0.6, 0.3); }
    else if (e.floor) this.shake(big ? 0.2 : 0.1, big ? 0.2 : 0.12);
    else { this.shake(big ? 0.3 : 0.14, big ? 0.25 : 0.15); if (big) this.punch(-1.2, 0.2); }
    if (e.dir && (big || e.who === 'boss') && !e.floor) {           // the lens is turned along the blow that stopped
      const m = this.ctx.camera.matrixWorld.elements, k = (e.who === 'boss' ? 0.012 : 0.008) * (this.ctx.ui && this.ctx.ui.settings && this.ctx.ui.settings.reducedMotion ? 0.3 : 1);
      const rx = e.dir.x * m[0] + e.dir.y * m[1] + e.dir.z * m[2], uy = e.dir.x * m[4] + e.dir.y * m[5] + e.dir.z * m[6], l = Math.hypot(rx, uy);
      if (l > 0.05) { this.kickX += rx / l * k; this.kickY += uy / l * k; }
    }
  }
  onSlam(e) {
    if (this._mode === 'cine') return;
    const power = e.power === undefined ? 1 : e.power, reach = 10 + (e.radius || 2) * 2.5;
    this.near(e.pos, clamp(0.3 + 0.35 * power, 0.2, 0.9), 0.3 + 0.15 * power, reach);
    if (this.ctx.input.rumble) this.ctx.input.rumble(0.6 * power, 0.4, 0.2);
  }

  /** May the lens be at (x, z)? The play area grown by CAM.wall (a rounded rectangle), and the bay between the two open
   *  door leaves (CAM.bay). Everything the hall draws beyond that is a wall, a pier or a door leaf. */
  allowed(x, z, B) {
    const ix = B.hx - B.r, iz = B.hz - B.r, zw = iz + CAM.wallWest - CAM.wall, ze = -iz - CAM.wallEast + CAM.wall, lim = B.r + CAM.wall - CAM.radius;
    const dx = x - clamp(x, -ix, ix), dz = z - clamp(z, ze, zw);
    if (dx * dx + dz * dz <= lim * lim) return true;
    const bay = CAM.bay, z0 = zw + lim; if (!bay || z < z0 - 1 || z > z0 + bay.deep) return false;      // the bay between the leaves: its sides slant inward
    const u = clamp((z - z0) / bay.deep) * bay.slant;
    return x >= bay.xl + u && x <= bay.xr - u;
  }
  /** How far along the way from o to c (0..1) the lens may go before it leaves the hall or enters a column. What the
   *  walls alone allow is left in this.kWall (place() holds the lens to that at once: it is never outside the hall). */
  clearance(o, c) {
    const a = this.ctx.arena; this.kWall = 1; if (!a) return 1;
    const vx = c.x - o.x, vz = c.z - o.z, L2 = vx * vx + vz * vz; if (L2 < 1e-6) return 1;
    let k = 1;
    const B = a.bounds;
    if (B) {                                                               // the first place along the way where it would leave: walked in twelve strides (the bay makes the shape hollow: the way to a place inside the bay may pass outside, round a leaf's edge), then the edge is found by halving
      let lo = 0, hi = -1;
      for (let i = 1; i <= 12; i++) { const m = i / 12; if (this.allowed(o.x + vx * m, o.z + vz * m, B)) lo = m; else { hi = m; break; } }
      if (hi >= 0) {
        for (let i = 0; i < 7; i++) { const m = (lo + hi) / 2; if (this.allowed(o.x + vx * m, o.z + vz * m, B)) lo = m; else hi = m; }
        k = this.kWall = lo;
      }
    }
    const cols = a.colliders, her = this.target && this.target.alive && !this.target.puppet ? this.target : null;
    for (let i = cols ? cols.length - 1 : -1; i >= -1; i--) {
      // a fallen stone or a drum of the toppled pier; and, last, the Cantor herself: the lens is never inside her
      if (i < 0 && !her) break;
      const cx = i < 0 ? her.pos.x : cols[i].x, cz = i < 0 ? her.pos.z : cols[i].z, R = (i < 0 ? (her.radius || 1.5) + CAM.her : cols[i].r) + CAM.radius, fx = o.x - cx, fz = o.z - cz;
      const bq = fx * vx + fz * vz, cq = fx * fx + fz * fz - R * R;
      if (cq <= 0) continue;                                               // he is hugging it: nothing sensible to do
      const disc = bq * bq - L2 * cq; if (disc <= 0 || bq >= 0) continue;
      const t = (-bq - Math.sqrt(disc)) / L2; if (t >= 0 && t < k) k = t;
    }
    return Math.max(0.06, k);
  }
  /** The same, for the place `a` radians round him from where the lens wants to be. */
  roomAt(pv, a, reach) { _c.set(pv.x - Math.sin(this.orbit + a) * reach, 0, pv.z - Math.cos(this.orbit + a) * reach); return this.clearance(pv, _c); }

  /** Locked, and the place behind him is in a wall or a column: how far round him (radians) is there room? */
  findSlip(pv) {
    const reach = Math.cos(this.pitch) * this.dist, k0 = this.roomAt(pv, 0, reach);
    if (k0 >= 0.92) return 0;
    let best = 0, score = k0;
    const side = Math.sign(this.slip);
    for (let i = 1; i <= CAM.slipMax; i++) for (let s = -1; s <= 1; s += 2) {
      const sc = Math.min(1, this.roomAt(pv, s * i * CAM.slipStep, reach)) - i * 0.045 + (side === s ? 0.08 : 0);     // nearer the line is better; stay on the side it is on
      if (sc > score + 1e-3) { score = sc; best = s * i * CAM.slipStep; }
    }
    return best;
  }

  /** Work out where the lens is and where it points; snap = no easing. */
  place(dt, snap) {
    const ctx = this.ctx, f = this.follow, b = this.target, cam = ctx.camera, pv = this.pivot;
    const lock = this._mode === 'lock' && b && b.alive;
    // the point it turns about follows him closely, never rigidly
    _t.set(f.pos.x, f.pos.y + CAM.shoulder, f.pos.z);
    if (snap || pv.distanceToSquared(_t) > 36) pv.copy(_t); else { const k = 1 - Math.exp(-CAM.follow * dt); pv.lerp(_t, k); }
    this.lockK = snap ? (lock ? 1 : 0) : damp(this.lockK, lock ? 1 : 0, 6, dt);

    let fov = CAM.fov, wantDist = CAM.dist, wantPitch = this.pitch;
    if (b && b.char) {                                                     // her chest, for the lock mark; her crown, for the framing
      const B = b.char.bones, s = b.char.scale;
      if (B && B.Spine2) B.Spine2.getWorldPosition(this.lockPoint); else this.lockPoint.set(b.pos.x, 0.6 * 1.8 * s, b.pos.z);
      let top = 1.84 * s; if (B && B.Head) { B.Head.getWorldPosition(_b); top = _b.y + 0.3 * s; }
      this.top = snap ? top : damp(this.top, top, 3, dt);
    }
    if (lock) {
      const dx = b.pos.x - pv.x, dz = b.pos.z - pv.z, d = Math.hypot(dx, dz), close = 1 - smooth((d - 3) / 6.5);
      fov = CAM.fov + CAM.fovClose * close;
      const h = lerp(CAM.lockHigh, CAM.lockLow, close), span = (fov - CAM.marginTop - CAM.marginBottom) * DEG, H = this.top;
      let c = CAM.lockMin;
      for (let i = 0; i < 26 && c < CAM.lockMax; i++) { if (Math.atan2(H - h, c + d) + Math.atan2(h, c) <= span) break; c += 0.2; }
      wantDist = Math.hypot(c, h - CAM.shoulder); wantPitch = Math.atan2(h - CAM.shoulder, c);
      // swing round behind him: slower the nearer he is to her (so passing her legs does not whip the picture round)
      const want = Math.atan2(dx, dz), cap = Math.min(CAM.swingMax, CAM.swing + CAM.swingPerM * d) * (this.lockAge < 0.5 ? 2.5 : 1);
      if (snap) this.orbit = want; else if (d > 0.3) this.orbit = turnStep(this.orbit, want, 6, cap, dt);
      if (snap) { this.pitch = wantPitch; this.dist = wantDist; } else { this.pitch = damp(this.pitch, wantPitch, 3.2, dt); this.dist = damp(this.dist, wantDist, 3.2, dt); }
      const slip = this.findSlip(pv);
      this.slip = snap ? slip : this.slip + clamp(slip - this.slip, -CAM.slip * dt, CAM.slip * dt);
    } else {
      if (!snap) this.dist = damp(this.dist, CAM.dist + (f.alive ? 0 : 1.4), f.alive ? 3 : 0.5, dt);
      if (this.slip) { this.orbit += this.slip; this.slip = 0; }
      this.peekX = this.peekY = 0;
    }

    this.fovBase = snap || this.fovBase === undefined ? fov : damp(this.fovBase, fov, 5, dt); fov = this.fovBase;      // the widening near her comes and goes smoothly

    // where it would sit, then what the hall allows
    const pt = clamp(this.pitch + this.peekY, CAM.pitchMin, CAM.pitchMax), oa = this.orbit + this.slip + this.peekX;
    const cp = Math.cos(pt), sp = Math.sin(pt), so = Math.sin(oa), co = Math.cos(oa);
    _c.set(pv.x - so * cp * this.dist, pv.y + sp * this.dist, pv.z - co * cp * this.dist);
    const k = this.clearance(pv, _c), kWall = Math.max(0.06, this.kWall);
    this.squeeze = snap ? k : damp(this.squeeze, k, k < this.squeeze ? CAM.squeezeIn : CAM.squeezeOut, dt);
    if (kWall < this.squeeze) this.squeeze = kWall;
    const q = Math.min(1, this.squeeze);                            // (the walls are met at once, not eased into: the edge moves smoothly under the lens, and the lens is never behind a door leaf)
    this.pos.set(pv.x + (_c.x - pv.x) * q, pv.y + (_c.y - pv.y) * q + (1 - q) * CAM.squeezeLift, pv.z + (_c.z - pv.z) * q);
    let floor = (ctx.arena && typeof ctx.arena.waterY === 'number' ? ctx.arena.waterY : WATER_Y) + 0.35;
    if (ctx.arena && ctx.arena.ground) floor = Math.max(floor, ctx.arena.ground(this.pos.x, this.pos.z) + 0.45);      // over the dais's steps
    if (this.pos.y < floor) this.pos.y = floor;

    // where it points. Free: at a point above his shoulder. Locked: so that his feet sit at the bottom margin and she is ahead.
    const ahead = (1 - q) * 3;                                             // pushed in close: look past him, not down at him
    _lf.set(pv.x + so * ahead - this.pos.x, pv.y + CAM.lookUp - this.pos.y, pv.z + co * ahead - this.pos.z).normalize();
    this.fovNow = fov;
    if (this.lockK > 0.001 && b) {
      const P = this.pos, hd = Math.max(0.3, Math.hypot(pv.x - P.x, pv.z - P.z));
      const half = fov * DEG / 2, mB = CAM.marginBottom * DEG;
      const elFeet = -Math.atan2(P.y - f.pos.y, hd) - mB + half;           // his feet on the bottom margin: where it likes to look
      const elHead = -Math.atan2(P.y - f.pos.y - 1.9, hd) - mB + half;     // his head on the bottom margin: the most it may look up
      const bd = Math.max(0.5, Math.hypot(b.pos.x - P.x, b.pos.z - P.z)), elHer = Math.atan2(this.top - P.y, bd) + CAM.marginTop * DEG - half;   // her crown on the top margin
      let el = elFeet;
      if (elHer > el) el = Math.min(elHer, elHead);                        // no room for both: she stays whole and his boots leave the picture
      el = clamp(el, -0.6, 0.85);
      // over the ground: between him and her, never so far toward her that he leaves the picture
      const azP = Math.atan2(pv.x - P.x, pv.z - P.z), azB = Math.atan2(b.pos.x - P.x, b.pos.z - P.z);
      const hHalf = Math.atan(Math.tan(half) * (cam.aspect || 1.78));
      let az = azP + clamp(angleDiff(azB, azP) * CAM.aim, -hHalf * 0.72, hHalf * 0.72);
      if (snap || this.fresh) { this.aimEl = el; this.aimAz = az; } else { this.aimEl = damp(this.aimEl, el, 9, dt); this.aimAz += angleDiff(az, this.aimAz) * (1 - Math.exp(-9 * dt)); }
      const ce = Math.cos(this.aimEl);
      _ll.set(Math.sin(this.aimAz) * ce, Math.sin(this.aimEl), Math.cos(this.aimAz) * ce);
      const kk = smooth(this.lockK);
      this.dir.copy(_lf).lerp(_ll, kk).normalize();
    } else { this.dir.copy(_lf); this.aimEl = Math.asin(clamp(_lf.y, -1, 1)); this.aimAz = Math.atan2(_lf.x, _lf.z); }
    this.yaw = Math.atan2(this.dir.x, this.dir.z);
    this.fresh = false;
    cam.position.copy(this.pos); cam.up.set(0, 1, 0); _t.copy(this.pos).add(this.dir); cam.lookAt(_t);
  }

  update(dt) {
    const ctx = this.ctx, input = ctx.input, f = this.follow, b = this.target, cam = ctx.camera;
    this.time += dt; this.lockAge += dt;
    this.feel(dt);
    if (this._mode === 'cine') { this.wasCine = true; this.trauma = 0; this.punchT = 0; this.kickX = this.kickY = 0; if (this.ghostSet) { this.ghost = 0; this.ghostSet = 0; if (f && f.look && 'ghost' in f.look) f.look.ghost = 0; else { if (f && f.look) f.look.fade = 0; if (f && f.kit) f.kit.fade = 0; } } return; }
    if (this.wasCine) { this.wasCine = false; this.fresh = true; }
    if (!f) return;
    if (input.pressed('lock') && f.alive && !f.puppet) {
      if (this._mode === 'lock') this.setLock(false);
      else if (b && b.alive) this.setLock(true);
      else { this.orbit = f.yaw; this.idle = 0; }                         // nothing to lock on to: swing round behind him
    }
    if (this._mode === 'lock' && !(b && b.alive)) this.setLock(false);
    // the fight has just begun: lock on for the player (Q lets go again)
    if (this.autoT > 0) { this.autoT -= dt; if (this.autoT <= 0 && this._mode === 'free' && b && b.alive && f.alive && !f.puppet) this.setLock(true); }
    if (this._mode === 'lock') {
      // locked on, the lens is its own master, but the hand is still answered: the mouse leans it a little, and it settles back
      const lx = input.look.x, ly = input.look.y;
      if (lx || ly) { this.peekX = clamp(this.peekX + lx, -CAM.peek, CAM.peek); this.peekY = clamp(this.peekY - ly, -CAM.peekUp, CAM.peekUp); this.idle = 0; }
      else { this.idle += dt; if (this.idle > CAM.peekBack) { this.peekX = damp(this.peekX, 0, 2.5, dt); this.peekY = damp(this.peekY, 0, 2.5, dt); } }
    }
    if (this._mode === 'free') {
      const lx = input.look.x, ly = input.look.y;
      if (lx || ly) { this.orbit += lx; this.pitch = clamp(this.pitch - ly, CAM.pitchMin, CAM.pitchMax); this.idle = 0; }
      else {
        this.idle += dt;
        // left alone while he runs: drift round behind the way he is going, and back to a comfortable height
        const sp = f.speed || 0;
        if (this.idle > CAM.driftWait && sp > 1 && f.alive) {
          const head = Math.atan2(f.vel.x, f.vel.z), off = angleDiff(head, this.orbit), a = Math.abs(off);
          if (a > 0.05 && a < 2.5) this.orbit += clamp(off * 0.9, -CAM.drift, CAM.drift) * Math.min(1, sp / 4.6) * dt;
          this.pitch = damp(this.pitch, CAM.pitch, 0.5, dt);
        }
        // not locked on, but she towers right in front of the lens: sink and look up at her (a touch of the mouse takes it back)
        if (this.idle > CAM.regardWait && b && b.alive && f.alive) {
          const dx = b.pos.x - f.pos.x, dz = b.pos.z - f.pos.z, d = Math.hypot(dx, dz), near = 1 - smooth((d - 3) / 7);
          if (near > 0.02 && Math.abs(angleDiff(Math.atan2(dx, dz), this.orbit)) < 1.0) this.pitch = damp(this.pitch, lerp(CAM.pitch, CAM.regard, near), 1.4, dt);
        }
      }
    }
    this.place(dt, this.fresh);
    // a sprint opens the picture a little; a blow kicks it
    const sprint = f.state === 'sprint' ? 1 : 0; this.sprintK = damp(this.sprintK, sprint, 4, dt);
    let fov = this.fovNow + CAM.fovSprint * this.sprintK;
    if (this.punchT > 0) { this.punchT -= dt; const k = Math.max(0, this.punchT / this.punchT0); fov += this.punchV * k * k; }
    this.fov = fov;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    // the kick of a blow: the lens turned along it, coming back
    if (this.kickX || this.kickY) {
      cam.rotateY(-this.kickX); cam.rotateX(this.kickY);
      const k = Math.exp(-CAM.kickBack * dt); this.kickX *= k; this.kickY *= k; if (Math.abs(this.kickX) + Math.abs(this.kickY) < 1e-4) this.kickX = this.kickY = 0;
    }
    this.fadeNear(dt);
    // the shake: a few sines that never line up, squared trauma
    if (this.trauma > 0) {
      const a = this.trauma * this.trauma, t = this.time;
      const nx = Math.sin(t * 43.1) * 0.6 + Math.sin(t * 71.7 + 1.3) * 0.4, ny = Math.sin(t * 37.3 + 2.1) * 0.6 + Math.sin(t * 83.9 + 0.4) * 0.4, nz = Math.sin(t * 51.9 + 4.2) * 0.6 + Math.sin(t * 67.3 + 2.9) * 0.4;
      cam.rotateX(nx * a * CAM.shakeAngle); cam.rotateY(ny * a * CAM.shakeAngle); cam.rotateZ(nz * a * CAM.shakeAngle * 0.7);
      cam.position.x += ny * a * CAM.shakeMove; cam.position.y += nx * a * CAM.shakeMove * 0.6;
      this.trauma = Math.max(0, this.trauma - this.decay * dt);
    }
    cam.updateMatrixWorld();
  }

  /** The lens must sometimes come close to him (his back to a wall, a corner): then he fades, rather than fill the
   *  picture or be cut open by the near plane. It is the body's own dissolve (gfx look.fade) and the kit's (kit.fade). */
  fadeNear(dt) {
    const f = this.follow, cam = this.ctx.camera; if (!f || !f.char) return;
    const y = clamp(cam.position.y, f.pos.y + 0.2, f.pos.y + 1.7), d = Math.hypot(cam.position.x - f.pos.x, cam.position.y - y, cam.position.z - f.pos.z);
    const want = f.alive && !f.puppet ? clamp((CAM.ghost - d) / CAM.ghostOver) : 0;
    this.ghost += clamp(want - this.ghost, -5 * dt, 9 * dt);
    if (this.ghost < 0.004 && this.ghostSet === 0) return;
    const g = this.ghost < 0.004 ? 0 : this.ghost;
    // Graphics now fades him PLAINLY (look.ghost: a fine screen pattern over his body and everything he wears and
    // carries, by itself); before that the only fade there was the death's dissolve (gold shards), on body and kit.
    if (f.look && 'ghost' in f.look) f.look.ghost = g; else { if (f.look) f.look.fade = g; if (f.kit) f.kit.fade = g; }
    this.ghostSet = g;
  }

  /** The red at the edges of the picture: a flash when he is struck, a slow pulse when his health is low. */
  feel(dt) {
    const ctx = this.ctx, f = this.follow, post = ctx.gfx && ctx.gfx.post; if (!post || !f) return;
    this.flash = Math.max(0, this.flash - dt * 2.2);
    if (this._mode === 'cine' || !ctx.game || (ctx.game.state !== 'fight' && ctx.game.state !== 'rescue')) { this.flash = 0; return; }
    const s = ctx.ui && ctx.ui.settings, calm = s && s.reducedMotion;
    let pulse = 0;
    if (f.alive && f.hp < f.hpMax * 0.3) pulse = calm ? 0.16 : 0.15 + 0.09 * Math.sin(this.time * Math.PI * 2 * 0.9);
    else if (!f.alive) pulse = 0.5;
    post.hurt = Math.max(this.flash, pulse);
  }

  /** Once per display frame: nothing of the picture is decided here (that is update's), only the gamepad is read, so
   *  a tap between two steps or during a hit-stop is not lost. */
  frame(dt) {
    const i = this.ctx.input; if (i && i.poll) i.poll();
    // hit-stop: while the world is held, the struck body shakes a little (its drawn model only: nothing of the rules moves)
    const j = this.jolt; if (!j) return;
    const m = j.char && j.char.model, loop = this.ctx.game && this.ctx.game.loop, held = loop && loop.freeze > 0 && this.joltT > 0;
    if (m) {
      if (held) { this.joltT -= dt || 0; this.joltClock += dt || 0; const a = this.joltAmp / (j.char.scale || 1), t = this.joltClock; m.position.x = this.joltX + Math.sin(t * 190) * a; m.position.z = this.joltZ + Math.cos(t * 163) * a; }
      else { m.position.x = this.joltX; m.position.z = this.joltZ; this.jolt = null; }
    }
  }

  dispose() { for (const off of this.offs) off(); this.offs.length = 0; }
}
