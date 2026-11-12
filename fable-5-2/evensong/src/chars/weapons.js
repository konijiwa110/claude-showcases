// Weapons and the other hard things a fighter carries: where they sit on the body, what they are made of, how a hand
// closes round them, and the lantern's swing. (Cloth is cloth.js, her wings are wings.js, wardrobe.js puts a whole
// fighter together.)
//
//   makeCarry(char, o)            -> keeps a carried thing out of its bearer's body by turning the arm that carries it
//   makeHand(char, side, o)       -> fingers and thumb that close round a grip, or hang at ease
//   grip(char)                    -> Object3D in the right fist, from the MEASURED hold (docs/grips.md): its origin the
//                                    middle of the fist on the grip, +y up the blade, x the edge's way, z the flat's normal
//   shieldSocket(char)            -> the same for the shield on the left forearm
//   makeWeapon(ctx, kind, look)   -> { object, base, tip, radius, length, kind, anchors, materials }
//                                    kind: 'longsword' | 'greatsword' | 'shield' | 'lantern' | 'scabbard' | 'flask' | 'pipe'
//   place(char, bone, at, name)   -> Object3D riding on a bone, put where `at` (a Matrix4 or [x, y, z]) is ON THE
//                                    FIGURE AT REST, in the figure's own units: it does not matter what pose the
//                                    figure is in when this is called
//
// Sizes are in the character's own units (a 1.8 m figure), because these things hang inside the scaled model.
// The models come from tools/kit_weapons/build_props.py (Blender); the files carry shapes, corner colours and
// material NAMES; the materials themselves are made here (LOOKS), so they can be tuned without Blender.
import * as THREE from 'three';

const P = 'assets/models/props/';
const tex = (file, srgb) => ({ url: P + file, type: 'texture', srgb, repeat: true });
/** Files this module needs (wardrobe.js exports them on as part of its ASSETS). */
export const ASSETS = {
  'prop.greatsword': P + 'greatsword.glb', 'prop.pipe': P + 'pipe.glb',
  'prop.longsword': P + 'longsword.glb', 'prop.scabbard': P + 'scabbard.glb', 'prop.shield': P + 'shield.glb', 'prop.lantern': P + 'lantern.glb', 'prop.flask': P + 'flask.glb',
  'prop.tex.metal_orm': tex('tex_metal_orm.webp', false), 'prop.tex.metal_n': tex('tex_metal_n.webp', false),
  'prop.tex.shield': tex('tex_shield.webp', true), 'prop.tex.shield_orm': tex('tex_shield_orm.webp', false), 'prop.tex.shield_n': tex('tex_shield_n.webp', false),
};

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();
const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);

// ------------------------------------------------------------------------------------------------------ rest pose
/** A bone's matrix at rest, in the model's own space (from the skin's bind matrices, so the present pose does not matter). */
export function restMatrix(char, boneName, out = new THREE.Matrix4()) {
  const bone = char.bones[boneName];
  if (!bone) throw new Error(`${char.name}: no bone "${boneName}"`);
  const mesh = char.meshes && char.meshes.find((m) => m.isSkinnedMesh && m.skeleton && m.skeleton.bones.includes(bone));
  if (mesh) return out.copy(mesh.skeleton.boneInverses[mesh.skeleton.bones.indexOf(bone)]).invert();
  // no skin to ask (a bare skeleton): take the pose as it stands
  char.model.updateWorldMatrix(true, true);
  return out.copy(char.model.matrixWorld).invert().multiply(bone.matrixWorld);
}
const restPoint = (char, boneName, out) => out.setFromMatrixPosition(restMatrix(char, boneName, _m2));

/** An Object3D riding on a bone, standing where `at` is on the figure at rest (a Matrix4, or a point [x, y, z]). */
export function place(char, boneName, at, name) {
  const s = new THREE.Object3D(); s.name = name || 'kit:' + boneName;
  const want = at.isMatrix4 ? at : _m.makeTranslation(at[0], at[1], at[2]);
  new THREE.Matrix4().copy(restMatrix(char, boneName, _m2)).invert().multiply(want).decompose(s.position, s.quaternion, s.scale);
  char.bones[boneName].add(s);
  return s;
}

/**
 * An Object3D riding on a bone, given in the bone's OWN frame (position in figure units, quaternion [x, y, z, w]):
 * for holds measured on Mixamo's own skeleton, whose bones turn exactly as ours do once the rest-pose correction is on.
 */
export function placeLocal(char, boneName, position, quaternion, name) {
  const bone = char.bones[boneName]; if (!bone) throw new Error(`${char.name}: no bone "${boneName}"`);
  const s = new THREE.Object3D(); s.name = name || 'kit:' + boneName;
  s.position.set(position[0], position[1], position[2]); if (quaternion) s.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]).normalize();
  bone.add(s);
  return s;
}

// ----------------------------------------------------------------------------------------------------------- holds
// Where things sit in the hand and on the forearm. These are MEASURED, not fitted by eye: the lead took them from
// Mixamo's own characters that carry the props the clips were animated with (the sword-and-shield figure and the
// great-sword figure): source-art/mixamo/wprop/grips.json, docs/grips.md. Each is a frame in the carrying bone's
// OWN frame (figure units), valid because, with the rest-pose correction on, our bones turn exactly as Mixamo's do.
//   swords:  position = where the hilt's axis passes through the fist; y_blade = up the blade; x_edge = toward an
//            edge (across the blade); z_flat = the flat's normal
//   shield:  position = its middle; x_side = along the forearm toward the elbow; y_top = its top; z_face = its face
const HOLDS = {
  knight: {
    sword: { bone: 'RightHand', position: [0.017, 0.084, 0.0294], x_edge: [-0.1606, 0.9566, 0.2432], y_blade: [0.8533, 0.2584, -0.4529], z_flat: [-0.496, 0.1348, -0.8577] },
    shield: { bone: 'LeftForeArm', position: [0.014, 0.1467, -0.035], x_side: [0.0488, -0.9962, -0.0719], y_top: [-0.998, -0.0515, 0.0368], z_face: [-0.0404, 0.07, -0.9968] },
  },
  cantor: {
    sword: { bone: 'RightHand', position: [-0.0057, 0.0921, 0.0157], x_edge: [0.2921, -0.7494, 0.5942], y_blade: [0.8396, 0.4986, 0.2159], z_flat: [-0.458, 0.4358, 0.7748] },
  },
};
/** The hollow of a closed fist with nothing measured for it, from the wrist: across the palm, along the fingers, out of the palm (figure units). */
export const HOLLOW = [0, 0.050, 0.031];
const holdsOf = (char) => HOLDS[char.name in HOLDS ? char.name : /cantor/.test(char.name) ? 'cantor' : 'knight'];
/** A socket on a bone from a measured hold: makeBasis(x, y, z).setPosition(position) in the bone's own frame. It remembers where that is on the figure at rest (userData.rest). */
function socketOf(char, h, x, y, z, name) {
  const local = new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z)).setPosition(h.position[0], h.position[1], h.position[2]);
  const s = new THREE.Object3D(); s.name = name; s.applyMatrix4(local); char.bones[h.bone].add(s);
  s.userData.rest = restMatrix(char, h.bone, new THREE.Matrix4()).multiply(local); s.userData.hold = h;
  return s;
}
export function handFrame(char, side, o) {
  restPoint(char, side + 'Hand', _a); const hx = _a.x, hy = _a.y, hz = _a.z;
  restPoint(char, side + 'HandIndex1', _b); restPoint(char, side + 'HandThumb1', _c);
  const f = new THREE.Vector3().subVectors(_b, _a).normalize();
  const b = new THREE.Vector3().subVectors(_c, _a); b.addScaledVector(f, -b.dot(f)).normalize();
  const n = new THREE.Vector3().crossVectors(b, f); if (side !== 'Right') n.negate();
  o.f = f; o.b = b; o.n = n; o.hand = new THREE.Vector3(hx, hy, hz);
  return o;
}
/**
 * The socket a sword hangs in, in the right fist: its origin the middle of the fist on the grip, +y up the blade,
 * x the edge's direction, z the flat's normal: the measured hold, used as it stands (the sword files are modelled to
 * the same axes). `fit` overrides it: { bone, position, x_edge, y_blade, z_flat }.
 */
