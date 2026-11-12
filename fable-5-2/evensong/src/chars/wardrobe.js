// What the fighters wear and carry (docs/engine.md, "Wardrobe"; more in docs/modules/wardrobe.md).
//
//   const kit = dressKnight(ctx, char)     longsword + scabbard, round shield, lantern on a chain, tattered cloak
//   const kit = dressCantor(ctx, char)     great sword, wings of organ pipes + halo, veil, skirt with a train, tabard
//   both:  kit.update(dt) right after char.update(dt);  kit.teleport() after moving the fighter at once;  kit.fade 0..1;
//          kit.dispose()
//
// The pieces: weapons.js (props from assets/models/props, grips, hands, materials), cloth.js (the cloth), wings.js
// (her pipes and halo). Everything is built by tools/kit_weapons (Blender scripts and a texture painter).
//
// ASSETS must reach the game's manifest: boss.js merges it into its own ASSETS today (player.js need not as well).
import * as THREE from 'three';
import * as W from './weapons.js';
import { Cloth, Capsules, Shapes } from './cloth.js';
import { Wings, makeHalo } from './wings.js';
import { WATER_Y } from '../core/constants.js';

const TEX = 'assets/models/props/';
export const ASSETS = Object.assign({}, W.ASSETS, {
  'prop.tex.cloth_n': { url: TEX + 'tex_cloth_n.webp', type: 'texture', srgb: false, repeat: true },
  'prop.tex.cloak': { url: TEX + 'tex_cloak.webp', type: 'texture', srgb: true },
  'prop.tex.skirt': { url: TEX + 'tex_skirt.webp', type: 'texture', srgb: true }, 'prop.tex.skirt_mr': { url: TEX + 'tex_skirt_mr.webp', type: 'texture', srgb: false },
  'prop.tex.veil': { url: TEX + 'tex_veil.webp', type: 'texture', srgb: true }, 'prop.tex.veil_mr': { url: TEX + 'tex_veil_mr.webp', type: 'texture', srgb: false },
  'prop.tex.tabard': { url: TEX + 'tex_tabard.webp', type: 'texture', srgb: true }, 'prop.tex.tabard_mr': { url: TEX + 'tex_tabard_mr.webp', type: 'texture', srgb: false },
});

const DEG = Math.PI / 180;
const _rootNow = new THREE.Matrix4(), _move = new THREE.Matrix4(), _v3 = new THREE.Vector3(), _hem = { x: 0, z: 0, px: 0, pz: 0, speed: 0 };
const FLOOR = WATER_Y + 0.012;                         // cloth and pipes rest on the water, not under it
const LANTERN_CD = 5.2;                                // the lantern's light at level 1, candela (it was 3.6 when point lights had no size)

/** A point given on the figure at rest (its own units) as an offset in a bone's own frame, for pins and capsules. */
function onBone(char, bone, x, y, z) {
  const inv = W.restMatrix(char, bone, new THREE.Matrix4()).invert(), v = new THREE.Vector3(x, y, z).applyMatrix4(inv);
  return { bone: char.bones[bone], x: v.x, y: v.y, z: v.z };
}
const off = (q) => [q.x, q.y, q.z];
/** A flat wall riding on a bone (for cloth.js `walls`), from a point and a normal given on the figure at rest: the cloth keeps to the side the normal points to. */
function wallOn(char, bone, px, py, pz, nx, ny, nz) {
  const inv = W.restMatrix(char, bone, new THREE.Matrix4()).invert(), p = new THREE.Vector3(px, py, pz).applyMatrix4(inv), n = new THREE.Vector3(nx, ny, nz).transformDirection(inv);
  return { bone: char.bones[bone], x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z };
}

// Clips in which empty hands are laid palm to palm (or clap): there the fingers stay straight; everywhere else a hand
// that holds nothing hangs half-curled (weapons.js, hand.relax). [from, to] seconds into the clip.
const FLAT_HANDS = { pray_idle: [0, 99], buckled_pray: [0, 99], pray_to_stand: [0, 2.7], fall_to_pray: [1.6, 4.9], cast_clap: [2.3, 2.9] };
/** How much an empty hand may curl now (0 in a prayer, 1 otherwise), eased. */
function easeOf(kit, dt) {
  const c = kit.char, f = FLAT_HANDS[c.clipName], flat = f && c.time >= f[0] && c.time <= f[1];
  kit.ease = kit.ease === undefined ? (flat ? 0 : 1) : kit.ease + ((flat ? 0 : 1) - kit.ease) * Math.min(1, dt * 5);
  return kit.ease;
}

