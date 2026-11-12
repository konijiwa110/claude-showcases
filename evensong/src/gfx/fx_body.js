// Effects on a fighter's whole body: the flash when struck, and the ending, where she turns to light and motes.
//
// Neither touches the fighter's own materials (they belong to the graphics owner and must never be recompiled in
// play). Instead each skinned mesh gets a twin of ours: the same geometry on the same skeleton, drawn with a
// material of ours, kept in our own group and laid exactly over its source when it is drawn.
//   flash     the twin is drawn over the body, adding light that hugs its outline, for a tenth of a second. What the
//             fighter wears and carries flashes with it (cloth, weapons, shield, lantern: every lit, opaque mesh under
//             the fighter's root that is not skinned gets a twin as well; the wings are skinned and always had one)
//   dissolve  first the same light swells until the body is all light; then the body itself is hidden and the twin
//             stands in for it, a shell of light eaten away from the ends of the limbs toward the heart, shedding
//             motes where it is being eaten
//
// Not part of the contract: other modules use ctx.vfx (src/gfx/vfx.js).
import * as THREE from 'three';
import { GLSL_OUT } from './fx_common.js';

const VERT = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
uniform float uPush;
varying vec3 vN;
varying vec3 vV;
varying vec3 vRest;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  float nl = length(normal);
  if (nl > 1e-5) transformed += normal / nl * uPush;
  #include <skinning_vertex>
  #include <project_vertex>
  vN = transformedNormal; vV = -mvPosition.xyz; vRest = position;
}`;

const FLASH_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uPower, uFill;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  gl_FragColor = vec4(uColor * (uPower * (uFill + (1.0 - uFill) * 1.7 * f * f)), 0.0);
  ${GLSL_OUT}
}`;