export function grip(char, side = 'Right', fit) {
  if (side !== 'Right') throw new Error('wardrobe: only the right hand has a measured grip');
  const h = fit || holdsOf(char).sword;
  return socketOf(char, h, h.x_edge, h.y_blade, h.z_flat, 'grip:' + side);
}
/** The socket the shield hangs in, on the left forearm: its origin the shield's middle on the arm's side, +x along the arm toward the elbow, +y its top, +z out of its face. */
export function shieldSocket(char, fit) {
  const h = fit || holdsOf(char).shield;
  return socketOf(char, h, h.x_side, h.y_top, h.z_face, 'kit:shield');
}
/** A point or direction on the figure at rest, mirrored to the other side of the body. */
export const mirrored = (v) => new THREE.Vector3(-v.x, v.y, v.z);

/**
 * Fingers that close. The rigs have two chains per hand (a thumb, and one "index" that stands for all four fingers);
 * most clips carry no finger keys at all (a channel that does not change inside a clip was dropped when the clips
 * were packed), so an open hand would hold the hilt, and an empty hand would hang like a paddle.
 *   hand.set(k)    k = 0 (as the pose stands: nothing is written) .. 1 (closed on what it holds); call it every step
 *                  after the pose. In between it blends from the pose as it stands.
 *   hand.relax(w)  an EMPTY hand: every finger joint the clip left unkeyed takes a natural half-curl (w = 0..1); joints
 *                  the clip does move are left alone. Call it instead of set(), or before set() while a hand lets go.
 *   o.round: { point, axis, radius } on the figure at rest: a hilt to close ROUND. The finger chain is laid tangent to
 *            it, joint by joint, over its far side; the thumb comes round the near side to meet it, so the grip sits
 *            inside the fist whatever its size and place. Without it: a plain fist.
 */
export function makeHand(char, side, o = {}) {
  const H = handFrame(char, side, {}), B = char.bones, bones = [], shut = [], soft = [], unkeyed = [];
  const sign = side === 'Right' ? 1 : -1, DEG = Math.PI / 180;
  // turning f toward n is a turn about f x n = b (right hand; the left hand's n is mirrored, so -b)
  const acrossPalm = H.b.clone().multiplyScalar(sign);
  const J = [1, 2, 3, 4].map((k) => restPoint(char, side + 'HandIndex' + k, new THREE.Vector3())), T = [1, 2, 3, 4].map((k) => restPoint(char, side + 'HandThumb' + k, new THREE.Vector3()));
  // what the hand closes round: the hilt it was given, or (a plain fist) a thin roll lying in the hollow of the palm
  const grip = o.round || { point: H.hand.clone().addScaledVector(H.f, J[0].clone().sub(H.hand).dot(H.f) + 0.012).addScaledVector(H.n, 0.02), axis: H.b.clone(), radius: 0.016 };
  const A = grip.axis.clone().normalize(), R = grip.radius;

  // ---- the fingers: in the plane the finger bends in (u along the finger at rest, v out of the palm), from the first
  // knuckle: each bone in turn is laid along the tangent from its joint to the hilt's circle, passing on the outside
  const fu = J[1].clone().sub(J[0]).normalize(), fAcross = new THREE.Vector3().crossVectors(fu, H.n).normalize();
  const fv = new THREE.Vector3().crossVectors(fAcross, fu).normalize(); if (fv.dot(H.n) < 0) fv.negate();
  const curlRound = () => {
    const den = A.dot(fAcross), hit = Math.abs(den) > 0.2 ? grip.point.clone().addScaledVector(A, J[0].clone().sub(grip.point).dot(fAcross) / den) : grip.point.clone();      // where the hilt crosses the finger's plane
    const cu = hit.clone().sub(J[0]).dot(fu), cv = hit.clone().sub(J[0]).dot(fv);
    let ju = 0, jv = 0, dir = 0; const out = [];
    for (let k = 0; k < 3; k++) {
      const L = J[k + 1].distanceTo(J[k]), du = cu - ju, dv = cv - jv, dist = Math.hypot(du, dv), to = Math.atan2(dv, du);
      // the tangent that keeps the hilt on the palm side of the finger. A joint that already lies against the hilt (the
      // measured holds sit deep in the palm, at the knuckles) simply closes as a fist does; no joint ever bends backward
      let bend;
      if (dist > R * 1.02) { bend = to - Math.asin(R / dist) - dir; while (bend > Math.PI) bend -= 2 * Math.PI; while (bend < -Math.PI) bend += 2 * Math.PI; } else bend = 1.4;
      bend = Math.max(0, Math.min(1.83, bend)); const a = dir + bend;
      out.push(bend / DEG); ju += Math.cos(a) * L; jv += Math.sin(a) * L; dir = a;
    }
    return out;
  };
  const curl = o.curl || curlRound();
  /** Where the finger's joints are when it is bent so (on the figure at rest): [second joint, third joint, tip]. */
  const fingerAt = (bends) => { const out = [], at = J[0].clone(); let a = 0; for (let k = 0; k < 3; k++) { a += bends[k] * DEG; at.addScaledVector(fu, Math.cos(a) * J[k + 1].distanceTo(J[k])).addScaledVector(fv, Math.sin(a) * J[k + 1].distanceTo(J[k])); out.push(at.clone()); } return out; };

  // ---- the thumb. It lies beside the fingers at rest, in the palm's plane. Closing, it comes out of the palm and
  // curls to meet the fingers, so that thumb and fingers ring the grip from two sides: its end is laid on the finger
  // (the frontmost of the finger's joints and tip that it can reach without passing through the grip), its three
  // bones bent evenly, bowed away from the grip. Worked in the plane square to the hilt, through the thumb's root:
  // angle 0 = straight out of the palm, 90 degrees = along the fingers.
  const eF = H.f.clone().addScaledVector(A, -H.f.dot(A)).normalize(), eN = new THREE.Vector3().crossVectors(A, eF); if (eN.dot(H.n) < 0) eN.negate();
  const toFingers = A.clone().multiplyScalar(J[0].clone().sub(T[0]).dot(A) > 0 ? 1 : -1);       // along the hilt, from the thumb's root toward the knuckles
  const TL = [0, 1, 2].map((k) => T[k + 1].distanceTo(T[k])), reach = TL[0] + TL[1] + TL[2];
  const rest0 = T[1].clone().sub(T[0]), phiRest = Math.atan2(rest0.dot(eF), rest0.dot(eN));
  const in2 = (p) => [p.clone().sub(T[0]).dot(eF), p.clone().sub(T[0]).dot(eN)];
  const thumbClosed = () => {
    const c = in2(grip.point), fj = fingerAt(curl), clearOf = R * 0.8;
    let best = null;
    for (const p of fj) {
      const q = in2(p), out = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1;
      const tf = q[0] + (q[0] - c[0]) / out * 0.014, tn = q[1] + (q[1] - c[1]) / out * 0.014, D = Math.hypot(tf, tn);      // on the finger's outside
      if (D > reach * 0.96 || D < reach * 0.3) continue;
      const u = Math.max(0, Math.min(1, (c[0] * tf + c[1] * tn) / (D * D))), gap = Math.hypot(c[0] - tf * u, c[1] - tn * u);   // the grip's middle from the straight way there
      if (gap < clearOf) continue;
      if (!best || tn > best.tn) best = { tf, tn, D };
    }
    if (!best) {                                            // nothing to lay it on: across the front of the fist
      const phi1 = phiRest - 55 * DEG; return [phi1, phi1 + 50 * DEG, phi1 + 95 * DEG];
    }
    // even bends b at the two outer joints so that the end is D from the root (bisection: more bend, nearer)
    const end = (b) => [TL[0] + TL[1] * Math.cos(b) + TL[2] * Math.cos(2 * b), TL[1] * Math.sin(b) + TL[2] * Math.sin(2 * b)];
    let lo = 0.05, hi = 1.6; for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2, e = end(mid); if (Math.hypot(e[0], e[1]) > best.D) lo = mid; else hi = mid; }
    const bnd = (lo + hi) / 2, e = end(bnd), lead = Math.atan2(e[1], e[0]), to = Math.atan2(best.tf, best.tn);
    const phi1 = Math.max(to - lead, phiRest - 75 * DEG);    // (its root gives at most that much out of the palm)
    return [phi1, phi1 + bnd, phi1 + 2 * bnd];
  };
  const thumbDirs = (phis, lean, splay = 0) => phis.map((phi, k) => new THREE.Vector3().addScaledVector(eN, Math.cos(phi)).addScaledVector(eF, Math.sin(phi)).addScaledVector(toFingers, lean * k - splay).normalize());

  // ---- from wanted bends and directions to each bone's own quaternion. A bone's turn from rest is given in the
  // model's space at rest; a child inherits its parent's (local' = parentRest^-1 * parentTurn^-1 * turn * rest)
  const restQ = (name) => new THREE.Quaternion().setFromRotationMatrix(restMatrix(char, name, new THREE.Matrix4()));
  const localOf = (name, parentTurn, turn) => {
    const bone = B[name], qp = bone.parent && bone.parent.isBone ? restQ(bone.parent.name.replace(/^mixamorig\d*:?/, '')) : new THREE.Quaternion();
    return qp.invert().multiply(parentTurn.clone().invert()).multiply(turn).multiply(restQ(name));
  };
  const fingerPose = (bends) => { let turn = new THREE.Quaternion(); const out = []; for (let k = 0; k < 3; k++) { const parent = turn; turn = parent.clone().multiply(new THREE.Quaternion().setFromAxisAngle(acrossPalm, bends[k] * DEG)); out.push(localOf(side + 'HandIndex' + (k + 1), parent, turn)); } return out; };
  const thumbPose = (dirs) => {
    let turn = new THREE.Quaternion(); const out = [];
    for (let k = 0; k < 3; k++) {
      const parent = turn, was = T[k + 1].clone().sub(T[k]).normalize().applyQuaternion(parent);       // where this bone points if it only follows its parent
      turn = new THREE.Quaternion().setFromUnitVectors(was, dirs[k]).multiply(parent);                 // a plain bend at this joint brings it round
      out.push(localOf(side + 'HandThumb' + (k + 1), parent, turn));
    }
    return out;
  };
  const names = [1, 2, 3].map((k) => side + 'HandIndex' + k).concat([1, 2, 3].map((k) => side + 'HandThumb' + k));
  const closed = fingerPose(curl).concat(thumbPose(thumbDirs(thumbClosed(), 0.1)));
  // an empty hand at ease: fingers a third closed, the thumb a little out of the palm's plane
  const easy = fingerPose([24, 32, 22]).concat(thumbPose(thumbDirs([phiRest - 24 * DEG, phiRest - 12 * DEG, phiRest + 4 * DEG], 0, 0.42)));
  // what the animation writes into a bone no clip moves: the clips' own rest pose (character.js, tposeWorld)
  const _tp = new THREE.Quaternion(), _tb = new THREE.Quaternion();
  names.forEach((name, i) => {
    const bone = B[name]; if (!bone) return;
    bones.push(bone); shut.push(closed[i]); soft.push(easy[i]);
    let still = bone.quaternion.clone();
    if (typeof char.tposeWorld === 'function' && bone.parent && bone.parent.isBone) { try { char.tposeWorld(bone.parent.name.replace(/^mixamorig\d*:?/, ''), _tp); char.tposeWorld(name, _tb); still = _tp.clone().invert().multiply(_tb); } catch (e) { /* an older character: the pose as it stands */ } }
    unkeyed.push(still);
  });
  return {
    side, bones, k: 0, curl,
    set(k) { this.k = k; if (k <= 0.001) return; for (let i = 0; i < bones.length; i++) { if (k >= 0.999) bones[i].quaternion.copy(shut[i]); else bones[i].quaternion.slerp(shut[i], k); } },
    relax(w = 1) {
      if (w <= 0.001) return;
      for (let i = 0; i < bones.length; i++) {
        const q = bones[i].quaternion, off = q.angleTo(unkeyed[i]); if (off > 0.26) continue;       // the clip moves this joint: it is the clip's
        const m = off < 0.035 ? w : w * (1 - (off - 0.035) / 0.225);
        if (m >= 0.999) q.copy(soft[i]); else q.slerp(soft[i], m);
      }
    },
    open() { for (let i = 0; i < bones.length; i++) bones[i].quaternion.copy(unkeyed[i]); },
  };
}