/** What every kit shares: the body's capsules, the cloths, kit.fade, being moved at once. */
class Kit {
  constructor(ctx, char) {
    this.ctx = ctx; this.char = char; this.scale = char.scale;
    this.body = new Capsules(char.scale); this.cloths = []; this.things = []; this.shapes = null;      // (shapes: the body as it really is, for cloth: cloth.js Shapes; hers has one)
    this.who = /cantor/.test(char.name) ? 'boss' : 'player';
    this.fadeU = W.makeFade(1.8 * char.scale, this.who); this._fade = 0;
    this.look = (char.model.userData && char.model.userData.look) || null;       // the body's look (gfx.materials.character), when it has one
    this.wind = new THREE.Vector3(0.35, 0, -0.5);       // a slow draught down the nave, from the doors toward the organ
    this.prevRoot = new THREE.Matrix4(); this.started = false; this.moved = false; this.time = 0;
    this.holder = new THREE.Group(); this.holder.name = 'kit'; char.root.add(this.holder);
  }
  get fade() { return this._fade; }
  set fade(v) { this._fade = v < 0 ? 0 : v > 1 ? 1 : v; this.fadeU.uKit.value.x = this._fade; this.onFade(this._fade); }
  onFade() {}
  /** A capsule between two points on the figure at rest: [bone, x, y, z] each (figure units), radius. */
  cap(name, a, b, r) { const p = onBone(this.char, a[0], a[1], a[2], a[3]), q = onBone(this.char, b[0], b[1], b[2], b[3]); this.body.add(name, p.bone, off(p), q.bone, off(q), r); }
  /** A capsule from one joint to the next. */
  limb(name, a, b, r) { this.body.add(name, this.char.bones[a], null, this.char.bones[b], null, r); }
  clothMaterial(o) {
    const has = (n) => this.ctx.assets.has && this.ctx.assets.has(n), tex = (n) => (n && has(n) ? this.ctx.assets.texture(n) : null);
    const map = tex(o.map), mr = tex(o.mr), n0 = tex('prop.tex.cloth_n');
    let nm = null; if (n0) { nm = n0.clone(); nm.repeat.set(o.weave || 6, (o.weave || 6) * (o.aspect || 1)); nm.needsUpdate = true; this.things.push(nm); }
    const p = { color: o.color || 0xffffff, roughness: o.roughness !== undefined ? o.roughness : 0.9, metalness: mr ? 1 : 0, side: THREE.DoubleSide, vertexColors: true };
    if (map) { p.map = map; p.alphaTest = 0.5; }
    if (mr) { p.roughnessMap = mr; p.metalnessMap = mr; p.roughness = 1; }
    if (nm) { p.normalMap = nm; p.normalScale = new THREE.Vector2(o.bump || 0.5, o.bump || 0.5); }
    if (o.sheenColor !== undefined) p.sheenColor = o.sheenColor;
    if (o.sheen !== undefined) p.sheen = o.sheen;
    const m = W.standard(this.ctx, 'cloth', p);
    if (o.emissive) { m.emissive.set(o.emissive); m.emissiveIntensity = o.emissiveIntensity || 0; if (map) m.emissiveMap = map; }
    m.shadowSide = THREE.DoubleSide; m.name = 'kit.' + (o.name || 'cloth');
    W.fadeable(m, this.fadeU, { rim: o.rim, rimPower: o.rimPower }); this.things.push(m);
    return m;
  }
  addCloth(o) {
    const c = new Cloth(Object.assign({ scale: this.scale, capsules: this.body, parent: this.holder, floor: FLOOR, wind: this.wind }, o));
    c.mesh.userData.kit = true; this.cloths.push(c); return c;
  }
  teleport() { this.moved = true; }
  /** Rings where a hem is dragged over the water (call after the cloths' update, with the cloths that reach it). */
  hems(dt, cloths, strength = 0.5) {
    const water = this.ctx.water; if (!water || !water.wake) return;
    this.hemT = (this.hemT || 0) - dt; if (this.hemT > 0) return; this.hemT = 0.14;
    for (const c of cloths) { const n = c.hemContact(_hem); if (n && _hem.speed > 0.7) water.wake(_hem.px, _hem.pz, _hem.x, _hem.z, Math.min(1.5, strength * _hem.speed * 0.35)); }
  }
  /** First thing each step: the skeleton's world matrices as the pose left them. */
  pose() { this.char.root.updateMatrixWorld(true); }
  /** The body's capsules now (for the guards, which run before begin()). */
  readBody() { this.body.update(); this.bodyRead = this.time; }
  /** Then: the cloth carried along if the fighter was put somewhere else at once, and the body's capsules. */
  begin(dt) {
    const root = this.char.root;
    _rootNow.copy(root.matrixWorld);
    if (this.started) {
      const a = this.prevRoot.elements, b = _rootNow.elements, jump = Math.hypot(b[12] - a[12], b[13] - a[13], b[14] - a[14]);
      if (jump > 1.2 + 0.6 * this.scale) this.moved = true;
    }
    this.body.update(this.bodyRead === this.time && this.started);       // (again, if the kit read them this step before moving an arm)
    if (this.shapes) { if (this.moved && this.started) this.shapes.teleport(); this.shapes.update(); }
    if (this.moved && this.started) {
      _move.copy(this.prevRoot).invert().premultiply(_rootNow);          // from the old place to the new one
      this.body.teleport(); this.body.update();
      for (const c of this.cloths) c.teleport(_move);
      this.onTeleport();
    }
    this.moved = false; this.started = true; this.time += dt;
    // the kit shares the body's edge of light and (hers) the gold that rises with the mood
    const look = this.look || (this.look = (this.char.model.userData && this.char.model.userData.look) || null), mood = this.ctx.gfx && this.ctx.gfx.mood;
    this.fadeU.uKit.value.y = root.position.y;
    if (look && typeof look.rim === 'number') this.fadeU.rim(look.rim);
    this.fadeU.gold(look && typeof look.gold === 'number' ? look.gold : mood ? mood.gold : 0);
  }
  end() { this.prevRoot.copy(_rootNow); }
  /**
   * Bones were moved AFTER update(): a cutscene poses her arms after the fighters' step (src/cine/stage.js, Grasp), a
   * cut puts her in another pose in the step it falls in, the struck body is shaken while the world is held. The
   * cloth was laid on the body as update() found it; here its PICTURE alone is put off the body as it will be drawn
   * (the particles are not touched, and the next step goes on from where the last left the body). Called before each
   * drawn frame (dressCantor hooks it to the renderer); fresh = false: bring the skeleton's world matrices up to date
   * first. Nothing happens, and nothing is spent, unless a bone has moved. Only kits with `shapes`.
   */
  late(fresh = true) {
    const sh = this.shapes; if (!sh || !this.started || this._fade >= 0.995) return false;
    if (!fresh) this.char.root.updateMatrixWorld(true);
    if (!sh.moved()) return false;
    sh.keep(); sh.update(true);
    for (const c of this.cloths) if (c.laid) c.write();
    sh.restore();
    return true;
  }
  onTeleport() {}
  disposeKit() {
    for (const c of this.cloths) c.dispose();
    for (const t of this.things) if (t && t.dispose) t.dispose();
    if (this.holder.parent) this.holder.parent.remove(this.holder);
  }
}

/**
 * Her body as it really is, for her cloth to lie on (cloth.js, Shapes): every part is read from her own skin (hip
 * plates, tassets, knee cops, pauldrons, crown and all), so nothing here is a guessed radius. A limb's part runs along
 * the line from its joint to the next; trunk, head, hands and feet along their bone through the middle of their skin.
 * Fingers go with the hand, toes with the foot, the collar bones with the chest (a bone named by no part goes with
 * the nearest one above it). null when the figure has no skin to read (the checkers that stand her bare skeleton in).
 */
function cantorShapes(char, o = {}) {
  const knob2 = (n, d) => (o.knobs && o.knobs[n] !== undefined ? o.knobs[n] : d);
  const B = char.bones, sh = new Shapes(char.scale), at = (n) => [B[n].position.x, B[n].position.y, B[n].position.z];
  if (!B.Hips || !B.Spine || !char.meshes || !char.meshes.some((m) => m.isSkinnedMesh)) return null;
  // Rows and directions are finest where her cloth hangs (a map is as fat as its cells are wide, and a fat map lifts
  // the cloth off her). One vertex of the shared skin stands for its neighbours (`thin`: the size of the cube, her
  // units: smallest where the cloth hangs), and the head counts as one piece with its neck (`rigid`).
  sh.add('pelvis', B.Hips, { along: at('Spine'), row: 0.008, round: 64, thin: knob2('cfp', 0.006) });
  sh.add('belly', B.Spine, { along: at('Spine1'), row: 0.012, round: 64, thin: knob2('cfp', 0.006) });
  sh.add('waist', B.Spine1, { along: at('Spine2'), row: 0.012, round: 64, thin: knob2('cfp', 0.006) });
  sh.add('chest', B.Spine2, { along: at('Neck'), row: 0.015, round: 64, thin: 0.008 });
  sh.add('neck', B.Neck, { along: at('Head'), row: 0.015 });
  sh.add('head', B.Head, { along: at('HeadTop_End'), rigid: 0.8, cap: 0.118 });      // (her head and the band of her crown; not its spikes: read as they stand they are a cone of 70 cm round her head, and the veil pinned under the crown stood out over it like a collar)
  for (const s of ['Left', 'Right']) {
    const k = s[0];
    sh.add('thigh' + k, B[s + 'UpLeg'], { to: at(s + 'Leg'), row: 0.01, round: 64, thin: knob2('cfp', 0.006) });
    sh.add('shin' + k, B[s + 'Leg'], { to: at(s + 'Foot'), row: 0.015, thin: 0.008 });
    sh.add('foot' + k, B[s + 'Foot'], { along: at(s + 'ToeBase'), row: 0.015, thin: 0.01 });
    sh.add('arm' + k, B[s + 'Arm'], { to: at(s + 'ForeArm'), thin: 0.008 });
    sh.add('fore' + k, B[s + 'ForeArm'], { to: at(s + 'Hand'), row: 0.015, thin: 0.006 });
    sh.add('hand' + k, B[s + 'Hand'], { along: at(s + 'HandIndex1'), row: 0.012, pad: 0.05, thin: 0.006 });
  }
  return sh.fit(char.meshes, o) ? sh : null;      // (armour and under-layer: in the crease of a folded hip it is the under-layer that the tabard lies on)
}