const LIGHT_FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform vec3 uColor, uCentre, uHalf;
uniform float uPower, uGone, uGrain, uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vRest;
void main() {
  vec3 q = (vRest - uCentre) / uHalf;
  float core = 1.0 - clamp(length(q) / 1.3, 0.0, 1.0);                       // 1 at the heart, 0 at the ends of the limbs
  vec3 p = vRest * uGrain;
  float n = (texture2D(tNoise, p.xy).r + texture2D(tNoise, p.yz + 0.31).r + texture2D(tNoise, p.zx + 0.57).r) / 3.0;
  float n2 = texture2D(tNoise, p.xy * 3.1 + p.z).g;
  float field = core * 0.62 + n * 0.3 + n2 * 0.08;
  float th = uGone * 1.03 - 0.015;
  if (field < th) discard;
  float lip = 1.0 - smoothstep(th, th + 0.06, field);                        // where it is being eaten: hottest
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  // a body of light: hottest at the heart, a brighter outline, and a slow shimmer moving up through it
  float shimmer = texture2D(tNoise, vec2(p.x + p.z, p.y * 0.7 - uTime * 0.11)).r;
  float glow = (0.4 + 1.25 * core * core) * (0.7 + 0.6 * shimmer) + 1.3 * f * f * f;
  vec3 col = mix(uColor, vec3(1.0, 0.97, 0.9), clamp(core * 0.75 + lip, 0.0, 1.0));
  gl_FragColor = vec4(col * (uPower * glow + 4.0 * lip * step(0.001, uGone)), 1.0);
  ${GLSL_OUT}
}`;

const _v = new THREE.Vector3(), _box = new THREE.Box3();
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
/** Is this thing drawn at all (itself and everything above it)? */
const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
const A = 0.2;                                         // the share of a dissolve spent swelling into light

export class Bodies {
  /**
   * @param ctx    the game's context
   * @param group  where our twins live
   * @param noise  the shared noise texture
   * @param mote   (x, y, z, color) => void: one mote of light shed there
   */
  constructor(ctx, group, noise, mote) {
    this.ctx = ctx; this.group = group; this.noise = noise; this.mote = mote;
    this.list = [];                                   // one record for each thing ever flashed or dissolved
    this.flashProto = new THREE.ShaderMaterial({
      name: 'fx.bodyflash', uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.75) }, uPower: { value: 0 }, uFill: { value: 0.22 }, uPush: { value: 0.0015 } },
      vertexShader: VERT, fragmentShader: FLASH_FRAG, transparent: true, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    // the same light multiplied into what is already drawn there (out = body x (1 + light)): the body's own colours and
    // shading, brighter. That is the flash of a struck body: a brightening, not a white figure put in its place.
    // (Same shader as the flash, another blend: no second program.)
    this.liftProto = this.flashProto.clone(); this.liftProto.name = 'fx.bodylift'; this.liftProto.blendSrc = THREE.DstColorFactor; this.liftProto.blendDst = THREE.OneFactor;
    this.lightProto = new THREE.ShaderMaterial({
      name: 'fx.bodylight', uniforms: { tNoise: { value: noise }, uColor: { value: new THREE.Color(1, 0.86, 0.6) }, uCentre: { value: new THREE.Vector3() }, uHalf: { value: new THREE.Vector3(1, 1, 1) },
        uPower: { value: 2 }, uGone: { value: 0 }, uGrain: { value: 1 }, uPush: { value: 0 }, uTime: { value: 0 } },
      vertexShader: VERT, fragmentShader: LIGHT_FRAG, side: THREE.DoubleSide,
    });
    // so that both programs exist before the first blow lands: a skinned nothing, drawn for the first frames only
    const geo = this.primerGeo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    this.primers = [this.flashProto, this.lightProto].map((mat) => {
      const bone = new THREE.Bone(), m = new THREE.SkinnedMesh(geo, mat);
      m.add(bone); m.bind(new THREE.Skeleton([bone])); m.frustumCulled = false; m.name = 'fx.primer'; group.add(m); return m;
    });
    // ... and the flash's program as cloth and weapons use it: not skinned, drawn from both sides
    this.rigidProto = this.flashProto.clone(); this.rigidProto.side = THREE.DoubleSide;
    { const m = new THREE.Mesh(geo, this.rigidProto); m.frustumCulled = false; m.name = 'fx.primer'; group.add(m); this.primers.push(m); }
  }

  /** Our record for a fighter, a Character or any Object3D: its meshes and our twins of them. */
  record(target) {
    // (every skinned mesh under the root is taken: since the skin repair a fighter is two on one skeleton, the armour and
    //  `skin_underlayer_mail`, and both get their twins)
    const root = target && target.isObject3D ? target : target && target.char && target.char.root ? target.char.root : target && target.root ? target.root : null;
    if (!root) return null;
    for (const r of this.list) if (r.root === root) return r;
    const src = [];
    root.traverse((o) => { if (o.isSkinnedMesh && !o.userData.fxTwin) src.push(o); });
    if (!src.length) root.traverse((o) => { if (o.isMesh && !o.userData.fxTwin) src.push(o); });
    if (!src.length) return null;
    const ctx = this.ctx, is = (f) => !!f && (root === f.root || (f.char && root === f.char.root)), who = is(ctx.boss) ? ctx.boss : is(ctx.player) ? ctx.player : null;
    const rec = { root, who, src, twins: [], lifts: [], rigid: [], rtwins: [], flashMat: this.flashProto.clone(), liftMat: this.liftProto.clone(), lightMat: this.lightProto.clone(), flashT: 0, flashDur: 0.1, flashPeak: 1, liftPeak: 0, flashHold: false, d: null, samples: null, hidden: [] };
    // what it wears and carries: cloth, blades, the shield, the lantern (lit and opaque; glows, flames and the halo are light already)
    const lit = (m) => !!m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) && !m.transparent;
    if (src.length && src[0].isSkinnedMesh) root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.userData.fxTwin || o.userData.noFlash) return;
      const g = o.geometry; if (!g || !g.attributes || !g.attributes.position || !g.attributes.normal) return;
      if (!(Array.isArray(o.material) ? o.material.some(lit) : lit(o.material))) return;
      rec.rigid.push(o);
    });
    // the same two materials for them, drawn from both sides (cloth is one sheet); they share the body's uniforms, so one flash drives all
    rec.flashMatR = rec.flashMat.clone(); rec.liftMatR = rec.liftMat.clone();
    for (const [a, b] of [[rec.flashMatR, rec.flashMat], [rec.liftMatR, rec.liftMat]]) { a.side = THREE.DoubleSide; a.uniforms = b.uniforms; }
    rec.lightMat.uniforms.tNoise.value = this.noise;
    // the body at rest: where its heart is and how far its limbs reach (for the order in which it goes)
    _box.makeEmpty();
    for (const m of src) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); _box.union(m.geometry.boundingBox); }
    const c = rec.lightMat.uniforms.uCentre.value, h = rec.lightMat.uniforms.uHalf.value;
    _box.getCenter(c); _box.getSize(h).multiplyScalar(0.5); c.y += h.y * 0.22; h.x = Math.max(h.x, 1e-3); h.y = Math.max(h.y * 1.05, 1e-3); h.z = Math.max(h.z * 1.6, 1e-3);
    const size = Math.max(h.x, h.y, h.z);
    rec.lightMat.uniforms.uGrain.value = 1.6 / size; rec.flashMat.uniforms.uPush.value = rec.liftMat.uniforms.uPush.value = size * 0.0018;
    const twin = (m, mat, order) => {
      const t = m.isSkinnedMesh ? new THREE.SkinnedMesh(m.geometry, mat) : new THREE.Mesh(m.geometry, mat);
      if (m.isSkinnedMesh) { t.bind(m.skeleton, m.bindMatrix); t.bindMode = m.bindMode; }
      t.name = 'fx.twin'; t.userData.fxTwin = true; t.frustumCulled = false; t.castShadow = false; t.receiveShadow = false; t.visible = false;
      t.matrixAutoUpdate = false; t.matrixWorldAutoUpdate = false; t.renderOrder = order;
      t.onBeforeRender = () => { t.matrixWorld.copy(m.matrixWorld); if (m.isSkinnedMesh) { t.bindMatrix.copy(m.bindMatrix); t.bindMatrixInverse.copy(m.bindMatrixInverse); } };
      this.group.add(t); return t;
    };
    for (const m of src) { rec.lifts.push(twin(m, rec.liftMat, 7.9)); rec.twins.push(twin(m, rec.flashMat, 8)); }      // the brightening first, the light on its outline over it
    for (const m of rec.rigid) { rec.rtwins.push(twin(m, rec.liftMatR, 7.9)); rec.rtwins.push(twin(m, rec.flashMatR, 8)); }
    this.list.push(rec);
    return rec;
  }

  /**
   * A struck body's flash: for a moment the whole body is brighter (what is drawn there times 1 + `lift`, in `color`:
   * its own colours and shading, not a white figure) and light runs along its outline (`power`). It is at full
   * strength on the frame it is asked for (and for as long as the world is held), then gone in `seconds`.
   */
  flash(target, seconds = 0.14, color = 0xffe9c4, power = 1.6, lift = power * 2) {
    const rec = this.record(target); if (!rec || rec.d) return;
    if (rec.flashT > 0 && rec.flashPeak * (rec.flashT / rec.flashDur) > power) return;      // a stronger one is still on it
    rec.flashT = rec.flashDur = Math.max(0.02, seconds); rec.flashPeak = power; rec.liftPeak = lift; rec.flashHold = true;
    const f = rec.flashMat.uniforms, l = rec.liftMat.uniforms;
    f.uColor.value.set(color); f.uFill.value = 0.1; f.uPower.value = power;      // (a little light added all over, not only at the outline: the dark under-layer in the armour's openings would stay a dark patch under a brightening that only multiplies)
    l.uColor.value.set(color); l.uFill.value = 1; l.uPower.value = lift;
    for (const t of rec.twins) { t.material = rec.flashMat; t.visible = true; }
    for (const t of rec.lifts) t.visible = true;
    for (let i = 0; i < rec.rtwins.length; i++) rec.rtwins[i].visible = shown(rec.rigid[i >> 1]);
  }

  /** Turn it to light and motes over `seconds`. Returns { progress 0..1, done, cancel() }. */
  dissolve(target, seconds = 4, o = {}) {
    const rec = this.record(target); if (!rec) return { progress: 1, done: true, cancel() {} };
    if (rec.d) this.cancel(rec);
    rec.flashT = 0; for (const t of rec.lifts) t.visible = false; for (const t of rec.rtwins) t.visible = false;
    const kit = o.kit !== undefined ? o.kit : rec.who ? rec.who.kit : null;
    const color = new THREE.Color(o.color !== undefined ? o.color : 0xffdc9a);
    if (!rec.samples) this.sample(rec);
    const handle = { progress: 0, done: false, cancel: () => this.cancel(rec) };
    rec.d = { t: 0, seconds: Math.max(0.2, seconds), handle, kit, color, covered: false, ptr: 0, power: o.power || 2.4 };
    rec.flashMat.uniforms.uColor.value.copy(color); rec.flashMat.uniforms.uFill.value = 0.5; rec.flashMat.uniforms.uPower.value = 0;
    rec.lightMat.uniforms.uColor.value.copy(color); rec.lightMat.uniforms.uGone.value = 0;
    for (const t of rec.twins) { t.material = rec.flashMat; t.visible = true; }
    return handle;
  }

  /** Places on the body to shed motes from, in the order the dissolve reaches them. */
  sample(rec) {
    const c = rec.lightMat.uniforms.uCentre.value, h = rec.lightMat.uniforms.uHalf.value, all = [];
    rec.src.forEach((m, mi) => {
      const pos = m.geometry.attributes.position, n = pos.count, take = Math.min(n, Math.round(1400 / rec.src.length)), stride = n / take;
      for (let k = 0; k < take; k++) {
        const i = Math.min(n - 1, Math.floor(k * stride + (k * 0.618034 % 1) * stride));
        const core = 1 - Math.min(1, Math.hypot((pos.getX(i) - c.x) / h.x, (pos.getY(i) - c.y) / h.y, (pos.getZ(i) - c.z) / h.z) / 1.3);
        all.push({ mi, i, f: core * 0.62 + 0.19 });
      }
    });
    all.sort((a, b) => a.f - b.f);
    rec.samples = { mesh: new Uint8Array(all.length), index: new Uint32Array(all.length), field: new Float32Array(all.length), n: all.length };
    all.forEach((s, k) => { rec.samples.mesh[k] = s.mi; rec.samples.index[k] = s.i; rec.samples.field[k] = s.f; });
  }

  cancel(rec) {
    if (!rec.d) return;
    for (const m of rec.hidden) m.visible = true; rec.hidden.length = 0;
    for (const t of rec.twins) t.visible = false;
    rec.d.handle.done = true; rec.d = null;
  }
  /** Every dissolve undone (the fight begins again). */
  cancelAll() { for (const rec of this.list) { this.cancel(rec); rec.flashT = 0; for (const t of rec.twins) t.visible = false; for (const t of rec.lifts) t.visible = false; for (const t of rec.rtwins) t.visible = false; } }

  update(dt) {
    for (const rec of this.list) {
      if (rec.flashT > 0 && !rec.d) {
        if (rec.flashHold) rec.flashHold = false; else rec.flashT -= dt;
        const k = Math.max(0, rec.flashT / rec.flashDur);
        rec.flashMat.uniforms.uPower.value = rec.flashPeak * k * Math.sqrt(k); rec.liftMat.uniforms.uPower.value = rec.liftPeak * k * Math.sqrt(k);
        if (rec.flashT <= 0) { for (const t of rec.twins) t.visible = false; for (const t of rec.lifts) t.visible = false; for (const t of rec.rtwins) t.visible = false; }
      }
      const d = rec.d; if (!d || d.handle.done) continue;
      d.t += dt; const p = Math.min(1, d.t / d.seconds); d.handle.progress = p;
      if (d.kit && typeof d.kit.fade === 'number') d.kit.fade = ease((p - 0.08) / 0.62);
      let gone = 0;
      if (p < A) rec.flashMat.uniforms.uPower.value = d.power * ease(p / A) * 1.15;
      else {
        if (!d.covered) {                              // she is all light now: the light stands in for her
          d.covered = true;
          for (const m of rec.src) if (m.visible) { m.visible = false; rec.hidden.push(m); }
          for (const t of rec.twins) t.material = rec.lightMat;
        }
        const k = (p - A) / (1 - A); gone = k * k * (3 - 2 * k) * 0.55 + k * 0.45;
        rec.lightMat.uniforms.uGone.value = gone; rec.lightMat.uniforms.uTime.value = d.t;
        rec.lightMat.uniforms.uPower.value = d.power * (1 - 0.5 * ease((p - 0.6) / 0.4));
      }
      // motes: from the ends of the limbs while she swells, then from wherever the light is being eaten
      const s = rec.samples, reach = p < A ? ease(p / A) * 0.2 : 0.2 + gone * 0.85;
      let budget = 14;
      while (d.ptr < s.n && s.field[d.ptr] < reach && budget-- > 0) {
        const m = rec.src[s.mesh[d.ptr]], i = s.index[d.ptr++];
        if (m.isSkinnedMesh) m.getVertexPosition(i, _v); else _v.fromBufferAttribute(m.geometry.attributes.position, i);
        _v.applyMatrix4(m.matrixWorld);
        this.mote(_v.x, _v.y, _v.z, d.color);
      }
      if (p >= 1) { for (const t of rec.twins) t.visible = false; d.handle.done = true; }
    }
  }

  /** The primers have been drawn: both programs exist. */
  primed() { for (const m of this.primers) { if (m.parent) m.parent.remove(m); } }

  dispose() {
    this.cancelAll();
    for (const rec of this.list) { for (const t of rec.twins) { if (t.parent) t.parent.remove(t); } for (const t of rec.lifts) { if (t.parent) t.parent.remove(t); } for (const t of rec.rtwins) { if (t.parent) t.parent.remove(t); } rec.flashMat.dispose(); rec.liftMat.dispose(); rec.lightMat.dispose(); rec.flashMatR.dispose(); rec.liftMatR.dispose(); }
    this.list.length = 0; this.primed(); this.primerGeo.dispose(); this.flashProto.dispose(); this.liftProto.dispose(); this.lightProto.dispose(); this.rigidProto.dispose();
  }
}
