// Cinematics: directing the actors, their things and the room. Everything goes through the contracts in
// docs/engine.md (fighters as puppets, their kits, candles, water, effects, mood, sound, interface); anything that
// may not be there yet is guarded, so a cutscene runs against stand-ins and against the finished modules alike.
import * as THREE from 'three';
import { clamp, Spring } from './ease.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _r = new THREE.Quaternion(), _ax = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), _gapv = new THREE.Vector3();
const TAU = Math.PI * 2;
const angleDiff = (b, a) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

/**
 * Turns a fighter's head (with a little of the neck and chest) toward a point, on top of whatever clip plays.
 * Used when the animation module's own `char.look` is not there.
 */
class HeadTurn {
  constructor(f) {
    const B = f.char.bones; this.f = f;
    this.bones = [B.Spine2, B.Neck, B.Head].filter(Boolean); this.share = this.bones.length === 3 ? [0.18, 0.3, 0.52] : this.bones.map(() => 1 / this.bones.length);
    this.base = this.bones.map(() => new THREE.Quaternion()); this.last = this.bones.map(() => new THREE.Quaternion()); this.mine = this.bones.map(() => false);
    this.yaw = new Spring(0); this.pitch = new Spring(0); this.point = new THREE.Vector3(); this.weight = 0; this.rate = 3; this.limit = 1.0; this.on = false;
  }
  aim(point, o = {}) {
    if (point) { this.point.copy(point); this.weight = o.weight === undefined ? 1 : o.weight; this.on = true; } else this.weight = 0;
    this.rate = o.rate || o.speed || 3; this.limit = o.limit || 1.0;
  }
  /** Stop at once and give the bones back as the clip left them. */
  drop() { for (let i = 0; i < this.bones.length; i++) if (this.mine[i] && this.bones[i].quaternion.equals(this.last[i])) this.bones[i].quaternion.copy(this.base[i]); this.mine.fill(false); this.on = false; this.yaw.reset(0); this.pitch.reset(0); }
  update(dt) {
    if (!this.on) return;
    const f = this.f, head = this.bones[this.bones.length - 1];
    let wy = 0, wp = 0;
    if (this.weight > 0) {
      head.getWorldPosition(_v);
      const dx = this.point.x - _v.x, dy = this.point.y - _v.y, dz = this.point.z - _v.z;
      wy = clamp(angleDiff(Math.atan2(dx, dz), f.yaw), -this.limit, this.limit) * this.weight;
      wp = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.45, 0.45) * this.weight;
    }
    const yaw = this.yaw.step(wy, this.rate, dt), pitch = this.pitch.step(wp, this.rate, dt);
    if (this.weight === 0 && Math.abs(yaw) < 2e-3 && Math.abs(pitch) < 2e-3) { this.drop(); return; }
    _ax.set(Math.cos(f.yaw + yaw), 0, -Math.sin(f.yaw + yaw));                       // the axis her head nods about
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i], k = this.share[i];
      if (!this.mine[i] || !b.quaternion.equals(this.last[i])) this.base[i].copy(b.quaternion);      // the clip wrote a new pose
      _r.setFromAxisAngle(UP, yaw * k); _q.setFromAxisAngle(_ax, -pitch * k); _r.multiply(_q);       // the turn, in the world
      b.parent.getWorldQuaternion(_q); _qi.copy(_q).invert();
      b.quaternion.copy(_qi).multiply(_r).multiply(_q).multiply(this.base[i]);
      this.last[i].copy(b.quaternion); this.mine[i] = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------------- a hand that takes hold
