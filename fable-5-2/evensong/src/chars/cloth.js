// Cloth: position-based sheets hung from bones.
//
// A sheet is a grid of particles (cols across, rows down). Some particles are held on bones (normally the whole top
// row); the rest fall, are kept the right distance from their neighbours (stretch, shear, bend), are tethered to the
// particle they hang from so the sheet can never stretch however hard it is thrown, are pushed out of capsules that
// ride on the body's bones, rest on the water, and feel the air: drag square to the sheet (so it billows and lags
// behind the body) and a wind that flutters. Everything is simulated in the world, in metres, in a fixed number of
// sub-steps per update(dt). The picture is a finer grid laid through the particles (Catmull-Rom), with normals,
// rebuilt in place: nothing is allocated after the constructor.
//
//   const body = new Capsules(scale); body.add('thigh.l', boneA, [x, y, z] | null, boneB, [x, y, z] | null, radius); body.build();
//   const sheet = new Cloth({ cols, rows, scale, rest, pin, capsules: body, use: ['thigh.l', ...], parent, material, ... });
//   each step, after the pose:  root.updateMatrixWorld(true); body.update(); sheet.update(dt);
//
// Sizes given to the constructor are in the character's own units; `scale` turns them into metres.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const ZERO = [0, 0, 0];

/** Capsules that ride on bones, shared by everything one fighter wears. World end points are worked out once a step. */
export class Capsules {
  constructor(scale = 1) { this.scale = scale; this.list = []; this.index = new Map(); this.cur = null; this.prev = null; this.rad = null; this.fresh = true; }
  /** A capsule from a point on bone `a` to a point on bone `b` (offsets in the bones' own units), radius in character units. */
  add(name, a, ao, b, bo, r) { this.index.set(name, this.list.length); this.list.push({ name, a, ao: ao || ZERO, b: b || a, bo: bo || ZERO, r }); return this; }
  /** A capsule whose ends its owner writes in the world each step with setFree (her wings, a shield): radius in character units. */
  addFree(name, r) { this.index.set(name, this.list.length); this.list.push({ name, free: true, r }); return this; }
  setFree(name, ax, ay, az, bx, by, bz) { const k = this.index.get(name) * 6, c = this.cur; c[k] = ax; c[k + 1] = ay; c[k + 2] = az; c[k + 3] = bx; c[k + 4] = by; c[k + 5] = bz; if (this.freeFresh) this.prev.set(c.subarray(k, k + 6), k); }
  build() {
    const n = this.list.length; this.cur = new Float32Array(n * 6); this.prev = new Float32Array(n * 6); this.rad = new Float32Array(n);
    for (let i = 0; i < n; i++) this.rad[i] = this.list[i].r * this.scale;
    this.freeFresh = true;
    return this;
  }
  ids(names) { return names.map((n) => { const i = this.index.get(n); if (i === undefined) throw new Error('no capsule "' + n + '"'); return i; }); }
  /** Call after the skeleton's world matrices are current. again = true: a second reading in the same step (a bone was moved since): where they were a step ago is kept. */
  update(again = false) {
    const cur = this.cur, list = this.list;
    if (!again) { this.prev.set(cur); this.freeFresh = this.fresh; }
    for (let i = 0, k = 0; i < list.length; i++, k += 6) {
      const c = list[i]; if (c.free) continue;
      let e = c.a.matrixWorld.elements, o = c.ao;
      cur[k] = e[0] * o[0] + e[4] * o[1] + e[8] * o[2] + e[12]; cur[k + 1] = e[1] * o[0] + e[5] * o[1] + e[9] * o[2] + e[13]; cur[k + 2] = e[2] * o[0] + e[6] * o[1] + e[10] * o[2] + e[14];
      e = c.b.matrixWorld.elements; o = c.bo;
      cur[k + 3] = e[0] * o[0] + e[4] * o[1] + e[8] * o[2] + e[12]; cur[k + 4] = e[1] * o[0] + e[5] * o[1] + e[9] * o[2] + e[13]; cur[k + 5] = e[2] * o[0] + e[6] * o[1] + e[10] * o[2] + e[14];
    }
    if (this.fresh) { this.prev.set(cur); this.fresh = false; }
  }
  /** The body was put somewhere else at once: forget where the capsules were. */
  teleport() { this.fresh = true; }
}

// ---- Shapes: the body as it really is, for cloth to lie on ------------------------------------------------------
//
// A capsule is a guess at a limb. Where she wears plate (hip plates, tassets, knee cops, pauldrons, a crown) the guess
// is centimetres off, and a sheet that knows only some capsules falls through everything else (Kevin, 9 Nov: "make sure
// her cloth doesn't sink into her body"). A Shapes is made from the character's OWN skin instead. Every vertex of the
// skinned meshes belongs to one PART (the part of the bone that carries most of it); a part is a map round its own
// axis, riding on its bone: how far the skin stands from the axis, in 32 or 64 directions round it and in rows along it.
// A limb with a radius that depends on where round it and where along it you ask: tassets, knee cops and all.
//
//   - Skin that one bone carries alone moves rigidly with it: it is laid on the part's map once, in the bind pose
//     (triangle by triangle: corners, the middles of the sides, the middle), when the character is dressed.
//   - Skin that several bones share (the plates and folds round a joint: half of her vertices) moves in the part's
//     frame as the joint bends: a tasset's tip by 26 cm of the world when she kneels. Those vertices are skinned here,
//     every step, straight into their part's frame (the same sum of bone matrices the shader makes) and laid on the
//     map again. So the map is where her skin IS in this pose, not where it was at rest.
//
// The largest radius of any skin that falls on a cell of the map is kept on the cell's four corners, so the map read
// between its corners is never inside the skin it was made from. A point is outside a part or is pushed out of it
// STRAIGHT OUT FROM THE PART'S AXIS, as a capsule would (see push(): not the nearest way, and why).
//
//   const shapes = new Shapes(scale);
//   shapes.add('thighL', bone, { to: [x, y, z] | along: [x, y, z], bones: [bone, ...], row: 0.02 });   offsets in the bone's own frame
//   shapes.fit(char.meshes);            read the skin (bind pose): some milliseconds, once
//   each step, after the pose:  shapes.update();      (teleport() when the body was put somewhere else at once)
//
// Nothing here allocates after fit().
// The directions of a map's columns are evenly spaced on a diamond (|x| + |y| = 1), which needs no arctangent to find.
// A map has 32 of them or 64 (a thick part: its cells would otherwise be hand-wide).
const REACH = 0.01, SHIFT = 0.5;      // a part's shared skin is read again when one of its bones has turned, in the part's frame, so far that skin at the part's far end has moved a centimetre of the world (REACH, metres); SHIFT weighs the matrices' offsets (metres) against that (bones only turn: an offset changes with the turn, by its lever)

export class Shapes {
  constructor(scale = 1) {
    this.scale = scale; this.list = []; this.index = new Map(); this.n = 0; this.fresh = true; this.ready = false;
    this.ox = 0; this.oy = 0; this.oz = 0; this.depth = 0;      // what push() answers: how to move the point out, and how deep it was
  }
  /**
   * A part riding on `bone`. o: { to: [x, y, z] the far end of its axis in the bone's own frame (a limb: the next
   * joint; the axis then runs through the bone's own origin) | along: [x, y, z] only the axis' direction (it then runs
   * through the middle of the part's skin), bones: every bone whose skin is part of it (default: the bone; a bone
   * named by no part goes with the nearest bone above it that is), row = 0.02 (how far apart the map's rows are,
   * character units), pad = 0.08 (how far past its skin at rest the map runs at each end, for skin that a bent joint
   * carries along it), grow = 0 (character units added to every radius), thin, rigid (see fit(): this part's own),
   * round = 32 | 64 (how many directions round the axis the map has: 64 for a thick part), every = 4 (its shared
   * skin is read again after so many steps at the latest, however little has moved; see skin()), cap (character
   * units: no radius of the map is larger than this: a crown's spikes are not a wall round a head) }
   */
  add(name, bone, o = {}) {
    if (!bone) throw new Error('Shapes: no bone for "' + name + '"');
    this.index.set(name, this.list.length);
    this.list.push({ name, bone, o, bones: o.bones || [bone] });
    return this;
  }
  ids(names) { return names.map((n) => { const i = this.index.get(n); if (i === undefined) throw new Error('no shape "' + n + '"'); return i; }); }

