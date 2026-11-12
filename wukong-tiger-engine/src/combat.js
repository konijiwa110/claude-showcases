// Hit detection: bone-attached sphere/capsule shapes (from `hit` events) swept per frame against target capsules.
import * as THREE from "three";

const EPS = 1e-9;
/** squared distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9) */
export function segSegDist2(p1, q1, p2, q2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= EPS && e <= EPS) { s = t = 0; }
  else if (a <= EPS) { s = 0; t = Math.min(Math.max(f / e, 0), 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = Math.min(Math.max(-c / a, 0), 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > EPS ? Math.min(Math.max((b * f - c * e) / den, 0), 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(Math.max(-c / a, 0), 1); }
      else if (t > 1) { t = 1; s = Math.min(Math.max((b - c) / a, 0), 1); }
    }
  }
  const x = p1.x + d1x * s - (p2.x + d2x * t), y = p1.y + d1y * s - (p2.y + d2y * t), z = p1.z + d1z * s - (p2.z + d2z * t);
  return x * x + y * y + z * z;
}

/** Vertical hurt capsule of a character (feet pos + capsule {radius, halfHeight} in UE semantics). */
export function hurtCapsule(ch, cap, out) {
  const r = cap.radius, h = Math.max(2 * cap.halfHeight, 2 * r);
  const p = ch.position;
  out.a.set(p.x, p.y + r, p.z); out.b.set(p.x, p.y + h - r, p.z); out.r = r;
  return out;
}

/**
 * Pawn vs pawn blocking (UE capsule sweep on the Pawn channel): clips the horizontal part of `delta` (mutated) so a
 * mover at `pos` cannot enter the circle of radius R around `other`; the remainder slides tangentially.
 */
export function blockMove(pos, delta, other, R) {
  const px = pos.x - other.x, pz = pos.z - other.z;
  const dx = delta.x, dz = delta.z;
  const a = dx * dx + dz * dz;
  if (a < 1e-10) return delta;
  const c = px * px + pz * pz - R * R;
  if (c <= 0) {
    // already touching: only allow motion that does not go further in
    const d = Math.sqrt(px * px + pz * pz) || 1e-6, nx = px / d, nz = pz / d;
    const into = dx * nx + dz * nz;
    if (into < 0) { delta.x -= nx * into; delta.z -= nz * into; }
    return delta;
  }
  const b = 2 * (px * dx + pz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return delta;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return delta;
  // stop at contact, slide the rest along the tangent
  const cx = px + dx * t, cz = pz + dz * t, cl = Math.hypot(cx, cz) || 1e-6, nx = cx / cl, nz = cz / cl;
  let rx = dx * (1 - t), rz = dz * (1 - t);
  const into = rx * nx + rz * nz;
  rx -= nx * into; rz -= nz * into;
  delta.x = dx * t + rx; delta.z = dz * t + rz;
  return delta;
}

/**
 * Tracks bone positions of one attacker's active hit events and tests them against targets.
 * Each event instance hits a given target at most once per clip play.
 */
export class HitTracker {
  constructor(ch, defaultRadius) {
    this.ch = ch;
    this.defaultRadius = defaultRadius;
    this.prev = new Map(); // bone -> Vector3 from previous frame (only while a hit window is active)
    this.hitKeys = new Set();
    this.playId = null;
  }
  reset() { this.prev.clear(); this.hitKeys.clear(); }

  /** returns array of {event, point} for `hit` windows that touch capsule `cap` this frame (once per window) */
  test(cap, targetId) {
    const ch = this.ch;
    const playKey = ch.cur ? ch.cur.stamp : null;
    if (playKey !== this.playId) { this.playId = playKey; this.reset(); }
    const active = ch.activeEvents("hit");
    if (!active.length) { this.prev.clear(); return []; }
    const res = [];
    const cur = new Map();
    for (const e of active) {
      // windows sharing a SweepCheck group id count as one (data damageModel.oncePerTarget)
      const slot = e.group != null && e.group >= 0 ? `g${e.group}` : ch.cur.meta.events.indexOf(e);
      const key = `${slot}@${targetId}`;
      if (this.hitKeys.has(key)) { this.sample(e, cur); continue; }
      const point = this.overlap(e, cap, cur, this.prev);
      if (point) { this.hitKeys.add(key); res.push({ event: e, point }); }
    }
    for (const [n, p] of cur) this.prev.set(n, p);
    return res;
  }

  sample(e, cur) {
    for (const n of e.bones || []) if (!cur.has(n)) { const p = this.ch.bonePos(n); if (p) cur.set(n, p); }
  }

  /** sphere per bone/socket (radii[i] | radius | default) swept from its previous-frame position */
  overlap(e, cap, cur, prev) {
    const names = e.bones || [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      let p = cur.get(n);
      if (!p) { p = this.ch.bonePos(n); if (!p) continue; cur.set(n, p); }
      const pp = prev?.get(n) || p;
      const r = (e.radii?.[i] ?? e.radius ?? this.defaultRadius) + cap.r;
      if (segSegDist2(pp, p, cap.a, cap.b) <= r * r) return p.clone();
    }
    return null;
  }

  /** does any active event of `type` (e.g. "warning"/"hit") overlap `cap` right now? */
  overlapsNow(type, cap) {
    const cur = new Map();
    for (const e of this.ch.activeEvents(type)) if (this.overlap(e, cap, cur, null)) return e;
    return null;
  }
}
