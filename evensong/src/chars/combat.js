// Who hits whom (docs/engine.md, "Combat"; more in docs/modules/player.md).
//
//   const w = combat.addWeapon({ owner, base, tip, radius })      base, tip: Object3D along the blade; radius in the owner's own units
//   combat.arm(w, { damage, poise, heavy, knockdown, reach })     open a hit window: one hit per target per window
//   combat.disarm(w), combat.removeWeapon(w)
//   combat.strike({ attacker, target, point?, dir?, damage, poise, heavy, knockdown })   a hit that is not a blade
//   combat.update(dt)                                             sweeps every armed blade against the other fighter
//   combat.sweepNow(w, dt) -> 0..1, combat.resync(w)              an owner sweeps her own blade inside her update (see sweepNow)
//   combat.armed(owner)                                           is one of this fighter's blades live?
//   combat.threat(target)  -> { live, dist, closing, eta, vel }   the nearest blade of the other side, as a player sees it
//   combat.warn({ target, eta, kind }), combat.incoming(target)   a blow that is not a blade is so many seconds away
//
// Every hit carries `weight`: 'light' | 'heavy' | 'colossal' (docs/impact.md: everything felt on the contact frame is
// scaled by it). Whoever strikes may set it (arm(w, { weight }) or strike({ weight })); left out, it is worked out here:
// hers: 'colossal' if it throws him down, else 'heavy' for her blade and her heavy blows, 'light' for the small things
// of light (a ring, a blade of the Hymn: under 28); his: 'heavy' for his heavy blows, else 'light'. A blow that kills, or
// that breaks her poise, is made 'colossal' after it has landed.
//
// A blade is a solid thing: the pilgrim's live blade is also swept against the stones of the hall (arena.colliders,
// arena.piers) and the floor. Stone stops it: 'clash' { point, stone: true, dir } and owner.bladeStopped(info) (he
// recoils); the floor is told once a swing: 'clash' { point, stone: true, floor: true }. Both carry the blow's weight
// (`weight`, `heavy`) and `who: 'player'`. The Cantor's blade against stone is her own business (boss.js, bladeStone:
// she must put her pose back before her kit is placed): she tells the same `clash` with `who: 'boss'`.
//
// The blade is a segment from base to tip. Each step it is swept from where it was to where it is, in slices fine
// enough that nothing can pass through between two slices, against the target's capsules (Character.hurt).
// Every hit, blade or not, is offered to target.takeHit(hit) first: the target may block it (hit.blocked = true),
// change hit.damage, or return false to refuse it (rolling, already down). Then 'hit' goes out on the bus with
// `fatal` filled in, and 'clash' { point } too when it was blocked.
//
// Generous to the pilgrim, exact for the Cantor:
//   - his blade counts 0.14 m fatter than it is, and a big target (her) also has capsules for her feet and for the
//     robes between her legs, so a cut at her ankles or into her skirts lands;
//   - her blade is exactly as fat as the wardrobe says, and it cannot hit his arms (only torso, head and legs), so
//     his own sword arm reaching out never costs him a blow.
import * as THREE from 'three';

const GRACE = 0.14;                 // metres added to the pilgrim's blade
// How high a fallen stone stands when the arena does not say (collider.h), and how far inside its collider's circle
// the stone itself begins. Both are guesses from pictures of the hall as it is built today, and both err on the side of
// the blade passing: a clash in the empty air over a low stone looks worse than a blade grazing its edge. The great
// stone head (1.55 m round) stands about 1.6 m, a drum of the toppled pier lies waist high, the heap of vault stones
// is knee high.
const stoneHeight = (c) => (c.h !== undefined ? c.h : c.r >= 1.4 ? 1.6 : c.r <= 1.0 ? 0.95 : 0.7);
const STONE_IN = 0.05;                // the colliders are fitted to the drawn stones now (look polish, 8 Nov): a blade stops at the stone's face
const PIER_R = 0.85;                // a pier of the arcade, for his blade (arena.piers gives only where they stand)
const HEAD_TRIM = 0.11;             // his head capsule ends this far (in his own units) under its bone's end: it stood 12 cm over his drawn hood
const SLICE_PLAYER = 0.14, SLICE_BOSS = 0.2;      // how far the tip may travel between two slices of a sweep
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3(), _a0 = new THREE.Vector3(), _b0 = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();

/** Closest points of two segments (p1-q1, p2-q2): the squared distance; the points in c1, c2; how far along the first in segSeg.s. */
function segSeg(p1, q1, p2, q2, c1, c2) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  c1.copy(p1).addScaledVector(_d1, s); c2.copy(p2).addScaledVector(_d2, t);
  segSeg.s = s;
  return c1.distanceToSquared(c2);
}