/** The Cantor: great sword, wings and halo, a veil from her crown, an open skirt with a train, a tabard. */
export function dressCantor(ctx, char) {
  const kit = new Kit(ctx, char), body = kit.body, B = char.bones;
  // &clothfit=0: her cloth as it was before it knew her real body (the capsules below and nothing else), bit for bit
  const FIT = !(ctx.params && typeof ctx.params.get === 'function' && ctx.params.get('clothfit') === '0');
  const knob = (n, d) => (ctx.params && typeof ctx.params.get === 'function' && ctx.params.get(n) !== null && ctx.params.get(n) !== '' && !Number.isNaN(+ctx.params.get(n)) ? +ctx.params.get(n) : d);      // (dev: &cfthin=, &cfrigid= for the checkers)
  const shapes = kit.shapes = FIT ? cantorShapes(char, { thin: knob('cfthin', 0), rigid: knob('cfrigid', 0.98), shares: knob('cfshares', 8), grow: knob('cfgrow', 0), under: knob('cfunder', 0.008), edge: knob('cfedge', 0.03), knobs: { cfp: knob('cfp', 0.006) } }) : null;
  // ---- her body, for cloth: capsules between joints, and a few placed on the figure at rest
  kit.cap('hipL', ['Hips', 0.066, 0.985, -0.006], ['Hips', 0.066, 0.90, -0.006], 0.124);
  kit.cap('hipR', ['Hips', -0.066, 0.985, -0.006], ['Hips', -0.066, 0.90, -0.006], 0.124);
  kit.cap('waist', ['Hips', 0, 1.06, -0.004], ['Spine1', 0, 1.24, -0.012], 0.092);
  kit.cap('chest', ['Spine2', 0, 1.30, -0.012], ['Spine2', 0, 1.40, -0.02], 0.122);
  kit.cap('shoulders', ['Spine2', -0.15, 1.40, -0.04], ['Spine2', 0.15, 1.40, -0.04], 0.085);
  kit.cap('head', ['Head', 0, 1.575, -0.008], ['Head', 0, 1.64, -0.014], 0.102);
  kit.cap('crown', ['Head', 0, 1.56, -0.01], ['Head', 0, 1.68, -0.02], 0.17);          // head and crown together: what her own blade keeps out of
  kit.limb('neck', 'Neck', 'Head', 0.062);
  for (const s of ['Left', 'Right']) {
    kit.limb('thigh' + s[0], s + 'UpLeg', s + 'Leg', 0.088); kit.limb('shin' + s[0], s + 'Leg', s + 'Foot', 0.07); kit.limb('foot' + s[0], s + 'Foot', s + 'ToeBase', 0.055);
    kit.limb('arm' + s[0], s + 'Arm', s + 'ForeArm', 0.058); kit.limb('fore' + s[0], s + 'ForeArm', s + 'Hand', 0.05);
  }
  // ---- wings and halo
  const wings = new Wings(ctx, char, { fade: kit.fadeU, floor: FLOOR + 0.02 * char.scale, holder: kit.holder, capsules: body, avoid: ['armL', 'armR', 'foreL', 'foreR', 'head', 'blade'] });
  const halo = makeHalo(ctx, char, { fade: kit.fadeU });
  body.add('yoke', wings.carrier, [-0.3, -0.03, -0.035], wings.carrier, [0.3, -0.03, -0.035], 0.075);
  body.addFree('wingL', 0.085); body.addFree('wingR', 0.085);
  body.addFree('blade', 0.03);                            // her own blade: the pipes and the veil part for it
  body.addFree('pilgrim', 0.42 / char.scale);             // the pilgrim: a solid thing to her skirts (docs/impact.md, part 1, line 5)
  body.build();

  // ---- cloth
  // Heavy cloth on a body that moves like nothing alive (ten metres in a third of a second and a dead stop; her head
  // from six metres to the floor in a quarter): cloth.js's four limits, in her own units a second (times 3.67 in the
  // world). Without them every sheet swung over her head after the lunge and stood there like a sail (castcheck).
  const HEAVY = { carry: 1.6, maxSpeed: 3.3, rise: 1.2, toss: 1.0 };
  // Every sheet lies on ALL of her as she really is (when she has `shapes`), asked in this order: the trunk first, the
  // hands last. Where cloth is pinched between two parts with no room (her hand laid on her hip, a forearm against a
  // thigh) the last has the last word, so the cloth stays out of the small part in front and gives into the large one
  // behind it, where the small part hides it. The capsules each sheet names stay as well: they are what gave the
  // sheets their hang (her thigh capsules are fatter than her knees and close the gap between her legs: without them
  // the tabard falls between her knees instead of lying over the leg, which is true to her legs and not how she looked).
  const FITTED = shapes ? { shapes, fit: ['pelvis', 'belly', 'waist', 'chest', 'thighL', 'thighR', 'head', 'neck', 'shinL', 'shinR', 'armL', 'armR', 'footL', 'footR', 'foreL', 'foreR', 'handL', 'handR'] } : {};
  const BLADE_GOLD = [1.0 * 0.85, 0.60 * 0.85, 0.21 * 0.85];      // the kit's gold as it is laid on her blade (the kit's own is 1.0, 0.74, 0.34 times 2.4)
  // the skirt: round her back and sides from the belt, open in front, a train behind
  const SC = 25, SR = 15, HALF = 128 * DEG;
  const skirtLen = (a) => 1.0 + 0.5 * Math.pow(Math.cos(a * 0.5 * Math.PI / HALF), 2);          // longest at the back: the train
  const r0 = 0.50, TH = 1.12;
  const skirt = kit.addCloth({
    name: 'kit:skirt', cols: SC, rows: SR, subdiv: 2, use: ['hipL', 'hipR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'pilgrim'], ...FITTED,
    rest: (i, j) => { const u = i / (SC - 1) - 0.5, a = u * 2 * HALF, th = u * TH, r = r0 + (j / (SR - 1)) * skirtLen(a); return [Math.sin(th) * r, -Math.cos(th) * r]; },
    pin: (i, j) => { if (j) return null; const a = (i / (SC - 1) - 0.5) * 2 * HALF, k = Math.abs(a) / HALF; return onBone(char, 'Hips', -0.131 * Math.sin(a), 1.09 - 0.022 * k * k, -0.004 - 0.121 * Math.cos(a)); },
    away: onBone(char, 'Hips', 0, 1.0, 0.0), gravity: 20, damping: 0.9, drag: 1.5, bend: 0.3, shear: 0.55, friction: 0.35, flutter: 0.35, thickness: 0.012, ...HEAVY,
    material: kit.clothMaterial({ name: 'skirt', map: 'prop.tex.skirt', mr: 'prop.tex.skirt_mr', weave: 10, bump: 0.45, sheenColor: 0xfff0d8, sheen: 0.5 }),
  });
  // the tabard: a long panel down the front
  const TC = 6, TR = 11;
  const tabard = kit.addCloth({
    name: 'kit:tabard', cols: TC, rows: TR, subdiv: 2, use: ['hipL', 'hipR', 'thighL', 'thighR', 'shinL', 'shinR', 'pilgrim'], ...FITTED,
    rest: (i, j) => { const v = j / (TR - 1), w = 0.17 + 0.07 * v; return [(i / (TC - 1) - 0.5) * w, -v * 0.93]; },
    pin: (i, j) => { if (j) return null; const u = i / (TC - 1) - 0.5; return onBone(char, 'Hips', u * 0.17, 1.082, 0.116 - 0.05 * u * u * 4); },
    away: onBone(char, 'Hips', 0, 1.0, -0.2), gravity: 20, damping: 1.0, drag: 3.2, bend: 0.2, flutter: 0.4, ...HEAVY,
    // (it hangs from the belt and stays below it: when she drops to her knees it may not fly up before her like a board)
    walls: [wallOn(char, 'Hips', 0, 1.1, 0, 0, -1, 0.12)],
    material: kit.clothMaterial({ name: 'tabard', map: 'prop.tex.tabard', mr: 'prop.tex.tabard_mr', weave: 4, aspect: 2.6, bump: 0.45, sheenColor: 0xfff0d8, sheen: 0.5 }),
  });
  // the veil: from under her crown, over the wings' yoke, down her back
  const VC = 11, VR = 17, VHALF = 62 * DEG;               // (it starts well behind her ears: at 78 degrees its side edge stood beside her cheek like a card in the close shots)
  const veil = kit.addCloth({
    name: 'kit:veil', cols: VC, rows: VR, subdiv: 2, use: ['head', 'neck', 'chest', 'shoulders', 'armL', 'armR', 'yoke', 'wingL', 'wingR', 'hipL', 'hipR', 'blade', 'pilgrim'], ...FITTED,
    rest: (i, j) => { const v = j / (VR - 1), w = 0.29 + 0.62 * Math.pow(v, 0.8); return [(i / (VC - 1) - 0.5) * w, -v * 1.28]; },
    pin: (i, j) => { if (j) return null; const b = (i / (VC - 1) - 0.5) * 2 * VHALF; return onBone(char, 'Head', 0.106 * Math.sin(b), 1.607 + 0.028 * Math.cos(b), -0.022 - 0.098 * Math.cos(b)); },
    away: onBone(char, 'Head', 0, 1.6, 0.1), gravity: 15, damping: 0.7, drag: 3.6, bend: 0.06, shear: 0.3, compress: 0.25, flutter: 0.7, thickness: 0.01, ...HEAVY, rise: 1.0, toss: 0.8,
    // (it is pinned behind her crown and stays behind her ears: bowed to the floor after the cleave, it may not fall over her face;
    // and it stays under the top of her head: thrown forward by a sudden stop it leant on the first wall and stood there, a horn)
    walls: [wallOn(char, 'Head', 0, 1.6, 0.012, 0, -0.35, -1), wallOn(char, 'Head', 0, 1.665, 0, 0, -1, 0)],
    material: kit.clothMaterial({ name: 'veil', map: 'prop.tex.veil', mr: 'prop.tex.veil_mr', weave: 7, aspect: 2, bump: 0.25, sheenColor: 0xffffff, sheen: 0.8, roughness: 0.6 }),
  });

  // ---- the great sword
  // (its own share in kit.fade: a sword left standing in the floor stays when she turns to light)
  const swordU = W.makeFade(1.8 * char.scale, 'boss');
  const sword = W.makeWeapon(ctx, 'greatsword', { scale: 2.4, fade: swordU });
  // Last polish: the blade's own light is the gold of her pipes (wings.js, uWingColor: 1.0, 0.60, 0.21), not the
  // champagne it was made with (1.0, 0.80, 0.46 on a near-white core): in phase two, beside gold pipes, the blade and
  // the halo were the palest things on her, a flat cream. Hue here; how much of it, in update below.
  { const sm = sword.materials || {}; if (sm.core) { sm.core.emissive.setRGB(1.0, 0.56, 0.18); sm.core.color.setRGB(1.0, 0.82, 0.52); } if (sm.gold_pale) sm.gold_pale.emissive.setRGB(1.0, 0.60, 0.21); }
  // in her right fist by the measured hold (docs/grips.md): nothing here is placed by eye
  const hand = W.grip(char); hand.add(sword.object);
  sword.glow = 0;
  // both fists close ROUND the grip: the right where the hold puts it; the left on the same grip 0.137 lower, which on
  // the figure at rest is the right fist's place mirrored
  const gripAt = new THREE.Vector3().setFromMatrixPosition(hand.userData.rest), gripLine = new THREE.Vector3().setFromMatrixColumn(hand.userData.rest, 1).normalize();
  const leftAt = W.mirrored(gripAt), leftLine = W.mirrored(gripLine), round = 0.0175 + 0.0105;
  const rightHand = W.makeHand(char, 'Right', { round: { point: gripAt, axis: gripLine, radius: round } });
  const leftHand = W.makeHand(char, 'Left', { round: { point: leftAt, axis: leftLine, radius: round } }), leftArm = W.makeArm(char, 'Left', { point: leftAt, line: leftLine });
  // a safety net: where a clip would carry the blade through her own body, her wrist turns, then her arm from the
  // shoulder (never the sword in her fist): see weapons.js, makeCarry. (Only the blade: the great-sword clips hold the
  // pommel at her hip by design, nearer than the capsules her cloth lies on.)
  const guard = W.makeCarry(char, { object: sword.object, body, names: ['crown', 'chest', 'waist', 'hipL', 'hipR', 'thighL', 'thighR'], margin: 0.01,
    segs: [{ a: [0, sword.anchors.guard.position.y + 0.03, 0], b: [0, sword.tip.position.y, 0], r: 0.016 }],
    joints: [{ bone: B.RightHand, max: 0.6 }, { bone: B.RightArm, max: 0.9 }], floor: () => char.root.position.y });      // (the floor a hair under where boss.js lets the point ride: the net never pushes it down through it)
  // where on the grip her left fist's middle may be: on Mixamo's own figure it is 0.113 to 0.137 below the right
  // fist's; on OUR Cantor (longer in the arm) the same clips put it 0.10 to 0.20 below and 4 to 10 cm off the grip's
  // line, so her left arm is drawn the last of the way onto the grip (a two-bone reach), within these bounds
  const gripLo = sword.anchors.pommel.position.y + 0.122, gripHi = -0.1;
  const _o = new THREE.Vector3(), _ax = new THREE.Vector3(), _t = new THREE.Vector3(), _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3();
  const pomY = sword.anchors.pommel.position.y, guardY = sword.anchors.guard.position.y;
  /** How near a point (world) is to the grip of the sword where it stands, in her own units. */
  const toGrip = (p) => { const m = sword.object.matrixWorld; _p0.set(0, pomY + 0.05, 0).applyMatrix4(m); _p1.set(0, guardY - 0.02, 0).applyMatrix4(m).sub(_p0); const u = Math.max(0, Math.min(1, _t.subVectors(p, _p0).dot(_p1) / _p1.lengthSq())); return _t.addScaledVector(_p1, -u).length() / char.scale; };
  const PLANT_DEPTH = 0.13;                              // how much of the blade stands in the floor: a hand's depth at her size (0.48 m)

  // (what is posed after her step, an arm in a cutscene, shows in the cloth's picture too: Kit.late, before every drawn frame)
  const unhook = shapes && ctx.gfx && typeof ctx.gfx.onBeforeRender === 'function' ? ctx.gfx.onBeforeRender(() => { kit.late(true); }) : null;

  Object.assign(kit, {
    sword, swordPlanted: false, wings, halo, veil, panels: skirt, tabard, leftOn: 0, leftPull: 0, gripR: 1, holdR: 0, holdL: 0, guards: { blade: guard },
    plantSword(x, z, yaw = 0) {
      kit.swordPlanted = true; const s = char.scale, o = sword.object; ctx.scene.add(o);
      // upright in the floor where it is planted (the stone there: the dais has steps), point down, a hand's depth of
      // the blade in the stone
      // (at yaw 0 the flat of the blade faces along the world's x, the cross lies along z: as the stand-in's did)
      const ground = ctx.arena && typeof ctx.arena.ground === 'function' ? ctx.arena.ground(x, z) : 0;
      o.scale.setScalar(s); o.rotation.set(Math.PI, yaw + Math.PI / 2, 0); o.position.set(x, ground + (sword.tip.position.y - PLANT_DEPTH) * s, z); o.updateMatrixWorld(true);
      o.visible = true;
    },
    takeSword() { kit.swordPlanted = false; const o = sword.object; hand.add(o); o.scale.setScalar(1); o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); guard.rest(0.25); kit.gripR = Math.max(kit.gripR, kit.holdR); o.visible = kit.fade < 0.995; },
    onTeleport() { wings.teleport(); },
    onFade(f) { wings.mesh.castShadow = f < 0.5; for (const c of kit.cloths) c.mesh.castShadow = f < 0.5; const vis = f < 0.995; wings.mesh.visible = vis; halo.object.visible = vis; sword.object.visible = vis || kit.swordPlanted; for (const c of kit.cloths) c.mesh.visible = vis; },
    update(dt) {
      kit.pose(); kit.readBody();
      // her hands close on the hilt: the right always (while she holds it); the left when the clip has it at the grip
      // (every two-handed clip does, to within a hand's breadth on our figure: the reach closes that gap)
      // a hand that holds nothing hangs half-curled (flat only where the clip lays palm to palm)
      const easy = easeOf(kit, dt);
      kit.gripR += ((kit.swordPlanted ? 0 : 1) - kit.gripR) * Math.min(1, dt * 14);
      if (kit.gripR < 0.999) rightHand.relax(easy);
      leftHand.relax(easy);
      rightHand.set(kit.gripR);
      // a sword left standing in the floor stays as it is when everything else she wears fades
      { const a = swordU.uKit.value, b = kit.fadeU.uKit.value; a.copy(b); if (kit.swordPlanted) a.x = 0; swordU.uKitRim.value.copy(kit.fadeU.uKitRim.value); { const g = swordU.uKitGold.value; g.copy(kit.fadeU.uKitGold.value); g.x = BLADE_GOLD[0]; g.y = BLADE_GOLD[1]; g.z = BLADE_GOLD[2]; } }      // (the kit's gold as it rises, w; but laid on the blade in the pipes' hue and a third as strong: the whole of it bleached the steel)
      if (kit.swordPlanted) {
        // ... and a hand that comes to its grip closes on it (she takes it out of the floor)
        hand.getWorldPosition(_v3); let near = toGrip(_v3), want = near < 0.1 ? 1 : near > 0.19 ? 0 : 1 - (near - 0.1) / 0.09;
        kit.holdR += (want - kit.holdR) * Math.min(1, dt * 10); rightHand.set(kit.holdR);
        leftArm.hollow(_v3); near = toGrip(_v3); want = near < 0.1 ? 1 : near > 0.19 ? 0 : 1 - (near - 0.1) / 0.09;
        kit.holdL += (want - kit.holdL) * Math.min(1, dt * 10); leftHand.set(kit.holdL);
      } else { kit.holdR = 0; kit.holdL = 0; }
      if (!kit.swordPlanted) {
        guard.update(dt);                                                    // the blade keeps out of her own head and body (her wrist turns, then her arm)
        const e = sword.object.matrixWorld.elements, s = char.scale;
        _o.set(e[12], e[13], e[14]); _ax.set(e[4], e[5], e[6]).normalize();
        leftArm.hollow(_v3); let along = _t.subVectors(_v3, _o).dot(_ax) / s; along = along < gripLo ? gripLo : along > gripHi ? gripHi : along;
        _t.copy(_o).addScaledVector(_ax, along * s);
        // within 0.12 of the grip it is holding it; past 0.2 it is doing something else (a cast, a balance) and is left alone
        const d = _v3.distanceTo(_t) / s, w = d < 0.12 ? 1 : d > 0.2 ? 0 : 1 - (d - 0.12) / 0.08, want = w * w * (3 - 2 * w);
        kit.leftOn += (want - kit.leftOn) * (1 - Math.exp(-dt * (want > kit.leftOn ? 9 : 6)));
        const ww = kit.leftOn < 0.004 ? 0 : kit.leftOn;
        // the arm is never drawn further than a hand's length: when a clip takes the hand away fast (the one-handed lunge,
        // a cast) it lets go at once instead of trailing after the sword
        const far = d > 0.2 ? 0.2 / d : 1;
        if (far < 1) _t.lerpVectors(_v3, _t, far);
        kit.leftPull = d * far * ww;                                         // how far (figure units) the arm is drawn this step: for the checkers
        if (ww > 0) { leftArm.align(_ax, ww * far); leftArm.reach(_t, ww); }  // the hand turned along the grip first, then brought onto it
        leftHand.set(ww);
      } else { kit.leftOn = 0; kit.leftPull = 0; }
      if (shapes) { B.LeftHand.updateMatrixWorld(true); B.RightHand.updateMatrixWorld(true); }      // (her fingers were closed just now: the cloth's body is read from the bones as they will be drawn)
      kit.begin(dt);
      // her blade and the pilgrim, for the pipes and the cloth to keep off
      sword.base.getWorldPosition(_p0); sword.tip.getWorldPosition(_p1); body.setFree('blade', _p0.x, _p0.y, _p0.z, _p1.x, _p1.y, _p1.z);
      { const p = ctx.player, q = p && p.pos; if (q && p.alive !== false) body.setFree('pilgrim', q.x, q.y + 0.4, q.z, q.x, q.y + 1.4, q.z); else body.setFree('pilgrim', 0, -1e4, 0, 0, -1e4 - 1, 0); }
      wings.update(dt);
      const g = wings.guard; body.setFree('wingL', g[1][0], g[1][1], g[1][2], g[1][3], g[1][4], g[1][5]); body.setFree('wingR', g[0][0], g[0][1], g[0][2], g[0][3], g[0][4], g[0][5]);
      for (const c of kit.cloths) c.update(dt);
      kit.hems(dt, [skirt], 0.9);
      halo.update();
      const m = sword.materials; if (m.gold_pale) m.gold_pale.emissiveIntensity = 0.1 + sword.glow * 0.6; if (m.core) m.core.emissiveIntensity = 0.7 + sword.glow * 3.0;      // (the core was 0.9 + 5 x glow of a paler colour: white-hot at every tell)
      kit.end();
    },
    dispose() {
      if (unhook) unhook();
      wings.dispose(); halo.dispose(); W.disposeWeapon(sword); rightHand.open(); leftHand.open();
      if (hand.parent) hand.parent.remove(hand);
      kit.disposeKit();
    },
  });
  return kit;
}