// ----------------------------------------------------------------------------------------------------------- reach
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pt = new THREE.Vector3(), _ax0 = new THREE.Vector3(), _ax1 = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _d0 = new THREE.Quaternion(), _d1 = new THREE.Quaternion(), _d2 = new THREE.Quaternion(), _qs = new THREE.Quaternion();
const _s3 = new THREE.Vector3();
const clamp1 = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
/** Turn a bone by a rotation given in the world (dq), by rewriting its own quaternion. */
function turnInWorld(bone, dq) { bone.parent.matrixWorld.decompose(_s3, _qp, _s3); bone.quaternion.premultiply(_qs.copy(_qp).invert().multiply(dq).multiply(_qp)); }

/**
 * A hand that finds a hilt: two-bone reach for an arm (upper arm, forearm, hand), after the pose. Call
 * arm.reach(target, weight) with the place its fist's hollow should be (world) and how much to move it (0..1);
 * the elbow keeps the side it was on. arm.hollow(out) says where the fist's hollow is now (world).
 * arm.align(axis, weight) then turns the hand so its palm lies along a hilt (axis: a world direction).
 */
export function makeArm(char, side, o = {}) {
  const B = char.bones, upper = B[side + 'Arm'], fore = B[side + 'ForeArm'], hand = B[side + 'Hand'], H = handFrame(char, side, {});
  // the middle of the fist and the line a hilt takes through it, in the hand bone's own frame
  // (o.point, o.line: given on the figure at rest; by default the palm's hollow and the line across the palm)
  const inv = restMatrix(char, side + 'Hand', new THREE.Matrix4()).invert();
  const hollowLocal = (o.point ? o.point.clone() : H.hand.clone().addScaledVector(H.b, HOLLOW[0]).addScaledVector(H.f, HOLLOW[1]).addScaledVector(H.n, HOLLOW[2])).applyMatrix4(inv);
  const acrossLocal = (o.line ? o.line.clone() : H.b.clone()).normalize().transformDirection(inv);
  return {
    side, upper, fore, hand,
    hollow(out) { return out.copy(hollowLocal).applyMatrix4(hand.matrixWorld); },
    /** The world direction of the line across the palm (toward the thumb). */
    across(out) { return out.copy(acrossLocal).transformDirection(hand.matrixWorld); },
    reach(target, weight) {
      if (weight <= 0.001) return;
      _pa.setFromMatrixPosition(upper.matrixWorld); _pb.setFromMatrixPosition(fore.matrixWorld); _pc.setFromMatrixPosition(hand.matrixWorld);
      // the wrist must move as far as the hollow must
      this.hollow(_pt); _pt.subVectors(target, _pt).multiplyScalar(weight).add(_pc);
      const l1 = _pa.distanceTo(_pb), l2 = _pb.distanceTo(_pc), eps = 0.002 * l1;
      let lat = _pa.distanceTo(_pt); lat = Math.min(Math.max(lat, Math.abs(l1 - l2) + eps), l1 + l2 - eps);
      _u.subVectors(_pc, _pa).normalize(); _w.subVectors(_pb, _pa).normalize();
      const acab0 = Math.acos(clamp1(_u.dot(_w)));
      _ax0.crossVectors(_u, _w); if (_ax0.lengthSq() < 1e-10) _ax0.set(0, 0, 1); _ax0.normalize();
      const babc0 = Math.acos(clamp1(-_w.dot(_s3.subVectors(_pc, _pb).normalize())));
      const acab1 = Math.acos(clamp1((l2 * l2 - l1 * l1 - lat * lat) / (-2 * l1 * lat))), babc1 = Math.acos(clamp1((lat * lat - l1 * l1 - l2 * l2) / (-2 * l1 * l2)));
      _w.subVectors(_pt, _pa).normalize(); const acat = Math.acos(clamp1(_u.dot(_w)));
      _ax1.crossVectors(_u, _w); if (_ax1.lengthSq() < 1e-10) _ax1.copy(_ax0); _ax1.normalize();
      // shoulder: open or close the triangle, then swing it onto the target; elbow: the matching bend
      _d0.setFromAxisAngle(_ax0, acab1 - acab0); _d2.setFromAxisAngle(_ax1, acat); _d2.multiply(_d0);
      _d1.setFromAxisAngle(_ax0, babc1 - babc0);
      hand.matrixWorld.decompose(_s3, _qc, _s3);                           // the hand keeps the way it faced
      turnInWorld(fore, _d1); turnInWorld(upper, _d2);
      upper.updateMatrixWorld(true);
      fore.matrixWorld.decompose(_s3, _qb, _s3); hand.quaternion.copy(_qb.invert().multiply(_qc));
      hand.updateMatrixWorld(true);
    },
    align(axis, weight) {
      if (weight <= 0.001) return;
      this.across(_u); if (_u.dot(axis) < 0) _u.negate();                  // whichever way round is nearer
      _d0.setFromUnitVectors(_u, axis); if (weight < 0.999) _d0.slerp(_qs.identity(), 1 - weight);
      this.hollow(_pt);                                                    // turn about the hollow, so the fist stays where it is
      turnInWorld(hand, _d0); hand.updateMatrixWorld(true);
    },
  };
}