const _ga = new THREE.Vector3(), _gb = new THREE.Vector3(), _gc = new THREE.Vector3(), _gt = new THREE.Vector3(), _gu = new THREE.Vector3(), _gw = new THREE.Vector3();
const _gf = new THREE.Vector3(), _gB = new THREE.Vector3(), _gn = new THREE.Vector3(), _fd = new THREE.Vector3(), _nd = new THREE.Vector3(), _gx = new THREE.Vector3(), _gs = new THREE.Vector3();
const _gh = new THREE.Vector3();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _d0 = new THREE.Quaternion(), _d1 = new THREE.Quaternion(), _d2 = new THREE.Quaternion(), _hq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _pi = new THREE.Quaternion();
const IDENT = new THREE.Quaternion();
const acos1 = (x) => Math.acos(x < -1 ? -1 : x > 1 ? 1 : x);
/** Turn a bone by a rotation given in the world (its own quaternion is rewritten; everything under it follows). */
function turnWorld(bone, dq) {
  bone.parent.matrixWorld.decompose(_gs, _pq, _gs);
  bone.quaternion.premultiply(_pi.copy(_pq).invert().multiply(dq).multiply(_pq));
  bone.updateMatrixWorld(true);
}
/**
 * A hand that takes hold of something standing still (her great sword, planted): after the pose, the arm is bent to
 * bring the hollow of the palm onto a point of the grip, the hand is turned so that the line across the palm lies
 * along the grip (thumb toward `axis`) with the palm against it, and the fingers close round it. `weight` (0..1) is
 * how far the arm has been taken from the clip, `grip` (0..1) how far the fingers are closed. The wardrobe does the
 * same for a sword she HOLDS; this is only for one she has not yet taken.
 */
class Grasp {
  constructor(f, side = 'Right') {
    const B = f.char.bones; this.f = f; this.sign = side === 'Right' ? 1 : -1;
    this.upper = B[side + 'Arm']; this.fore = B[side + 'ForeArm']; this.hand = B[side + 'Hand'];
    this.index = B[side + 'HandIndex1']; this.thumb = B[side + 'HandThumb1'];
    this.fingers = [1, 2, 3].map((k) => B[side + 'HandIndex' + k]).filter(Boolean);
    this.thumbs = [1, 2, 3].map((k) => B[side + 'HandThumb' + k]).filter(Boolean);
    this.ok = !!(this.upper && this.fore && this.hand && this.index && this.thumb);
    this.point = new THREE.Vector3(); this.axis = new THREE.Vector3(0, 1, 0); this.weight = 0; this.grip = 0;
    this.swing = 0;                      // radians: the hand comes round the grip from its own side by this much
    this.hollow = [0.050, 0.031];        // the middle of a closed fist from the wrist: along the fingers, out of the palm (figure units)
    this.curl = [74, 86, 55]; this.wrap = [38, 24, 32];      // degrees: the three finger joints; the thumb over the palm, then its two bends
  }
  /** The hand's own frame from its joints: f along the fingers, b across the palm toward the thumb, n out of the palm. */
  frame() {
    _gh.setFromMatrixPosition(this.hand.matrixWorld);
    _gf.setFromMatrixPosition(this.index.matrixWorld).sub(_gh).normalize();
    _gB.setFromMatrixPosition(this.thumb.matrixWorld).sub(_gh); _gB.addScaledVector(_gf, -_gB.dot(_gf)).normalize();
    _gn.crossVectors(_gB, _gf); if (this.sign < 0) _gn.negate();
  }
  update() {
    const w = this.weight; if (!this.ok || w <= 0.001) return;
    const S = this.f.char.scale || 1, up = this.upper, fo = this.fore, ha = this.hand, A = this.axis;
    // ---- how the hand should lie: fingers level, running past the grip from the shoulder's side; palm against the grip
    _ga.setFromMatrixPosition(up.matrixWorld);
    _fd.copy(this.point).sub(_ga); _fd.addScaledVector(A, -_fd.dot(A)).normalize();
    if (this.swing) _fd.applyAxisAngle(A, this.swing);
    _nd.crossVectors(A, _fd); if (this.sign < 0) _nd.negate();
    this.frame();
    _m1.makeBasis(_gf, _gB, _gn).transpose(); _m2.makeBasis(_fd, A, _nd).multiply(_m1);
    _d0.setFromRotationMatrix(_m2); if (w < 0.999) _d0.copy(IDENT).slerp(_d2.setFromRotationMatrix(_m2), w);
    ha.matrixWorld.decompose(_gs, _hq, _gs); _hq.premultiply(_d0);                   // the hand's turn in the world, afterwards
    // ---- where the wrist must be for the hollow of the palm to lie on the grip
    _gc.setFromMatrixPosition(ha.matrixWorld);
    _gt.copy(this.point).addScaledVector(_fd, -this.hollow[0] * S).addScaledVector(_nd, -this.hollow[1] * S).sub(_gc).multiplyScalar(w).add(_gc);
    // ---- two bones: open or close the elbow, the shoulder taking up the difference, then swing the arm onto the place
    _gb.setFromMatrixPosition(fo.matrixWorld);
    const l1 = _ga.distanceTo(_gb), l2 = _gb.distanceTo(_gc), eps = 0.002 * l1;
    const lat = Math.min(Math.max(_ga.distanceTo(_gt), Math.abs(l1 - l2) + eps), l1 + l2 - eps);
    _gu.subVectors(_gc, _ga).normalize(); _gw.subVectors(_gb, _ga).normalize();
    const a0 = acos1(_gu.dot(_gw)), b0 = acos1(-_gw.dot(_gx.subVectors(_gc, _gb).normalize()));
    _gx.crossVectors(_gu, _gw); if (_gx.lengthSq() < 1e-10) _gx.set(0, 0, 1); _gx.normalize();
    const a1 = acos1((l1 * l1 + lat * lat - l2 * l2) / (2 * l1 * lat)), b1 = acos1((l1 * l1 + l2 * l2 - lat * lat) / (2 * l1 * l2));
    _d1.setFromAxisAngle(_gx, b1 - b0);                                              // the elbow
    _d0.setFromAxisAngle(_gx, a1 - a0);                                              // the shoulder, in the arm's own plane
    _gw.subVectors(_gt, _ga).normalize(); _d2.setFromUnitVectors(_gu, _gw).multiply(_d0);
    turnWorld(fo, _d1); turnWorld(up, _d2);
    fo.matrixWorld.decompose(_gs, _pq, _gs); ha.quaternion.copy(_pq.invert().multiply(_hq)); ha.updateMatrixWorld(true);
    // ---- the fingers close round it; the thumb comes over from the other side
    const g = this.grip * w; if (g <= 0.001) return;
    this.frame();
    for (let i = 0; i < this.fingers.length; i++) turnWorld(this.fingers[i], _d0.setFromAxisAngle(_gB, this.sign * this.curl[i] * g * Math.PI / 180));
    if (this.thumbs.length) {
      this.frame();
      turnWorld(this.thumbs[0], _d0.setFromAxisAngle(_gf, -this.sign * this.wrap[0] * g * Math.PI / 180));
      if (this.thumbs[1]) {
        _gn.applyQuaternion(_d0);                                                    // (the thumb's bending plane swings over with it)
        _gx.setFromMatrixPosition(this.thumbs[1].matrixWorld).sub(_gu.setFromMatrixPosition(this.thumbs[0].matrixWorld)).normalize().cross(_gn).normalize();
        for (let i = 1; i < this.thumbs.length; i++) turnWorld(this.thumbs[i], _d0.setFromAxisAngle(_gx, this.wrap[i] * g * Math.PI / 180));
      }
    }
  }
}