  /**
   * Read the skin. meshes: the character's skinned meshes (the bind pose is taken from their own skeletons).
   * o: { rigid = 0.98: a vertex whose part's own bone carries at least this share of it is laid on the map once; the
   * rest are skinned every step; thin = 0 (every one of them; a part may say its own): of those, one in each cube of
   * this size (character units, at rest) stands for the rest that move with it, shares = 8: "move with
   * it" means the same bones, in shares that agree when rounded to one in this many, under = 0.008: the cube for
   * every mesh after the first, whatever its part says (an under-layer that lies inside the armour and shows only
   * where plates part: it matters in a hip's crease, but not to the millimetre), edge = 0.03: a side of a triangle
   * is watched for stretching when some bone's share differs by this much between its two ends }. Returns false when
   * there is no skin to read.
   */
  fit(meshes, o = {}) {
    const skins = (meshes || []).filter((m) => m && m.isSkinnedMesh && m.skeleton && m.geometry && m.geometry.attributes.skinIndex);
    const list = this.list, np = list.length, S = this.scale, RIGID = o.rigid !== undefined ? o.rigid : 0.98, THIN = o.thin || 0, SHARES = o.shares || 8, UNDER = o.under !== undefined ? o.under : 0.008, EDGE = o.edge !== undefined ? o.edge : 0.03, EDGE2 = Math.max(EDGE, 0.1);
    if (!skins.length || !np) return false;
    const parts = list.map((p, k) => ({ p, k, NPHI: p.o.round === 64 ? 64 : 32, cap: p.o.cap || Infinity, row: p.o.row || 0.02, pad: p.o.pad !== undefined ? p.o.pad : 0.08, grow: p.o.grow || 0, inv: null, ax: null, cnt: 0, cx: 0, cy: 0, cz: 0, zmin: Infinity, zmax: -Infinity, nu: 0, tab: null, dyn: [], mats: [], edges: [] }));
    const local = (e, x, y, z, out) => { out[0] = e[0] * x + e[4] * y + e[8] * z + e[12]; out[1] = e[1] * x + e[5] * y + e[9] * z + e[13]; out[2] = e[2] * x + e[6] * y + e[10] * z + e[14]; };
    const q = [0, 0, 0];
    // ---- every mesh once: the bind pose in the mesh's own space, and which part each vertex belongs to
    const data = [];
    for (const m of skins) {
      const g = m.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, bones = m.skeleton.bones, bm = m.bindMatrix.elements, nv = pos.count;
      const vb = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i); vb[i * 3] = bm[0] * x + bm[4] * y + bm[8] * z + bm[12]; vb[i * 3 + 1] = bm[1] * x + bm[5] * y + bm[9] * z + bm[13]; vb[i * 3 + 2] = bm[2] * x + bm[6] * y + bm[10] * z + bm[14]; }
      // each bone of this skeleton -> its part (a bone no part names goes with the nearest named bone above it)
      const partOf = new Int32Array(bones.length).fill(-1), mainOf = new Int32Array(np).fill(-1);
      for (let k = 0; k < np; k++) { mainOf[k] = bones.indexOf(list[k].bone); if (mainOf[k] >= 0) parts[k].inv = m.skeleton.boneInverses[mainOf[k]].elements; for (const b of list[k].bones) { const j = bones.indexOf(b); if (j >= 0) partOf[j] = k; } }
      for (let j = 0; j < bones.length; j++) { let b = bones[j], k = partOf[j]; while (k < 0 && b.parent) { b = b.parent; const jj = bones.indexOf(b); if (jj < 0) break; k = partOf[jj]; } partOf[j] = k; }
      // each vertex: the part that carries most of it; and whether that part's own bone carries (nearly) all of it
      const part = new Int16Array(nv).fill(-1), still = new Uint8Array(nv), sum = new Float32Array(np);
      for (let i = 0; i < nv; i++) {
        let tot = 0; for (let j = 0; j < 4; j++) tot += sw.getComponent(i, j);
        if (!(tot > 0)) continue;
        let best = -1, own = 0;
        for (let j = 0; j < 4; j++) { const w = sw.getComponent(i, j); if (w <= 0) continue; const k = partOf[si.getComponent(i, j)]; if (k < 0) continue; sum[k] += w / tot; }
        for (let j = 0; j < 4; j++) { const w = sw.getComponent(i, j); if (w <= 0) continue; const k = partOf[si.getComponent(i, j)]; if (k < 0) continue; if (best < 0 || sum[k] > sum[best]) best = k; }
        if (best >= 0) for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === mainOf[best]) own += sw.getComponent(i, j) / tot;
        for (let j = 0; j < 4; j++) { const k = partOf[si.getComponent(i, j)]; if (k >= 0) sum[k] = 0; }
        part[i] = best; still[i] = best >= 0 && own >= (list[best].o.rigid !== undefined ? list[best].o.rigid : RIGID) ? 1 : 0;
      }
      data.push({ m, g, vb, part, still, nv, si, sw, bones });
    }
    // ---- each part's axis (a limb: the bone's own line; else through the middle of its skin), then its extent along it
    for (const d of data) for (let i = 0; i < d.nv; i++) { const k = d.part[i]; if (k < 0 || !parts[k].inv) continue; const P = parts[k]; local(P.inv, d.vb[i * 3], d.vb[i * 3 + 1], d.vb[i * 3 + 2], q); P.cx += q[0]; P.cy += q[1]; P.cz += q[2]; P.cnt++; }
    for (const P of parts) {
      if (!P.cnt) continue;
      const po = P.p.o, dd = po.to || po.along || [0, 1, 0];
      const l = Math.hypot(dd[0], dd[1], dd[2]) || 1, Z = [dd[0] / l, dd[1] / l, dd[2] / l];
      let X = Math.abs(Z[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]; const k = X[0] * Z[0] + X[1] * Z[1] + X[2] * Z[2]; X = [X[0] - Z[0] * k, X[1] - Z[1] * k, X[2] - Z[2] * k]; const xl = Math.hypot(X[0], X[1], X[2]); X = [X[0] / xl, X[1] / xl, X[2] / xl];
      const Y = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];
      const c = po.to ? [0, 0, 0] : [P.cx / P.cnt, P.cy / P.cnt, P.cz / P.cnt];
      P.ax = { c, X, Y, Z };
    }
    for (const d of data) for (let i = 0; i < d.nv; i++) {
      const k = d.part[i]; if (k < 0 || !parts[k].ax) continue; const P = parts[k], A = P.ax;
      local(P.inv, d.vb[i * 3], d.vb[i * 3 + 1], d.vb[i * 3 + 2], q);
      const z = (q[0] - A.c[0]) * A.Z[0] + (q[1] - A.c[1]) * A.Z[1] + (q[2] - A.c[2]) * A.Z[2]; if (z < P.zmin) P.zmin = z; if (z > P.zmax) P.zmax = z;
    }
    let total = 0;
    for (const P of parts) {
      if (!P.ax || !(P.zmax > P.zmin)) { P.ax = null; continue; }
      P.zmin -= P.pad; P.zmax += P.pad;
      P.nu = Math.max(2, Math.ceil((P.zmax - P.zmin) / P.row) + 1); P.dz = (P.zmax - P.zmin) / (P.nu - 1);
      P.tab = new Float32Array(P.nu * P.NPHI); total += P.nu * P.NPHI;
    }
    // ---- the skin one bone carries alone: laid on the map now (figure units; whole triangles where all three corners are such)
    const lay = (P, x, y, z) => {
      const A = P.ax, tab = P.tab, nu = P.nu, NPHI = P.NPHI, QUAD = NPHI / 4;
      local(P.inv, x, y, z, q);
      const dx = q[0] - A.c[0], dy = q[1] - A.c[1], dz = q[2] - A.c[2], pz = dx * A.Z[0] + dy * A.Z[1] + dz * A.Z[2], fu = (pz - P.zmin) / P.dz;
      const px = dx * A.X[0] + dy * A.X[1] + dz * A.X[2], py = dx * A.Y[0] + dy * A.Y[1] + dz * A.Y[2], r = Math.min(P.cap, Math.sqrt(px * px + py * py) + P.grow);
      const ax = Math.abs(px), ay = Math.abs(py), sm = ax + ay, sd = sm > 1e-9 ? ay / sm : 0, tt = (px >= 0 ? (py >= 0 ? sd : 4 - sd) : (py >= 0 ? 2 - sd : 2 + sd)) * QUAD;
      const k0 = Math.floor(tt) % NPHI, k1 = (k0 + 1) % NPHI, i0 = Math.max(0, Math.min(nu - 2, Math.floor(fu)));
      let o0 = i0 * NPHI + k0; if (tab[o0] < r) tab[o0] = r; o0 = i0 * NPHI + k1; if (tab[o0] < r) tab[o0] = r;
      o0 = (i0 + 1) * NPHI + k0; if (tab[o0] < r) tab[o0] = r; o0 = (i0 + 1) * NPHI + k1; if (tab[o0] < r) tab[o0] = r;
    };
    const BARY = [[0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3]];
    let nStill = 0, nDyn = 0;
    for (const d of data) {
      const { g, vb, part, still, nv } = d, idx = g.index, nt = (idx ? idx.count : nv) / 3;
      for (let i = 0; i < nv; i++) if (part[i] >= 0 && still[i] && parts[part[i]].ax) { lay(parts[part[i]], vb[i * 3], vb[i * 3 + 1], vb[i * 3 + 2]); nStill++; }
      for (let t = 0; t < nt; t++) {
        const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2, k = part[a];
        if (k < 0 || part[b] !== k || part[c] !== k || !still[a] || !still[b] || !still[c] || !parts[k].ax) continue;
        for (const w of BARY) lay(parts[k], vb[a * 3] * w[0] + vb[b * 3] * w[1] + vb[c * 3] * w[2], vb[a * 3 + 1] * w[0] + vb[b * 3 + 1] * w[1] + vb[c * 3 + 1] * w[2], vb[a * 3 + 2] * w[0] + vb[b * 3 + 2] * w[1] + vb[c * 3 + 2] * w[2]);
      }
    }
    // ---- the skin several bones share: kept as points to be skinned into their part's frame every step.
    // Her vertices stand 4 to 6 mm apart (her own units) and the map's cells are two or three times that, so where a
    // part says so (`thin`) one point may stand for its neighbours: of the vertices in one small cube (at rest) that
    // are carried by the same bones in nearly the same shares (they move together), the outermost is kept, and is
    // given, as a radius of its own, the distance to the furthest of those it stands for.
    // A point of part P: where it is at rest, and which bones carry how much of it. The part's own bone's share of it
    // rides with the part (that much of it is simply where it was at rest, in the part's own frame); the other
    // bones' shares are worked out each step.
    const point = (P, m, x, y, z, bns, wts) => {
      const A = P.ax, pt = { x, y, z, own: 0, at: [0, 0, 0], b: [], w: [], r: 0, grow: 0, part: P, all: null, index: -1 };
      for (let j = 0; j < bns.length; j++) {
        const w = wts[j]; if (!(w > 0)) continue;
        const bone = m.skeleton.bones[bns[j]];
        if (bone === P.p.bone) { pt.own += w; continue; }
        let mi = P.mats.findIndex((e) => e.bone === bone);
        if (mi < 0) { mi = P.mats.length; P.mats.push({ bone, inv: m.skeleton.boneInverses[bns[j]].elements.slice() }); }
        const at = pt.b.indexOf(mi); if (at >= 0) pt.w[at] += w; else { pt.b.push(mi); pt.w.push(w); }
      }
      local(P.inv, x, y, z, q);
      const dx = q[0] - A.c[0], dy = q[1] - A.c[1], dz = q[2] - A.c[2], px = dx * A.X[0] + dy * A.X[1] + dz * A.X[2], py = dx * A.Y[0] + dy * A.Y[1] + dz * A.Y[2];
      pt.at[0] = px; pt.at[1] = py; pt.at[2] = dx * A.Z[0] + dy * A.Z[1] + dz * A.Z[2]; pt.r = Math.sqrt(px * px + py * py);
      return pt;
    };
    let nEdge = 0;
    for (const d of data) {
      const { g, vb, part, still, nv, si, sw, m } = d; const keep = new Map(), ptOf = new Array(nv).fill(null), keyOf = new Array(nv).fill(null);
      const shares = (i) => { let tot = 0; for (let j = 0; j < 4; j++) tot += sw.getComponent(i, j); const bns = [], wts = []; for (let j = 0; j < 4; j++) { const w = sw.getComponent(i, j) / tot; if (w > 0) { bns.push(si.getComponent(i, j)); wts.push(w); } } return [bns, wts]; };
      for (let i = 0; i < nv; i++) {
        const k = part[i]; if (k < 0 || still[i] || !parts[k].ax) continue; const P = parts[k], h = d === data[0] ? (P.p.o.thin !== undefined ? P.p.o.thin : THIN) : Math.max(P.p.o.thin !== undefined ? P.p.o.thin : THIN, UNDER);
        const [bns, wts] = shares(i), pt = point(P, m, vb[i * 3], vb[i * 3 + 1], vb[i * 3 + 2], bns, wts);
        if (!(h > 0)) { P.dyn.push(pt); ptOf[i] = pt; continue; }
        const mix = pt.b.map((bb, j) => bb + '/' + Math.round(pt.w[j] * SHARES)).sort().join(' ');
        const key = k + ':' + Math.floor(pt.x / h) + ':' + Math.floor(pt.y / h) + ':' + Math.floor(pt.z / h) + ':' + mix;
        const was = keep.get(key); keyOf[i] = key;
        if (!was) { pt.all = [pt]; keep.set(key, pt); } else if (was.r >= pt.r) was.all.push(pt); else { pt.all = was.all; pt.all.push(pt); was.all = null; keep.set(key, pt); }
      }
      for (const pt of keep.values()) {
        for (const o2 of pt.all) { const dd = Math.hypot(o2.x - pt.x, o2.y - pt.y, o2.z - pt.z); if (dd > pt.grow) pt.grow = dd; }
        pt.all = null; pt.part.dyn.push(pt);
      }
      for (let i = 0; i < nv; i++) if (keyOf[i]) ptOf[i] = keep.get(keyOf[i]);
      // ---- The sides of her triangles that STRETCH. Two neighbouring vertices that different bones carry in different
      // shares move apart when a joint bends (a seam between two plates, the fold of a waist): each is laid on its
      // map where it is, and the skin between them would be in no cell at all. Such sides are remembered (the two
      // points), and skin() fills the cells between them whenever they have come more than a cell apart. Where a
      // side's two ends belong to two parts, each part gets the side's middle as a point of its own, and its half.
      const idx = g.index, nt = (idx ? idx.count : nv) / 3, seen = new Set();
      const pt = (i) => { if (!ptOf[i]) { const [bns, wts] = shares(i); ptOf[i] = point(parts[part[i]], m, vb[i * 3], vb[i * 3 + 1], vb[i * 3 + 2], bns, wts); parts[part[i]].dyn.push(ptOf[i]); } return ptOf[i]; };      // (a vertex that never moves in its part, as the end of a side that stretches)
      for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
        const a = idx ? idx.getX(t * 3 + e) : t * 3 + e, b = idx ? idx.getX(t * 3 + (e + 1) % 3) : t * 3 + (e + 1) % 3, ka = part[a], kb = part[b];
        if (ka < 0 || kb < 0 || !parts[ka].ax || !parts[kb].ax || (still[a] && still[b] && ka === kb)) continue;
        const key = a < b ? a * nv + b : b * nv + a; if (seen.has(key)) continue; seen.add(key);
        const [ba, wa] = shares(a), [bb, wb] = shares(b); let diff = 0;
        for (let j = 0; j < ba.length; j++) { const o2 = bb.indexOf(ba[j]); diff = Math.max(diff, Math.abs(wa[j] - (o2 < 0 ? 0 : wb[o2]))); }
        for (let j = 0; j < bb.length; j++) if (ba.indexOf(bb[j]) < 0) diff = Math.max(diff, wb[j]);
        if (diff < EDGE) continue;
        if (ka === kb) { const pa = pt(a), pb = pt(b); if (pa !== pb) { parts[ka].edges.push(pa, pb); nEdge++; } continue; }
        if (diff < EDGE2) continue;
        // the middle of the side, carried as the mean of its two ends: once for each of the two parts
        const mb = ba.slice(), mw = wa.map((w) => w * 0.5); for (let j = 0; j < bb.length; j++) { const o2 = mb.indexOf(bb[j]); if (o2 < 0) { mb.push(bb[j]); mw.push(wb[j] * 0.5); } else mw[o2] += wb[j] * 0.5; }
        const mx = (vb[a * 3] + vb[b * 3]) * 0.5, my = (vb[a * 3 + 1] + vb[b * 3 + 1]) * 0.5, mz = (vb[a * 3 + 2] + vb[b * 3 + 2]) * 0.5;
        for (const [v, k] of [[a, ka], [b, kb]]) { const pm = point(parts[k], m, mx, my, mz, mb, mw); parts[k].dyn.push(pm); parts[k].edges.push(pt(v), pm); nEdge++; }
      }
    }
    for (const P of parts) nDyn += P.dyn.length;
    // ---- small gaps in a row of the still skin (a seam cut open between plates) are closed from their two sides
    for (const P of parts) {
      if (!P.ax) continue;
      const tab = P.tab, NPHI = P.NPHI, most = (P.p.o.gap !== undefined ? P.p.o.gap : 5) * NPHI / 32;
      for (let i = 0; i < P.nu; i++) {
        const row = i * NPHI; let any = false; for (let k = 0; k < NPHI; k++) if (tab[row + k] > 0) { any = true; break; }
        if (!any) continue;
        for (let k = 0; k < NPHI; k++) {
          if (tab[row + k] > 0 || !(tab[row + (k + NPHI - 1) % NPHI] > 0)) continue;
          let len = 1; while (len < NPHI && !(tab[row + (k + len) % NPHI] > 0)) len++;
          if (len > most) continue;
          const a = tab[row + (k + NPHI - 1) % NPHI], b = tab[row + (k + len) % NPHI];
          for (let j = 0; j < len; j++) tab[row + (k + j) % NPHI] = a + (b - a) * (j + 1) / (len + 1);
        }
      }
    }
    // ---- as flat arrays, in metres
    const live = parts.filter((P) => P.ax), n = this.n = live.length;
    this.names = live.map((P) => P.p.name); this.bone = live.map((P) => P.p.bone); this.index = new Map(this.names.map((nm, i) => [nm, i]));
    this.loc = new Float32Array(n * 12);          // in the bone's own frame: the axis' point, X, Y, Z
    this.cur = new Float32Array(n * 12); this.prev = new Float32Array(n * 12); this.at = new Float32Array(n * 12);       // in the world: now, a step ago, and where the sub-step has them
    this.z0 = new Float32Array(n); this.dz = new Float32Array(n); this.nu = new Int32Array(n); this.nphi = new Int32Array(n); this.off = new Int32Array(n); this.every = new Int32Array(n); this.age = new Int32Array(n); this.turn = new Float32Array(n); this.cap = new Float32Array(n); this.rmax = new Float32Array(n); this.rstill = new Float32Array(n); this.z1 = new Float32Array(n);
    this.box = new Float32Array(n * 6);            // each part's box in the world, at the sub-step
    this.still = new Float32Array(total); this.tab = new Float32Array(total);      // the map of the skin that never moves in its part, and the map as it is this step
    // the moving skin: per part a run of points and a run of bones
    this.dStart = new Int32Array(n + 1); this.mStart = new Int32Array(n + 1); this.eStart = new Int32Array(n + 1);
    let nm = 0; for (let i = 0; i < n; i++) { this.dStart[i + 1] = this.dStart[i] + live[i].dyn.length; this.mStart[i + 1] = this.mStart[i] + live[i].mats.length; this.eStart[i + 1] = this.eStart[i] + live[i].edges.length / 2; nm += live[i].mats.length; }
    this.eA = new Int32Array(this.eStart[n]); this.eB = new Int32Array(this.eStart[n]);      // the sides that stretch: two points each
    this.pu = new Float32Array(nDyn); this.pk = new Float32Array(nDyn); this.pr = new Float32Array(nDyn);      // where each point lies on its part's map this step: row, column, radius (row < -1e8: off the map)
    this.dv = new Float32Array(nDyn * 3); this.dw = new Float32Array(nDyn * 4); this.db = new Uint8Array(nDyn * 4); this.dr = new Float32Array(nDyn); this.d0 = new Float32Array(nDyn * 3); this.dc = new Uint8Array(nDyn);      // per point: at rest (mesh space); the other bones' shares, which bones, how many; its own radius; and its own bone's share of where it is in the part's frame (metres)
    this.mBone = []; this.mInv = new Float32Array(nm * 12); this.mNow = new Float32Array(nm * 12); this.mUsed = new Float32Array(nm * 12).fill(1e9);      // (mUsed: what each part's map was last read with)
    let off = 0;
    for (let i = 0; i < n; i++) {
      const P = live[i], { c, X, Y, Z } = P.ax, o = i * 12;
      this.loc.set([c[0], c[1], c[2], X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2]], o);
      this.z0[i] = P.zmin * S; this.dz[i] = P.dz * S; this.z1[i] = P.zmax * S; this.nu[i] = P.nu; this.nphi[i] = P.NPHI; this.off[i] = off; this.every[i] = Math.max(1, P.p.o.every || 4); this.age[i] = i % this.every[i]; this.cap[i] = P.cap * S;
      // (how far one of its bones may turn before its shared skin is read again: so much that the skin furthest from the part's middle moves REACH)
      { let far = 0.08; for (const pt of P.dyn) { const d = Math.hypot(pt.at[0], pt.at[1], pt.at[2]); if (d > far) far = d; } this.turn[i] = Math.min(0.04, REACH / (far * S)) * S; }
      let mx = 0; for (let k = 0; k < P.tab.length; k++) { const v = P.tab[k] * S; this.still[off + k] = v; if (v > mx) mx = v; }
      this.rstill[i] = mx; this.rmax[i] = mx; off += P.tab.length;
      P.dyn.sort((a, b) => a.b.length - b.b.length);              // (those with the fewest other bones first: the loop in skin() stays in step)
      for (let j = 0; j < P.dyn.length; j++) {
        const pt = P.dyn[j], at = this.dStart[i] + j; pt.index = at; this.dv[at * 3] = pt.x; this.dv[at * 3 + 1] = pt.y; this.dv[at * 3 + 2] = pt.z; this.dr[at] = (pt.grow + (o.grow || 0) + P.grow) * S; this.dc[at] = pt.b.length;
        for (let a = 0; a < 3; a++) this.d0[at * 3 + a] = pt.at[a] * pt.own * S;
        for (let a = 0; a < pt.b.length; a++) { this.dw[at * 4 + a] = pt.w[a]; this.db[at * 4 + a] = pt.b[a]; }
      }
      for (let j = 0; j < P.edges.length; j += 2) { this.eA[this.eStart[i] + j / 2] = P.edges[j].index; this.eB[this.eStart[i] + j / 2] = P.edges[j + 1].index; }
      for (let j = 0; j < P.mats.length; j++) { const e = P.mats[j].inv, at = (this.mStart[i] + j) * 12; this.mBone.push(P.mats[j].bone); for (let r = 0; r < 3; r++) for (let cc = 0; cc < 4; cc++) this.mInv[at + r * 4 + cc] = e[cc * 4 + r]; }
    }
    this.tab.set(this.still);
    this.counts = { still: nStill, moving: nDyn, edges: this.eStart[n], parts: n, cells: total };
    this.ready = true; this.fresh = true;
    return true;
  }

  /** Call after the skeleton's world matrices are current. again: a second reading in the same step (see Capsules.update). */
  update(again = false) {
    if (!this.ready) return;
    const { cur, loc, bone, n } = this;
    if (!again) this.prev.set(cur);
    for (let i = 0, o = 0; i < n; i++, o += 12) {
      const e = bone[i].matrixWorld.elements, s = 1 / (Math.hypot(e[0], e[1], e[2]) || 1);
      const cx = loc[o], cy = loc[o + 1], cz = loc[o + 2];
      cur[o] = e[0] * cx + e[4] * cy + e[8] * cz + e[12]; cur[o + 1] = e[1] * cx + e[5] * cy + e[9] * cz + e[13]; cur[o + 2] = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
      for (let a = 3; a < 12; a += 3) {
        const x = loc[o + a], y = loc[o + a + 1], z = loc[o + a + 2];
        cur[o + a] = (e[0] * x + e[4] * y + e[8] * z) * s; cur[o + a + 1] = (e[1] * x + e[5] * y + e[9] * z) * s; cur[o + a + 2] = (e[2] * x + e[6] * y + e[10] * z) * s;
      }
    }
    const fresh = this.fresh;
    if (fresh) { this.prev.set(cur); this.fresh = false; }
    this.skin(fresh);                                             // (put somewhere else at once, or the first time: every part is read)
  }

  /**
   * The skin that several bones share, laid on the maps where it is now (see the top). all = false: a part's skin
   * is read again only when its joints have MOVED since it was last read (one of its other bones has turned, in the
   * part's own frame, enough to carry skin at the part's far end REACH: a centimetre of the world), or after `every`
   * steps at the latest. So a body that stands is read fifteen times a second, and one that is struck or drops to
   * its knees every step; what is left unread is by construction about a centimetre from where it would be.
   */
  skin(all = true) {
    const { cur, n, tab, still, mBone, mInv, mNow, mUsed, mStart, dStart, dv, dw, db, dr, dc, z0, dz, nu, off, rmax, rstill, pu, pk, pr, eStart, eA, eB, every, age } = this, dAt = this.d0;
    for (let i = 0; i < n; i++) {
      const o = i * 12, d0 = dStart[i], d1 = dStart[i + 1];
      if (d1 === d0) continue;                                    // (no shared skin: its map is the still one, for good)
      // each bone that carries some of this part's skin: bind position -> (across, across, along) of the part's own frame, in metres
      const Ox = cur[o], Oy = cur[o + 1], Oz = cur[o + 2]; let moved = 0;
      for (let j = mStart[i]; j < mStart[i + 1]; j++) {
        const e = mBone[j].matrixWorld.elements, b = j * 12;
        for (let r = 0; r < 3; r++) {
          const qx = cur[o + 3 + r * 3], qy = cur[o + 4 + r * 3], qz = cur[o + 5 + r * 3];
          // the row of (part's axes) x (bone's world matrix): three numbers and the offset
          const a0 = qx * e[0] + qy * e[1] + qz * e[2], a1 = qx * e[4] + qy * e[5] + qz * e[6], a2 = qx * e[8] + qy * e[9] + qz * e[10], a3 = qx * (e[12] - Ox) + qy * (e[13] - Oy) + qz * (e[14] - Oz);
          // ... times the bone's bind inverse (kept row by row)
          const v0 = a0 * mInv[b] + a1 * mInv[b + 4] + a2 * mInv[b + 8], v1 = a0 * mInv[b + 1] + a1 * mInv[b + 5] + a2 * mInv[b + 9], v2 = a0 * mInv[b + 2] + a1 * mInv[b + 6] + a2 * mInv[b + 10], v3 = a0 * mInv[b + 3] + a1 * mInv[b + 7] + a2 * mInv[b + 11] + a3, k = b + r * 4;
          mNow[k] = v0; mNow[k + 1] = v1; mNow[k + 2] = v2; mNow[k + 3] = v3;
          // how far from what the map was last read with (the first three turn: they are sizes of a unit vector times her scale; the last shifts: metres)
          let d = v0 - mUsed[k]; if (d < 0) d = -d; if (d > moved) moved = d; d = v1 - mUsed[k + 1]; if (d < 0) d = -d; if (d > moved) moved = d; d = v2 - mUsed[k + 2]; if (d < 0) d = -d; if (d > moved) moved = d;
          d = (v3 - mUsed[k + 3]) * SHIFT; if (d < 0) d = -d; if (d > moved) moved = d;
        }
      }
      if (!all && moved < this.turn[i] && age[i] < every[i] - 1) { age[i]++; continue; }
      age[i] = 0; rmax[i] = rstill[i];
      { const a = mStart[i] * 12, b = mStart[i + 1] * 12; mUsed.set(mNow.subarray(a, b), a); }
      { const a = off[i], b = a + nu[i] * this.nphi[i]; tab.set(still.subarray(a, b), a); }
      const m0 = mStart[i] * 12, zz = z0[i], inv = 1 / dz[i], rows = nu[i], base = off[i], NPHI = this.nphi[i], QUAD = NPHI / 4, cap = this.cap[i]; let top = rmax[i];
      for (let p = d0; p < d1; p++) {
        const x = dv[p * 3], y = dv[p * 3 + 1], z = dv[p * 3 + 2], cnt = dc[p]; let px = dAt[p * 3], py = dAt[p * 3 + 1], pz = dAt[p * 3 + 2];
        for (let a = 0; a < cnt; a++) {
          const w = dw[p * 4 + a], b = m0 + db[p * 4 + a] * 12;
          px += w * (mNow[b] * x + mNow[b + 1] * y + mNow[b + 2] * z + mNow[b + 3]); py += w * (mNow[b + 4] * x + mNow[b + 5] * y + mNow[b + 6] * z + mNow[b + 7]); pz += w * (mNow[b + 8] * x + mNow[b + 9] * y + mNow[b + 10] * z + mNow[b + 11]);
        }
        const fu = (pz - zz) * inv; if (fu < -0.5 || fu > rows - 0.5) { pu[p] = -1e9; continue; }      // (carried right off the end of its part's map: it is not laid on the map's last row, where it would stand as a disc in the air)
        let i0 = fu | 0; if (fu < 0) i0 = 0; else if (i0 > rows - 2) i0 = rows - 2;
        let r = Math.sqrt(px * px + py * py) + dr[p]; if (r > cap) r = cap;
        const ax = px < 0 ? -px : px, ay = py < 0 ? -py : py, sm = ax + ay, sd = sm > 1e-9 ? ay / sm : 0;
        const tt = (px >= 0 ? (py >= 0 ? sd : 4 - sd) : (py >= 0 ? 2 - sd : 2 + sd)) * QUAD;
        let k0 = tt | 0; if (k0 >= NPHI) k0 -= NPHI; const k1 = k0 + 1 === NPHI ? 0 : k0 + 1;
        pu[p] = fu; pk[p] = tt; pr[p] = r;
        const t0 = base + i0 * NPHI, t1 = t0 + NPHI;
        if (tab[t0 + k0] < r) tab[t0 + k0] = r; if (tab[t0 + k1] < r) tab[t0 + k1] = r; if (tab[t1 + k0] < r) tab[t1 + k0] = r; if (tab[t1 + k1] < r) tab[t1 + k1] = r;
        if (dr[p] > 0) {                                           // (it stands for its neighbours: one column wider each way)
          const ka = k0 === 0 ? NPHI - 1 : k0 - 1, kb = k1 + 1 === NPHI ? 0 : k1 + 1;
          if (tab[t0 + ka] < r) tab[t0 + ka] = r; if (tab[t0 + kb] < r) tab[t0 + kb] = r; if (tab[t1 + ka] < r) tab[t1 + ka] = r; if (tab[t1 + kb] < r) tab[t1 + kb] = r;
        }
        if (r > top) top = r;
      }
      rmax[i] = top;
      // the sides that have stretched: where the two ends of one lie more than two cells apart on the map, the cells between them are laid too
      for (let e = eStart[i], e1 = eStart[i + 1]; e < e1; e++) {
        const a = eA[e], b = eB[e], fa = pu[a], fb = pu[b]; if (fa < -1e8 || fb < -1e8) continue;
        let dk = pk[b] - pk[a]; const du = fb - fa; if (dk > NPHI * 0.5) dk -= NPHI; else if (dk < -NPHI * 0.5) dk += NPHI;
        const far = Math.max(du < 0 ? -du : du, dk < 0 ? -dk : dk); if (far <= 2) continue;      // (each end is laid on the corners of its own cell: up to two cells apart there is no gap)
        const n2 = far > 36 ? 24 : Math.ceil(far / 1.5), ka = pk[a], ra = pr[a], dr2 = pr[b] - ra;
        for (let s = 1; s < n2; s++) {
          const f = s / n2, fu = fa + du * f, r = ra + dr2 * f; let tt = ka + dk * f; if (tt < 0) tt += NPHI; else if (tt >= NPHI) tt -= NPHI;
          let i0 = fu | 0; if (fu < 0) i0 = 0; else if (i0 > rows - 2) i0 = rows - 2;
          let k0 = tt | 0; if (k0 >= NPHI) k0 -= NPHI; const k1 = k0 + 1 === NPHI ? 0 : k0 + 1, t0 = base + i0 * NPHI, t1 = t0 + NPHI;
          if (tab[t0 + k0] < r) tab[t0 + k0] = r; if (tab[t0 + k1] < r) tab[t0 + k1] = r; if (tab[t1 + k0] < r) tab[t1 + k0] = r; if (tab[t1 + k1] < r) tab[t1 + k1] = r;
        }
      }
    }
  }
  /** The body was put somewhere else at once: forget where the parts were. */
  teleport() { this.fresh = true; }

  /**
   * Have the bones been moved since update() read them? (A cutscene poses an arm AFTER the fighters' step; the struck
   * body is shaken while the world is held.) The skeleton's world matrices must be current. tol: metres, and the same
   * number for a unit axis.
   */
  moved(tol = 0.004) {
    if (!this.ready) return false;
    const { cur, loc, bone, n } = this;
    for (let i = 0, o = 0; i < n; i++, o += 12) {
      const e = bone[i].matrixWorld.elements, s = 1 / (Math.hypot(e[0], e[1], e[2]) || 1);
      for (let a = 0; a < 12; a += 3) {
        const x = loc[o + a], y = loc[o + a + 1], z = loc[o + a + 2], k = a ? s : 1, t = a ? 0 : 1;
        let d = (e[0] * x + e[4] * y + e[8] * z + e[12] * t) * k - cur[o + a]; if (d > tol || d < -tol) return true;
        d = (e[1] * x + e[5] * y + e[9] * z + e[13] * t) * k - cur[o + a + 1]; if (d > tol || d < -tol) return true;
        d = (e[2] * x + e[6] * y + e[10] * z + e[14] * t) * k - cur[o + a + 2]; if (d > tol || d < -tol) return true;
      }
    }
    return false;
  }
  /** For a reading that must leave no trace (see Kit.late in wardrobe.js): keep where the parts are / put that back. */
  keep() { (this.kept || (this.kept = new Float32Array(this.cur.length))).set(this.cur); }
  restore() { if (this.kept) this.cur.set(this.kept); }

  /** Where the parts are f of the way through this step's travel (0 = a step ago, 1 = now): for the questions that follow. */
  place(f) {
    const { cur, prev, at, n, box, z0, z1, rmax } = this;
    if (f >= 1) at.set(cur); else for (let k = 0; k < n * 12; k++) at[k] = prev[k] + (cur[k] - prev[k]) * f;
    for (let i = 0, o = 0, b = 0; i < n; i++, o += 12, b += 6) {
      const r = rmax[i];
      for (let a = 0; a < 3; a++) {
        const p0 = at[o + a] + at[o + 9 + a] * z0[i], p1 = at[o + a] + at[o + 9 + a] * z1[i];
        box[b + a] = (p0 < p1 ? p0 : p1) - r; box[b + 3 + a] = (p0 > p1 ? p0 : p1) + r;
      }
    }
  }

  /**
   * Is the point nearer part i than `margin` (metres; inside counts as nearer)? If so: true, and this.ox, oy, oz is
   * the move that puts it `margin` off the part, straight out from the part's axis; this.depth is how long that move is.
   */
  push(i, x, y, z, margin) {
    const at = this.at, o = i * 12;
    const dx = x - at[o], dy = y - at[o + 1], dz = z - at[o + 2];
    const pz = dx * at[o + 9] + dy * at[o + 10] + dz * at[o + 11], fu = (pz - this.z0[i]) / this.dz[i], nu = this.nu[i], NPHI = this.nphi[i];
    if (fu < 0 || fu > nu - 1) return false;
    const px = dx * at[o + 3] + dy * at[o + 4] + dz * at[o + 5], py = dx * at[o + 6] + dy * at[o + 7] + dz * at[o + 8], r2 = px * px + py * py, lim = this.rmax[i] + margin;
    if (r2 >= lim * lim) return false;
    const ax = px < 0 ? -px : px, ay = py < 0 ? -py : py, sum = ax + ay, sd = sum > 1e-9 ? ay / sum : 0, tt = (px >= 0 ? (py >= 0 ? sd : 4 - sd) : (py >= 0 ? 2 - sd : 2 + sd)) * (NPHI >> 2);
    let k0 = tt | 0; const wp = tt - k0; if (k0 >= NPHI) k0 -= NPHI; const k1 = k0 + 1 === NPHI ? 0 : k0 + 1;
    let i0 = fu | 0; if (i0 > nu - 2) i0 = nu - 2; const wu = fu - i0;
    const tab = this.tab, t0 = this.off[i] + i0 * NPHI, t1 = t0 + NPHI;
    const r00 = tab[t0 + k0], r01 = tab[t0 + k1], r10 = tab[t1 + k0], r11 = tab[t1 + k1];
    const ra = r00 + (r01 - r00) * wp, rb = r10 + (r11 - r10) * wp, R = ra + (rb - ra) * wu;
    if (R <= 0) return false;
    const want = R + margin;
    if (r2 >= want * want) return false;
    const r = Math.sqrt(r2), deep = want - r;
    let ux, uy; if (r > 1e-6) { ux = px / r; uy = py / r; } else { ux = 1; uy = 0; }
    // Straight out from the part's axis, like a capsule whose radius is the map's. (At first the way out followed
    // the map's own slope: the nearest way, square to the skin. Over plates and tassets that way turns from one hand's
    // breadth to the next, and cloth that its seams draw against her every sub-step was put out to another side each
    // time: it TREMBLED wherever it was squeezed, on her knees, lying, by a hand to half a metre. Straight out is the
    // same way from one sub-step to the next. tools/tests/clothfit/measure.mjs --shake counts it.)
    const mx = ux * deep, my = uy * deep;
    this.ox = at[o + 3] * mx + at[o + 6] * my; this.oy = at[o + 4] * mx + at[o + 7] * my; this.oz = at[o + 5] * mx + at[o + 8] * my;
    this.depth = deep;
    return true;
  }

  /** How far inside any of the parts (plus margin) a point of the world is, as the parts stand at place(): 0 when it is outside all of them. For tools and for laying out. */
  inside(x, y, z, margin = 0, only = null) {
    let deep = 0;
    for (let j = 0, m = only ? only.length : this.n; j < m; j++) { const i = only ? only[j] : j; if (this.push(i, x, y, z, margin) && this.depth > deep) deep = this.depth; }
    return deep;
  }
}