// ----------------------------------------------------------------------------------------------------------- carry
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _gr = new THREE.Vector3(), _gc1 = new THREE.Vector3(), _gc2 = new THREE.Vector3(), _q0 = new THREE.Vector3();
/** Closest points of two segments (p1-q1, p2-q2) into c1, c2; returns their distance. */
function closest(p1, q1, p2, q2, c1, c2) {
  _g1.subVectors(q1, p1); _g2.subVectors(q2, p2); _gr.subVectors(p1, p2);
  const a = _g1.dot(_g1), e = _g2.dot(_g2), f = _g2.dot(_gr), c = _g1.dot(_gr), b = _g1.dot(_g2), den = a * e - b * b;
  let s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = e > 1e-9 ? (b * s + f) / e : 0;
  if (t < 0) { t = 0; s = a > 1e-9 ? Math.min(1, Math.max(0, -c / a)) : 0; } else if (t > 1) { t = 1; s = a > 1e-9 ? Math.min(1, Math.max(0, (b - c) / a)) : 0; }   // (a = 0: the first "segment" is a point)
  c1.copy(p1).addScaledVector(_g1, s); c2.copy(p2).addScaledVector(_g2, t);
  return c1.distanceTo(c2);
}
/**
 * Keeps a thing a fighter carries out of his own body (a blade also out of his shield and the floor) by moving the
 * ARM that carries it, never the thing in the hand: the measured hold (docs/grips.md) stays exactly as it is, a fist
 * closed square round a grip, in every frame. The clips were made on another body, some with nothing in the hands
 * (a sprint, rolls, getting up, a bow): where one would put the blade or the board through him, the outermost joint
 * turns first, just far enough (the wrist for a sword, the forearm for a shield), and what it cannot give comes from
 * the shoulder. It takes hold at once (the thing slides along the body instead of entering it) and lets go slowly.
 * It is a safety net: in the sword-and-shield and great-sword clips it hardly acts (tools/kit_weapons/holds.mjs
 * prints how many degrees, clip by clip).
 *   o.object        the thing (a child, however deep, of joints[0].bone): the shapes are in its own frame
 *   o.segs          [{ a: [x, y, z], b: [x, y, z], r }]: what of it must stay clear: segments with a radius (a blade)
 *                   or points (a board's rim), figure units
 *   o.joints        [{ bone, max }] from the hand inward: joints[0] turns first, at most `max` radians, then the next
 *   o.order         which joint is tried first, second ... (indices into joints; default as listed)
 *   o.body, o.names a cloth.js Capsules and the names of those to keep out of;  o.margin (figure units)
 *   o.disc          { object, radius, offset }: a round board (its own +z is its face) no segment may pass through
 *   o.floor         world y nothing may go under, a number or a function giving it (omit: no floor);  o.back: how fast it lets go (per second)
 * carry.update(dt) each step after the pose, with the body's capsules current. carry.amount: radians the first
 * joint is turned now, carry.amounts[i] each of them. carry.rest(seconds): let be for so long, then ease in (a draw).
 */
export function makeCarry(char, o) {
  const S = char.scale, J = o.joints.length, body = o.body, margin = (o.margin !== undefined ? o.margin : 0.008) * S, back = o.back || 5, disc = o.disc || null, floor = o.floor;
  const segs = o.segs.map((g) => ({ a: new THREE.Vector3(...g.a), b: new THREE.Vector3(...g.b), r: g.r * S }));
  const n = segs.length, a0 = segs.map(() => new THREE.Vector3()), b0 = segs.map(() => new THREE.Vector3()), a1 = segs.map(() => new THREE.Vector3()), b1 = segs.map(() => new THREE.Vector3());
  const Q = o.joints.map(() => new THREE.Quaternion()), Qwas = o.joints.map(() => new THREE.Quaternion()), P = o.joints.map(() => new THREE.Vector3()), Pj = new THREE.Vector3(), Qin = new THREE.Quaternion();
  const quick = o.quick !== undefined ? o.quick : 0.16;      // the most a joint's turn changes in one step (radians): a blade that arrives at speed is met over two or three steps, not in one twitch
  const tq = new THREE.Vector3(), lev = new THREE.Vector3(), nrm = new THREE.Vector3(), tmp = new THREE.Vector3(), dq = new THREE.Quaternion(), ca = new THREE.Vector3(), cb = new THREE.Vector3(), dc = new THREE.Vector3(), dn = new THREE.Vector3(), x = new THREE.Vector3(), e = new THREE.Vector3(), t2 = new THREE.Vector3(), ident = new THREE.Quaternion();
  let ids = null, wait = 0, gain = 1, hits = 0, floorY;
  const order = o.order || o.joints.map((_, i) => i);
  const angle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  /** Where a point of the clip's pose is with the turns found so far (joints[0]'s first, then the next's about its own pivot ...). */
  const carryPoint = (p, out) => { out.copy(p); for (let j = 0; j < J; j++) out.sub(P[j]).applyQuaternion(Q[j]).add(P[j]); return out; };
  /** One small turn that would lift a touching point out: about the pivot, along the push, weighed with the rest. */
  const push = (at, dir, depth) => { lev.subVectors(at, Pj); const l2 = lev.lengthSq(); if (l2 < 1e-8 * S * S) return; tq.addScaledVector(tmp.crossVectors(lev, dir), depth / l2); hits++; };
  /** Everything that touches, with the turns as they stand, as one small turn about joint j's pivot (in tq). */
  const look = (j) => {
    tq.set(0, 0, 0); hits = 0;
    Pj.copy(P[j]); for (let k = j + 1; k < J; k++) Pj.sub(P[k]).applyQuaternion(Q[k]).add(P[k]);       // where joint j itself is, carried by those inward of it
    const C = body.cur, RAD = body.rad;
    for (let i = 0; i < n; i++) {
      carryPoint(a0[i], a1[i]); carryPoint(b0[i], b1[i]);
      const A = a1[i], B2 = b1[i], r = segs[i].r;
      for (let c = 0; c < ids.length; c++) {
        const k = ids[c] * 6; ca.set(C[k], C[k + 1], C[k + 2]); cb.set(C[k + 3], C[k + 4], C[k + 5]);
        const d = closest(A, B2, ca, cb, _gc1, _gc2), RR = RAD[ids[c]] + r + margin;
        if (d >= RR) continue;
        nrm.subVectors(_gc1, _gc2); if (d < 1e-5 * S) nrm.set(0, 1, 0); else nrm.multiplyScalar(1 / d);
        push(_gc1, nrm, RR - d);
      }
      if (floorY !== undefined) { const fy = floorY + r; if (A.y < fy) push(A, nrm.set(0, 1, 0), fy - A.y); if (B2.y < fy) push(B2, nrm.set(0, 1, 0), fy - B2.y); }
      if (disc && A.distanceToSquared(B2) > 1e-10) {
        // through the board? turn the lesser way: back to the side it came from, or out past the rim
        const da = x.subVectors(A, dc).dot(dn), db = x.subVectors(B2, dc).dot(dn);
        if (da * db < 0) {
          const u = da / (da - db); x.copy(A).lerp(B2, u); e.subVectors(x, dc); e.addScaledVector(dn, -e.dot(dn)); const rr = e.length(), R = disc.radius * S;
          if (rr < R) {
            const far = Pj.distanceToSquared(B2) > Pj.distanceToSquared(A) ? B2 : A, df = far === B2 ? db : da, depth = Math.abs(df) + margin + r;      // the end away from the hand comes back
            const turnSide = depth / Math.max(far.distanceTo(Pj), 0.15 * S), turnRim = (R - rr + margin + r) / Math.max(x.distanceTo(Pj), 0.15 * S);
            if (turnSide <= turnRim) push(far, nrm.copy(dn).multiplyScalar(df > 0 ? -1 : 1), depth);
            else { if (rr > 1e-5 * S) e.multiplyScalar(1 / rr); else e.set(dn.y, -dn.x, 0).normalize(); push(t2.copy(x), e, R - rr + margin + r); }
          }
        }
      }
    }
    return hits;
  };
  const carry = {
    amount: 0, amounts: o.joints.map(() => 0),
    reset() { for (const q of Q) q.identity(); for (const q of Qwas) q.identity(); this.amount = 0; this.amounts.fill(0); },
    rest(seconds) { wait = seconds; gain = 0; this.reset(); },
    update(dt) {
      if (!ids) ids = body.ids(o.names);
      if (wait > 0) { wait -= dt; return; }
      if (gain < 1) gain = Math.min(1, gain + dt * 3);
      const m = o.object.matrixWorld;
      floorY = typeof floor === 'function' ? floor() : floor;
      for (let i = 0; i < n; i++) { a0[i].copy(segs[i].a).applyMatrix4(m); b0[i].copy(segs[i].b).applyMatrix4(m); }
      for (let j = 0; j < J; j++) P[j].setFromMatrixPosition(o.joints[j].bone.matrixWorld);
      if (disc) { const d = disc.object.matrixWorld.elements; dn.set(d[8], d[9], d[10]).normalize(); dc.set(d[12], d[13], d[14]).addScaledVector(dn, (disc.offset || 0) * S); }
      // let go a little, then take up whatever touches
      const ease = Math.exp(-back * dt); let any = false;
      for (let j = 0; j < J; j++) Qwas[j].copy(Q[j]);
      for (let j = 0; j < J; j++) { if (Q[j].w < 0.9999995) { Q[j].slerp(ident, 1 - ease); any = true; } }
      for (let oi = 0; oi < J; oi++) {
        const j = order[oi]; let left = 0;
        for (let it = 0; it < 4; it++) {
          left = look(j); if (!left) break;
          any = true;
          // the turn was found where things are now: inward joints have carried it there
          Qin.identity(); for (let k = j + 1; k < J; k++) Qin.premultiply(Q[k]);
          tq.multiplyScalar(0.9 / Math.sqrt(left)).applyQuaternion(Qin.invert());
          const ang = tq.length(); if (ang < 1e-6) break;
          Q[j].premultiply(dq.setFromAxisAngle(tq.multiplyScalar(1 / ang), Math.min(ang, 0.5)));
          const lim = o.joints[j].max * gain, now = angle(Q[j]); if (now > lim) Q[j].slerp(ident, 1 - lim / now);
        }
        if (!left) break;                                   // clear: the joints further in are not needed
      }
      for (let j = 0; j < J; j++) { const step = Q[j].angleTo(Qwas[j]); if (step > quick) { dq.copy(Q[j]); Q[j].copy(Qwas[j]).slerp(dq, quick / step); } this.amounts[j] = angle(Q[j]); }
      this.amount = this.amounts[0];
      if (!any) return;
      for (let j = 0; j < J; j++) if (Q[j].w < 0.9999995) turnInWorld(o.joints[j].bone, Q[j]);
      o.joints[J - 1].bone.updateMatrixWorld(true);
    },
  };
  return carry;
}