/**
 * A weight on a spring: what a body does when it gives way. Asked to be somewhere else it starts slowly, gathers
 * speed, runs past, comes back and lies still (how far past: `zeta`, 1 = not at all, 0.4 = by a quarter; how fast:
 * `omega`, radians a second). It keeps the speed it has, so a thing handed to it mid-fall goes on falling. No easing
 * curve does that: a curve knows where it is going, a weight only what pulls at it.
 */
export class Weight {
  constructor(x = 0, v = 0) { this.x = x; this.v = v; }
  set(x, v = 0) { this.x = x; this.v = v; return this; }
  step(target, omega, zeta, dt) { this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * dt; this.x += this.v * dt; return this.x; }
}

/**
 * An arm let go. The hand hangs from the shoulder like a weight on a string: let go wherever it is, it falls (slowly at
 * first, then fast), comes down beside the body, is stopped by it, swings out again a little and hangs. `phi` is the
 * string's angle from the plumb line (radians), `w` its speed.
 */
export class Dangle {
  constructor() { this.on = false; this.phi = 0; this.w = 0; this.phi0 = 1; this.len = 1; this.x = 1; this.z = 0; }
  /** Let go: the hand is at `hand`, the shoulder at `shoulder` (world); w0: a speed it already has (+ = outward and up). */
  release(shoulder, hand, w0 = 0) {
    const ex = hand.x - shoulder.x, ey = hand.y - shoulder.y, ez = hand.z - shoulder.z, l = Math.hypot(ex, ey, ez) || 1, h = Math.hypot(ex, ez);
    this.on = true; this.len = l; this.phi = this.phi0 = Math.max(0.02, Math.acos(clamp(-ey / l, -1, 1))); this.w = w0;
    if (h > 1e-4) { this.x = ex / h; this.z = ez / h; }
    return this;
  }
  /**
   * One step. g: gravity over the arm's length (1/s2: a straight arm of two metres, hung by its end, 7.4), drag (1/s),
   * stop: how far past the plumb line the body lets it go (radians; it comes off the body with a quarter of its speed).
   */
  step(g, drag, stop, dt) {
    // (an arm held above the shoulder does not balance there like a rod stood on end: its elbow gives at once)
    const pull = Math.sin(this.phi) + 0.6 * Math.max(0, -Math.cos(this.phi));
    this.w += (-g * pull - drag * this.w) * dt; this.phi += this.w * dt;
    if (this.phi < -stop) { this.phi = -stop; this.w = Math.abs(this.w) * 0.25; }
    return this.phi;
  }
  /** How far it has come down: 0 as it was let go, 1 hanging. */
  get down() { return clamp(1 - this.phi / this.phi0, 0, 1); }
  /**
   * Where the hand is, the string `len` long at rest. On the way down the string is shorter (by `fold` of itself when
   * the hand is level with the shoulder): the elbow leads and the hand comes down near the body, it is not swung round
   * at arm's length.
   */
  point(shoulder, len, out, fold = 0.4) {
    const sn = Math.sin(this.phi), l = len * (1 - fold * sn * sn), s = sn * l;
    return out.set(shoulder.x + this.x * s, shoulder.y - Math.cos(this.phi) * l, shoulder.z + this.z * s);
  }
}

