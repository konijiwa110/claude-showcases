// Putting the cathedral together from its kit: pieces modelled in Blender (tools/kit/*.py -> assets/models/arena/*.glb)
// are placed many times and merged into a few big static meshes, one per stretch of the building, material,
// shadow flag and "is it in the water's mirror". Nothing here runs after the arena has been built.
//
// The mirror. The water's reflection is the whole scene drawn a second time, and the frame's cost follows the number
// of triangles drawn. So only what makes the reflection is drawn in it: masses (walls, piers), the organ, the rose,
// what stands in the water. Mouldings, shafts, tracery, statues, ivy and rubble are put on layer 2, which the
// mirror's camera does not see (docs/engine.md, "Layers"); the main camera and the shadow pass see both layers.
//
// What the kit carries on every vertex (see tools/kit/gothic.py): colour R = ambient occlusion at short range,
// G = at long range, B = a per-element variation, A = a mask for the material. The merge turns R, G, B into one
// grey multiplier (times the placement's tint) in the colour's rgb, and keeps A.
//
// A second attribute, `wdLit` (two bytes a vertex), carries light that no lamp of the game's can give: the glow of
// hundreds of candles on a wall far from them, and the organ's own light in phase two. The arena works it out once,
// here, vertex by vertex (see Arena.light); the materials add it, scaled by the mood (materials.js, LIT).
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3(), _lit = [0, 0];
/** Baked light is kept as the square root of (light / LIT_MAX) in a byte: fine steps where it is dim. */
export const LIT_MAX = 4;
/** Materials whose vertex colours are painted colours (leaves, petals), not baked light. */
export const RAW = new Set(['foliage']);

/** The kit: every named piece of every loaded kit file, as { parts: [{ mat, geometry }], anchors: { name: Vector3 } }. */
export class Kit {
  constructor() { this.pieces = new Map(); }
  add(gltf) {
    for (const node of gltf.scene.children) {
      const parts = [];
      node.traverse((o) => { if (o.isMesh) parts.push({ mat: o.material.name, geometry: o.geometry }); });
      const anchors = {}, src = (node.userData && node.userData.anchors) || {};
      for (const k in src) anchors[k] = new THREE.Vector3(src[k][0], src[k][1], src[k][2]);
      const extra = { ...(node.userData || {}) }; delete extra.anchors;
      this.pieces.set(node.name, { name: node.name, parts, anchors, extra });
    }
    return this;
  }
  has(name) { return this.pieces.has(name); }
  get(name) { const p = this.pieces.get(name); if (!p) throw new Error(`the kit has no piece "${name}"`); return p; }
  triangles(name) { let n = 0; for (const p of this.get(name).parts) n += p.geometry.index.count / 3; return n; }
}

/** A small seeded random source (the building must come out the same on every run). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Collects placements and merges them.
 *   b.place('pier', { x, y, z, ry, sx, sy, sz, rx, rz } | Matrix4, { zone, tint: [r, g, b] | number, cast, mirror, only, vary })
 *      cast: true (default) | false | ['ashlar'] (only those of the piece's materials throw shadows)
 *      mirror: true (default) | false | ['ashlar'] (only those of the piece's materials appear in the water's mirror)
 *      only: ['ashlar'] (if the piece has parts of these materials, its other parts are left out altogether)
 *   b.build(materials) -> Group
 * zone: any string: where a thing stands, for the baked light (see `light`) and for merging. Meshes are merged by
 *      `bucket(zone, mat, cast, mirror)` -> a name (default: the zone itself): one mesh for each name, material and
 *      pair of flags. A draw call costs this game more than a few thousand triangles do, so the arena merges small
 *      things across the whole building and keeps only the large masses apart by stretch (so the camera can skip
 *      the end of the hall that is behind it).
 * shade(x, y, z) -> a multiplier applied to every vertex (large-scale darkness: aisles, corners).
 * light(zone, x, y, z, nx, ny, nz, out) -> false, or true with out[0] = the candles' light and out[1] = the organ's
 *      glow arriving at that point (irradiance, in the game's light units), kept in the attribute `wdLit`.
 */