// ------------------------------------------------------------------------------------------------------- materials
/** Add GLSL to a built-in material without losing what anyone else added before or adds after. */
export function patch(material, key, fn) {
  const before = material.onBeforeCompile, keyFn = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) { if (before) before.call(this, shader, renderer); fn(shader, renderer); };
  material.customProgramCacheKey = function () { return (keyFn ? keyFn.call(this) : '') + '|' + key; };
  material.needsUpdate = true;
  return material;
}
const insertAfter = (src, include, code) => {
  const tag = `#include <${include}>`;
  if (!src.includes(tag)) { console.warn(`wardrobe: no ${tag} in this shader`); return src; }
  return src.replace(tag, tag + '\n' + code);
};

// What every lit material of a kit shares with the fighter's body (gfx/materials.js gives the body the same things,
// so body and kit read as one figure):
//   an edge of light (so the pilgrim's dark cloak still separates from the dark behind it), her own light and her
//   gold rising with the mood (the Cantor), and "kit.fade": everything worn turns to light and is eaten away.
// uKit = fade 0..1, the feet's world y, the fighter's height (m), grain (1/m)
const LOOK_PARS = /* glsl */`
uniform vec4 uKit; uniform vec3 uKitLight; uniform vec4 uKitRim; uniform vec3 uKitSelf; uniform vec4 uKitGold; uniform vec3 uKitRimMul; uniform vec4 uKitCut;
float kitEdge = 0.0;
vec3 kitP;
float kitHash( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
float kitNoise( vec3 p ) {
	vec3 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( kitHash( i ), kitHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( kitHash( i + vec3( 0, 1, 0 ) ), kitHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( kitHash( i + vec3( 0, 0, 1 ) ), kitHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( kitHash( i + vec3( 0, 1, 1 ) ), kitHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}`;
const LOOK_DISCARD = /* glsl */`
	kitP = ( - vViewPosition - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
	if ( dot( kitP, uKitCut.xyz ) > uKitCut.w ) discard;
	if ( uKit.x > 0.002 ) {
		float kitN = kitNoise( kitP * uKit.w ) * 0.7 + kitNoise( kitP * uKit.w * 3.4 ) * 0.3;
		float kitCut = uKit.x * 0.98 - 0.07 + 0.13 * uKit.x * clamp( ( kitP.y - uKit.y ) / max( uKit.z, 0.1 ), 0.0, 1.0 );
		if ( kitN < kitCut ) discard;
		kitEdge = 1.0 - smoothstep( 0.0, 0.09, kitN - kitCut );
	}`;
const LOOK_LIGHT = /* glsl */`
	{
		float kitFres = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), uKitRim.w * uKitRimMul.y );
		// light from behind and above as the camera sees the fighter: there is always an edge of light
		float kitBack = saturate( dot( normal, vec3( 0.0, 0.675, - 0.737 ) ) * 0.5 + 0.62 );
		totalEmissiveRadiance += uKitRim.rgb * ( kitFres * kitBack * uKitRimMul.x );
		totalEmissiveRadiance += diffuseColor.rgb * uKitSelf;
		float kitH = clamp( ( kitP.y - uKit.y ) / max( uKit.z, 0.1 ), 0.0, 1.0 );
		float kitRise = uKitGold.w * smoothstep( 0.0, 0.3, uKitGold.w * 1.3 - kitH );
		totalEmissiveRadiance += uKitGold.rgb * ( kitRise * uKitRimMul.z ) * ( 0.1 + 0.9 * metalnessFactor ) * ( 0.55 + 0.45 * kitFres );
		totalEmissiveRadiance += uKitLight * ( kitEdge * 5.0 + smoothstep( 0.0, 0.55, uKit.x ) * 0.8 );
	}`;

// the same numbers gfx/materials.js uses for the two bodies
const LOOKS_WHO = {
  player: { rim: [0.50, 0.66, 1.0], rimStrength: 0.42, rimPower: 3.0, self: 0, gold: 0 },
  boss: { rim: [0.78, 0.86, 1.0], rimStrength: 0.26, rimPower: 3.4, self: 0.11, gold: 2.4 },
};
/**
 * The uniforms one fighter's whole kit shares. look.fade(v), look.rim(k) (a multiplier, 1 = as the body's),
 * look.gold(g) (0..1: her gold, the mood's), look.feet(y) each step. Materials join with fadeable(material, look).
 */