/** The pilgrim: longsword and scabbard, round shield, a lantern on a chain at his hip, a tattered cloak. */
export function dressKnight(ctx, char) {
  const kit = new Kit(ctx, char), body = kit.body, B = char.bones;
  kit.cap('hipL', ['Hips', 0.075, 1.0, 0.01], ['Hips', 0.075, 0.9, 0.01], 0.148);
  kit.cap('hipR', ['Hips', -0.075, 1.0, 0.01], ['Hips', -0.075, 0.9, 0.01], 0.148);
  kit.cap('belly', ['Hips', 0, 1.08, 0.02], ['Spine1', 0, 1.22, 0.02], 0.148);
  kit.cap('chest', ['Spine2', 0, 1.27, -0.005], ['Spine2', 0, 1.39, -0.012], 0.168);
  kit.cap('head', ['Head', 0, 1.6, -0.01], ['Head', 0, 1.68, 0], 0.148);
  for (const s of ['Left', 'Right']) {
    const x = s === 'Left' ? 1 : -1;
    kit.limb('thigh' + s[0], s + 'UpLeg', s + 'Leg', 0.108); kit.limb('shin' + s[0], s + 'Leg', s + 'Foot', 0.085);
    kit.cap('arm' + s[0], [s + 'Arm', x * 0.21, 1.35, -0.014], [s + 'ForeArm', x * 0.302, 1.203, -0.011], 0.078);       // from a little down the upper arm (the cloak is pinned at the shoulder)
    kit.limb('fore' + s[0], s + 'ForeArm', s + 'Hand', 0.066);
  }
  body.addFree('scabbard', 0.034); body.addFree('lantern', 0.07); body.addFree('flask', 0.034);
  body.build();

  // ---- the cloak: from under the hood's mantle, round the back and over both shoulders, to the calves
  const CC = 13, CR = 17, CHALF = 76 * DEG;
  const cloak = kit.addCloth({
    name: 'kit:cloak', cols: CC, rows: CR, subdiv: 2, use: ['chest', 'belly', 'hipL', 'hipR', 'thighL', 'thighR', 'shinL', 'shinR', 'armL', 'armR', 'foreL', 'foreR', 'scabbard', 'lantern', 'flask'],
    rest: (i, j) => { const v = j / (CR - 1), w = 0.46 + 0.36 * Math.pow(v, 0.85); return [(i / (CC - 1) - 0.5) * w, -v * 1.12]; },
    pin: (i, j) => { if (j) return null; const a = (i / (CC - 1) - 0.5) * 2 * CHALF, k = Math.abs(a) / CHALF; return onBone(char, 'Spine2', 0.172 * Math.sin(a), 1.425 + 0.035 * k * k, -0.018 - 0.168 * Math.cos(a)); },
    away: onBone(char, 'Spine2', 0, 1.3, 0.06), gravity: 9.81, damping: 0.5, drag: 3.2, bend: 0.22, shear: 0.5, flutter: 0.6, thickness: 0.014, friction: 0.5,
    // Last polish: three of cloth.js's limits (the pilgrim's units are metres). The cloak stood 0.7 m over his helmet for
    // 0.7 s whenever something whipped it (a limb through it, a quick turn of his body at a wall), 0.5 to 0.6 m in the
    // charged blow and the leap attack, 0.8 to 0.95 m when he was thrown down. `rise`: it keeps at most 1 m/s of upward
    // speed (thrown cloth rises a hand); `toss`: a limb that pushes it aside leaves it at most 1 m/s along the push;
    // `maxSpeed`: no particle keeps more than 5 m/s (without it the roll put the cloak 9.5 cm into his hip). No `carry`:
    // that is what pushed it into his hip in the roll (wardrobe's note). Measured: tools/tests/lastpolish/cloakwall.mjs,
    // tools/kit_weapons/flight.mjs --knight, solid.mjs knight (docs/logs/lastpolish.md has the table).
    rise: 1.0, toss: 1.0, maxSpeed: 5,
    material: kit.clothMaterial({ name: 'cloak', map: 'prop.tex.cloak', weave: 9, aspect: 1.4, bump: 0.8, roughness: 0.94, sheenColor: 0x6a7c9c, sheen: 0.5, rim: 2.4, rimPower: 0.7 }),
  });

  // ---- sword, scabbard, shield, lantern
  const look = { scale: 1, fade: kit.fadeU };
  const sword = W.makeWeapon(ctx, 'longsword', look), scabbard = W.makeWeapon(ctx, 'scabbard', look), shield = W.makeWeapon(ctx, 'shield', look), lamp = W.makeWeapon(ctx, 'lantern', look);
  // sword and shield by the measured holds (docs/grips.md): nothing here is placed by eye
  const hand = W.grip(char); hand.add(sword.object);
  const arm = W.shieldSocket(char); arm.add(shield.object);
  // The scabbard: worn at his LEFT hip (a right-handed man draws across his body), hung from the belt, its mouth
  // forward and up, its chape back and down. WHERE on the belt is measured, not chosen: in Mixamo's draw (draw_sword
  // 0.49, draw_sword2 0.0, sheath 1.0 to 1.26) the fist closes on the hilt at (0.16, 1.07, 0.185) on the figure at rest
  // with the blade lying along (0.07, -0.19, -0.98), which puts the mouth at the left front of the belt, 17 cm out and
  // 8 cm forward of the hips' middle (here on the surface of this body's armour). At rest it hangs 35 degrees from
  // upright; when his hand comes to the hilt it tips level into the hand (Hanger.aim), as a swordsman tips it to draw.
  const scabAt = new THREE.Vector3(0.212, 1.045, 0.078), scabLine = new THREE.Vector3(0.09, -0.82, -0.565).normalize();
  const sy = scabLine.clone().negate(), sz = new THREE.Vector3(scabAt.x, 0, scabAt.z - 0.003).normalize(); sz.addScaledVector(sy, -sz.dot(sy)).normalize();
  const hip = W.place(char, 'Hips', new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(sy, sz), sy, sz).setPosition(scabAt), 'kit:scabbard');
  kit.holder.add(scabbard.object);
  scabbard.length = scabbard.anchors.chape ? -scabbard.anchors.chape.position.y : 0.83;      // mouth to the end of the chape
  // (the scabbard is shorter than the blade, so that it clears the floor in his guard: while the sword is home the
  // steel is not drawn past the chape: weapons.js, fadeable's cut plane)
  const bladeCut = sword.materials.steel && sword.materials.steel.userData.kitCut ? sword.materials.steel.userData.kitCut.value : null;
  const hang = new W.Hanger(hip, scabbard.object, scabbard.length, { capsules: body, use: ['thighL', 'shinL', 'thighR', 'shinR'], radius: 0.028, floor: () => char.root.position.y + 0.012, centre: B.Hips, rest: -scabLine.y, hang: 0.7 });
  const sheath = scabbard.anchors.sword, homeY = sheath.position.y;       // (the grip's middle stands this far out of the mouth when the sword is home)
  // the lantern: on the RIGHT side of his belt, toward the back (the scabbard has the left hip), swinging on its chain
  const pivot = W.place(char, 'Hips', [-0.208, 1.045, -0.05], 'kit:lantern');
  kit.holder.add(lamp.object);
  const swing = new W.Pendulum(pivot, lamp.object, 0.125, { capsules: body, use: ['thighR', 'hipR', 'hipL', 'belly', 'thighL'], radius: 0.05, damping: 4.2, gravity: 16, maxAngle: 1.45, centre: B.Hips });
  const light = ctx.gfx && ctx.gfx.lights && ctx.gfx.lights.add ? ctx.gfx.lights.add('lantern') : null;
  const flame = lamp.materials.flame, glass = lamp.materials.glass, flameAt = lamp.anchors.flame;
  // his right fist closes round the grip where the hold puts it; his left round the shield's grip strap
  const gripAt = new THREE.Vector3().setFromMatrixPosition(hand.userData.rest), gripLine = new THREE.Vector3().setFromMatrixColumn(hand.userData.rest, 1).normalize();
  const strapAt = shield.anchors.hand.position.clone().applyMatrix4(arm.userData.rest), strapLine = new THREE.Vector3().setFromMatrixColumn(arm.userData.rest, 1).normalize();
  const rightHand = W.makeHand(char, 'Right', { round: { point: gripAt, axis: gripLine, radius: 0.0135 + 0.012 } });
  const leftHand = W.makeHand(char, 'Left', { round: { point: strapAt, axis: strapLine, radius: 0.008 + 0.012 } });
  // two safety nets (weapons.js, makeCarry): where a clip would put the board or the blade through his own body, the ARM
  // that carries it turns (forearm, then shoulder; wrist, then shoulder), never the thing on the arm or in the fist
  const rim = []; for (let k = 0; k < 16; k++) { const a = k / 8 * Math.PI; rim.push({ a: [Math.cos(a) * 0.305, Math.sin(a) * 0.305, 0.012], b: [Math.cos(a) * 0.305, Math.sin(a) * 0.305, 0.012], r: 0.008 }); }
  for (let k = 0; k < 8; k++) { const a = k / 4 * Math.PI; rim.push({ a: [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.035], b: [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.035], r: 0.008 }); }
  rim.push({ a: [0, 0, 0.05], b: [0, 0, 0.05], r: 0.008 });
  // ---- the flask: on a thong at the left of his belt behind the scabbard's mouth; in his LEFT hand while he drinks
  // (the clip drinks left-handed: the fist lets go of the shield's grip, the shield stays strapped to the forearm).
  // In the hand it lies as a grip does in the right fist by the measured hold, mirrored: mouth to the thumb's side.
  const flask = W.makeWeapon(ctx, 'flask', look);
  const fOut = new THREE.Vector3(0.19, 0, -0.105).normalize(), fUp = new THREE.Vector3(0.04, 1, -0.02).normalize(); fOut.addScaledVector(fUp, -fOut.dot(fUp)).normalize();
  const flaskBelt = W.place(char, 'Hips', new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(fUp, fOut), fUp, fOut).setPosition(0.196, 0.945, -0.108), 'kit:flask');
  const cupAt = W.mirrored(gripAt), cupUp = W.mirrored(gripLine), cupOut = W.handFrame(char, 'Left', {}).n.clone(); cupOut.addScaledVector(cupUp, -cupOut.dot(cupUp)).normalize();
  const flaskHandAt = W.place(char, 'LeftHand', new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(cupUp, cupOut), cupUp, cupOut).setPosition(cupAt.clone().addScaledVector(cupUp, 0.012)), 'kit:flask-hand');
  const cupHand = W.makeHand(char, 'Left', { round: { point: cupAt, axis: cupUp, radius: 0.027 + 0.009 } });
  kit.holder.add(flask.object); flask.object.matrixAutoUpdate = false;
  const elbowPivot = new THREE.Vector3(0.147, 0, -0.035), _Y = new THREE.Vector3(0, 1, 0);      // where the elbow lies behind the board (the measured hold: 0.147 along the forearm, 0.034 off its axis)
  const _fp = new THREE.Vector3(), _fq = new THREE.Quaternion(), _fs = new THREE.Vector3(), _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _fm = new THREE.Matrix4(), _fi = new THREE.Matrix4();
  const boardGuard = W.makeCarry(char, { object: shield.object, body, names: ['chest', 'belly', 'head', 'hipL', 'hipR', 'thighL', 'thighR'], segs: rim, margin: 0.006,
    joints: [{ bone: B.LeftForeArm, max: 0.6 }, { bone: B.LeftArm, max: 0.7 }], order: [1, 0] });      // the elbow goes out from the body first (the shoulder), then the forearm turns
  const guard = W.makeCarry(char, { object: sword.object, body, names: ['head', 'chest', 'belly', 'hipL', 'hipR', 'thighL', 'thighR'], margin: 0.01,
    segs: [{ a: [0, sword.anchors.guard.position.y, 0], b: [0, sword.tip.position.y, 0], r: 0.012 }],
    joints: [{ bone: B.RightHand, max: 0.6 }, { bone: B.RightArm, max: 0.9 }], disc: { object: shield.object, radius: 0.315, offset: 0.025 },
    floor: () => char.root.position.y + 0.02 });      // (a hair under where player.js lets the point ride on the floor: the net never pushes it down through it)
  const _f = new THREE.Vector3(), _a = new THREE.Vector3(), _b2 = new THREE.Vector3(), _tu = new THREE.Vector3(), _ts = new THREE.Vector3(), _tq = new THREE.Quaternion();
  const TRAY = 1.08, TRAY_FROM = 0.87;                   // a board lying level on a raised forearm is rolled until its face looks 62 degrees from straight up; one that already looks 50 degrees away is left alone

  Object.assign(kit, {
    sword, shield, scabbard, cloak, sheathed: false, gripR: 1, guards: { blade: guard, board: boardGuard }, hang, drawT: 9, aimed: 0, flask, sip: 0, boardTilt: 0, tray: 0, traySide: 0, trayMin: TRAY,
    lantern: { object: lamp.object, light, level: 1 },
    sheathe(on) {
      const was = kit.sheathed; kit.sheathed = !!on; const o = sword.object;
      // (the blade leaves the scabbard past his hip: the net waits, and the scabbard is tipped toward the hand for a fifth of
      // a second. Last polish: only when it really LEAVES it. Every respawn and every placement says sheathe(false) with the
      // sword already drawn, and the empty scabbard swung up to level and back each time: the reviewer's "stands out to the
      // side at about forty degrees for half a second after he is put somewhere at once")
      if (on) { sheath.add(o); o.position.set(0, 0, 0); o.quaternion.identity(); } else { hand.add(o); o.position.set(0, 0, 0); o.quaternion.identity(); if (was) { guard.rest(0.35); kit.drawT = 0; } }
    },
    onTeleport() { swing.teleport(); hang.teleport(); },
    onFade(f) { const vis = f < 0.995; for (const w of [sword, scabbard, shield, lamp, flask]) w.object.visible = vis; cloak.mesh.visible = vis; cloak.mesh.castShadow = f < 0.5; },
    update(dt) {
      // his right fist closes on the grip while he holds the sword; sheathed, the hand hangs at ease (and where a clip
      // moves the fingers, the draw, it is the clip's); his left fist is always closed on the shield's strap
      kit.gripR += ((kit.sheathed ? 0 : 1) - kit.gripR) * Math.min(1, dt * 14);
      if (kit.gripR < 0.999) rightHand.relax(easeOf(kit, dt));
      rightHand.set(kit.gripR);
      leftHand.set(1);
      // drinking (the clip in front or laid over the walk): the flask comes off the belt into his left hand
      const sipping = char.overlayName === 'drink' || char.clipName === 'drink';
      kit.sip += ((sipping ? 1 : 0) - kit.sip) * Math.min(1, dt * (sipping ? 10 : 6)); if (kit.sip < 0.002) kit.sip = 0;
      cupHand.set(kit.sip);
      kit.pose(); kit.readBody();
      // While he drinks, his left fist has let go of the shield's grip and the wrist bends back to tip the flask: the
      // board, held by the forearm strap alone, is pushed off by the back of the hand. It hinges where it lies on the
      // forearm at the elbow, just as far as the hand needs (about ten degrees). At any other time it is not touched:
      // the measured hold stands.
      { let need = 0; const o = shield.object;
        if (kit.sip > 0.01) {
          for (let i = 0; i < 3; i++) {
            arm.worldToLocal((i === 0 ? B.LeftHand : i === 1 ? B.LeftHandIndex1 : flaskHandAt).getWorldPosition(_a));
            need = Math.max(need, (_a.z + (i === 0 ? 0.03 : i === 1 ? 0.04 : 0.055)) / Math.max(0.1, elbowPivot.x - _a.x));
          }
        }
        const want = Math.asin(Math.min(0.5, Math.max(0, need))) * kit.sip;
        kit.boardTilt += (want - kit.boardTilt) * Math.min(1, dt * 14); if (kit.boardTilt < 0.002) kit.boardTilt = 0;
        if (kit.boardTilt > 0 || o.quaternion.w < 1) { o.quaternion.setFromAxisAngle(_Y, kit.boardTilt); o.position.copy(elbowPivot).sub(_v3.copy(elbowPivot).applyQuaternion(o.quaternion)); o.updateMatrixWorld(true); } }
      // The board is not carried like a tray. Where a clip throws the shield arm straight out with the palm down (the
      // third light cut's wind-up, atk_thrust 0.3 to 0.7: castcheck's "waiter's tray"), the board, strapped along the
      // forearm, lies level with its face to the ceiling. The forearm then rolls about its own length, as a forearm
      // does (from palm down toward thumb up), until the face looks TRAY radians away from straight up. The measured hold on the forearm is not touched; nothing happens where the board is
      // low (he lies, he kneels) or while he drinks.
      { const e = shield.object.matrixWorld.elements, el = Math.hypot(e[8], e[9], e[10]) || 1, high = e[13] - char.root.position.y;
        B.LeftForeArm.getWorldPosition(_a); B.LeftHand.getWorldPosition(_b2); _b2.sub(_a).normalize();                 // the forearm's line
        const uy = Math.sqrt(Math.max(0, 1 - _b2.y * _b2.y)); let want = 0, t = 0;
        if (uy > 0.5 && high > 0.8) {
          _tu.set(0, 1, 0).addScaledVector(_b2, -_b2.y).multiplyScalar(1 / uy); _ts.crossVectors(_b2, _tu);         // as far up as the face can look, and level across the arm
          t = Math.atan2((e[8] * _ts.x + e[9] * _ts.y + e[10] * _ts.z) / el, (e[8] * _tu.x + e[9] * _tu.y + e[10] * _tu.z) / el);
          kit.traySide = -1;                                      // always the way a left forearm turns from palm down: thumb upward (arm forward: the face comes round to his left, outward; arm across his chest: toward the enemy)
          // (lying flat it is rolled TRAY; from TRAY_FROM on it is the clip's; between, in proportion: the ordinary cuts,
          // which carry the face 50 to 60 degrees from upright, are not touched. Once it rolls one way it keeps to that
          // side until the clip has taken the board well over to the other.)
          const lean = t * kit.traySide, w = Math.min(1, (uy - 0.5) / 0.25) * Math.min(1, (high - 0.8) / 0.25) * (1 - kit.sip) * Math.min(1, Math.max(0, (e[9] / el - 0.62) / 0.18));      // (only a face that really looks at the ceiling)
          if (lean < TRAY_FROM && lean > -0.6 * TRAY_FROM) want = kit.traySide * Math.min(1.9, kit.trayMin * (1 - lean / TRAY_FROM)) * w;
        }
        const step = (Math.abs(want) > Math.abs(kit.tray) ? 0.34 : 0.16) * dt * 60; kit.tray += Math.max(-step, Math.min(step, want - kit.tray));      // (last polish: it comes ON twice as fast as it goes: at 0.16 a step the board still lay flat for two frames of the third cut's wind-up)
        if (Math.abs(kit.tray) < 0.003 && want === 0) { kit.tray = 0; kit.traySide = 0; }
        if (kit.tray !== 0) {
          const f = B.LeftForeArm; f.parent.matrixWorld.decompose(_fp, _hq, _fs);
          f.quaternion.premultiply(_fq.copy(_hq).invert().multiply(_tq.setFromAxisAngle(_b2, kit.tray)).multiply(_hq)); f.updateMatrixWorld(true);
        } }
      boardGuard.update(dt);                                                 // the shield keeps out of his body,
      if (!kit.sheathed) guard.update(dt);                                   // and the blade out of his hood, his body and the shield
      kit.begin(dt);
      // the scabbard hangs and swings. While the sword is in it and his fist comes to the hilt (and for a moment after
      // the blade has left it) it tips so that its line passes through the fist; the sword slides out with the hand
      hand.getWorldPosition(_f); sheath.getWorldPosition(_a); kit.drawT += dt;
      const near = _f.distanceTo(_a), want = kit.sheathed ? (near < 0.12 ? 1 : near > 0.34 ? 0 : 1 - (near - 0.12) / 0.22) : kit.drawT < 0.2 ? 1 : 0;
      kit.aimed += (want - kit.aimed) * Math.min(1, dt * (want > kit.aimed ? 16 : 5)); if (kit.aimed < 0.002) kit.aimed = 0;
      hang.aimed = kit.aimed; hang.aim.copy(_f);
      hang.update(dt); scabbard.object.updateMatrixWorld(true);
      if (kit.sheathed) sword.object.position.y = -Math.max(0, Math.min(0.3, hang.piv.distanceTo(_f) - homeY)) * kit.aimed;      // (in the sheath's own frame +y runs down into the scabbard)
      if (bladeCut) { if (kit.sheathed) { const d = hang.dir; bladeCut.set(d.x, d.y, d.z, d.dot(hang.x) - 0.035); } else bladeCut.w = 1e9; }
      // the flask: where its thong holds it on the belt, or in the hand, or on the way between the two
      { const k = kit.sip * kit.sip * (3 - 2 * kit.sip);
        flaskBelt.matrixWorld.decompose(_fp, _fq, _fs);
        if (k > 0) { flaskHandAt.matrixWorld.decompose(_hp, _hq, _fs); _fp.lerp(_hp, k); _fq.slerp(_hq, k); }
        _fm.compose(_fp, _fq, _fs); flask.object.matrix.copy(_fi.copy(kit.holder.matrixWorld).invert()).multiply(_fm); flask.object.updateMatrixWorld(true);
        _fs.set(0, 0.03, 0).applyQuaternion(_fq); body.setFree('flask', _fp.x - _fs.x, _fp.y - _fs.y, _fp.z - _fs.z, _fp.x + _fs.x, _fp.y + _fs.y, _fp.z + _fs.z); }
      // the scabbard, for the cloak to lie over
      const e = scabbard.object.matrixWorld.elements; _a.set(e[12], e[13], e[14]); _b2.set(0, -scabbard.length + 0.03, 0).applyMatrix4(scabbard.object.matrixWorld);
      body.setFree('scabbard', _a.x, _a.y, _a.z, _b2.x, _b2.y, _b2.z);
      swing.update(dt);
      lamp.object.updateMatrixWorld(true); _a.set(0, -0.08, 0).applyMatrix4(lamp.object.matrixWorld); _b2.set(0, -0.15, 0).applyMatrix4(lamp.object.matrixWorld);
      body.setFree('lantern', _a.x, _a.y, _a.z, _b2.x, _b2.y, _b2.z);        // the cloak hangs beside the lantern, not over it
      cloak.update(dt);
      kit.hems(dt, [cloak], 0.4);
      // the flame: a quiet flicker, and the light where the flame is
      const L = kit.lantern, t = kit.time, flick = 1 + 0.06 * Math.sin(t * 11.3) + 0.04 * Math.sin(t * 23.7 + 1.3) + 0.03 * Math.sin(t * 5.1 + 0.4), lv = Math.max(0, L.level) * (1 - kit.fade);
      lamp.object.updateMatrixWorld(true); flameAt.getWorldPosition(_f);
      // the light stands a hand out from the flame, away from him (the renderer's point lights have a size now, so it no
      // longer has to stand far off to spare his hip and cloak): 5.2 cd at level 1 lays a pool of warm light on the water
      // about him, as in the painting
      if (light) { const r = char.root.position, ox = _f.x - r.x, oz = _f.z - r.z, ol = Math.hypot(ox, oz) || 1; light.position.set(_f.x + ox / ol * 0.1, _f.y + 0.04, _f.z + oz / ol * 0.1); light.intensity = LANTERN_CD * lv * flick; }
      if (flame && flame.userData.base) flame.color.copy(flame.userData.base).multiplyScalar(flame.userData.power * (0.25 + 0.75 * lv) * flick);
      if (glass && glass.userData.base) glass.color.copy(glass.userData.base).multiplyScalar(glass.userData.power * (0.2 + 0.8 * lv));
      kit.end();
    },
    dispose() {
      for (const w of [sword, scabbard, shield, lamp, flask]) W.disposeWeapon(w);
      for (const s of [hand, hip, arm, pivot, flaskBelt, flaskHandAt]) if (s.parent) s.parent.remove(s);
      if (light) light.intensity = 0;
      rightHand.open(); leftHand.open();
      kit.disposeKit();
    },
  });
  return kit;
}