/** The two ends of one of a character's capsules, in the world. Both shapes are understood:
 *  { a: Object3D, b: Object3D, r } (between two bones) and { bone, a: Vector3, b: Vector3, r } (in a bone's space). */
function capsuleEnds(cap, outA, outB) {
  if (cap.bone) { cap.bone.updateWorldMatrix(true, false); outA.copy(cap.a).applyMatrix4(cap.bone.matrixWorld); outB.copy(cap.b).applyMatrix4(cap.bone.matrixWorld); }
  else { cap.a.getWorldPosition(outA); cap.b.getWorldPosition(outB); }
}
const boneName = (cap) => { const o = cap.bone || cap.a; return (o && o.name) || ''; };

export class Combat {
  constructor(ctx) {
    this.ctx = ctx; this.weapons = []; this.warnings = []; this.time = 0; this.stepNo = 0;
    this._threat = { live: false, dist: Infinity, closing: 0, eta: Infinity, vel: new THREE.Vector3(), weapon: null };
    this._extra = new Map();          // fighter -> the extra capsules of a big target
    this._arms = new Map();           // fighter -> which of its capsules are arms
    this._crown = new Map();          // fighter -> which of its capsules is the top of the head
    this._stop = { point: new THREE.Vector3(), normal: new THREE.Vector3(), dir: new THREE.Vector3(), u: 1, floor: false, weapon: null };
  }

  addWeapon(w) {
    w.armed = null; w.prevBase = new THREE.Vector3(); w.prevTip = new THREE.Vector3(); w.fresh = true;
    w.nowBase = new THREE.Vector3(); w.nowTip = new THREE.Vector3(); w.vel = new THREE.Vector3(); w.dist = Infinity; w.closing = 0; w.seen = false; w.inStone = false;
    this.weapons.push(w); return w;
  }
  removeWeapon(w) { const i = this.weapons.indexOf(w); if (i >= 0) this.weapons.splice(i, 1); }
  /** Open a hit window. o: { damage, poise, heavy, knockdown, reach (extra metres), once = true }. */
  arm(w, o = {}) {
    const a = w._arm || (w._arm = { hit: new Set() });
    a.damage = o.damage !== undefined ? o.damage : (w.damage || 10); a.poise = o.poise || 0; a.heavy = o.heavy !== undefined ? !!o.heavy : !!w.heavy;
    a.knockdown = !!o.knockdown; a.reach = o.reach || 0; a.weight = o.weight || null; a.hit.clear();
    w.armed = a; if (!w.seen) w.fresh = true; w.inStone = false; w.onFloor = false;      // a blade that was being watched keeps its last place: the first slice sweeps from there
  }
  disarm(w) { w.armed = null; }
  /** Is one of this fighter's blades live? */
  armed(owner) { for (const w of this.weapons) if (w.owner === owner && w.armed) return true; return false; }

  /** Deliver a hit. Returns the hit if it landed (blocked or not), null if the target refused it. */
  strike(hit) {
    const t = hit.target, ctx = this.ctx;
    if (!t || !t.alive) return null;
    hit.blocked = false; hit.fatal = false; hit.poise = hit.poise || 0; hit.heavy = !!hit.heavy; hit.damage = hit.damage || 0;
    const scale = t.char ? t.char.scale : 1;
    if (!hit.dir) { hit.dir = new THREE.Vector3(); if (hit.attacker && hit.attacker.pos) hit.dir.subVectors(t.pos, hit.attacker.pos); hit.dir.y = 0; if (hit.dir.lengthSq() < 1e-8) hit.dir.set(0, 0, 1); hit.dir.normalize(); }
    if (!hit.point) hit.point = new THREE.Vector3(t.pos.x, 1.1 * scale, t.pos.z).addScaledVector(hit.dir, -Math.min(0.3 * scale, t.radius || 0.3));
    // how heavy it is, for everything that answers it (docs/impact.md): the striker's word, or worked out here
    if (hit.weight !== 'light' && hit.weight !== 'heavy' && hit.weight !== 'colossal') {
      const big = !!(hit.attacker && hit.attacker.char && hit.attacker.char.scale > 1.5);
      hit.weight = big ? (hit.knockdown ? 'colossal' : hit.heavy || hit.weapon || hit.damage >= 28 ? 'heavy' : 'light') : hit.heavy ? 'heavy' : 'light';
    }
    const wasDown = !!t.staggered;
    if (t.takeHit(hit) === false) return null;
    hit.fatal = !t.alive;
    if (hit.fatal || (!wasDown && t.staggered)) hit.weight = 'colossal';       // the killing blow, the breaking of her poise
    ctx.bus.emit('hit', hit);
    if (hit.blocked) ctx.bus.emit('clash', { point: hit.point });
    return hit;
  }