export class Stage {
  constructor(ctx) {
    this.ctx = ctx; this.dirty = new Set(); this.turns = new Map(); this.points = new Map(); this.planted = false; this.grasps = new Map(); this.graspsL = new Map();
    this.windRest = new Map(); this.wingRest = undefined; this.relaxed = null; this.keyRest = new Map(); this.posed = new Map();
    this.kept = new Map();                         // lookKeep: a fighter's eased look as the fight left it
    this.lookOpts = { weight: 1, speed: 3, limit: undefined, limitPitch: undefined, always: true, head: undefined, chest: undefined }; this.lookOff = { speed: 3, limitPitch: undefined };
    this.playMode = 'free';                        // the play camera's mode when the cutscene began (it is given back at the end)
    this.subtitleOn = false; this.nameOn = false;
  }
  get pilgrim() { return this.ctx.player; }
  get cantor() { return this.ctx.boss; }

  // ---------------------------------------------------------------- actors
  /** Both fighters are driven by the cutscene (true), or by a clip's own travel as well ('root'), or by their rules (false). */
  puppets(on) { this.ctx.player.puppet = on; this.ctx.boss.puppet = on; }

  /** Put a fighter somewhere at once (a cut). The pose and the cloth are settled in flush(). */
  place(f, x, z, yaw) {
    const near = Math.abs(f.pos.x - x) + Math.abs(f.pos.z - z) < 0.02 && (yaw === undefined || Math.abs(angleDiff(yaw, f.yaw)) < 0.01);
    f.pos.set(x, 0, z); if (yaw !== undefined) f.yaw = yaw;
    if (!near) this.dirty.add(f);                                 // already there: no need to shake his cloak out again
  }

  has(f, clip) { const c = f.char; return c.has ? c.has(clip) : !!(c.clips && c.clips.has(clip)); }

  /** Cross-fade a fighter to a clip. o: { fade = 0.3, at = 0, speed = 1 (0 holds the moment), loop }. Returns the action. */
  play(f, clip, o = {}) {
    if (!this.has(f, clip)) { console.warn(`cine: ${f.name || 'fighter'} has no clip "${clip}"`); clip = 'idle'; }
    const fade = o.fade === undefined ? 0.3 : o.fade;
    const a = f.char.play(clip, { fade, at: o.at || 0, speed: o.speed || 1, loop: o.loop, force: true });
    if (a && o.speed === 0) a.timeScale = 0;
    if (fade === 0) this.dirty.add(f);
    return a;
  }