export class Builder {
  constructor(kit, { shade = null, seed = 7, light = null, bucket = null } = {}) {
    this.kit = kit; this.shade = shade; this.light = light; this.bucket = bucket; this.rand = rng(seed);
    this.buckets = new Map();                 // key -> { mat, zone, cast, items: [{ geometry, matrix, tint, flip }], verts, indices }
    this.anchors = [];                        // { piece, name, pos: Vector3 (world) }
    this.count = 0; this.triangles = 0;
  }

  static matrix(t, out = new THREE.Matrix4()) {
    if (t.isMatrix4) return out.copy(t);
    const e = new THREE.Euler(t.rx || 0, t.ry || 0, t.rz || 0, 'YXZ');
    return out.compose(new THREE.Vector3(t.x || 0, t.y || 0, t.z || 0), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1));
  }

  /** Place a piece of the kit. Returns the placement's matrix (to place things on its anchors). */
  place(name, at, o = {}) {
    const piece = this.kit.get(name), matrix = Builder.matrix(at);
    const vary = o.vary ?? 0.07, k = 1 + (this.rand() * 2 - 1) * vary, w = (this.rand() * 2 - 1) * vary * 0.4;
    const t = o.tint === undefined ? [1, 1, 1] : typeof o.tint === 'number' ? [o.tint, o.tint, o.tint] : o.tint;
    const tint = [t[0] * k * (1 + w), t[1] * k, t[2] * k * (1 - w)];
    const only = o.only && piece.parts.some((p) => o.only.includes(p.mat)) ? o.only : null;
    for (const part of piece.parts) {
      if (only && !only.includes(part.mat)) continue;
      const mat = o.mat || part.mat, cast = Array.isArray(o.cast) ? o.cast.includes(part.mat) : o.cast;       // cast: true | false | the materials that cast
      const mirror = Array.isArray(o.mirror) ? o.mirror.includes(part.mat) : o.mirror;
      this.addGeometry(part.geometry, matrix, { ...o, mat, tint, cast, mirror, raw: o.raw ?? RAW.has(mat) });
    }
    for (const an in piece.anchors) this.anchors.push({ piece: name, name: an, pos: piece.anchors[an].clone().applyMatrix4(matrix), matrix });
    this.count++;
    return matrix;
  }

  /** Add any geometry (position, normal, uv; colour optional) under a material name. */
  addGeometry(geometry, matrix, o = {}) {
    const zone = o.zone || 'all', cast = o.cast !== false, mat = o.mat || 'plain', mirror = o.mirror !== false;
    const where = this.bucket ? this.bucket(zone, mat, cast, mirror) : zone;
    const key = `${where}|${mat}|${cast ? 1 : 0}|${o.receive === false ? 0 : 1}${mirror ? '' : '|nomirror'}`;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { key, mat, zone: where, cast, mirror, receive: o.receive !== false, items: [], verts: 0, indices: 0 }));
    const m = matrix.isMatrix4 ? matrix.clone() : Builder.matrix(matrix);
    // (`lit`: a name of its own for the baked light, when a thing must not be lit as the stretch it stands in is)
    b.items.push({ geometry, matrix: m, zone: o.lit || zone, tint: o.tint || [1, 1, 1], flip: m.determinant() < 0, raw: !!o.raw, shade: o.shade !== false });
    b.verts += geometry.attributes.position.count;
    const n = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    b.indices += n; this.triangles += n / 3;
  }

  /** World positions of every placed anchor whose name starts with `prefix` (e.g. 'ledge', 'niche'). */
  anchored(prefix) { return this.anchors.filter((a) => a.name.startsWith(prefix)); }

  /** Merge everything into meshes. materials: { name: Material }. */
  build(materials, group = new THREE.Group()) {
    for (const b of this.buckets.values()) {
      const pos = new Float32Array(b.verts * 3), nor = new Float32Array(b.verts * 3), uv = new Float32Array(b.verts * 2), col = new Uint8Array(b.verts * 4);
      const idx = b.verts > 65535 ? new Uint32Array(b.indices) : new Uint16Array(b.indices);
      const lit = new Uint8Array(b.verts * 2), light = this.light;
      let v0 = 0, i0 = 0, anyLit = false;
      for (const it of b.items) {
        const g = it.geometry, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color, n = P.count;
        _n.getNormalMatrix(it.matrix);
        for (let i = 0; i < n; i++) {
          _v.fromBufferAttribute(P, i).applyMatrix4(it.matrix);
          const x = _v.x, y = _v.y, z = _v.z, o = (v0 + i) * 3;
          pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
          if (N) { _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize(); nor[o] = _v.x; nor[o + 1] = _v.y; nor[o + 2] = _v.z; } else nor[o + 1] = 1;
          if (light && it.shade && light(it.zone, x, y, z, nor[o], nor[o + 1], nor[o + 2], _lit)) {
            const l = (v0 + i) * 2;
            lit[l] = Math.round(Math.sqrt(Math.min(1, Math.max(0, _lit[0] / LIT_MAX))) * 255);
            lit[l + 1] = Math.round(Math.sqrt(Math.min(1, Math.max(0, _lit[1] / LIT_MAX))) * 255);
            anyLit = true;
          }
          if (U) { uv[(v0 + i) * 2] = U.getX(i); uv[(v0 + i) * 2 + 1] = U.getY(i); }
          let r = 1, gg = 1, bb = 1, a = 0;
          if (C) {
            if (it.raw) { r = C.getX(i); gg = C.getY(i); bb = C.getZ(i); a = C.itemSize > 3 ? C.getW(i) : 0; } else {
              const near = C.getX(i), far = C.getY(i), vary = C.getZ(i);
              // variation: 0.5 leaves the colour alone; below 0.25 it is dark paint (the inside of a pipe, a slot)
              const tone = vary >= 0.25 ? 1 + (vary - 0.5) * 0.5 : 0.08 + vary * 3.18;
              const k = Math.pow(near, 1.15) * (0.22 + 0.78 * far) * tone;
              r = gg = bb = k; a = C.itemSize > 3 ? C.getW(i) : 0;
            }
          }
          const s = this.shade && it.shade ? this.shade(x, y, z) : 1, c = (v0 + i) * 4;
          col[c] = Math.max(0, Math.min(255, Math.round(r * it.tint[0] * s * 255)));
          col[c + 1] = Math.max(0, Math.min(255, Math.round(gg * it.tint[1] * s * 255)));
          col[c + 2] = Math.max(0, Math.min(255, Math.round(bb * it.tint[2] * s * 255)));
          col[c + 3] = Math.round(a * 255);
        }
        const I = g.index, m = I ? I.count : n;
        if (it.flip) for (let i = 0; i < m; i += 3) { idx[i0 + i] = v0 + (I ? I.getX(i) : i); idx[i0 + i + 1] = v0 + (I ? I.getX(i + 2) : i + 2); idx[i0 + i + 2] = v0 + (I ? I.getX(i + 1) : i + 1); }
        else for (let i = 0; i < m; i++) idx[i0 + i] = v0 + (I ? I.getX(i) : i);
        v0 += n; i0 += m;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4, true));
      geo.setAttribute('wdLit', new THREE.BufferAttribute(anyLit ? lit : new Uint8Array(b.verts * 2), 2, true));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      const material = materials[b.mat];
      if (!material) throw new Error(`no material "${b.mat}" for the arena`);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `arena:${b.key}`; mesh.castShadow = b.cast; mesh.receiveShadow = b.receive;
      if (!b.mirror) mesh.layers.set(2);                    // seen by the main camera and the shadow pass, not by the water's mirror
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      group.add(mesh);
    }
    return group;
  }
}