export class Cloth {
  /**
   * @param o {
   *   cols, rows            particles across and down
   *   scale                 metres per character unit
   *   rest(i, j) -> [x, y]  the sheet laid flat (character units): only the distances between neighbours matter
   *   pin(i, j) -> null | { bone, x, y, z }    particles held on a bone (offset in the bone's own units); normally row 0
   *   capsules, use         a Capsules and the names of those this sheet collides with
   *   parent                Object3D whose space the mesh lives in (the fighter's root): the sheet moves with it for free
   *   material              a three material (two-sided)
   *   subdiv = 2            picture grid cells per particle cell
   *   substeps = 2, iterations = 3
   *   gravity = 9.81, damping = 0.6 (per second, of all motion), drag = 3 (per second, of motion square to the sheet)
   *   stretch = 1, compress = 0.5, shear = 0.6, bend = 0.25, slack = 1.03 (tether length over rest length)
   *   thickness = 0.012 (character units, kept off the body), floor = 0.08 (world y the sheet rests on), friction = 0.4
   *   wind                  THREE.Vector3 (m/s, world), shared and changed by the owner; flutter = 0.5
   *   away                  { bone, x, y, z }: a point the sheet hangs away from when it is first laid out
   *   wetLine               world y under which the sheet gets wet (default: floor + 0.03)
   *   give = 1.1            how far past its own length a limb may carry the cloth before it slips off the limb
   *   walls                 [{ bone, x, y, z, nx, ny, nz }]: flat walls that ride on bones (a point and a normal in the
   *                         bone's own frame): the sheet stays on the side the normal points to (a veil that may not
   *                         fall forward over a face, a panel that may not fly up past the belt)
   *   A sudden stop (a lunge of thirty metres a second that ends in one step, a head thrown to the floor) must not
   *   leave the sheet standing in the air like a sail. Four limits, all off unless given (character units a second):
   *   carry                 the sheet is TAKEN ALONG with the place it hangs from for the part of that place's speed
   *                         over this: it never feels its bearer move faster, so it has little to keep when she stops
   *                         (carryDown: true: only the downward part of that speed, for a cloak on a man who drops)
   *   maxSpeed = 30         no particle keeps more speed than this from one sub-step to the next
   *   rise                  ... nor more upward speed than this (gravity wins: thrown cloth rises a hand, not a storey)
   *   toss                  the most speed a body that pushes the sheet aside may leave it with, along the push (a
   *                         blade at forty metres a second parts the cloth; it does not fling it)
   *   The body as it really is (Shapes, above), instead of capsules for it. All off unless `shapes` is given:
   *   shapes, fit           a Shapes (fitted), and the names of its parts this sheet lies on (default: all of them), in
   *                         the order they are asked: the LAST has the last word (name the trunk after the limbs)
   *   skin = 0.006          how far off the body the particles are kept (character units)
   *   picture = 0.003       ... and the picture's own vertices, which are pushed out once more when the picture is
   *                         written (the picture's grid is finer than the particles': it sags between them)
   *   mid = 0.045           the middle of every edge between two particles that is longer than this at rest is kept
   *                         off the body as well (a limb passes between particles that stand a forearm apart)
   *   ease = 0.16           a held edge may be pinned nearer the body than `skin` (a belt lies ON the hips): what hangs
   *                         from it is let that much nearer too, fading out over this length of cloth
   * }
   */
  constructor(o) {
    const cols = this.cols = o.cols, rows = this.rows = o.rows, n = this.n = cols * rows, S = this.scale = o.scale || 1;
    this.substeps = o.substeps || 2; this.iterations = o.iterations || 3;
    this.gravity = o.gravity !== undefined ? o.gravity : 9.81; this.damping = o.damping !== undefined ? o.damping : 0.6; this.drag = o.drag !== undefined ? o.drag : 3;
    this.friction = o.friction !== undefined ? o.friction : 0.4; this.floor = o.floor !== undefined ? o.floor : 0.08; this.wetLine = o.wetLine !== undefined ? o.wetLine : this.floor + 0.03;
    this.thick = (o.thickness !== undefined ? o.thickness : 0.012) * S; this.flutter = o.flutter !== undefined ? o.flutter : 0.5;
    this.wind = o.wind || new THREE.Vector3(); this.time = 0; this.maxStep = (o.maxSpeed || 30) * S;
    this.carryDown = !!o.carryDown; this.carry = (o.carry !== undefined ? o.carry : Infinity) * S; this.rise = (o.rise !== undefined ? o.rise : Infinity) * S; this.toss = (o.toss !== undefined ? o.toss : Infinity) * S;
    this.cPrev = new Float32Array(3); this.cs = new Float32Array(3); this.tossStep = Infinity;      // (where the held edge's middle was a step ago; what each sub-step takes the sheet along by)
    this.body = o.capsules || null; this.caps = this.body && o.use ? Int32Array.from(this.body.ids(o.use)) : new Int32Array(0);
    this.parent = o.parent; this.away = o.away || null; this.wetDark = o.wetDark !== undefined ? o.wetDark : 0.5; this.dry = o.dry || 0.06;

    this.x = new Float32Array(n * 3); this.p = new Float32Array(n * 3); this.nrm = new Float32Array(n * 3); this.w = new Float32Array(n).fill(1); this.wet = new Float32Array(n);
    // the flat pattern, in metres
    const pat = new Float32Array(n * 2);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const r = o.rest(i, j); pat[(j * cols + i) * 2] = r[0] * S; pat[(j * cols + i) * 2 + 1] = r[1] * S; }
    const dist = (a, b) => Math.hypot(pat[a * 2] - pat[b * 2], pat[a * 2 + 1] - pat[b * 2 + 1]);
    // pins
    const pins = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const q = o.pin(i, j); if (q) { pins.push({ k: j * cols + i, bone: q.bone, x: q.x, y: q.y, z: q.z }); this.w[j * cols + i] = 0; } }
    this.pins = pins; this.pinCur = new Float32Array(pins.length * 3); this.pinPrev = new Float32Array(pins.length * 3);
    this.pinBone = pins.length && pins.every((q) => q.bone === pins[0].bone) ? pins[0].bone : null;      // (the one bone the whole held edge rides on, if it is one)
    this.walls = o.walls || [];
    this.bound = new Float32Array(4);                      // a ball round the whole sheet (world): the middle of its held edge, as far as its longest fall
    this.heldList = new Int32Array(n); this.give = o.give !== undefined ? o.give : 1.1;      // (give: how far past its length a limb may carry the cloth before the cloth lets go of it)
    // the body as it really is (Shapes): which parts, how far off them, and what is asked besides the particles
    this.fit = o.shapes && o.shapes.ready ? o.shapes : null;
    if (this.fit) {
      this.fitIds = Int32Array.from(o.fit ? this.fit.ids(o.fit) : this.fit.names.map((_, i) => i));
      this.skinOff = (o.skin !== undefined ? o.skin : 0.006) * S; this.picOff = (o.picture !== undefined ? o.picture : 0.003) * S; this.easeLen = (o.ease !== undefined ? o.ease : 0.16) * S;
      this.ease = new Float32Array(n); this.rowBox = new Float32Array(rows * 6); this.rowNear = new Uint8Array(rows + 1); this.midMin = (o.mid !== undefined ? o.mid : 0.045) * S;
      // what is DRAWN where the cloth goes there and back (see calmShow)
      this.xA = new Float32Array(n * 3); this.xB = new Float32Array(n * 3); this.show = new Float32Array(n * 3); this.osc = new Uint8Array(n); this.calmSkip = true; this.popMin = (o.pop !== undefined ? o.pop : 0.0011) * S;
    }
    // constraints, in the order they are solved: down the columns first (a pull at the top reaches the hem in one pass)
    const A = [], B = [], R = [], K = [], C = [];
    const add = (a, b, k, c) => { if (this.w[a] === 0 && this.w[b] === 0) return; A.push(a); B.push(b); R.push(dist(a, b)); K.push(k); C.push(c); };
    const st = o.stretch !== undefined ? o.stretch : 1, co = o.compress !== undefined ? o.compress : 0.5, sh = o.shear !== undefined ? o.shear : 0.6, be = o.bend !== undefined ? o.bend : 0.25;
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols; i++) add(j * cols + i, (j + 1) * cols + i, st, st * co);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols - 1; i++) add(j * cols + i, j * cols + i + 1, st, st * co);
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) { add(j * cols + i, (j + 1) * cols + i + 1, sh, sh * co); add(j * cols + i + 1, (j + 1) * cols + i, sh, sh * co); }
    for (let j = 0; j < rows - 2; j++) for (let i = 0; i < cols; i++) add(j * cols + i, (j + 2) * cols + i, be, be);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols - 2; i++) add(j * cols + i, j * cols + i + 2, be, be);
    this.cA = Int32Array.from(A); this.cB = Int32Array.from(B); this.cR = Float32Array.from(R); this.cK = Float32Array.from(K); this.cC = Float32Array.from(C);
    if (this.fit) {
      // the long edges, row by row: down from each particle of the row, and along the row
      const ma = [], mb = [], start = [0];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          if (j < rows - 1 && dist(k, k + cols) > this.midMin && !(this.w[k] === 0 && this.w[k + cols] === 0)) { ma.push(k); mb.push(k + cols); }
          if (i < cols - 1 && dist(k, k + 1) > this.midMin && !(this.w[k] === 0 && this.w[k + 1] === 0)) { ma.push(k); mb.push(k + 1); }
        }
        start.push(ma.length);
      }
      this.mA = Int32Array.from(ma); this.mB = Int32Array.from(mb); this.mRow = Int32Array.from(start);
      // ... and the middle of every cell both of whose sides are long (a shin, a foot, a forearm goes through the middle of a cell that is a forearm wide)
      const qa = [], qStart = [0];
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) { const k = j * cols + i; if (dist(k, k + cols) > this.midMin && dist(k, k + 1) > this.midMin) qa.push(k); }
        qStart.push(qa.length);
      }
      this.qA = Int32Array.from(qa); this.qRow = Int32Array.from(qStart);
    }
    // tethers: every free particle to the nearest held particle above it in its column (or, failing that, the nearest pin)
    const slack = o.slack || 1.03; this.tA = new Int32Array(n).fill(-1); this.tL = new Float32Array(n);
    for (let i = 0; i < cols; i++) {
      let anchor = -1, len = 0;
      for (let j = 0; j < rows; j++) {
        const k = j * cols + i;
        if (this.w[k] === 0) { anchor = k; len = 0; continue; }
        if (anchor >= 0) { len += dist(k, k - cols); this.tA[k] = anchor; this.tL[k] = len * slack; }
      }
    }
    for (let k = 0; k < n; k++) if (this.w[k] !== 0 && this.tA[k] < 0 && pins.length) {
      let best = pins[0].k, bd = Infinity; for (const q of pins) { const d = dist(k, q.k); if (d < bd) { bd = d; best = q.k; } }
      this.tA[k] = best; this.tL[k] = bd * slack * 1.1;
    }
    this.pat = pat;

    // the picture: a finer grid
    const s = this.subdiv = Math.max(1, o.subdiv || 2), fc = this.fc = (cols - 1) * s + 1, fr = this.fr = (rows - 1) * s + 1, fn = fc * fr;
    this.loc = new Float32Array(n * 3); this.tmp = new Float32Array(fc * rows * 3); this.tmpW = new Float32Array(fc * rows);
    if (this.fit) { this.picEase = new Float32Array(fn); this.picW = new Float32Array(fn * 3); this.picBox = new Float32Array(fr * 6); this.picHeld = new Uint8Array(fn); this.pinched = new Int32Array(fn); }      // (picHeld: which vertices this write() moved; pinched: their numbers)
    const pos = new Float32Array(fn * 3), nor = new Float32Array(fn * 3), uv = new Float32Array(fn * 2), col = new Float32Array(fn * 3).fill(1);
    for (let j = 0; j < fr; j++) for (let i = 0; i < fc; i++) { uv[(j * fc + i) * 2] = i / (fc - 1); uv[(j * fc + i) * 2 + 1] = 1 - j / (fr - 1); }
    const idx = fn > 65535 ? new Uint32Array((fc - 1) * (fr - 1) * 6) : new Uint16Array((fc - 1) * (fr - 1) * 6);
    for (let j = 0, t = 0; j < fr - 1; j++) for (let i = 0; i < fc - 1; i++) {
      const a = j * fc + i, b = a + 1, c = a + fc, d = c + 1;
      // wound so that a triangle's front is the side its normals (across x down) point from: the light falls on the right side
      if ((i + j) & 1) { idx[t++] = a; idx[t++] = b; idx[t++] = c; idx[t++] = b; idx[t++] = d; idx[t++] = c; } else { idx[t++] = a; idx[t++] = d; idx[t++] = c; idx[t++] = a; idx[t++] = b; idx[t++] = d; }
    }
    const g = this.geometry = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);        // never culled by mistake: it is always near a fighter
    this.mesh = new THREE.Mesh(g, o.material); this.mesh.name = o.name || 'cloth'; this.mesh.frustumCulled = false;
    this.mesh.castShadow = o.castShadow !== false; this.mesh.receiveShadow = o.receiveShadow !== false;
    if (this.parent) this.parent.add(this.mesh);
    // Catmull-Rom weights for the s places between two particles
    this.cr = new Float32Array(s * 4);
    for (let k = 0; k < s; k++) { const t = k / s, t2 = t * t, t3 = t2 * t; this.cr[k * 4] = -0.5 * t3 + t2 - 0.5 * t; this.cr[k * 4 + 1] = 1.5 * t3 - 2.5 * t2 + 1; this.cr[k * 4 + 2] = -1.5 * t3 + 2 * t2 + 0.5 * t; this.cr[k * 4 + 3] = 0.5 * t3 - 0.5 * t2; }
    this.laid = false; this.settleSteps = o.settle !== undefined ? o.settle : 40;
  }

  /** Where the held particles are now (the skeleton's world matrices must be current). */
  readPins() {
    const pins = this.pins, cur = this.pinCur;
    this.pinPrev.set(cur);
    if (this.reachMax === undefined) { let r = 0; for (let k = 0; k < this.n; k++) if (this.tL[k] > r) r = this.tL[k]; this.reachMax = r * 1.15; }
    for (let i = 0, k = 0; i < pins.length; i++, k += 3) {
      const q = pins[i], e = q.bone.matrixWorld.elements;
      cur[k] = e[0] * q.x + e[4] * q.y + e[8] * q.z + e[12]; cur[k + 1] = e[1] * q.x + e[5] * q.y + e[9] * q.z + e[13]; cur[k + 2] = e[2] * q.x + e[6] * q.y + e[10] * q.z + e[14];
    }
    // the ball round the sheet: the middle of the held particles, and the furthest any of them is from it, plus the longest fall
    let cx = 0, cy = 0, cz = 0; const np = pins.length || 1; for (let k = 0; k < pins.length * 3; k += 3) { cx += cur[k]; cy += cur[k + 1]; cz += cur[k + 2]; } cx /= np; cy /= np; cz /= np;
    let far = 0; for (let k = 0; k < pins.length * 3; k += 3) { const d = (cur[k] - cx) * (cur[k] - cx) + (cur[k + 1] - cy) * (cur[k + 1] - cy) + (cur[k + 2] - cz) * (cur[k + 2] - cz); if (d > far) far = d; }
    const b = this.bound; b[0] = cx; b[1] = cy; b[2] = cz; b[3] = Math.sqrt(far) + this.reachMax + (this.pinTravel || 0);
  }

  /** Lay the sheet out hanging from its pins, away from the body, and let it come to rest. */
  layOut() {
    const { x, p, n, cols, rows, pins, pinCur, pat } = this;
    this.readPins(); this.pinPrev.set(pinCur); this.cPrev.set(this.bound.subarray(0, 3));
    let cx = 0, cy = 0, cz = 0;
    if (this.away) { const a = this.away, e = a.bone.matrixWorld.elements; cx = e[0] * a.x + e[4] * a.y + e[8] * a.z + e[12]; cz = e[2] * a.x + e[6] * a.y + e[10] * a.z + e[14]; }
    else { for (let i = 0; i < pins.length; i++) { cx += pinCur[i * 3]; cz += pinCur[i * 3 + 2]; } cx /= pins.length || 1; cz /= pins.length || 1; }
    for (let i = 0; i < pins.length; i++) { const k = pins[i].k * 3; x[k] = pinCur[i * 3]; x[k + 1] = pinCur[i * 3 + 1]; x[k + 2] = pinCur[i * 3 + 2]; }
    for (let k = 0; k < n; k++) {
      if (this.w[k] === 0) continue;
      const a = this.tA[k]; if (a < 0) continue;
      let ox = x[a * 3] - cx, oz = x[a * 3 + 2] - cz; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
      const d = Math.hypot(pat[k * 2] - pat[a * 2], pat[k * 2 + 1] - pat[a * 2 + 1]);
      // down from its anchor, leaning a little outward; the constraints spread it sideways as it settles
      x[k * 3] = x[a * 3] + ox * d * 0.22; x[k * 3 + 1] = x[a * 3 + 1] - d * 0.95; x[k * 3 + 2] = x[a * 3 + 2] + oz * d * 0.22;
      if (x[k * 3 + 1] < this.floor) x[k * 3 + 1] = this.floor;
    }
    p.set(x); this.wet.fill(0);
    if (this.fit) this.easeOff();
    const drag = this.drag, damping = this.damping, flutter = this.flutter;
    this.drag = 8; this.damping = 6; this.flutter = 0;
    for (let i = 0; i < this.settleSteps; i++) this.substep(1 / 120, 1, false);
    this.drag = drag; this.damping = damping; this.flutter = flutter;
    p.set(x); this.laid = true;
  }

  /**
   * The body was moved at once: carry the sheet with it as it hangs (m = the rigid move, a Matrix4 from the old place
   * to the new one), then let it settle for a moment with the body still.
   */
  teleport(m) {
    if (!this.laid) return;
    const { x, p, n } = this;
    if (this.fit) this.calmSkip = true;                          // (what is drawn starts afresh from where the cloth is put)
    if (m) {
      const e = m.elements;
      for (let k = 0; k < n * 3; k += 3) {
        const a = x[k], b = x[k + 1], c = x[k + 2];
        x[k] = e[0] * a + e[4] * b + e[8] * c + e[12]; x[k + 1] = e[1] * a + e[5] * b + e[9] * c + e[13]; x[k + 2] = e[2] * a + e[6] * b + e[10] * c + e[14];
      }
    }
    this.readPins(); this.pinPrev.set(this.pinCur);
    p.set(x);
    // about a second of falling into the new pose, in coarse steps, so nothing is seen settling after a cut
    const drag = this.drag, damping = this.damping, flutter = this.flutter;
    this.drag = 8; this.damping = 5; this.flutter = 0;
    for (let i = 0; i < 48; i++) this.substep(1 / 50, 1, false);
    this.drag = drag; this.damping = damping; this.flutter = flutter;
    p.set(x); this.skip = true;
  }

  update(dt) {
    if (!this.laid) { this.layOut(); this.write(); return; }
    this.readPins();
    if (this.skip) { this.skip = false; this.pinPrev.set(this.pinCur); this.cPrev.set(this.bound.subarray(0, 3)); }
    this.time += dt;
    const h = dt / this.substeps;
    // the place it hangs from moved faster than `carry`: the sheet goes along with the rest of that travel, at rest
    { const b = this.bound, c = this.cPrev, cs = this.cs; let sx = b[0] - c[0], sy = b[1] - c[1], sz = b[2] - c[2]; c[0] = b[0]; c[1] = b[1]; c[2] = b[2];
      if (this.carryDown) { sx = 0; sz = 0; if (sy > 0) sy = 0; }      // (only where its bearer DROPS: a cloak is not left standing over a man who falls)
      const d = Math.sqrt(sx * sx + sy * sy + sz * sz), lim = this.carry * dt;
      if (d > lim) { const k = (1 - lim / d) / this.substeps; cs[0] = sx * k; cs[1] = sy * k; cs[2] = sz * k; } else cs[0] = cs[1] = cs[2] = 0; }
    this.tossStep = this.toss * h;
    this.normals();
    for (let s = 1; s <= this.substeps; s++) this.substep(h, s / this.substeps, true);
    this.cs[0] = this.cs[1] = this.cs[2] = 0; this.tossStep = Infinity;
    // wetness: under the line it soaks at once, above it dries slowly
    const { x, wet, n } = this, line = this.wetLine, dry = this.dry * dt;
    for (let k = 0; k < n; k++) { if (x[k * 3 + 1] < line) wet[k] = 1; else if (wet[k] > 0) wet[k] = Math.max(0, wet[k] - dry); }
    if (this.fit) this.calmShow();
    this.write();
  }

  /** Normals of the particle grid (for the air's push); unit length. */
  normals() {
    const { x, nrm, cols, rows } = this;
    for (let j = 0; j < rows; j++) {
      const j0 = j > 0 ? j - 1 : j, j1 = j < rows - 1 ? j + 1 : j;
      for (let i = 0; i < cols; i++) {
        const i0 = i > 0 ? i - 1 : i, i1 = i < cols - 1 ? i + 1 : i;
        const a = (j * cols + i0) * 3, b = (j * cols + i1) * 3, c = (j0 * cols + i) * 3, d = (j1 * cols + i) * 3;
        const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2], vx = x[d] - x[c], vy = x[d + 1] - x[c + 1], vz = x[d + 2] - x[c + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        const k = (j * cols + i) * 3; nrm[k] = nx / l; nrm[k + 1] = ny / l; nrm[k + 2] = nz / l;
      }
    }
  }

  /** One sub-step of h seconds; f = how far through this update's travel the pins and capsules are (0..1). */
  substep(h, f, air) {
    const { x, p, w, n, nrm } = this;
    // held particles ride their bones
    const pins = this.pins, pc = this.pinCur, pp = this.pinPrev;
    for (let i = 0, k = 0; i < pins.length; i++, k += 3) {
      const q = pins[i].k * 3;
      x[q] = pp[k] + (pc[k] - pp[k]) * f; x[q + 1] = pp[k + 1] + (pc[k + 1] - pp[k + 1]) * f; x[q + 2] = pp[k + 2] + (pc[k + 2] - pp[k + 2]) * f;
      p[q] = x[q]; p[q + 1] = x[q + 1]; p[q + 2] = x[q + 2];
    }
    // the free ones fall, keep their motion, and feel the air
    const keep = Math.exp(-this.damping * h), dr = air ? 1 - Math.exp(-this.drag * h) : 0, gy = -this.gravity * h * h, max = this.maxStep * h, up = this.rise * h;
    const t = this.time, fl = this.flutter, wind = this.wind, wx0 = wind.x * h, wy0 = wind.y * h, wz0 = wind.z * h, cx = this.cs[0], cy = this.cs[1], cz = this.cs[2];
    for (let k = 0, q = 0; k < n; k++, q += 3) {
      if (w[k] === 0) continue;
      let dx = (x[q] - p[q]) * keep, dy = (x[q + 1] - p[q + 1]) * keep, dz = (x[q + 2] - p[q + 2]) * keep;
      if (dr > 0) {
        // the wind comes in slow swells and quick flickers that differ from place to place on the sheet
        const g = fl > 0 ? 1 + fl * (Math.sin(t * 1.3 + x[q] * 0.7 + x[q + 2] * 0.45) * 0.6 + Math.sin(t * 3.7 + x[q] * 2.1 - x[q + 1] * 1.3) * 0.4) : 1;
        const nx = nrm[q], ny = nrm[q + 1], nz = nrm[q + 2], rel = (dx - wx0 * g) * nx + (dy - wy0 * g) * ny + (dz - wz0 * g) * nz;
        dx -= rel * nx * dr; dy -= rel * ny * dr; dz -= rel * nz * dr;
      }
      dy += gy; if (dy > up) dy = up;
      const l2 = dx * dx + dy * dy + dz * dz; if (l2 > max * max) { const s = max / Math.sqrt(l2); dx *= s; dy *= s; dz *= s; }
      p[q] = x[q] + cx; p[q + 1] = x[q + 1] + cy; p[q + 2] = x[q + 2] + cz;      // (taken along with the place it hangs from: no speed comes of that)
      x[q] = p[q] + dx; x[q + 1] = p[q + 1] + dy; x[q + 2] = p[q + 2] + dz;
    }
    const { cA, cB, cR, cK, cC, tA, tL } = this, m = cA.length;
    for (let it = 0; it < this.iterations; it++) {
      for (let c = 0; c < m; c++) {
        const ia = cA[c], ib = cB[c], a = ia * 3, b = ib * 3;
        const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const d = Math.sqrt(d2), wa = w[ia], wb = w[ib], r = cR[c];
        const s = (d > r ? cK[c] : cC[c]) * (d - r) / (d * (wa + wb));
        if (wa !== 0) { x[a] += dx * s; x[a + 1] += dy * s; x[a + 2] += dz * s; }
        if (wb !== 0) { x[b] -= dx * s; x[b + 1] -= dy * s; x[b + 2] -= dz * s; }
      }
      // tethers: no particle may be further from the one it hangs from than the cloth between them is long
      for (let k = 0, q = 0; k < n; k++, q += 3) {
        const a = tA[k]; if (a < 0) continue;
        const a3 = a * 3, dx = x[q] - x[a3], dy = x[q + 1] - x[a3 + 1], dz = x[q + 2] - x[a3 + 2], d2 = dx * dx + dy * dy + dz * dz, L = tL[k];
        if (d2 > L * L) { const s = L / Math.sqrt(d2); x[q] = x[a3] + dx * s; x[q + 1] = x[a3 + 1] + dy * s; x[q + 2] = x[a3 + 2] + dz * s; }
      }
    }
    // the body: every particle out of every part of it (and the middles of the long edges), then out of every capsule
    if (this.fit) this.lieOn(f, null, 0);
    this.collide(f, null, 0);
    // ... and no stretching. A limb can carry the cloth further from where it hangs than the cloth is long (a foot
    // under a skirt, an elbow behind a cloak): there the cloth must slip off the limb. Particles held too far are
    // drawn back to their length, pushed out of the body once more (which slides them round it), and, where a limb
    // leaves them no place within their length, the length has the last word (a little give: cloth stretches a hand).
    let held = 0; const list = this.heldList;
    for (let k = 0, q = 0; k < n; k++, q += 3) {
      const a = tA[k]; if (a < 0) continue;
      const a3 = a * 3, dx = x[q] - x[a3], dy = x[q + 1] - x[a3 + 1], dz = x[q + 2] - x[a3 + 2], d2 = dx * dx + dy * dy + dz * dz, L = tL[k];
      if (d2 > L * L * 1.0404) { const s = L / Math.sqrt(d2); x[q] = x[a3] + dx * s; x[q + 1] = x[a3 + 1] + dy * s; x[q + 2] = x[a3 + 2] + dz * s; list[held++] = k; }
    }
    if (held) {
      if (this.fit) this.lieOn(f, list, held);
      this.collide(f, list, held);
      for (let i = 0; i < held; i++) {
        const k = list[i], q = k * 3, a3 = tA[k] * 3, dx = x[q] - x[a3], dy = x[q + 1] - x[a3 + 1], dz = x[q + 2] - x[a3 + 2], d2 = dx * dx + dy * dy + dz * dz, L = tL[k] * this.give;
        if (d2 > L * L) { const s = L / Math.sqrt(d2); x[q] = x[a3] + dx * s; x[q + 1] = x[a3 + 1] + dy * s; x[q + 2] = x[a3 + 2] + dz * s; }
      }
    }
    // walls that ride on bones: the sheet stays on its side of each
    for (let wi = 0; wi < this.walls.length; wi++) {
      const wl = this.walls[wi], e = wl.bone.matrixWorld.elements, sc = Math.hypot(e[0], e[1], e[2]) || 1;
      const ox = e[0] * wl.x + e[4] * wl.y + e[8] * wl.z + e[12], oy = e[1] * wl.x + e[5] * wl.y + e[9] * wl.z + e[13], oz = e[2] * wl.x + e[6] * wl.y + e[10] * wl.z + e[14];
      const nx = (e[0] * wl.nx + e[4] * wl.ny + e[8] * wl.nz) / sc, ny = (e[1] * wl.nx + e[5] * wl.ny + e[9] * wl.nz) / sc, nz = (e[2] * wl.nx + e[6] * wl.ny + e[10] * wl.nz) / sc;
      for (let q = 0, i = 0; i < n; i++, q += 3) {
        if (w[i] === 0) continue;
        const d = (x[q] - ox) * nx + (x[q + 1] - oy) * ny + (x[q + 2] - oz) * nz;
        if (d < 0) { x[q] -= nx * d; x[q + 1] -= ny * d; x[q + 2] -= nz * d; }
      }
    }
    // the water it rests on: it cannot go under, and it drags
    const fy = this.floor, mu = this.friction;
    for (let q = 0, i = 0; i < n; i++, q += 3) {
      if (w[i] === 0 || x[q + 1] >= fy) continue;
      x[q + 1] = fy; if (p[q + 1] < fy) p[q + 1] = fy;
      p[q] += (x[q] - p[q]) * mu; p[q + 2] += (x[q + 2] - p[q + 2]) * mu;
    }
  }

  /**
   * How much nearer the body than `skin` each particle may lie: a held edge is pinned where its owner put it (a belt
   * on the hips, a veil under a crown), often nearer the body's map than the cloth is otherwise kept; what hangs from
   * it is let as near, fading out over `ease` of cloth. Worked out once, when the sheet is laid out (the pins are in
   * the world by then), against the parts that ride on each pin's own bone.
   */
  easeOff() {
    const sh = this.fit, { pins, pinCur, ease, n, tA, pat, cols, rows, fc, fr } = this, s = this.subdiv, off = this.skinOff;
    sh.place(1); ease.fill(0);
    const deep = new Float32Array(n);
    for (let i = 0; i < pins.length; i++) {
      const q = pins[i]; let d = 0;
      for (let j = 0; j < this.fitIds.length; j++) { const id = this.fitIds[j]; if (sh.bone[id] !== q.bone) continue; if (sh.push(id, pinCur[i * 3], pinCur[i * 3 + 1], pinCur[i * 3 + 2], off) && sh.depth > d) d = sh.depth; }
      deep[q.k] = d; ease[q.k] = d;
    }
    for (let k = 0; k < n; k++) {
      const a = tA[k]; if (a < 0 || this.w[k] === 0 || !(deep[a] > 0)) continue;
      const d = Math.hypot(pat[k * 2] - pat[a * 2], pat[k * 2 + 1] - pat[a * 2 + 1]);
      ease[k] = deep[a] * Math.max(0, 1 - d / this.easeLen);
    }
    // the same for the picture's vertices (between the particles': straight lines are near enough)
    const pe = this.picEase; this.picHeld.fill(0);
    for (let J = 0; J < fr; J++) {
      const j0 = Math.min(rows - 2, (J / s) | 0), v = J / s - j0;
      for (let I = 0; I < fc; I++) {
        const i0 = Math.min(cols - 2, (I / s) | 0), u = I / s - i0, a = j0 * cols + i0;
        pe[J * fc + I] = (ease[a] * (1 - u) + ease[a + 1] * u) * (1 - v) + (ease[a + cols] * (1 - u) + ease[a + cols + 1] * u) * v;
      }
    }
  }

  /**
   * WHAT IS DRAWN. Where the cloth has no place (a seam across a limb, cloth under a knee or between a thigh and a
   * calf) a particle can go THERE AND BACK from one step to the next for as long as she holds still: the seams draw
   * it in, the body puts it out, by a finger or by a hand. Drawn as it stands the sheet flickers, and a flicker is
   * seen even small and far away. So the picture is drawn from `show`, not from the particles: a particle that went
   * one way in the last step and more than half of that back in this one is shown MIDWAY between the two places
   * (eased there, for a fifth of a second after it last did so, and eased back); every other particle is shown where it is. The
   * cloth itself is not touched, and the picture is still put off her body afterwards (pictureOff).
   */
  calmShow() {
    const { x, xA, xB, show, osc, n, w } = this;
    if (this.calmSkip) { this.calmSkip = false; xA.set(x); xB.set(x); show.set(x); osc.fill(0); return; }
    const min2 = this.popMin * this.popMin;
    for (let k = 0, q = 0; k < n; k++, q += 3) {
      const X = x[q], Y = x[q + 1], Z = x[q + 2];
      if (w[k] !== 0) {
        const ux = xA[q] - xB[q], uy = xA[q + 1] - xB[q + 1], uz = xA[q + 2] - xB[q + 2], u2 = ux * ux + uy * uy + uz * uz;
        if (u2 > min2) { const vx = X - xA[q], vy = Y - xA[q + 1], vz = Z - xA[q + 2], v2 = vx * vx + vy * vy + vz * vz, dot = ux * vx + uy * vy + uz * vz; if (dot < 0 && v2 > 0.25 * u2 && dot * dot > 0.25 * u2 * v2) osc[k] = 12; }
        if (osc[k] > 0) {
          osc[k]--;
          show[q] += (0.5 * (X + xA[q]) - show[q]) * 0.5; show[q + 1] += (0.5 * (Y + xA[q + 1]) - show[q + 1]) * 0.5; show[q + 2] += (0.5 * (Z + xA[q + 2]) - show[q + 2]) * 0.5;
          continue;
        }
      }
      // (not going there and back: shown where it is. One that WAS shown elsewhere a step ago comes to its place by
      //  halves, so nothing jumps when the holding ends: for all the others `show` was their place and stays so.)
      const ox = show[q] - xA[q], oy = show[q + 1] - xA[q + 1], oz = show[q + 2] - xA[q + 2];
      if (ox * ox + oy * oy + oz * oz > 1e-6) { show[q] = X + 0.5 * ox; show[q + 1] = Y + 0.5 * oy; show[q + 2] = Z + 0.5 * oz; }
      else { show[q] = X; show[q + 1] = Y; show[q + 2] = Z; }
    }
    xB.set(xA); xA.set(x);
  }

  /** A box round each row of particles, `off` wider (this.rowBox: six numbers a row). */
  rowBoxes(off) {
    const { x, cols, rows } = this, rb = this.rowBox;
    for (let j = 0, b = 0; j < rows; j++, b += 6) {
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
      for (let i = 0, q = j * cols * 3; i < cols; i++, q += 3) { const a = x[q], bb = x[q + 1], cc = x[q + 2]; if (a < lx) lx = a; if (a > hx) hx = a; if (bb < ly) ly = bb; if (bb > hy) hy = bb; if (cc < lz) lz = cc; if (cc > hz) hz = cc; }
      rb[b] = lx - off; rb[b + 1] = ly - off; rb[b + 2] = lz - off; rb[b + 3] = hx + off; rb[b + 4] = hy + off; rb[b + 5] = hz + off;
    }
  }

  /**
   * The sheet lies ON the body: every particle is put `skin` off every part of the Shapes it knows (f: how far through
   * this update's travel the parts are), then the middle of every long edge (both its ends are moved). Rows of the
   * sheet that are nowhere near a part are not asked. `list` (with `count`): only these particles.
   */
  lieOn(f, list, count) {
    const sh = this.fit, ids = this.fitIds, { x, p, w, cols, rows, ease } = this, off = this.skinOff, toss = this.tossStep;
    sh.place(f);
    if (list) {
      for (let c = 0; c < ids.length; c++) {
        const id = ids[c], own = sh.bone[id] === this.pinBone;
        const o = id * 6, ax0 = sh.box[o] - off, ay0 = sh.box[o + 1] - off, az0 = sh.box[o + 2] - off, ax1 = sh.box[o + 3] + off, ay1 = sh.box[o + 4] + off, az1 = sh.box[o + 5] + off;
        for (let j = 0; j < count; j++) {
          const i = list[j]; if (w[i] === 0) continue; const q = i * 3, X = x[q], Y = x[q + 1], Z = x[q + 2];
          if (X < ax0 || X > ax1 || Y < ay0 || Y > ay1 || Z < az0 || Z > az1) continue;
          if (sh.push(id, X, Y, Z, own ? off - ease[i] : off)) { x[q] += sh.ox; x[q + 1] += sh.oy; x[q + 2] += sh.oz; }
        }
      }
      return;
    }
    // a box round each row of particles
    const rb = this.rowBox, near = this.rowNear, box = sh.box, mA = this.mA, mB = this.mB, mRow = this.mRow, qA = this.qA, qRow = this.qRow, fy = this.floor - 1e-4;
    // FIRST what lies between the particles: the middle of every long edge (both its ends make the move) and of every
    // wide cell (all four corners). These moves are made first and the particles' own afterwards, so that the last
    // word in a sub-step is always "no particle in her": made the other way round a middle's move could leave one of
    // its ends inside a limb, to be thrown out the next sub-step and drawn in again the one after. And a middle is
    // never put out DOWNWARD through the floor (a shin lying in the water with cloth over it: the floor would put the
    // ends back up, sideways of where they were, every sub-step).
    this.rowBoxes(off); near[rows] = 0; let moved = false;
    for (let c = 0; c < ids.length; c++) {
      const id = ids[c], o = id * 6, bx0 = box[o], by0 = box[o + 1], bz0 = box[o + 2], bx1 = box[o + 3], by1 = box[o + 4], bz1 = box[o + 5];
      const own = sh.bone[id] === this.pinBone, ax0 = bx0 - off, ay0 = by0 - off, az0 = bz0 - off, ax1 = bx1 + off, ay1 = by1 + off, az1 = bz1 + off;
      let any = 0;
      for (let j = 0, b = 0; j < rows; j++, b += 6) { const hit = rb[b] <= bx1 && rb[b + 3] >= bx0 && rb[b + 1] <= by1 && rb[b + 4] >= by0 && rb[b + 2] <= bz1 && rb[b + 5] >= bz0 ? 1 : 0; near[j] = hit; any |= hit; }
      if (!any) continue;
      for (let j = 0; j < rows; j++) {
        if (!near[j] && !near[j + 1]) continue;
        // the middles of the long edges of the rows that are near (an edge down from row j is near if j or j + 1 is)
        for (let e = mRow[j]; e < mRow[j + 1]; e++) {
          const a = mA[e], b = mB[e], qa = a * 3, qb = b * 3, X = (x[qa] + x[qb]) * 0.5, Y = (x[qa + 1] + x[qb + 1]) * 0.5, Z = (x[qa + 2] + x[qb + 2]) * 0.5;
          if (X < ax0 || X > ax1 || Y < ay0 || Y > ay1 || Z < az0 || Z > az1) continue;
          if (!sh.push(id, X, Y, Z, own ? off - (ease[a] + ease[b]) * 0.5 : off)) continue;
          const k = w[a] === 0 || w[b] === 0 ? 2 : 1, dx = sh.ox * k, dy = sh.oy * k, dz = sh.oz * k;      // (one end held: the other makes the whole move)
          if (dy < 0 && ((w[a] !== 0 && x[qa + 1] + dy < fy) || (w[b] !== 0 && x[qb + 1] + dy < fy))) continue;
          if (w[a] !== 0) { x[qa] += dx; x[qa + 1] += dy; x[qa + 2] += dz; }
          if (w[b] !== 0) { x[qb] += dx; x[qb + 1] += dy; x[qb + 2] += dz; }
          moved = true;
        }
        // ... and the middles of the wide cells between row j and the next: all four corners make the move
        if (j === rows - 1) continue;
        for (let e = qRow[j]; e < qRow[j + 1]; e++) {
          const a = qA[e] * 3, b = a + 3, c = a + cols * 3, d = c + 3;
          const X = (x[a] + x[b] + x[c] + x[d]) * 0.25, Y = (x[a + 1] + x[b + 1] + x[c + 1] + x[d + 1]) * 0.25, Z = (x[a + 2] + x[b + 2] + x[c + 2] + x[d + 2]) * 0.25;
          if (X < ax0 || X > ax1 || Y < ay0 || Y > ay1 || Z < az0 || Z > az1) continue;
          if (!sh.push(id, X, Y, Z, off)) continue;
          const dx = sh.ox, dy = sh.oy, dz = sh.oz, ka = qA[e];
          if (dy < 0 && ((w[ka] !== 0 && x[a + 1] + dy < fy) || (w[ka + 1] !== 0 && x[b + 1] + dy < fy) || (w[ka + cols] !== 0 && x[c + 1] + dy < fy) || (w[ka + cols + 1] !== 0 && x[d + 1] + dy < fy))) continue;
          if (w[ka] !== 0) { x[a] += dx; x[a + 1] += dy; x[a + 2] += dz; } if (w[ka + 1] !== 0) { x[b] += dx; x[b + 1] += dy; x[b + 2] += dz; }
          if (w[ka + cols] !== 0) { x[c] += dx; x[c + 1] += dy; x[c + 2] += dz; } if (w[ka + cols + 1] !== 0) { x[d] += dx; x[d + 1] += dy; x[d + 2] += dz; }
          moved = true;
        }
      }
    }
    // THEN every particle, out of every part
    if (moved) this.rowBoxes(off);
    for (let c = 0; c < ids.length; c++) {
      const id = ids[c], o = id * 6, bx0 = box[o], by0 = box[o + 1], bz0 = box[o + 2], bx1 = box[o + 3], by1 = box[o + 4], bz1 = box[o + 5];
      const own = sh.bone[id] === this.pinBone;                 // (only the part the held edge is pinned on lets the cloth nearer: see easeOff)
      const ax0 = bx0 - off, ay0 = by0 - off, az0 = bz0 - off, ax1 = bx1 + off, ay1 = by1 + off, az1 = bz1 + off;
      for (let j = 0, b = 0; j < rows; j++, b += 6) {
        if (!(rb[b] <= bx1 && rb[b + 3] >= bx0 && rb[b + 1] <= by1 && rb[b + 4] >= by0 && rb[b + 2] <= bz1 && rb[b + 5] >= bz0)) continue;
        for (let i = 0, k = j * cols, q = k * 3; i < cols; i++, k++, q += 3) {
          if (w[k] === 0) continue;
          const X = x[q], Y = x[q + 1], Z = x[q + 2];
          if (X < ax0 || X > ax1 || Y < ay0 || Y > ay1 || Z < az0 || Z > az1) continue;      // (not in the part's own box: most are not)
          if (!sh.push(id, X, Y, Z, own ? off - ease[k] : off)) continue;
          const dx = sh.ox, dy = sh.oy, dz = sh.oz; x[q] += dx; x[q + 1] += dy; x[q + 2] += dz;
          // what pushed it aside does not fling it: along the push it keeps no more speed than `toss`
          if (toss < 1e9) { const d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d > 1e-9) { const nx = dx / d, ny = dy / d, nz = dz / d, v = (x[q] - p[q]) * nx + (x[q + 1] - p[q + 1]) * ny + (x[q + 2] - p[q + 2]) * nz - toss; if (v > 0) { p[q] += nx * v; p[q + 1] += ny * v; p[q + 2] += nz * v; } } }
        }
      }
    }
  }

  /**
   * The picture's own vertices are put `picture` off the body (after write() has laid them through the particles): the
   * picture's grid is finer than the particles' and sags between them. In the parent's space, as write() left them.
   */
  pictureOff(pos) {
    const sh = this.fit, ids = this.fitIds, { fc, fr, picEase: pe, picHeld: ph, picW: pw, picBox: pb } = this, off = this.picOff, box = sh.box;
    sh.place(1);
    // into the world, with a box round each row
    const e = this.parent ? this.parent.matrixWorld.elements : null;
    for (let J = 0, b = 0, o = 0; J < fr; J++, b += 6) {
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
      for (let I = 0; I < fc; I++, o += 3) {
        const a = pos[o], bb = pos[o + 1], c = pos[o + 2];
        const X = e ? e[0] * a + e[4] * bb + e[8] * c + e[12] : a, Y = e ? e[1] * a + e[5] * bb + e[9] * c + e[13] : bb, Z = e ? e[2] * a + e[6] * bb + e[10] * c + e[14] : c;
        pw[o] = X; pw[o + 1] = Y; pw[o + 2] = Z;
        if (X < lx) lx = X; if (X > hx) hx = X; if (Y < ly) ly = Y; if (Y > hy) hy = Y; if (Z < lz) lz = Z; if (Z > hz) hz = Z;
      }
      pb[b] = lx - off; pb[b + 1] = ly - off; pb[b + 2] = lz - off; pb[b + 3] = hx + off; pb[b + 4] = hy + off; pb[b + 5] = hz + off;
    }
    // (The held edge is asked too. On the part it is pinned on it is let exactly as near as it was pinned, so it stays
    // put; but where a thigh folds over the belt, or the flesh under the belt swells, the edge of the PICTURE rides
    // out over it: the particles of the held edge stay on their bone.)
    let moved = 0; const list = this.pinched;
    for (let c = 0; c < ids.length; c++) {
      const id = ids[c], o6 = id * 6, bx0 = box[o6], by0 = box[o6 + 1], bz0 = box[o6 + 2], bx1 = box[o6 + 3], by1 = box[o6 + 4], bz1 = box[o6 + 5];
      const own = sh.bone[id] === this.pinBone, ax0 = bx0 - off, ay0 = by0 - off, az0 = bz0 - off, ax1 = bx1 + off, ay1 = by1 + off, az1 = bz1 + off;
      for (let J = 0, b = 0; J < fr; J++, b += 6) {
        if (!(pb[b] <= bx1 && pb[b + 3] >= bx0 && pb[b + 1] <= by1 && pb[b + 4] >= by0 && pb[b + 2] <= bz1 && pb[b + 5] >= bz0)) continue;
        for (let I = 0, v = J * fc, o = v * 3; I < fc; I++, v++, o += 3) {
          const X = pw[o], Y = pw[o + 1], Z = pw[o + 2];
          if (X < ax0 || X > ax1 || Y < ay0 || Y > ay1 || Z < az0 || Z > az1) continue;
          if (!sh.push(id, X, Y, Z, own ? off - pe[v] : off)) continue;
          pw[o] += sh.ox; pw[o + 1] += sh.oy; pw[o + 2] += sh.oz;
          if (!ph[v]) { ph[v] = 1; list[moved++] = v; }
        }
      }
    }
    if (!moved) return;
    // A vertex one part moved may now lie in another (cloth pinched between two parts with no room between them: a
    // hand laid on a hip, a forearm against a thigh, a thigh folded to the belly). Every moved vertex is asked again,
    // by all the parts at once: it goes by the MEAN of what they want, so between two it comes to rest midway (half
    // as deep in each as they overlap) or works its way out sideways where they part. A few rounds.
    let n = moved;
    for (let round = 0; round < 4 && n; round++) {
      let still = 0;
      for (let k = 0; k < n; k++) {
        const v = list[k], o = v * 3, X = pw[o], Y = pw[o + 1], Z = pw[o + 2]; let hits = 0, sx = 0, sy = 0, sz = 0;
        for (let c = 0; c < ids.length; c++) {
          const id = ids[c], o6 = id * 6;
          if (X < box[o6] - off || X > box[o6 + 3] + off || Y < box[o6 + 1] - off || Y > box[o6 + 4] + off || Z < box[o6 + 2] - off || Z > box[o6 + 5] + off) continue;
          if (sh.push(id, X, Y, Z, sh.bone[id] === this.pinBone ? off - pe[v] : off)) { sx += sh.ox; sy += sh.oy; sz += sh.oz; hits++; }
        }
        if (!hits) continue;
        pw[o] = X + sx / hits; pw[o + 1] = Y + sy / hits; pw[o + 2] = Z + sz / hits;
        list[still++] = v;
      }
      // (the list shrinks to those still wanted somewhere; all of `list[0..moved)` must still be written back below)
      if (still === n && round > 1) { /* no fewer than last round: they are pinched for good */ }
      n = still;
    }
    // those that were moved, back into the parent's space
    const m = e ? _m.copy(this.parent.matrixWorld).invert().elements : null;
    for (let v = 0, o = 0, nv = fc * fr; v < nv; v++, o += 3) {
      if (!ph[v]) continue; ph[v] = 0;
      const a = pw[o], bb = pw[o + 1], c = pw[o + 2];
      if (m) { pos[o] = m[0] * a + m[4] * bb + m[8] * c + m[12]; pos[o + 1] = m[1] * a + m[5] * bb + m[9] * c + m[13]; pos[o + 2] = m[2] * a + m[6] * bb + m[10] * c + m[14]; } else { pos[o] = a; pos[o + 1] = bb; pos[o + 2] = c; }
    }
  }

  /** Push particles out of the body's capsules (f: how far through this update's travel the capsules are). `list` (with `count`): only these particles. */
  collide(f, list, count) {
    const caps = this.caps; if (!caps.length) return;
    const { x, w, n, p } = this, cur = this.body.cur, prev = this.body.prev, rad = this.body.rad, th = this.thick, m = list ? count : n, toss = this.tossStep;
    const bx = this.bound[0], by = this.bound[1], bz = this.bound[2], br = this.bound[3];
    for (let ci = 0; ci < caps.length; ci++) {
      const c = caps[ci], k = c * 6, R = rad[c] + th, R2 = R * R;
      const ax = prev[k] + (cur[k] - prev[k]) * f, ay = prev[k + 1] + (cur[k + 1] - prev[k + 1]) * f, az = prev[k + 2] + (cur[k + 2] - prev[k + 2]) * f;
      const ex = prev[k + 3] + (cur[k + 3] - prev[k + 3]) * f - ax, ey = prev[k + 4] + (cur[k + 4] - prev[k + 4]) * f - ay, ez = prev[k + 5] + (cur[k + 5] - prev[k + 5]) * f - az;
      const e2 = ex * ex + ey * ey + ez * ez, inv = e2 > 1e-10 ? 1 / e2 : 0;
      // a capsule nowhere near the sheet (the other fighter across the hall, a blade held high) costs nothing
      { let u = ((bx - ax) * ex + (by - ay) * ey + (bz - az) * ez) * inv; if (u < 0) u = 0; else if (u > 1) u = 1; const dx = bx - ax - ex * u, dy = by - ay - ey * u, dz = bz - az - ez * u, lim = br + R; if (dx * dx + dy * dy + dz * dz > lim * lim) continue; }
      for (let j = 0; j < m; j++) {
        const i = list ? list[j] : j; if (w[i] === 0) continue;
        const q = i * 3, px = x[q] - ax, py = x[q + 1] - ay, pz = x[q + 2] - az;
        let u = (px * ex + py * ey + pz * ez) * inv; if (u < 0) u = 0; else if (u > 1) u = 1;
        const dx = px - ex * u, dy = py - ey * u, dz = pz - ez * u, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R2 && d2 > 1e-12) {
          const d = Math.sqrt(d2), s = R / d - 1; x[q] += dx * s; x[q + 1] += dy * s; x[q + 2] += dz * s;
          // what pushed it aside does not fling it: along the push it keeps no more speed than `toss`
          if (toss < 1e9) { const nx = dx / d, ny = dy / d, nz = dz / d, v = (x[q] - p[q]) * nx + (x[q + 1] - p[q + 1]) * ny + (x[q + 2] - p[q + 2]) * nz - toss; if (v > 0) { p[q] += nx * v; p[q + 1] += ny * v; p[q + 2] += nz * v; } }
        }
      }
    }
  }

  /** Rebuild the picture from the particles: positions in the parent's space, normals, and the dark of the wet parts. */
  write() {
    const { loc, n, cols, rows, fc, fr, tmp, cr, wet, tmpW } = this, s = this.subdiv, x = this.fit && !this.calmSkip ? this.show : this.x;
    // into the parent's space
    if (this.parent) {
      const e = _m.copy(this.parent.matrixWorld).invert().elements;
      for (let k = 0; k < n * 3; k += 3) {
        const a = x[k], b = x[k + 1], c = x[k + 2];
        loc[k] = e[0] * a + e[4] * b + e[8] * c + e[12]; loc[k + 1] = e[1] * a + e[5] * b + e[9] * c + e[13]; loc[k + 2] = e[2] * a + e[6] * b + e[10] * c + e[14];
      }
    } else loc.set(x);
    const pos = this.geometry.attributes.position.array, nor = this.geometry.attributes.normal.array, col = this.geometry.attributes.color.array;
    // along the rows: fc points for each particle row
    for (let j = 0; j < rows; j++) {
      const row = j * cols;
      for (let i = 0; i < cols - 1; i++) {
        const b = (row + i) * 3, c = b + 3, hasA = i > 0, hasD = i < cols - 2, a = b - 3, d = c + 3;
        for (let k = 0; k < s; k++) {
          const o = (j * fc + i * s + k) * 3, w0 = cr[k * 4], w1 = cr[k * 4 + 1], w2 = cr[k * 4 + 2], w3 = cr[k * 4 + 3];
          for (let ax = 0; ax < 3; ax++) {
            const pb = loc[b + ax], pc2 = loc[c + ax], pa = hasA ? loc[a + ax] : 2 * pb - pc2, pd = hasD ? loc[d + ax] : 2 * pc2 - pb;
            tmp[o + ax] = w0 * pa + w1 * pb + w2 * pc2 + w3 * pd;
          }
          tmpW[j * fc + i * s + k] = wet[row + i] + (wet[row + i + 1] - wet[row + i]) * (k / s);
        }
      }
      const o = (j * fc + fc - 1) * 3, e = (row + cols - 1) * 3;
      tmp[o] = loc[e]; tmp[o + 1] = loc[e + 1]; tmp[o + 2] = loc[e + 2]; tmpW[j * fc + fc - 1] = wet[row + cols - 1];
    }
    // down the columns
    const dark = this.wetDark;
    for (let i = 0; i < fc; i++) {
      for (let j = 0; j < rows - 1; j++) {
        const b = (j * fc + i) * 3, c = b + fc * 3, hasA = j > 0, hasD = j < rows - 2, a = b - fc * 3, d = c + fc * 3;
        const wb = tmpW[j * fc + i], wc = tmpW[(j + 1) * fc + i];
        for (let k = 0; k < s; k++) {
          const vi = (j * s + k) * fc + i, o = vi * 3, w0 = cr[k * 4], w1 = cr[k * 4 + 1], w2 = cr[k * 4 + 2], w3 = cr[k * 4 + 3];
          for (let ax = 0; ax < 3; ax++) {
            const pb = tmp[b + ax], pc2 = tmp[c + ax], pa = hasA ? tmp[a + ax] : 2 * pb - pc2, pd = hasD ? tmp[d + ax] : 2 * pc2 - pb;
            pos[o + ax] = w0 * pa + w1 * pb + w2 * pc2 + w3 * pd;
          }
          const v = 1 - (wb + (wc - wb) * (k / s)) * dark; col[o] = v; col[o + 1] = v; col[o + 2] = v;
        }
      }
      const vi = (fr - 1) * fc + i, o = vi * 3, e = ((rows - 1) * fc + i) * 3;
      pos[o] = tmp[e]; pos[o + 1] = tmp[e + 1]; pos[o + 2] = tmp[e + 2];
      const v = 1 - tmpW[(rows - 1) * fc + i] * dark; col[o] = v; col[o + 1] = v; col[o + 2] = v;
    }
    if (this.fit && this.laid) this.pictureOff(pos);
    // normals of the picture grid
    for (let j = 0; j < fr; j++) {
      const j0 = j > 0 ? j - 1 : j, j1 = j < fr - 1 ? j + 1 : j;
      for (let i = 0; i < fc; i++) {
        const i0 = i > 0 ? i - 1 : i, i1 = i < fc - 1 ? i + 1 : i;
        const a = (j * fc + i0) * 3, b = (j * fc + i1) * 3, c = (j0 * fc + i) * 3, d = (j1 * fc + i) * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1, k = (j * fc + i) * 3;
        nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
      }
    }
    const at = this.geometry.attributes; at.position.needsUpdate = true; at.normal.needsUpdate = true; at.color.needsUpdate = true;
  }

  /** How fast the lowest row is moving over the water where it touches it: for rings. Returns the count of touching hem particles. */
  hemContact(out) {
    const { x, p, cols, rows } = this, fy = this.floor + 0.004; let cnt = 0, best = 0;
    for (let i = 0; i < cols; i++) {
      const q = ((rows - 1) * cols + i) * 3; if (x[q + 1] > fy) continue;
      cnt++; const v = Math.hypot(x[q] - p[q], x[q + 2] - p[q + 2]);
      if (v > best) { best = v; out.x = x[q]; out.z = x[q + 2]; out.px = p[q]; out.pz = p[q + 2]; }
    }
    out.speed = best * this.substeps * 60; return cnt;
  }

  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); }
}