  /** A blow that is not a blade (a ring, a wave, a flying blade of light) will reach `target` in `eta` seconds if he
   *  stays where he is. Nothing is done with it here: the test player reads it (as a person reads the glow). */
  warn(o) { if (this.warnings.length < 32) this.warnings.push({ target: o.target || this.ctx.player, at: this.time + Math.max(0, o.eta || 0), kind: o.kind || 'blow' }); }
  /** Seconds until the next announced blow reaches this fighter (Infinity if none). */
  incoming(target) { let best = Infinity; for (const w of this.warnings) if (w.target === target && w.at - this.time < best) best = w.at - this.time; return best; }

  /** The nearest blade of the other side: is it live, how far is it from this fighter's body, how fast is it closing.
   *  The result is one shared object: read it, do not keep it. */
  threat(target) {
    const t = this._threat; t.live = false; t.dist = Infinity; t.closing = 0; t.eta = Infinity; t.weapon = null; t.vel.set(0, 0, 0);
    for (const w of this.weapons) {
      if (w.owner === target) continue;
      w.watch = 12;                                                        // keep measuring this blade for a little while
      if (!w.seen) continue;
      const live = !!w.armed;
      if (t.weapon && !(live && !t.live) && !(live === t.live && w.dist < t.dist)) continue;      // a live blade first, then the nearest
      t.live = live; t.dist = w.dist; t.closing = w.closing; t.weapon = w; t.vel.copy(w.vel);
    }
    if (t.weapon && t.closing > 0.5) t.eta = Math.max(0, t.dist - 0.45) / t.closing;
    return t;
  }

  /** The extra capsules of a big target (the Cantor): her feet and the robes between her legs. */
  _extraFor(f) {
    let e = this._extra.get(f);
    if (e === undefined) {
      const B = f.char && f.char.bones, big = f.char && f.char.scale > 1.5;
      e = big && B && B.Hips && B.LeftFoot && B.RightFoot ? { hips: B.Hips, lf: B.LeftFoot, rf: B.RightFoot, lt: B.LeftToeBase || null, rt: B.RightToeBase || null } : null;
      this._extra.set(f, e);
    }
    return e;
  }
  _isArm(f, cap) {
    let m = this._arms.get(f); if (!m) this._arms.set(f, m = new Map());
    let v = m.get(cap); if (v === undefined) { v = /Arm|Hand|Shoulder/.test(boneName(cap)); m.set(cap, v); }
    return v;
  }

  _isCrown(f, cap) {
    let m = this._crown.get(f); if (!m) this._crown.set(f, m = new Map());
    let v = m.get(cap); if (v === undefined) { v = /HeadTop/.test((cap.b && cap.b.name) || ''); m.set(cap, v); }
    return v;
  }

  /** Does the blade segment (_a0, _b0) touch `target`? If so the contact is left in _q (on her) and _p (on the blade). */
  _touch(w, target, reachBlade) {
    const scale = target.char.scale, generous = w.owner === this.ctx.player, hurt = target.char.hurt || [];
    for (let i = 0; i < hurt.length; i++) {
      const cap = hurt[i];
      if (!generous && this._isArm(target, cap)) continue;
      capsuleEnds(cap, _c, _d);
      if (!generous && this._isCrown(target, cap)) { _w.subVectors(_c, _d); const l = _w.length(); if (l > 1e-4) _d.addScaledVector(_w, Math.min(l, HEAD_TRIM * scale) / l); }      // exact for her: the top of his head is where it is drawn
      const reach = reachBlade + cap.r * scale;
      if (segSeg(_a0, _b0, _c, _d, _p, _q) <= reach * reach) { this._surface(cap.r * scale); return true; }
    }
    if (generous) {
      const e = this._extraFor(target);
      if (e) {
        e.hips.getWorldPosition(_c); e.lf.getWorldPosition(_d); e.rf.getWorldPosition(_v); _d.add(_v).multiplyScalar(0.5);
        let r = 0.17 * scale, reach = reachBlade + r;
        if (segSeg(_a0, _b0, _c, _d, _p, _q) <= reach * reach) { this._surface(r); return true; }
        r = 0.085 * scale; reach = reachBlade + r;
        if (e.lt) { e.lf.getWorldPosition(_c); e.lt.getWorldPosition(_d); if (segSeg(_a0, _b0, _c, _d, _p, _q) <= reach * reach) { this._surface(r); return true; } }
        if (e.rt) { e.rf.getWorldPosition(_c); e.rt.getWorldPosition(_d); if (segSeg(_a0, _b0, _c, _d, _p, _q) <= reach * reach) { this._surface(r); return true; } }
      }
    }
    return false;
  }
  /** Move the contact point from the capsule's axis out to its surface, toward the blade. */
  _surface(r) { _w.subVectors(_p, _q); const l = _w.length(); if (l > 1e-5) _q.addScaledVector(_w, Math.min(r, l) / l); }