export function makeFade(height = 1.8, who = 'player') {
  const L = LOOKS_WHO[who] || LOOKS_WHO.player;
  const u = {
    uKit: { value: new THREE.Vector4(0, 0, height, 9 / Math.max(1, height / 1.8)) }, uKitLight: { value: rgb(1.0, 0.8, 0.45).multiplyScalar(2.2) },
    uKitRim: { value: new THREE.Vector4(L.rim[0] * L.rimStrength, L.rim[1] * L.rimStrength, L.rim[2] * L.rimStrength, L.rimPower) },
    uKitSelf: { value: rgb(1.0, 0.94, 0.84).multiplyScalar(L.self) }, uKitGold: { value: new THREE.Vector4(1.0 * L.gold, 0.74 * L.gold, 0.34 * L.gold, 0) },
  };
  u.who = L;
  u.rim = (k) => { const r = u.uKitRim.value; r.x = L.rim[0] * L.rimStrength * k; r.y = L.rim[1] * L.rimStrength * k; r.z = L.rim[2] * L.rimStrength * k; };
  u.gold = (g) => { u.uKitGold.value.w = L.gold > 0 ? Math.min(1, Math.max(0, g)) : 0; };
  return u;
}
/**
 * Let a standard material take part in the kit's look (edge of light, her light and gold, kit.fade).
 * o: { rim: how strong this material's edge of light is beside the body's (1), rimPower: how narrow (1; lower = broader),
 *      gold: how much of the kit's gold (her mood's, laid on all metal) this material takes (1; her pipes take a fifth:
 *      under the whole of it sixty pipes were one flat cream) }
 */
export function fadeable(material, fade, o = {}) {
  if (!material || !(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) || material.userData.kitFade) return material;
  material.userData.kitFade = true;
  const mul = { value: new THREE.Vector3(o.rim !== undefined ? o.rim : 1, o.rimPower !== undefined ? o.rimPower : 1, o.gold !== undefined ? o.gold : 1) };
  // a plane in the world beyond which this material is not drawn (xyz its normal, w its place): far away unless its owner
  // sets it (the end of a sheathed blade that is longer than its scabbard)
  const cut = material.userData.kitCut = { value: new THREE.Vector4(0, 1, 0, 1e9) };
  return patch(material, 'kitlook', (shader) => {
    shader.uniforms.uKitRimMul = mul; shader.uniforms.uKitCut = cut;
    shader.uniforms.uKit = fade.uKit; shader.uniforms.uKitLight = fade.uKitLight; shader.uniforms.uKitRim = fade.uKitRim; shader.uniforms.uKitSelf = fade.uKitSelf; shader.uniforms.uKitGold = fade.uKitGold;
    let f = shader.fragmentShader.replace('void main() {', LOOK_PARS + '\nvoid main() {');
    f = insertAfter(f, 'clipping_planes_fragment', LOOK_DISCARD);
    f = insertAfter(f, 'emissivemap_fragment', LOOK_LIGHT);
    shader.fragmentShader = f;
  });
}