  /** After the cuts of a step: fighters that were placed or re-posed at once take their pose now, not a step late. */
  flush() {
    if (!this.dirty.size) return;
    for (const f of this.dirty) {
      const turn = this.turns.get(f); if (turn) turn.mine.fill(false);
      f.char.update(0);
      f.root.updateMatrixWorld(true);
      if (f.kit && f.kit.teleport) f.kit.teleport();
    }
    this.dirty.clear();
  }

  /** Where a bone is in the world (as of the last drawn pose). */
  bone(f, name, out) { const b = f.char.bones[name]; if (b) b.getWorldPosition(out); else out.set(f.pos.x, 1.5 * (f.char.scale || 1), f.pos.z); return out; }

  /**
   * Head and chest toward a point in the world (null lets go). o: { weight, rate, limit (radians), head, chest,
   * limitPitch }. `head` and `chest` are the shares of the turn each takes (the animation runtime's own: 0.65 and
   * 0.35): head 1, chest 0 and a high rate PIN the face on the point whatever the clip underneath does with head and
   * neck (her power-up, the phase cutscene). `limitPitch` (radians; the runtime's is 40 degrees) is how far up or down
   * the face may be taken: it STAYS as set, on that fighter, until it is set again: whoever widens it puts it back.
   * May be asked every step: nothing is allocated.
   */
  look(f, point, o = {}) {
    const c = f.char;
    if (point) { let p = this.points.get(f); if (!p) this.points.set(f, p = new THREE.Vector3()); point = p.copy(point); }     // the caller's vector may be a scratch one
    // (the animation module weakens its look during attack clips: a cutscene plays such clips as acting, so `always`)
    if (c.look && !Stage.ownLook) {
      const q = this.lookOpts;
      if (point) { q.weight = o.weight === undefined ? 1 : o.weight; q.speed = o.rate || 3; q.limit = o.limit; q.limitPitch = o.limitPitch; q.head = o.head; q.chest = o.chest; c.look(point, q); }
      else { this.lookOff.speed = o.rate || 3; this.lookOff.limitPitch = o.limitPitch; c.look(null, this.lookOff); }
      return;
    }
    let t = this.turns.get(f); if (!t) { if (!point) return; this.turns.set(f, t = new HeadTurn(f)); }
    t.aim(point, o);
  }

  /**
   * A cutscene that begins in the MIDDLE of the fight (the change of phase) and turns a fighter's head must hand her
   * back exactly as the old cutscene did: the animation runtime's look is an eased thing (how far head and chest are
   * turned, and how much of that is on), her chest carries her arms and her blade, and the fight that follows must
   * be the same fight to the last digit (tools/capture.py --check). So: lookKeep(f, rate) notes the eased look as it
   * is at that step; when the cutscene ends (release) it is put back as it would be had it only been let go at
   * `rate` since (which is what the cutscene did before it turned her head).
   */
  lookKeep(f, rate = 3) {
    const L = f.char.graph && f.char.graph.look;
    if (L && 'amount' in L && !this.kept.has(f)) this.kept.set(f, { yaw: L.yaw, pitch: L.pitch, amount: L.amount, rate, t: 0, fresh: true });
  }

  /** Once a step, after the fighters have taken their pose. */
  update(dt) {
    // bones are read for framing and focus: keep their world matrices true on steps that are not drawn too
    this.ctx.player.root.updateMatrixWorld(); this.ctx.boss.root.updateMatrixWorld();
    for (const t of this.turns.values()) t.update(dt);
    for (const g of this.grasps.values()) g.update();
    for (const g of this.graspsL.values()) g.update();
    for (const k of this.kept.values()) { if (k.fresh) k.fresh = false; else k.t += dt; }      // (the fighter's own steps since: the one in which it was kept had been taken already)
  }

  /**
   * A fighter's hand takes hold of something that stands still: returns the Grasp (set .point, .axis, .weight, .grip,
   * .swing each step or once). It is dropped when the cutscene ends. side: 'Right' (the default) | 'Left': one of each
   * per fighter (the same solve also carries a hand that holds nothing to a place: an arm that hangs, ending.js).
   */
  grasp(f, side = 'Right') { const m = side === 'Right' ? this.grasps : this.graspsL; let g = m.get(f); if (!g) m.set(f, g = new Grasp(f, side)); return g; }