  /** Does the blade segment a-b (a = by the hand) lie in stone (a fallen block, a drum, a pier)? If so the place where
   *  it enters is left in _p (on the stone's face, at the blade's height there) and the way out of the stone in _r. */
  _stone(a, b) {
    const arena = this.ctx.arena, cs = arena.colliders, piers = arena.piers;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    for (let pass = 0; pass < 2; pass++) {
      const list = pass ? piers : cs; if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const c = list[i], r = pass ? PIER_R : Math.max(0.2, c.r - STONE_IN), h = pass ? 99 : stoneHeight(c);
        // the stretch of the blade over the stone's footprint: from t0 to t1 along it (0 = hand end, 1 = point)
        const fx = a.x - c.x, fz = a.z - c.z, cq = fx * fx + fz * fz - r * r;
        let t0 = 0, t1 = 1;
        if (l2 > 1e-9) {
          const bq = fx * dx + fz * dz, disc = bq * bq - l2 * cq; if (disc <= 0) continue;
          const q = Math.sqrt(disc); t0 = (-bq - q) / l2; t1 = (-bq + q) / l2;
          if (t1 <= 0 || t0 >= 1) continue; if (t0 < 0) t0 = 0; if (t1 > 1) t1 = 1;
        } else if (cq >= 0) continue;
        // ... and of that, the part that is lower than the stone stands
        const y0 = a.y + dy * t0, y1 = a.y + dy * t1;
        if (y0 > h && y1 > h) continue;
        const t = y0 <= h ? t0 : t0 + (t1 - t0) * (y0 - h) / (y0 - y1);    // where it comes down into the stone
        _p.set(a.x + dx * t, a.y + dy * t, a.z + dz * t);
        _r.set(_p.x - c.x, 0, _p.z - c.z); if (_r.lengthSq() < 1e-8) _r.set(a.x - c.x, 0, a.z - c.z); if (_r.lengthSq() < 1e-8) _r.set(0, 0, 1); _r.normalize();
        return true;
      }
    }
    return false;
  }

  update(dt) {
    this.time += dt; this.stepNo++;
    if (this.warnings.length) { for (let i = this.warnings.length - 1; i >= 0; i--) if (this.warnings[i].at < this.time - 0.15) this.warnings.splice(i, 1); }
    for (const w of this.weapons) { if (w.doneStep === this.stepNo) continue; this._weapon(w, dt); }      // (a blade its owner has already swept this step: sweepNow)
  }

  /**
   * One blade's step, NOW: for an owner who must know within her own update whether, and how far through this step's
   * travel, her blade struck (the Cantor: she puts her pose back to that moment before her kit is placed, so the frame
   * the world holds on shows the blade ON him, not past him). Everything update() would do for this blade is done here
   * instead (the hit is delivered at once: takeHit, the events). Returns how far through the step it struck (0..1],
   * or 0 for no hit. After changing her pose she calls resync(w).
   */
  sweepNow(w, dt) { w.doneStep = this.stepNo + 1; return this._weapon(w, dt); }
  /** The blade has been put somewhere else at once (a pose put back): its sweep goes on from where it is now. */
  resync(w) { w.base.getWorldPosition(w.prevBase); w.tip.getWorldPosition(w.prevTip); }

  _weapon(w, dt) {
    const ctx = this.ctx;
    {
      const armed = w.armed, watched = w.watch > 0;
      if (!armed && !watched) { w.fresh = true; w.seen = false; return 0; }
      const owner = w.owner, target = owner === ctx.player ? ctx.boss : ctx.player;
      w.base.getWorldPosition(_a); w.tip.getWorldPosition(_b);
      if (w.fresh) { w.prevBase.copy(_a); w.prevTip.copy(_b); }
      w.vel.subVectors(_b, w.prevTip).divideScalar(dt);
      if (target && target.char) {
        // how near the blade is to his body (a standing line from shin to head), for whoever is watching it
        const s = target.char.scale; _c.set(target.pos.x, 0.25 * s, target.pos.z); _d.set(target.pos.x, 1.6 * s, target.pos.z);
        const d = Math.sqrt(segSeg(_a, _b, _c, _d, _p, _q));
        w.closing = w.seen ? w.closing + ((w.dist - d) / dt - w.closing) * 0.5 : 0; w.dist = d;
      }
      w.seen = true; if (watched) w.watch--;
      let struck = 0, slices = 1;
      if (armed && target && target.alive && target.char && !target.puppet && !owner.puppet && !armed.hit.has(target)) {
        const generous = owner === ctx.player;
        const reachBlade = (w.radius || 0.05) * (owner.char ? owner.char.scale : 1) + (generous ? GRACE : 0) + armed.reach;
        const travel = Math.max(_b.distanceTo(w.prevTip), _a.distanceTo(w.prevBase));
        const n = slices = w.fresh ? 1 : Math.min(12, Math.max(1, Math.ceil(travel / (generous ? SLICE_PLAYER : SLICE_BOSS))));
        for (let k = 1; k <= n; k++) {                                     // the blade between the last step and this one, slice by slice
          const u = k / n; _a0.lerpVectors(w.prevBase, _a, u); _b0.lerpVectors(w.prevTip, _b, u);
          if (!this._touch(w, target, reachBlade)) continue;
          armed.hit.add(target); struck = k;
          const dir = new THREE.Vector3().copy(w.vel); if (dir.lengthSq() < 0.04) dir.subVectors(target.pos, owner.pos).setY(0); dir.normalize();
          this.strike({ attacker: owner, target, point: _q.clone(), dir, damage: armed.damage, poise: armed.poise, heavy: armed.heavy, knockdown: armed.knockdown, weight: armed.weight, weapon: w });
          w.base.getWorldPosition(_a); w.tip.getWorldPosition(_b);         // (listeners may have asked the world for places: ours again)
          break;
        }
      }
      // the pilgrim's blade is a solid thing: stone stops it (a pier, a fallen block), the floor is struck, not entered
      if (w.armed && owner === ctx.player && ctx.arena && !owner.puppet) {
        const travel = Math.max(_b.distanceTo(w.prevTip), _a.distanceTo(w.prevBase)), n = w.fresh ? 1 : Math.min(12, Math.max(1, Math.ceil(travel / SLICE_PLAYER)));
        const last = struck || n;                                          // what lies behind her is not reached in the step she is struck
        for (let k = 1; k <= last; k++) {
          const u = k / n; _a0.lerpVectors(w.prevBase, _a, u); _b0.lerpVectors(w.prevTip, _b, u);
          if (!this._stone(_a0, _b0)) continue;
          if (w.inStone) break;                                            // it was in the stone when the swing went live: one clash is enough
          w.inStone = true;
          const st = this._stop; st.point.copy(_p); st.normal.copy(_r); st.dir.copy(w.vel).normalize(); st.u = (k - 1) / n; st.floor = false; st.weapon = w;
          ctx.bus.emit('clash', { point: _p.clone(), stone: true, dir: st.dir.clone(), normal: _r.clone(), heavy: !!w.armed.heavy, weight: w.armed.weight || (w.armed.heavy ? 'heavy' : 'light'), who: 'player' });
          if (typeof owner.bladeStopped === 'function') owner.bladeStopped(st);
          break;
        }
        if (w.armed && !w.onFloor) {
          const fy = ctx.arena.ground ? ctx.arena.ground(_b.x, _b.z) : 0, wet = fy < 0.02 ? (typeof ctx.arena.waterY === 'number' ? ctx.arena.waterY : 0.07) : fy;
          if (_b.y < wet + 0.01 && w.vel.y < -0.5) {
            w.onFloor = true;
            const st = this._stop; st.point.set(_b.x, wet, _b.z); st.normal.set(0, 1, 0); st.dir.copy(w.vel).normalize(); st.u = 1; st.floor = true; st.weapon = w;
            ctx.bus.emit('clash', { point: st.point.clone(), stone: true, floor: true, dir: st.dir.clone(), normal: st.normal.clone(), heavy: !!(w.armed && w.armed.heavy), weight: (w.armed && w.armed.weight) || (w.armed && w.armed.heavy ? 'heavy' : 'light'), who: 'player' });
            if (typeof owner.bladeStopped === 'function') owner.bladeStopped(st);
          }
        }
      }
      w.prevBase.copy(_a); w.prevTip.copy(_b); w.fresh = false;
      return struck ? struck / slices : 0;
    }
  }

  dispose() { this.weapons.length = 0; this.warnings.length = 0; this._extra.clear(); this._arms.clear(); this._crown.clear(); }
}