/** A standard material through the graphics owner's factory when there is one (so it is theirs to dispose of and tune), with our numbers. */
export function standard(ctx, kind, o) {
  const lib = ctx.gfx && ctx.gfx.materials, make = lib && typeof lib[kind] === 'function' ? lib[kind] : null;
  let m = null;
  if (make) { try { m = make.call(lib, Object.assign(kind === 'metal' ? { detail: 0 } : {}, o)); } catch (e) { console.warn('wardrobe: gfx.materials.' + kind + ' failed, using a plain material: ' + e.message); } }
  if (!m || !(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) m = new THREE.MeshStandardMaterial();
  for (const k in o) {                                   // a stand-in factory may have ignored some of what we asked for
    const v = o[k]; if (v === undefined || !(k in m)) continue;
    if (m[k] && m[k].isColor) m[k].set(v); else if (m[k] && m[k].isVector2 && v.isVector2) m[k].copy(v); else m[k] = v;
  }
  m.needsUpdate = true;
  return m;
}
/** Something that only glows (a flame, lit glass, the halo): an HDR colour, unlit. `mat.userData.base` keeps the colour at power 1. */
export function glowing(ctx, color, power = 1, o = {}) {
  const lib = ctx.gfx && ctx.gfx.materials;
  let m = null;
  if (lib && typeof lib.emissive === 'function') { try { m = lib.emissive(color, power); } catch (e) { m = null; } }
  if (!m || !m.isMaterial) m = new THREE.MeshBasicMaterial({ toneMapped: false });
  Object.assign(m, o);
  m.userData.base = new THREE.Color(color); m.userData.power = power; m.color.copy(m.userData.base).multiplyScalar(power);
  m.needsUpdate = true;
  return m;
}

// What each named material of the prop files is in the game. Colours are linear. `scale` multiplies how often the
// wear textures repeat (the Cantor's things are 3.67 times larger in the world, so theirs repeat more).
const LOOKS = {
  steel: { kind: 'metal', color: rgb(0.60, 0.62, 0.66), roughness: 0.36, metalness: 1, wear: 1 },
  steel_dark: { kind: 'metal', color: rgb(0.20, 0.22, 0.26), roughness: 0.46, metalness: 1, wear: 1 },
  iron: { kind: 'metal', color: rgb(0.075, 0.075, 0.085), roughness: 0.62, metalness: 0.85, wear: 1 },
  leather: { kind: 'stone', color: rgb(0.085, 0.055, 0.035), roughness: 0.72, metalness: 0, wear: 0.6, detail: 0 },
  gold: { kind: 'metal', color: rgb(0.95, 0.78, 0.50), roughness: 0.34, metalness: 1, wear: 0.7, emissive: rgb(1.0, 0.72, 0.36), emissiveIntensity: 0 },
  gold_pale: { kind: 'metal', color: rgb(0.96, 0.84, 0.60), roughness: 0.30, metalness: 1, wear: 0.7, emissive: rgb(1.0, 0.78, 0.42), emissiveIntensity: 0 },
  core: { kind: 'metal', color: rgb(1.0, 0.93, 0.78), roughness: 0.25, metalness: 0.5, emissive: rgb(1.0, 0.80, 0.46), emissiveIntensity: 0.25 },
  shield: { kind: 'metal', color: rgb(1, 1, 1), roughness: 1, metalness: 1, map: 'prop.tex.shield', orm: 'prop.tex.shield_orm', normalMap: 'prop.tex.shield_n', normalScale: 1.0 },
};

/**
 * Replace the materials of a loaded prop (by name) with the game's. Returns { name: material }.
 * o: { scale (how often the wear repeats, default 1), fade (from makeFade), only (Set of names to keep as they are) }
 */
export function materialise(ctx, object, o = {}) {
  const made = {}, has = (n) => ctx.assets && ctx.assets.has && ctx.assets.has(n), scale = o.scale || 1;
  const texture = (name, rep) => {
    if (!has(name)) return null;
    const t = ctx.assets.texture(name);
    if (!rep || rep === 1) return t;
    const c = t.clone(); c.repeat.set(rep, rep); c.needsUpdate = true; made['tex:' + name + rep] = c; return c;       // same picture, its own repeat
  };
  object.traverse((n) => {
    if (!n.isMesh) return;
    const name = n.material && n.material.name;
    if (!made[name]) {
      const L = LOOKS[name];
      if (name === 'glass') made[name] = glowing(ctx, 0xffa040, 1.6, { transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
      else if (name === 'flame') made[name] = glowing(ctx, 0xffc070, 6);
      else if (L) {
        const p = { color: L.color, roughness: L.roughness, metalness: L.metalness, vertexColors: true };
        if (L.emissive) { p.emissive = L.emissive; p.emissiveIntensity = L.emissiveIntensity; }
        if (L.detail !== undefined) p.detail = L.detail;
        if (L.map) { p.map = texture(L.map); const orm = texture(L.orm); if (orm) { p.roughnessMap = orm; p.metalnessMap = orm; p.aoMap = orm; } const nm = texture(L.normalMap); if (nm) { p.normalMap = nm; p.normalScale = new THREE.Vector2(L.normalScale, L.normalScale); } }
        else if (L.wear) {
          const orm = texture('prop.tex.metal_orm', scale), nm = texture('prop.tex.metal_n', scale);
          if (orm) { p.roughnessMap = orm; if (L.metalness > 0) p.metalnessMap = orm; }
          if (nm) { p.normalMap = nm; p.normalScale = new THREE.Vector2(0.55 * L.wear, 0.55 * L.wear); }
        }
        made[name] = standard(ctx, L.kind, p);
        if (o.fade) fadeable(made[name], o.fade);
      } else made[name] = n.material;
      made[name].name = 'kit.' + name;
    }
    n.material = made[name];
    n.castShadow = name !== 'glass' && name !== 'flame'; n.receiveShadow = n.castShadow;
    n.userData.kit = true;
  });
  return made;
}

const RADIUS = { longsword: 0.05, greatsword: 0.075 };
/** A prop from its file, with the game's materials. look: { scale, fade } as for materialise. */
export function makeWeapon(ctx, kind, look = {}) {
  const name = 'prop.' + kind;
  if (!ctx.assets || !ctx.assets.has(name)) throw new Error(`wardrobe: "${name}" was not loaded. The game's manifest must include wardrobe.ASSETS (boss.js and player.js re-export it).`);
  const object = ctx.assets.gltf(name).scene.clone(true); object.name = kind;
  const materials = materialise(ctx, object, look);
  const anchors = {}; object.traverse((n) => { if (!n.isMesh && n !== object && n.name && !n.children.some((c) => c.isMesh)) anchors[n.name] = n; });
  const base = anchors.base || new THREE.Object3D(), tip = anchors.tip || new THREE.Object3D();
  if (!anchors.base) object.add(base); if (!anchors.tip) object.add(tip);
  const length = tip.position.distanceTo(base.position);
  return { object, base, tip, radius: RADIUS[kind] || 0.05, length, kind, anchors, materials };
}
/** Free what makeWeapon made (materials and cloned textures; the shapes belong to the loaded file). */
export function disposeWeapon(w) {
  if (!w) return;
  if (w.object.parent) w.object.parent.remove(w.object);
  for (const k in w.materials) { const m = w.materials[k]; if (m && m.dispose) m.dispose(); }
}

// --------------------------------------------------------------------------------------------------------- scabbard
/**
 * A long thing worn at the belt (the scabbard): a rigid body on a pivot that rides on the hips. Its straps give it an
 * attitude (the pivot's own -y: chape back and down), but it HANGS: it never stands up when he rolls, falls or lies;
 * its far end lags a little behind his turns and settles; it lies on the floor, never in it; it keeps off his legs.
 * `aim` (a world point, with `aimed` 0..1) tips it so that its line passes through that point: the fist on the hilt
 * when he draws.
 *   pivot    an Object3D on the hips: origin = where it hangs, -y = its attitude at rest, +z = away from the body
 *   object   the thing; its own -y runs down its length from the pivot
 *   o: { capsules, use: names it keeps off, radius, floor: () => world y, centre: the hips bone, stiff, damp,
 *        rest: cos of its angle from straight down on the standing figure, hang: 0..1 how much it keeps that angle
 *        whatever the hips do (it hangs by its straps) rather than leaning with them }
 */
const SETTLE = 0.4;                       // seconds a hung thing is held to its straps after its bearer was put somewhere at once
export class Hanger {
  constructor(pivot, object, length, o = {}) {
    this.pivot = pivot; this.object = object; this.length = length; this.radius = o.radius || 0.03;
    this.capsules = o.capsules || null; this.use = this.capsules && o.use ? this.capsules.ids(o.use) : []; this.floor = o.floor || null; this.centre = o.centre || null;
    this.stiff = o.stiff || 420; this.damp = o.damp || 30; this.droop = o.droop !== undefined ? o.droop : -0.34;      // the highest its far end may point: sin of the angle from level
    this.hang = o.hang !== undefined ? o.hang : 0.7; this.rest = o.rest !== undefined ? o.rest : 0.75;                // how much it hangs rather than leans with the hips; cos of its angle from straight down at rest
    this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.piv = new THREE.Vector3(); this.dir = new THREE.Vector3(0, -1, 0); this.fresh = true;
    this.aim = new THREE.Vector3(); this.aimed = 0; this.scale = 1; this.settle = 0;
    object.matrixAutoUpdate = false;
  }
  /** He was put somewhere at once (a cut, a respawn, `&place=`). Last polish: for SETTLE seconds after that it is held
   *  where its straps hold it, without its lag, so nothing is seen settling after a cut. (What the reviewer saw swing
   *  out after a placement was something else: the draw's tilt, restarted by every sheathe(false): wardrobe.js.) */
  teleport() { this.fresh = true; this.settle = SETTLE; }
  update(dt) {
    const P = this.piv, L0 = this.length, x = this.x, v = this.v, e = this.pivot.matrixWorld.elements;
    const S = this.scale = Math.hypot(e[0], e[1], e[2]) || 1, L = L0 * S;
    P.set(e[12], e[13], e[14]);
    // where its straps would hold it: partly as the hips lean, mostly as a hung thing hangs (its own angle from upright,
    // heading the way the hips have it head); tipped toward the hand that takes the hilt
    _a.set(-e[4] / S, -e[5] / S, -e[6] / S);
    { const hl = Math.hypot(_a.x, _a.z); if (hl > 0.15) { const k = this.hang * Math.min(1, (hl - 0.15) / 0.2), sn = Math.sqrt(1 - this.rest * this.rest); _b.set(_a.x / hl * sn, -this.rest, _a.z / hl * sn); _a.lerp(_b, k).normalize(); } }
    if (this.aimed > 0.001) { _b.subVectors(P, this.aim); if (_b.lengthSq() > 1e-8) { _b.normalize(); _a.lerp(_b, this.aimed).normalize(); } }
    // it hangs: it cannot point higher than `droop` whatever the hips do (level for the draw)
    const top = this.droop + (0.0 - this.droop) * this.aimed;
    if (_a.y > top) {
      let hx = _a.x, hz = _a.z, hl = Math.hypot(hx, hz);
      if (hl < 0.2 && this.centre) { const c = this.centre.matrixWorld.elements, bl = Math.hypot(c[8], c[10]) || 1, k = 1 - hl / 0.2; hx += -c[8] / bl * k; hz += -c[10] / bl * k; hl = Math.hypot(hx, hz); }      // (nearly upright: behind him)
      if (hl < 1e-4) { hx = 0; hz = -1; hl = 1; }
      const flat = Math.sqrt(1 - top * top); _a.set(hx / hl * flat, top, hz / hl * flat);
    }
    if (this.fresh || this.settle > 0) { x.copy(P).addScaledVector(_a, L); v.set(0, 0, 0); this.fresh = false; if (this.settle > 0) this.settle -= dt; }
    else {
      // its far end: a weight on a spring toward where the straps hold it (lag, a little overshoot, settle)
      const k = this.stiff, c = this.damp, tx = P.x + _a.x * L, ty = P.y + _a.y * L, tz = P.z + _a.z * L;
      v.x += ((tx - x.x) * k - v.x * c) * dt; v.y += ((ty - x.y) * k - v.y * c) * dt; v.z += ((tz - x.z) * k - v.z * c) * dt;
      x.addScaledVector(v, dt);
      const ex = x.x - tx, ey = x.y - ty, ez = x.z - tz, e2 = ex * ex + ey * ey + ez * ez, lim = L * 0.2;      // never far from its place (a roll, a blow)
      if (e2 > lim * lim) { const f = lim / Math.sqrt(e2); x.set(tx + ex * f, ty + ey * f, tz + ez * f); }
    }
    const cur = this.capsules ? this.capsules.cur : null, rad = this.capsules ? this.capsules.rad : null, fy = this.floor ? this.floor() + this.radius * S : -Infinity;
    for (let pass = 0; pass < 2; pass++) {
      // his legs brush it aside
      for (let i = 0; i < this.use.length; i++) {
        const c = this.use[i], k = c * 6, R = rad[c] + this.radius * S;
        _b.set(cur[k], cur[k + 1], cur[k + 2]); _c.set(cur[k + 3], cur[k + 4], cur[k + 5]);
        _q0.copy(P).lerp(x, 0.32);                             // (its upper third lies against the hip by design)
        const d = closest(_q0, x, _b, _c, _gc1, _gc2); if (d >= R) continue;
        const t = Math.max(0.32, _gc1.distanceTo(P) / (x.distanceTo(P) || 1));
        _v.subVectors(_gc1, _gc2); if (d < 1e-5) _v.set(e[8], e[9], e[10]).normalize(); else _v.multiplyScalar(1 / d);
        x.addScaledVector(_v, (R - d) / t);
        const vn = v.dot(_v); if (vn < 0) v.addScaledVector(_v, -vn);
      }
      // rigid: its own length from the pivot; and on the floor, not in it (it slides out along it)
      _v.subVectors(x, P); const len = _v.length() || 1; _v.multiplyScalar(1 / len);
      const low = (fy - P.y) / L;                              // the lowest its line may point (sin of the angle)
      if (_v.y < low) {
        const up = Math.min(0.999, Math.max(-0.999, low)), flat = Math.sqrt(1 - up * up); let hx = _v.x, hz = _v.z, hl = Math.hypot(hx, hz);
        if (hl < 0.05 && this.centre) { const c = this.centre.matrixWorld.elements; hx = -c[8]; hz = -c[10]; hl = Math.hypot(hx, hz); }
        if (hl < 1e-4) { hx = 0; hz = -1; hl = 1; }
        _v.set(hx / hl * flat, up, hz / hl * flat); if (v.y < 0) v.y = 0;
      }
      x.copy(P).addScaledVector(_v, L);
    }
    this.dir.copy(_v);
    // the thing: its -y along the line, its +z kept away from the body
    _a.copy(_v).negate(); _b.set(e[8], e[9], e[10]); _b.addScaledVector(_a, -_b.dot(_a)); if (_b.lengthSq() < 1e-8) { _b.set(e[0], e[1], e[2]); _b.addScaledVector(_a, -_b.dot(_a)); } _b.normalize();
    _c.crossVectors(_a, _b);
    _m.makeBasis(_c, _a, _b).scale(_s3.set(S, S, S)).setPosition(P);
    const parent = this.object.parent;
    if (parent) this.object.matrix.copy(_m2.copy(parent.matrixWorld).invert()).multiply(_m); else this.object.matrix.copy(_m);
    this.object.matrixWorldNeedsUpdate = true;
  }
}

// --------------------------------------------------------------------------------------------------------- lantern
/**
 * A thing hanging from a point on the body, swinging: a weight on a short chain (a damped pendulum, in the world).
 * `pivot` is an Object3D on a bone; `object` hangs from it (its own -y runs down the chain); `length` in metres.
 */
export class Pendulum {
  constructor(pivot, object, length, o = {}) {
    this.pivot = pivot; this.object = object; this.length = length; this.damping = o.damping !== undefined ? o.damping : 2.2; this.gravity = o.gravity || 9.81;
    this.capsules = o.capsules || null; this.use = this.capsules && o.use ? this.capsules.ids(o.use) : []; this.radius = o.radius || 0.05;
    this.x = new THREE.Vector3(); this.p = new THREE.Vector3(); this.piv = new THREE.Vector3(); this.fresh = true; this.max = o.maxAngle !== undefined ? o.maxAngle : 1.25;
    this.slack = o.slack !== undefined ? o.slack : 0.45;  // how short the chain may fold when something lifts the weight (a share of its length)
    this.centre = o.centre || null;                       // an Object3D at the body's middle (the hips): "out" is away from it
    object.matrixAutoUpdate = false;
  }
  teleport() { this.fresh = true; }
  /** Is a point (the weight's middle) inside any of the capsules it keeps off? */
  inside(q) {
    const cur = this.capsules.cur, rad = this.capsules.rad;
    for (let i = 0; i < this.use.length; i++) {
      const c = this.use[i], k = c * 6, R = rad[c] + this.radius * 0.9;
      const ax = cur[k], ay = cur[k + 1], az = cur[k + 2], ex = cur[k + 3] - ax, ey = cur[k + 4] - ay, ez = cur[k + 5] - az, e2 = ex * ex + ey * ey + ez * ez;
      let u = e2 > 1e-10 ? ((q.x - ax) * ex + (q.y - ay) * ey + (q.z - az) * ez) / e2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = q.x - ax - ex * u, dy = q.y - ay - ey * u, dz = q.z - az - ez * u;
      if (dx * dx + dy * dy + dz * dz < R * R) return true;
    }
    return false;
  }
  update(dt) {
    const piv = this.piv, x = this.x, p = this.p, L = this.length;
    piv.setFromMatrixPosition(this.pivot.matrixWorld);
    if (this.fresh) { x.set(piv.x, piv.y - L, piv.z); p.copy(x); this.fresh = false; }
    // Verlet: keep the motion, fall, stay on the chain
    const keep = Math.exp(-this.damping * dt), vx = (x.x - p.x) * keep, vy = (x.y - p.y) * keep, vz = (x.z - p.z) * keep;
    p.copy(x); x.x += vx; x.y += vy - this.gravity * dt * dt; x.z += vz;
    const lim = -Math.cos(this.max), cur = this.capsules ? this.capsules.cur : null, rad = this.capsules ? this.capsules.rad : null;
    for (let pass = 0; pass < 4; pass++) {
      let touched = false;
      for (let i = 0; i < this.use.length; i++) {             // off the legs and the hips
        const c = this.use[i], k = c * 6, R = rad[c] + this.radius;
        const ax = cur[k], ay = cur[k + 1], az = cur[k + 2], ex = cur[k + 3] - ax, ey = cur[k + 4] - ay, ez = cur[k + 5] - az, e2 = ex * ex + ey * ey + ez * ez;
        let u = e2 > 1e-10 ? ((x.x - ax) * ex + (x.y - ay) * ey + (x.z - az) * ez) / e2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x.x - ax - ex * u, dy = x.y - ay - ey * u, dz = x.z - az - ez * u, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R * R && d2 > 1e-12) { const s = R / Math.sqrt(d2) - 1; x.x += dx * s; x.y += dy * s; x.z += dz * s; touched = true; }
      }
      // on the chain: never further from the belt than the chain is long, but the chain may go slack when a raised
      // thigh lifts the lantern (it rides on the leg); never swung up past `max` radians from straight down
      _v.subVectors(x, piv); const len = _v.length() || 1; _v.multiplyScalar(1 / len);
      if (_v.y > lim) { const h = Math.hypot(_v.x, _v.z) || 1, s = Math.sin(this.max) / h; _v.set(_v.x * s, lim, _v.z * s); }
      x.copy(piv).addScaledVector(_v, len > L || !touched ? L : Math.max(len, L * this.slack));
      if (!touched) break;
    }
    // still inside him (a deep crouch folds thigh, hip and belly round the belt)? Then it is squeezed out sideways:
    // the first free place along the line from his middle out through the belt point
    if (this.use.length && this.centre && this.inside(x)) {
      const ce = this.centre.matrixWorld.elements; let ox = piv.x - ce[12], oz = piv.z - ce[14]; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
      for (let k = 1; k <= 6; k++) { x.set(piv.x + ox * L * k / 6, piv.y - L * 0.25 * (1 - k / 6), piv.z + oz * L * k / 6); if (!this.inside(x)) break; }
    }
    _v.subVectors(x, piv); if (_v.lengthSq() < 1e-10) _v.set(0, -1, 0); _v.normalize();
    // the object: its -y along the chain, its facing kept from the pivot
    const e = this.pivot.matrixWorld.elements; _a.set(-_v.x, -_v.y, -_v.z);                                  // up the chain
    _b.set(e[8], e[9], e[10]); _b.addScaledVector(_a, -_b.dot(_a)); if (_b.lengthSq() < 1e-8) _b.set(e[0], e[1], e[2]); _b.normalize();   // the pivot's z, squared to the chain
    _c.crossVectors(_a, _b);
    const s = Math.hypot(e[0], e[1], e[2]);
    _m.makeBasis(_c, _a, _b).scale(_v.set(s, s, s)).setPosition(piv);
    // into the parent's space
    const parent = this.object.parent;
    if (parent) this.object.matrix.copy(_m2.copy(parent.matrixWorld).invert()).multiply(_m); else this.object.matrix.copy(_m);
    this.object.matrixWorldNeedsUpdate = true;
  }
}