  /**
   * His arms hang at his sides (true) or do what the clip in front does (false). The pilgrim's walks and idle carry a
   * sword and a shield at guard: with the sword still in its scabbard that is an empty fist held up. This lays the
   * relaxed upper body of `look_around` over whatever his legs are doing.
   */
  relax(f, on, fade = 0.3) {
    const c = f.char; if (!c.overlay || !this.has(f, 'look_around')) return;
    if (on) { const h = c.overlay('look_around', { mask: 'upper', fade, loop: true, at: 5.5, force: true }); if (h) h.timeScale = 0; this.relaxed = f; }
    else if (c.overlayName === 'look_around') { c.overlayOff(fade); this.relaxed = null; }
  }

  /**
   * One moment of a clip laid over part of the body at a weight the cutscene keys step by step (her arms opening with
   * her pipes: `cast_wide`'s spread arms over the standing figure, never held still). weight 0 lets go.
   */
  pose(f, clip, at, weight, mask = 'arms') {
    const c = f.char; if (!c.overlay || !this.has(f, clip)) return;
    if (weight <= 0.002) { if (c.overlayName === clip) c.overlayOff(0.12); this.posed.delete(f); return; }
    const h = c.overlay(clip, { mask, weight, loop: true, at, fade: 0 });        // (asked again every step: only the weight is taken over)
    if (h) h.timeScale = 0;
    this.posed.set(f, clip);
  }

  /** A named moment of a clip (the animation owner's `marks`: when a hand reaches a hilt, when she is upright), or the fall-back. */
  mark(f, clip, name, fallback) {
    const c = f.char, i = c.info ? c.info(clip) : null, v = i && i.marks ? i.marks[name] : undefined;
    return Number.isFinite(v) ? v : fallback;
  }

  /**
   * How a clip that turns carries its fighter (the animation runtime takes travel and turn out of such clips and hands
   * them back step by step; a cutscene that scrubs one as a layer applies them itself): at clip time t, out.x (to her
   * left) and out.z (forward) in her own units, in the frame she stood in at the clip's start, out.yaw in radians.
   * Returns false when the runtime does not say (then the cutscene makes do with a curve of its own).
   */
  carried(f, clip, t, out) {
    const cl = f.char.clips, e = cl && cl.get ? cl.get(clip) : null, r = e && e.root; out.x = 0; out.z = 0; out.yaw = 0;
    if (!r || !r.times || r.times.length < 2) return false;
    const T = r.times, n = T.length; let lo = 0, hi = n - 1;
    if (t <= T[0]) hi = 1; else if (t >= T[n - 1]) lo = n - 2; else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    hi = lo + 1; const k = clamp((t - T[lo]) / (T[hi] - T[lo]), 0, 1);
    out.x = r.x[lo] + (r.x[hi] - r.x[lo]) * k; out.z = r.z[lo] + (r.z[hi] - r.z[lo]) * k; out.yaw = r.yaw[lo] + (r.yaw[hi] - r.yaw[lo]) * k;
    return true;
  }

  /** A footfall the cutscene makes itself (a step laid over her legs has no clip events): water, spray and sound answer it as they answer her own. */
  step(f, side) {
    const b = f.char.bones[side === 'l' ? 'LeftFoot' : 'RightFoot']; if (!b) return;
    b.getWorldPosition(_v); _v.y = 0;
    this.ctx.bus.emit('step', { who: f === this.ctx.boss ? 'boss' : 'player', pos: _v, foot: side, run: false });
  }

  /** Turn a fighter about a point of the floor (a foot or a knee that bears her weight), so that point does not slide. */
  pivot(f, px, pz, dyaw) {
    const c = Math.cos(dyaw), s = Math.sin(dyaw), x = f.pos.x - px, z = f.pos.z - pz;
    f.pos.x = px + x * c + z * s; f.pos.z = pz - x * s + z * c; f.yaw += dyaw;
  }

  /** Out of sight without touching `visible` (his lantern is a light: toggling it would recompile shaders). */
  hidePilgrim() {
    const p = this.ctx.player, d = this.ctx.arena.spawn.door;
    this.place(p, d.x, d.z + 8, Math.PI); this.lantern(0);
  }

  // ---------------------------------------------------------------- their things
  plant(x, z, yaw = 0) { const k = this.ctx.boss.kit; if (k.plantSword) { k.plantSword(x, z, yaw); this.planted = true; } }
  take() { const k = this.ctx.boss.kit; if (k.takeSword && (this.planted || k.swordPlanted)) k.takeSword(); this.planted = false; }
  wings(open, glow) { const w = this.ctx.boss.kit.wings; if (!w) return; if (open !== undefined) w.open = open; if (glow !== undefined) w.glow = glow; }
  pulse(strength = 1) { const w = this.ctx.boss.kit.wings; if (w && w.pulse) w.pulse(strength); }
  halo(glow) { const h = this.ctx.boss.kit.halo; if (h) h.glow = glow; }
  blade(glow) { const s = this.ctx.boss.kit.sword; if (s) s.glow = glow; }
  fade(k) { this.ctx.boss.kit.fade = k; }
  /** How fast her wings follow `open` (the wardrobe's default is kept and put back when the cutscene ends). */
  wingSpeed(v) { const w = this.ctx.boss.kit.wings; if (!w || typeof w.speed !== 'number') return; if (this.wingRest === undefined) this.wingRest = w.speed; w.speed = v === undefined ? this.wingRest : v; }
  /** Her wings at a value at once (a cut, a skip). */
  wingsNow(open) { const w = this.ctx.boss.kit.wings; if (!w) return; w.open = open; if (w.snap) w.snap(open); }
  /** The draught a fighter's cloth feels, m/s in the world; wind(f) with no numbers gives it back as the wardrobe had it. */
  wind(f, x, y, z) {
    const w = f.kit && f.kit.wind; if (!w || !w.isVector3) return;
    if (!this.windRest.has(f)) this.windRest.set(f, w.clone());
    if (x === undefined) w.copy(this.windRest.get(f)); else w.set(x, y, z);
  }
  sheathe(on) { const k = this.ctx.player.kit; if (k.sheathe) k.sheathe(on); }
  /**
   * The graphics owner's "fighters' key" on one fighter (the soft light that lifts both figures off the hall):
   * 1 as designed, 0 a true silhouette. Given back when the cutscene ends.
   */
  key(f, k) { const look = f.root && f.root.userData && f.root.userData.look; if (!look || typeof look.key !== 'number') return; if (!this.keyRest.has(f)) this.keyRest.set(f, look.key); look.key = k === undefined ? this.keyRest.get(f) : k; }
  lantern(level) { const l = this.ctx.player.kit.lantern; if (l) l.level = level; }

  // ---------------------------------------------------------------- the room
  ripple(x, z, strength = 1, radius = 0.4) { const w = this.ctx.water; if (w && w.ripple) w.ripple(x, z, strength, radius); }
  wake(x0, z0, x1, z1, strength = 1) { const w = this.ctx.water; if (w && w.wake) w.wake(x0, z0, x1, z1, strength); }
  snuff(x, z, radius, seconds) { const c = this.ctx.candles; if (c && c.snuff) c.snuff(_v.set(x, 0, z), radius, seconds); }
  snuffAll(seconds) { const c = this.ctx.candles; if (c && c.snuffAll) c.snuffAll(seconds); }
  relight(fraction, seconds) { const c = this.ctx.candles; if (c && c.relight) c.relight(fraction, seconds); }
  /** Blow the mist open round a place (0..1). */
  gust(x, z, power = 0.8) { const v = this.ctx.vfx; if (v && v.gust) v.gust(_v.set(x, 0, z), power); }
  mood(candle, gold) { const m = this.ctx.gfx.mood; if (candle !== undefined) m.candle = candle; if (gold !== undefined) m.gold = gold; }
  /** The light the candles give right now (0..1): the mood follows it while they die and catch. */
  candlelight() { const c = this.ctx.candles; return c ? (typeof c.burning === 'number' ? c.burning : c.lit) : 1; }
  /** Her own light, when the boss offers the handle (null gives it back to her). */
  bossLight(level) { const b = this.ctx.boss; if ('lightLevel' in b) b.lightLevel = level; }
  /** The lit candle nearest a place, or the place itself when the candles do not say where they are. */
  candleNear(x, z, out) {
    const c = this.ctx.candles; out.set(x, 0.12, z);
    if (c && c.litNear) {
      // (litNear looks through a third of the candles at a time: ask for each third and keep the nearest)
      let best = 1e9, found = false;
      for (let k = 0; k < 3; k++) if (c.litNear(x, z, _v, k)) { const d = (_v.x - x) * (_v.x - x) + (_v.z - z) * (_v.z - z); if (d < best) { best = d; out.copy(_v); found = true; } }
      if (!found) out.set(x, 0.12, z);
      return out;
    }
    const list = c && (c.items || c.list); if (!list) return out;
    let best = 1e9;
    for (const it of list) { if (it.to === 0 || it.lit === false) continue; const d = Math.hypot(it.x - x, it.z - z); if (d < best) { best = d; out.set(it.x, it.y === undefined ? 0.15 : it.y, it.z); } }
    return out;
  }
  /** How far the nearest lit candle is from a place over the water (a large number when there is none). */
  candleGap(x, z) { const c = this.ctx.candles; if (!c || !c.litNear) return 99; this.candleNear(x, z, _gapv); const d = Math.hypot(_gapv.x - x, _gapv.z - z); return d < 1e-4 ? 99 : d; }

  // ---------------------------------------------------------------- sound and words
  /** A spoken line with its subtitle. */
  voice(name, text, seconds, who = 'cantor') {
    const ctx = this.ctx;
    if (ctx.audio && ctx.audio.voice) { const p = ctx.audio.voice(name); if (p && p.catch) p.catch(() => {}); }
    if (ctx.ui && ctx.ui.subtitle) { ctx.ui.subtitle(text, seconds); this.subtitleOn = true; }
    ctx.bus.emit('subtitle', { text, seconds, who });
  }
  /** A sound the bus does not already cause (the sound owner's names: 'sword_draw', 'hymn_cast' ...). */
  sound(name, pos, volume = 1) { const a = this.ctx.audio; if (a && a.play) a.play(name, pos ? { pos, volume } : { volume }); }
  nameCard(text, seconds) { const ui = this.ctx.ui; if (ui && ui.nameCard) { ui.nameCard(text, seconds); this.nameOn = !!text; } }
  /** A cutscene was cut short: take its words off the screen. */
  hush() {
    const ui = this.ctx.ui;
    if (this.subtitleOn && ui && ui.subtitle) ui.subtitle(null, 0);
    if (this.nameOn && ui && ui.nameCard) ui.nameCard(null);
    this.subtitleOn = false; this.nameOn = false;
  }

  /** The cutscene is over: nobody is a puppet, nobody's head is held. */
  release() {
    for (const [f, t] of this.turns) { t.drop(); if (f.char.look) f.char.look(null); }
    this.turns.clear(); this.grasps.clear(); this.graspsL.clear();
    if (this.relaxed) this.relax(this.relaxed, false, 0.2);
    for (const [f, clip] of this.posed) if (f.char.overlayName === clip) f.char.overlayOff(0);      // (only a skip finds one still on)
    this.posed.clear();
    const p = this.ctx.player, b = this.ctx.boss;
    if (p.char.look) p.char.look(null); if (b.char.look) b.char.look(null);
    for (const [f, k] of this.kept) {                              // (lookKeep: her eased look as the fight left it, let go at `rate` since)
      const L = f.char.graph && f.char.graph.look; this.lookOff.speed = k.rate; f.char.look(null, this.lookOff);
      if (L && 'amount' in L) { L.yaw = k.yaw; L.pitch = k.pitch; L.amount = k.amount * Math.exp(-k.rate * k.t); }
    }
    this.kept.clear();
    this.bossLight(null); b.pos.y = 0;
    this.wingSpeed(); for (const f of this.windRest.keys()) this.wind(f);
    for (const f of this.keyRest.keys()) this.key(f);
    this.puppets(false);
  }
}
Stage.ownLook = false;      // true: always use the head turn here, even when the animation module has its own
