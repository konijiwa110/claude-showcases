// The floating candles: a few hundred short candles in shallow brass bowls, adrift on the water of the nave.
// What they are made of (bowl, flame, smoke: geometry and shaders) is in src/gfx/water_candles.js; this file is where
// they are, how they float and how they burn.
//
// The contract (docs/engine.md, "Water"):
//   candles.count                              how many there are
//   candles.lit                                0..1: the share that burns (counted the moment snuff / relight is called)
//   candles.snuff(center, radius, seconds)     put out those within `radius` of `center` (Vector3), spreading outward
//   candles.snuffAll(seconds)                  every one, spreading out from the Cantor
//   candles.relight(fraction, seconds)         bring the lit share up to `fraction`, nearest the Cantor first
//   candles.update(dt), candles.dispose()
// and beyond it (docs/modules/water.md):
//   candles.burning                            0..1: the light they give right now (follows the flames as they die and catch)
//   candles.litNear(x, z, out, k = 0)          a burning candle near (x, z): out.set(x, y, z) of its flame; false if none
//   candles.blow(x, z, radius, power)          what a blow on the floor does to them (the bus's `boss-slam` calls it)
//   candles.prepare(camera)                    what is drawn of each bowl in the frame about to be drawn (the water calls it)
//   candles.drawn                              { hero, near, mid, far, hidden, triangles, mirrorTriangles } of the last frame
//   candles.tune                               the look, as numbers; &candles=key:value,key:value sets them from the address
//
// A flame going out leans from the wind that kills it, shrinks, and leaves an ember on the wick and a thread of smoke;
// one coming back flares. `seconds = 0` changes them at once with none of that (the game uses it to reset).
//
// They float (docs/impact.md, part 1 line 7): they ride the water's rings (water.sample), drift a little round the
// place they were set down, bump each other and the stones, and are shoved aside by everything solid that comes to
// the water: the pilgrim's feet (and his body when he rolls or lies), the Cantor's feet, shins and skirt (boss.solid),
// both blades where they run in the water, whatever lays a wake (her hems, the Tide), and cloth lying on the water
// (her train, her skirts when she kneels, his cloak in a roll: nothing floats under it). Nothing sits inside a foot.
//
// The room answers a blow (part 2 line 10), by the blow's power: at a `boss-slam`, a colossal `hit` or her landing.
// A cut that touches down (the boss tells one with every stroke, power 0.4) only lays the nearest flames over for a
// moment; a heavy blow throws the bowls round it outward; near a colossal one some go out, and in phase one they
// catch again by themselves a few seconds later (`lit` falls and rises with them). A candle struck hard by a body or
// a blade can go out the same way. A single candle going out near the pilgrim is heard (`candle_hiss`).
//
// Their light on the world is the renderer's eight candle lights (gfx.lights.setCandle), which this file moves to the
// brightest clusters near the fighters and the camera.
//
// What is drawn of them is chosen for every drawn frame, for the camera that frame is drawn with (prepare()): a bowl
// is one of four meshes by its size in the picture (1488 triangles for the sixteen largest, then 372, 174, 54), a
// candle outside the camera's view has no bowl at all, and the water's mirror draws simpler shapes still (328 / 96 /
// 32 triangles of what a mirror can show of a floating bowl; nothing for the farthest). Before this every bowl was
// 560 triangles in both passes whether it could be seen or not: half a million triangles a frame.
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { MIRROR_ONLY } from '../gfx/water_mirror.js';       // a layer only the water's mirror camera sees
import { BOWL, wickY, makeBowlGeometry, makeBowlMaterial, makeFlameMaterial, makeGlitterMaterial, makeLidGeometry, makeLidMaterial, makeQuads, makeSmokeMaterial, makeStrips } from '../gfx/water_candles.js';

export const ASSETS = {};

const TUNE = {
  count: 380,         // floating candles
  flame: 1.25,        // size of the flames (1 = 3 cm wide, 7.5 cm tall)
  power: 14,          // brightness of a flame's body (linear HDR)
  halo: 0.3,          // brightness of the soft light round a flame
  glow: 2.4,          // how brightly a flame lights the inside of its own bowl
  glitter: 1.0,       // the streak of each flame's light on the water (0 = only its exact image in the mirror)
  rough: 0.07,        // how rough the water is taken to be for that streak (as a slope): rougher is longer and fainter
  light: 1.0,         // strength of the eight candle lights: about one unit for each candle burning in the cluster
  lightY: 0.8,        // their height above the floor
  // levels of fineness, by how many pixels wide a bowl is in the picture being drawn (at 1600 x 900 and the play
  // camera's lens a bowl is 71 pixels wide at 3.4 m, 28 at 8.6 m, 11 at 22 m)
  heroPx: 71,         // wider than this: the fine mesh (48 sides), for the sixteen widest
  nearPx: 28,         // wider than this: 16 sides
  midPx: 11,          // wider than this: 12 sides; narrower: 6
  lod: 1,             // 0: every candle at 16 sides, in view or not, and all of them in the mirror (to compare and to measure)
  wide: 0,            // 1: the streaks' sheets as wide as they used to be (to measure what narrowing them saves)
};
const SMOKE_LIFE = 3.4, HERO = 16, CLUSTERS = 28, FAR = Math.fround(1e30);     // FAR is kept in Float32Arrays: it must survive the trip
const CELL = 0.5, GX0 = -14, GZ0 = -19.5, GNX = 56, GNZ = 84;        // the grid candles bump each other through
// What shoves candles: fat segments lying on the water. Each: x0 z0 x1 z1, radius (inside it nothing floats), soft
// (how much further the water it pushes ahead reaches), vx vz, air (how much further its wind reaches), then the
// box it can reach (min x, max x, min z, max z) and its speed.
const NPUSH = 96, PW = 16, WAKE0 = 30;      // slots: 0, 1 the fighters' middles; 2..8 the pilgrim's feet and body; 9, 10 the blades; 11..29 her capsules; from 30 on, whatever this step brings: wakes, the outlines of cloth lying on the water
// (the last two numbers of a pusher: a direction it shoves in; what lies on the other side of it is not its business. 0, 0: both sides.)
const SHEETS = 6, RIM = 40, CAND = 160;     // sheets of cloth with something on the water at once; the most corners an outline has; particles looked at for one
const PILGRIM = [['Hips', 0.23, 0.46], ['Spine2', 0.23, 0.46], ['Head', 0.15, 0.4], ['LeftHand', 0.09, 0.36], ['RightHand', 0.09, 0.36]];   // bone, radius, how low it must be
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _v = new THREE.Vector3(), _size = new THREE.Vector2(), _s = { h: 0, fx: 0, fz: 0 }, _m = new THREE.Matrix4();

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function lattice(ix, iz) { let x = Math.imul(ix * 374761393 + iz * 668265263, 1274126177); x ^= x >>> 13; x = Math.imul(x, 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
  const a = lattice(ix, iz), b = lattice(ix + 1, iz), c = lattice(ix, iz + 1), d = lattice(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}

export class Candles {
  constructor(ctx) {
    this.ctx = ctx; this.time = 0; this.cost = { update: 0, prepare: 0 };
    const tune = this.tune = Object.assign({}, TUNE);
    for (const part of (ctx.params && ctx.params.get('candles') || '').split(',')) { const [k, v] = part.split(':'); if (k in tune && v !== undefined && !Number.isNaN(+v)) tune[k] = +v; }
    const arena = ctx.arena;
    // what stands in the water: the arena's colliders, and the piers' bases when the arena says where they are
    this.cols = (arena.colliders || []).map((c) => ({ x: c.x, z: c.z, r: c.r }));
    for (const p of arena.piers || []) this.cols.push({ x: p.x, z: p.z, r: p.r || 1.25 });
    this.zMin = (arena.dais ? arena.dais.z : -17.6) + 0.3; this.zMax = 20.4; this.xMax = 12.3;

    const spots = this.scatter(Math.max(0, Math.round(tune.count)));
    const ledges = (arena.ledges || []).slice(0, 80);
    const nf = this.floating = spots.length, n = this.count = nf + ledges.length;
    const F = (k = 1) => new Float32Array(n * k);
    // where each one is and how it moves
    this.px = F(); this.pz = F(); this.py = F(); this.vx = F(); this.vz = F(); this.hx = F(); this.hz = F(); this.yaw = F(); this.spin = F();
    this.rock = F(); this.rockV = F(); this.lastH = F();
    // what each one is
    this.size = F(); this.wax = F(); this.tone = F(); this.seed = F();
    // how each one burns
    this.on = new Uint8Array(n); this.at = F(); this.burn = F(); this.flare = F(); this.ember = F(); this.smoke = F();
    this.gx = F(); this.gz = F(); this.wx = F(); this.wz = F();     // the wind that kills it (a direction), the air round it now
    this.back = F().fill(FAR); this.hissOn = new Uint8Array(n);      // when a candle a blow put out catches again by itself; whether its going out is to be heard
    this.rs = 0x2f6e2b1; this.hissT = -9; this.blowT = -9; this.blowX = 0; this.blowZ = 0; this.blowP = 0; this.stepN = 1;
    const rnd = mulberry(0x5eed1e);
    for (let i = 0; i < n; i++) {
      const s = i < nf ? spots[i] : ledges[i - nf];
      this.px[i] = this.hx[i] = s.x; this.pz[i] = this.hz[i] = s.z; this.py[i] = i < nf ? WATER_Y : s.y;
      this.yaw[i] = rnd() * Math.PI * 2;
      const big = rnd();
      this.size[i] = i < nf ? (big > 0.93 ? 1.3 + rnd() * 0.25 : 0.82 + rnd() * 0.36) : 0.9 + rnd() * 0.3;
      if (i >= nf) this.py[i] += 0.021 * this.size[i];                  // on a ledge the bowl stands on its foot
      this.wax[i] = 0.56 + rnd() * 0.44; this.tone[i] = rnd(); this.seed[i] = rnd();
      this.on[i] = 1; this.at[i] = FAR; this.burn[i] = 1; this.smoke[i] = -1;
    }
    this.rockC = F(); this.rockS = F(); for (let i = 0; i < n; i++) { this.rockC[i] = Math.cos(this.seed[i] * 40); this.rockS[i] = Math.sin(this.seed[i] * 40); }     // which way each one rocks after a ring
    this.litCount = n; this.burning = 1; this.alight = n; this.smoking = 0;
    this.order = new Uint16Array(n); this.key = F();
    this._byKey = (a, b) => this.key[a] - this.key[b];

    // ---- what is drawn
    const group = this.group = new THREE.Group(); group.name = 'candles'; ctx.scene.add(group);
    const u = this.uniforms = {
      uTime: { value: 0 }, uGlow: { value: new THREE.Vector3(tune.glow, 0.7, 2.2) },
      uViewH: { value: 900 }, uSize: { value: new THREE.Vector2(0.03 * tune.flame, 0.075 * tune.flame) }, uGlowR: { value: 0.1 * tune.flame },
      uPower: { value: new THREE.Vector3(tune.power, tune.halo, 1.6) },
      uSmokeSize: { value: new THREE.Vector2(0.2, 0.7) }, uSmokeColor: { value: new THREE.Color(0.3, 0.33, 0.4) }, uSmokeLife: { value: SMOKE_LIFE },
    };
    this.bowlMat = makeBowlMaterial(u);
    const inst = (count, size) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size); a.setUsage(THREE.DynamicDrawUsage); return a; };
    // Every candle's bowl and how it burns, as the GPU wants it: written each step (write()), handed out each frame (prepare()).
    this.M = new Float32Array(n * 16); this.S = F(4); this.Lk = F(4);
    for (let i = 0; i < n; i++) { this.Lk[i * 4] = this.tone[i]; this.Lk[i * 4 + 1] = wickY(this.wax[i]); }
    // The bowls: four instanced meshes, one for each level of fineness, each with room for every candle; prepare()
    // deals the candles out among them for each frame. They are on layer 2, so the mirror does not draw them: what
    // the mirror shows of a bowl is a plainer mesh of its own (`image`), on a layer only the mirror's camera sees,
    // drawn from the same buffers. The near levels carry a lid nobody sees, which keeps the water's flat sheet out
    // of a bowl that a ring pushes down (depth only, after everything solid, not in the mirror).
    this.lidMat = makeLidMaterial();
    const dress = (mesh, name, layer) => { mesh.name = name; mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false; mesh.layers.set(layer); mesh.count = 0; mesh.visible = false; group.add(mesh); return mesh; };
    const level = (name, room, image, lidSides) => {
      const geo = makeBowlGeometry(name), mesh = new THREE.InstancedMesh(geo, this.bowlMat, room), aState = inst(room, 4), aLook = inst(room, 4);
      geo.setAttribute('aState', aState); geo.setAttribute('aLook', aLook); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const v = { name, mesh: dress(mesh, 'candle-bowls-' + name, 2), image: null, lid: null, n: 0, M: mesh.instanceMatrix.array, S: aState.array, L: aLook.array, aState, aLook, tris: geo.userData.triangles, imageTris: 0,
        rM: { start: 0, count: 0 }, rS: { start: 0, count: 0 }, rL: { start: 0, count: 0 } };
      if (image) {
        const g = makeBowlGeometry(image); g.setAttribute('aState', aState); g.setAttribute('aLook', aLook);
        v.image = dress(new THREE.InstancedMesh(g, this.bowlMat, room), 'candle-bowls-' + image, MIRROR_ONLY); v.image.instanceMatrix = mesh.instanceMatrix; v.imageTris = g.userData.triangles;
      }
      if (lidSides) {
        v.lid = dress(new THREE.InstancedMesh(makeLidGeometry(lidSides), this.lidMat, room), 'candle-lids-' + name, 2); v.lid.instanceMatrix = mesh.instanceMatrix; v.lid.receiveShadow = false; v.lid.renderOrder = 2;
      }
      return v;
    };
    // by number: 1 near, 2 mid, 3 far, 4 the fine mesh (0: not drawn)
    this.levels = [null, level('near', n, 'mirror-near', 12), level('mid', n, 'mirror-mid', 0), level('far', n, null, 0), level('hero', HERO, 'mirror-hero', 32)];
    this.bowls = this.levels[1].mesh; this.hero = this.levels[4].mesh; this.lids = this.levels[1].lid; this.heroLids = this.levels[4].lid;
    this.lod = new Uint8Array(n); this.pxs = F(); this.isHero = new Uint8Array(n); this.heroOf = new Int16Array(HERO).fill(-1); this.heroPx = new Float32Array(HERO); this.planes = new Float32Array(16);
    this.drawn = { hero: 0, near: 0, mid: 0, far: 0, hidden: 0, triangles: 0, mirrorTriangles: 0 };      // what the last frame drew of the bowls
    this.prepared = false; this.hooked = false; this.disposed = false; this.benchHide = 0; this.warming = 0;

    const quads = makeQuads(n);
    this.aPos = inst(n, 3); this.aFlame = inst(n, 4); this.aLean = inst(n, 4); this.aSmoke = inst(n, 4);
    quads.setAttribute('aPos', this.aPos); quads.setAttribute('aFlame', this.aFlame); quads.setAttribute('aLean', this.aLean);
    this.flames = new THREE.Mesh(quads, makeFlameMaterial(u)); this.flames.name = 'candle-flames'; this.flames.frustumCulled = false; this.flames.renderOrder = 6;
    this.flames.matrixAutoUpdate = false;
    // a flame far away is held at a couple of pixels: the shader needs the height of whatever picture is being drawn
    this.flames.onBeforeRender = (renderer) => { const rt = renderer.getRenderTarget(); u.uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(_size).y; };
    group.add(this.flames);
    const sq = makeQuads(n); sq.setAttribute('aPos', this.aPos); sq.setAttribute('aSmoke', this.aSmoke);
    this.smokes = new THREE.Mesh(sq, makeSmokeMaterial(u)); this.smokes.name = 'candle-smoke'; this.smokes.frustumCulled = false; this.smokes.renderOrder = 5;
    this.smokes.layers.set(2); this.smokes.matrixAutoUpdate = false; group.add(this.smokes);
    // each flame's streak on the water: laid on the surface, drawn after it, and not in the mirror
    const wu = this.waterU = (ctx.water && ctx.water.uniforms) || null;
    this.blank = wu ? null : new THREE.DataTexture(new Uint8Array(4), 1, 1); if (this.blank) this.blank.needsUpdate = true;
    Object.assign(u, {
      uWaterY: { value: WATER_Y }, uGlitter: { value: new THREE.Vector4(tune.glitter, tune.rough, tune.power * 0.5 * 0.03 * 0.075 * tune.flame * tune.flame, tune.wide ? 1 : 0) },
      tRipple: wu ? wu.tRipple : { value: this.blank }, uField: wu ? wu.uField : { value: new THREE.Vector4(0, 0, 0, 0) },
      uOptics: wu ? wu.uOptics : { value: new THREE.Vector4(0.12, 3.5, 0, 0) }, uRings: { value: wu ? 1 : 0 },
    });
    const gq = makeStrips(n, 4); gq.setAttribute('aPos', this.aPos); gq.setAttribute('aFlame', this.aFlame); gq.setAttribute('aLean', this.aLean);
    this.glitter = new THREE.Mesh(gq, makeGlitterMaterial(u)); this.glitter.name = 'candle-glitter'; this.glitter.frustumCulled = false; this.glitter.renderOrder = -90;
    this.glitter.layers.set(2); this.glitter.matrixAutoUpdate = false; this.glitter.visible = tune.glitter > 0; group.add(this.glitter);
    for (let i = 0; i < n; i++) { this.aFlame.array[i * 4 + 3] = this.seed[i]; this.aLean.array[i * 4 + 2] = 0.85 + this.seed[i] * 0.4; this.aSmoke.array[i * 4] = -1; this.aSmoke.array[i * 4 + 1] = this.seed[i]; }

    // ---- bumping each other, the fighters, and the light they give
    this.cellHead = new Int16Array(GNX * GNZ); this.cellNext = new Int16Array(n);
    this.P = new Float32Array(NPUSH * PW); this.pushOn = new Uint8Array(NPUSH); this.pushLast = new Float32Array(NPUSH * 3); this.act = new Uint8Array(NPUSH); this.nAct = 0;
    // the outlines of cloth lying on the water: each corner x, z, vx, vz
    this.rims = new Float32Array(SHEETS * RIM * 4); this.rimN = new Int16Array(SHEETS); this.sheets = 0; this.cand = new Int32Array(CAND); this.rimQ = new Int32Array(CAND * 2 + 2);
    const bus = ctx.bus;
    this.listeners = [
      ['boss-slam', (e) => { if (e && e.pos) this.blow(e.pos.x, e.pos.z, e.radius || 3, e.power === undefined ? 1 : e.power); }],
      ['hit', (e) => { if (e && e.weight === 'colossal' && e.point) this.blow(e.point.x, e.point.z, 3.2, 0.9); }],
      ['land', (e) => { if (e && e.who === 'boss' && e.pos) this.blow(e.pos.x, e.pos.z, 3.4, e.hard ? 0.7 : 0.45); }],
    ];
    for (const [name, fn] of this.listeners) bus.on(name, fn);
    this.makeClusters();
    const pool = (ctx.gfx.lights && ctx.gfx.lights.pool) || 0;
    this.slots = []; for (let i = 0; i < pool; i++) this.slots.push({ c: -1, x: 0, z: 0, i: 0, want: 0 });
    this.lightTick = 0;
    this.write(0);
    // The water calls prepare() before its mirror pass; if nobody has by the time the hooks run, this one does.
    const gfx = ctx.gfx;
    if (gfx && gfx.onBeforeRender) { this.unhook = gfx.onBeforeRender(() => { if (this.disposed) return; if (!this.prepared) this.prepare(this.ctx.camera); this.prepared = false; }); this.hooked = true; }
    if (gfx && gfx.onWarm) gfx.onWarm(() => { this.warming = 2; });       // gfx.warm() draws two frames after this
    this.prepare(ctx.camera); this.prepared = false;
  }

  // ------------------------------------------------------------------------------------------------ the contract

  get lit() { return this.count ? this.litCount / this.count : 0; }

  /** Put out the candles within `radius` of `center`, the nearest first, the farthest after `seconds`. */
  snuff(center, radius, seconds = 1) {
    const cx = center.x, cz = center.z;
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - cx, dz = this.pz[i] - cz, d = Math.hypot(dx, dz);
      if (d >= radius) continue;
      this.back[i] = FAR; this.hissOn[i] = 0;                            // one a blow put out stays out too
      if (this.on[i]) this.set(i, 0, seconds * d / radius, seconds > 0, d > 1e-3 ? dx / d : 0, d > 1e-3 ? dz / d : 1);
    }
    this.ctx.bus.emit('candles', { lit: this.lit, how: 'snuff' });
  }

  /** Put out every candle: a wave running out from the Cantor that reaches the farthest one after `seconds`. */
  snuffAll(seconds = 2) {
    const b = this.ctx.boss, cx = b ? b.pos.x : 0, cz = b ? b.pos.z : 0;
    let far = 1;
    for (let i = 0; i < this.count; i++) far = Math.max(far, Math.hypot(this.px[i] - cx, this.pz[i] - cz));
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - cx, dz = this.pz[i] - cz, d = Math.hypot(dx, dz);
      this.back[i] = FAR; this.hissOn[i] = 0;
      if (this.on[i] || this.at[i] < FAR) this.set(i, 0, seconds * d / far, seconds > 0, d > 1e-3 ? dx / d : 0, d > 1e-3 ? dz / d : 1);
    }
    this.ctx.bus.emit('candles', { lit: this.lit, how: 'snuff' });
  }

  /** Bring the lit share up to `fraction`: the unlit candles nearest the Cantor catch first, the last after `seconds`. */
  relight(fraction, seconds = 1) {
    const n = this.count, need = Math.min(n, Math.round(fraction * n)) - this.litCount;
    if (need > 0) {
      const b = this.ctx.boss, cx = b ? b.pos.x : 0, cz = b ? b.pos.z : 0;
      for (let i = 0; i < n; i++) { this.order[i] = i; const dx = this.px[i] - cx, dz = this.pz[i] - cz; this.key[i] = this.on[i] ? FAR : dx * dx + dz * dz; }
      this.order.sort(this._byKey);
      for (let k = 0; k < need; k++) this.set(this.order[k], 1, seconds * (k / need), seconds > 0, 0, 0);
      this.ctx.bus.emit('candles', { lit: this.lit, how: 'relight' });
    }
    // (Told only when something catches. Until 9 Nov it was told every time, and the game asks for all candles once
    // more when the ending is over, as a net under a skipped ending: with every candle already burning the hall was
    // heard catching light a second time, over the fade to the game's name, for nothing.)
  }

  /** A burning candle near (x, z): its flame's place goes into out (a Vector3). k picks another one each time (0, 1, 2 ...). */
  litNear(x, z, out, k = 0) {
    let best = -1, bd = FAR; const n = this.count, start = ((k * 97) % n + n) % n;
    for (let j = 0; j < n; j += 3) {                                    // a third of them, a different third for each k
      const i = (start + j) % n;
      if (this.burn[i] < 0.5) continue;
      const dx = this.px[i] - x, dz = this.pz[i] - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return false;
    out.set(this.aPos.array[best * 3], this.aPos.array[best * 3 + 1], this.aPos.array[best * 3 + 2]);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ inside

  /** Candle i is to burn (1) or not (0), `delay` seconds from now; slow = with wind, ember and smoke, or with a flare. */
  set(i, to, delay, slow, gx, gz) {
    if (this.on[i] !== to) { this.litCount += to ? 1 : -1; this.on[i] = to; }
    if (to) this.back[i] = FAR;
    if (!slow) { this.at[i] = FAR; this.burn[i] = to; this.flare[i] = 0; this.ember[i] = 0; this.smoke[i] = -1; return; }
    this.at[i] = this.time + delay; this.gx[i] = gx; this.gz[i] = gz;
  }

  /** The flames' streaks on the water read the water's ripple field: take it from this water's uniforms. */
  link(wu) {
    this.waterU = wu;
    const u = this.uniforms, g = this.glitter.material.uniforms;
    u.tRipple = g.tRipple = wu.tRipple; u.uField = g.uField = wu.uField; u.uOptics = g.uOptics = wu.uOptics; u.uRings.value = 1;
  }

  /** A number in 0..1, the same on every run. */
  rand() { let x = this.rs; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rs = x >>> 0; return this.rs / 4294967296; }

  /**
   * Something has struck the water or the floor at (x, z): radius in metres, power about 0.4 (a cut touching down,
   * which the boss tells with every stroke) to 1.3 (her leap). Everything is scaled by the power. A cut only ruffles
   * the flames within a couple of metres (they lie over for a moment) and gives the nearest bowls a nudge; a heavy
   * blow (0.8: the Tide, her heel) throws the candles round it outward and a few of the nearest go out; a colossal
   * one (from 0.85: the cleave, the leap, her knee) throws them across the floor, lays the flames flat, and those
   * nearest go out in a wave running outward. In phase one each catches again by itself three to seven seconds later.
   */
  blow(x, z, radius = 3, power = 1) {
    const t = this.time;
    if (t - this.blowT < 0.3 && Math.hypot(x - this.blowX, z - this.blowZ) < 4 && power <= this.blowP) return;   // the same blow, told twice
    this.blowT = t; this.blowX = x; this.blowZ = z; this.blowP = power;
    const p = Math.max(0, power), p1 = Math.min(1, p), b = Math.min(1, Math.max(0, (p - 0.5) / 0.35)), big = b * b * (3 - 2 * b);   // 0 for a cut, 1 from the cleave up
    const reach = radius * (0.45 + 0.65 * p1) + 0.3, out = p >= 0.85 ? radius * 0.75 : p >= 0.6 ? radius * 0.3 : 0;
    const throwK = (1.0 + 2.4 * p) * (0.12 + 0.88 * big), turn = 0.25 + 0.75 * big, lay = Math.min(1.5, 0.3 + p);
    let gone = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - x, dz = this.pz[i] - z, d2 = dx * dx + dz * dz; if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2) || 1e-3, nx = dx / d, nz = dz / d, f = 1 - d / reach;
      if (i < this.floating) {
        const kick = throwK * f * f;
        this.vx[i] += nx * kick; this.vz[i] += nz * kick; this.spin[i] += (this.seed[i] - 0.5) * 16 * f * turn; this.rockV[i] += (this.seed[i] - 0.3) * 2.2 * f * turn;
      }
      this.wx[i] += nx * lay * f; this.wz[i] += nz * lay * f;
      if (d < out && this.on[i] && this.at[i] === FAR && this.rand() < Math.min(1, 1.3 - d / out) * p1) {
        const delay = d / 16;
        this.set(i, 0, delay, true, nx, nz); this.back[i] = t + delay + 3 + 4 * this.rand(); this.hissOn[i] = 1; gone++;
      }
    }
    if (gone >= 8) this.ctx.bus.emit('candles', { lit: this.lit, how: 'snuff' });      // a ring of them going out has its own sound; fewer are heard one by one
    return gone;
  }

  /** One wick meeting the water, heard if it is near the pilgrim (the sound owner's `candle_hiss`). */
  hiss(i) {
    const ctx = this.ctx, p = ctx.player, audio = ctx.audio, t = this.time;
    if (!p || !p.pos || !audio || !audio.play || t - this.hissT < 0.07) return;
    const dx = this.px[i] - p.pos.x, dz = this.pz[i] - p.pos.z; if (dx * dx + dz * dz > 64) return;
    this.hissT = t;
    try { audio.play('candle_hiss', { pos: _v.set(this.px[i], this.py[i] + 0.06, this.pz[i]) }); } catch (e) { /* no such sound in this build: silence is right */ }
  }

  /** One thing that shoves candles this step: a fat segment on the water (see NPUSH). Its speed comes from where it was last step. */
  push(slot, x0, z0, x1, z1, r, soft, air, dt, speed = -1, vx = 0, vz = 0) {
    const P = this.P, o = slot * PW, L = this.pushLast, l = slot * 3, mx = (x0 + x1) * 0.5, mz = (z0 + z1) * 0.5;
    if (speed < 0 && L[l + 2] === this.stepN - 1) { const jx = mx - L[l], jz = mz - L[l + 1]; if (jx * jx + jz * jz < 4) { vx = jx / dt; vz = jz / dt; } }
    L[l] = mx; L[l + 1] = mz; L[l + 2] = this.stepN;
    const reach = r + Math.max(soft, soft + air) + 0.25;
    P[o] = x0; P[o + 1] = z0; P[o + 2] = x1; P[o + 3] = z1; P[o + 4] = r; P[o + 5] = soft; P[o + 6] = vx; P[o + 7] = vz; P[o + 8] = air;
    P[o + 9] = Math.min(x0, x1) - reach; P[o + 10] = Math.max(x0, x1) + reach; P[o + 11] = Math.min(z0, z1) - reach; P[o + 12] = Math.max(z0, z1) + reach;
    P[o + 13] = speed < 0 ? Math.hypot(vx, vz) : speed; P[o + 14] = 0; P[o + 15] = 0;
    this.pushOn[slot] = 1;
  }
  /** The part of the stick a-b (world) that is within `top` of the floor, as a pusher; nothing if it is all above. */
  pushLow(slot, a, b, top, r, soft, dt) {
    if (a.y > top && b.y > top) return;
    let ta = 0, tb = 1;
    if (a.y > top) ta = (a.y - top) / (a.y - b.y); else if (b.y > top) tb = (top - a.y) / (b.y - a.y);
    this.push(slot, a.x + (b.x - a.x) * ta, a.z + (b.z - a.z) * ta, a.x + (b.x - a.x) * tb, a.z + (b.z - a.z) * tb, r, soft, 0, dt);
  }

  /** Everything solid at the water this step. */
  gather(dt) {
    const ctx = this.ctx, pl = ctx.player, bo = ctx.boss;
    this.pushOn.fill(0);
    // the pilgrim: his middle (the water he pushes ahead, the air he drags), his feet, and the rest of him when it is low (a roll, a fall)
    if (pl && pl.pos) {
      this.push(0, pl.pos.x, pl.pos.z, pl.pos.x, pl.pos.z, 0.2, 0.42, 1.6, dt);
      const B = pl.char && pl.char.bones;
      if (B && B.LeftFoot && B.RightFoot) {
        for (let k = 0; k < 2; k++) {
          const foot = k ? B.RightFoot : B.LeftFoot, toe = k ? B.RightToeBase : B.LeftToeBase;
          foot.getWorldPosition(_a); if (toe) toe.getWorldPosition(_b); else _b.copy(_a);
          if (Math.min(_a.y, _b.y) < 0.42) this.push(2 + k, _a.x, _a.z, _b.x, _b.z, 0.105, 0.1, 0, dt);
        }
        for (let k = 0; k < PILGRIM.length; k++) { const bone = B[PILGRIM[k][0]]; if (!bone) continue; bone.getWorldPosition(_a); if (_a.y < PILGRIM[k][2]) this.push(4 + k, _a.x, _a.z, _a.x, _a.z, PILGRIM[k][1], 0.12, 0, dt); }
      }
      const sw = pl.kit && pl.kit.sword;
      if (sw && sw.base && sw.tip) { sw.base.getWorldPosition(_a); sw.tip.getWorldPosition(_b); this.pushLow(9, _a, _b, 0.24, 0.07, 0.12, dt); }
    }
    // the Cantor: her capsules where they come down to the water (feet, shins, the skirt between them; thighs, body and arms when she kneels)
    if (bo && bo.pos) {
      const S = bo.solid;
      if (S && S.length) {
        this.push(1, bo.pos.x, bo.pos.z, bo.pos.x, bo.pos.z, 0.3, 1.5, 3.2, dt);
        for (let k = 0; k < S.length && k < WAKE0 - 11; k++) this.pushLow(11 + k, S[k].a, S[k].b, S[k].r + 0.3, S[k].r * 0.95, 0.3, dt);
      } else this.push(1, bo.pos.x, bo.pos.z, bo.pos.x, bo.pos.z, (bo.radius || 1.5) + 0.25, 1.3, 3.2, dt);
      const sw = bo.kit && bo.kit.sword;
      if (sw && sw.base && sw.tip) { sw.base.getWorldPosition(_a); sw.tip.getWorldPosition(_b); this.pushLow(10, _a, _b, 0.35, 0.26, 0.3, dt); }
    }
    // whatever was dragged through the water in this step (a wave, a hem moving fast)
    let slot = WAKE0;
    const water = ctx.water, W = water && water.wakes;
    if (W) for (let j = 0; j < W.length && slot < NPUSH; j += 7) {
      if (water.time - W[j + 6] > dt * 1.6) continue;
      this.push(slot++, W[j], W[j + 1], W[j + 2], W[j + 3], 0.02, W[j + 4] + 0.25, 0, dt, 1 + 1.6 * W[j + 5]);
    }
    // Cloth lying on the water (her train, her skirts round her when she kneels, his cloak in a roll): nothing floats
    // under it. The part of each sheet that is down at the water is taken as its outline; the outline's sides shove
    // what is outside them like anything else solid, and whatever is found inside is put out (uncover(), after the
    // candles have moved).
    this.sheets = 0;
    for (let f = 0; f < 2; f++) {
      const kit = f ? bo && bo.kit : pl && pl.kit, cloths = kit && kit.cloths;
      if (!cloths || !cloths.length) continue;
      for (let c = 0; c < cloths.length && this.sheets < SHEETS; c++) {
        const cl = cloths[c];
        if (cl && cl.x && cl.p && cl.cols > 1 && cl.rows > 1 && cl.x.length >= cl.cols * cl.rows * 3) slot = this.outline(cl, dt, slot);
      }
    }
    let n = 0; for (let k = 0; k < NPUSH; k++) if (this.pushOn[k]) this.act[n++] = k;
    this.nAct = n;
  }

  /**
   * The outline of what lies on the water of one sheet of cloth (the wardrobe's Cloth: particles `x` and where they
   * were a sub-step ago `p`, `cols` across and `rows` down, in the world): the convex outline of the particles that
   * are down, counter-clockwise, kept in this.rims for uncover(). Each side of it becomes a pusher that shoves
   * outward only. Returns the next free pusher slot. Nothing is allocated.
   */
  outline(cl, dt, slot) {
    const X = cl.x, Q = cl.p, cols = cl.cols, rows = cl.rows, top = WATER_Y + 0.07, cand = this.cand, H = this.rimQ;
    // the particles that can be corners: in each column the highest and the lowest that are down; in the two outer columns all that are down
    let n = 0;
    for (let i = 0; i < cols; i++) {
      const edge = i === 0 || i === cols - 1; let first = -1, last = -1;
      for (let j = 0; j < rows; j++) {
        const q = (j * cols + i) * 3; if (!(X[q + 1] < top)) continue;
        if (edge) { if (n < CAND) cand[n++] = q; } else { if (first < 0) first = q; last = q; }
      }
      if (first >= 0 && n < CAND) cand[n++] = first;
      if (last >= 0 && last !== first && n < CAND) cand[n++] = last;
    }
    if (n < 2) return slot;
    // sort them by x, then z (they come nearly in order: insertion is quick), and wrap a hull round them
    for (let a = 1; a < n; a++) { const q = cand[a], x = X[q], z = X[q + 2]; let b = a - 1; while (b >= 0 && (X[cand[b]] > x || (X[cand[b]] === x && X[cand[b] + 2] > z))) { cand[b + 1] = cand[b]; b--; } cand[b + 1] = q; }
    let m = 0;
    for (let a = 0; a < n; a++) { const c = cand[a]; while (m >= 2 && (X[H[m - 1]] - X[H[m - 2]]) * (X[c + 2] - X[H[m - 2] + 2]) - (X[H[m - 1] + 2] - X[H[m - 2] + 2]) * (X[c] - X[H[m - 2]]) <= 0) m--; H[m++] = c; }
    for (let a = n - 2, low = m + 1; a >= 0; a--) { const c = cand[a]; while (m >= low && (X[H[m - 1]] - X[H[m - 2]]) * (X[c + 2] - X[H[m - 2] + 2]) - (X[H[m - 1] + 2] - X[H[m - 2] + 2]) * (X[c] - X[H[m - 2]]) <= 0) m--; H[m++] = c; }
    m--;                                                                // the last corner is the first again
    const k = (cl.substeps || 1) / dt;
    if (m < 3) {                                                        // all in one line (a hem just touching): a plain two-sided pusher along it
      if (slot < NPUSH) { const a = cand[0], b = cand[n - 1], ux = (X[a] - Q[a] + X[b] - Q[b]) * 0.5 * k, uz = (X[a + 2] - Q[a + 2] + X[b + 2] - Q[b + 2]) * 0.5 * k; this.push(slot++, X[a], X[a + 2], X[b], X[b + 2], 0.05, 0.1, 0, dt, Math.hypot(ux, uz), ux, uz); }
      return slot;
    }
    const skip = Math.ceil(m / RIM), R = this.rims, o = this.sheets * RIM * 4; let c = 0;
    for (let a = 0; a < m; a += skip) { const q = H[a], r = o + c * 4; R[r] = X[q]; R[r + 1] = X[q + 2]; R[r + 2] = (X[q] - Q[q]) * k; R[r + 3] = (X[q + 2] - Q[q + 2]) * k; c++; }
    this.rimN[this.sheets++] = c;
    for (let a = 0; a < c && slot < NPUSH; a++) {
      const r = o + a * 4, t = o + ((a + 1) % c) * 4, ex = R[t] - R[r], ez = R[t + 1] - R[r + 1], l = Math.sqrt(ex * ex + ez * ez); if (l < 1e-4) continue;
      const ux = (R[r + 2] + R[t + 2]) * 0.5, uz = (R[r + 3] + R[t + 3]) * 0.5;
      this.push(slot, R[r], R[r + 1], R[t], R[t + 1], 0.05, 0.1, 0, dt, Math.hypot(ux, uz), ux, uz);
      this.P[slot * PW + 14] = ez / l; this.P[slot * PW + 15] = -ex / l;      // outward: to the right of a counter-clockwise outline
      slot++;
    }
    return slot;
  }

  /**
   * Whatever floats inside the outline of cloth lying on the water is put out of it by the nearest side: a hand's
   * breadth a step at most, so a train set down on candles at once (a cut, her kneeling) sweeps them out in a tenth
   * of a second rather than making them jump. Uses the grid the candles were sorted into while they moved.
   */
  uncover() {
    const R = this.rims, head = this.cellHead, next = this.cellNext, px = this.px, pz = this.pz, vx = this.vx, vz = this.vz, size = this.size;
    for (let h = 0; h < this.sheets; h++) {
      const m = this.rimN[h], o = h * RIM * 4;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let a = 0; a < m; a++) { const x = R[o + a * 4], z = R[o + a * 4 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      const cx0 = Math.max(0, Math.floor((x0 - GX0) / CELL) - 1), cx1 = Math.min(GNX - 1, Math.floor((x1 - GX0) / CELL) + 1), cz0 = Math.max(0, Math.floor((z0 - GZ0) / CELL) - 1), cz1 = Math.min(GNZ - 1, Math.floor((z1 - GZ0) / CELL) + 1);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) for (let i = head[cz * GNX + cx]; i >= 0; i = next[i]) {
        const x = px[i], z = pz[i];
        if (x < x0 || x > x1 || z < z0 || z > z1) continue;
        // how far outside each side it is; inside the outline it is outside none, and the nearest side is the way out
        let best = -1e9, bn = 0, bz = 0, bv = 0;
        for (let a = 0; a < m; a++) {
          const r = o + a * 4, t = o + ((a + 1) % m) * 4, ex = R[t] - R[r], ez = R[t + 1] - R[r + 1], l = Math.sqrt(ex * ex + ez * ez) || 1e-6, nx = ez / l, nz = -ex / l, d = (x - R[r]) * nx + (z - R[r + 1]) * nz;
          if (d > best) { best = d; bn = nx; bz = nz; bv = (R[r + 2] + R[t + 2]) * 0.5 * nx + (R[r + 3] + R[t + 3]) * 0.5 * nz; if (d >= 0) break; }
        }
        if (best >= 0) continue;
        const go = Math.min(0.12, BOWL.radius * size[i] + 0.05 - best);
        px[i] = x + bn * go; pz[i] = z + bz * go;
        const vn = vx[i] * bn + vz[i] * bz, want = Math.max(0, bv) + 0.4;
        if (vn < want) { vx[i] += bn * (want - vn); vz[i] += bz * (want - vn); }
        this.spin[i] += (this.seed[i] - 0.5) * 0.6;
      }
    }
  }

  /** Where the candles are set down: clusters and gaps, more of them toward the walls, the dais and where she kneels. */
  scatter(want) {
    const arena = this.ctx.arena, sp = arena.spawn || {}, rnd = mulberry(0xca9d1e5), out = [];
    const xm = 12.0, z0 = this.zMin + 0.1, z1 = 20.0;
    const clear = [[sp.player, 1.4], [sp.boss, 2.7], [sp.kneel, 3.1], [sp.door, 1.4]].filter((c) => c[0]);
    const kn = sp.kneel || { x: 0, z: -13.5 };
    const density = (x, z) => {
      const edge = Math.min(xm - Math.abs(x), z - z0, z1 - z);
      const walls = Math.exp(-edge / 2.0), dais = Math.exp(-(z - z0) / 3.2);
      const dk = Math.hypot(x - kn.x, z - kn.z), ring = Math.exp(-((dk - 4.6) * (dk - 4.6)) / 5.0);
      const clumps = Math.pow(noise2(x * 0.3 + 7.3, z * 0.3 + 2.1), 2.0) * 1.9 + 0.35 * Math.pow(noise2(x * 0.9 + 31.7, z * 0.9 + 11.9), 3.0);
      const aisle = 0.6 + 0.4 * Math.min(1, Math.abs(x) / 4.5);         // the middle of the nave a little barer: her reflection lies there
      return (0.13 + 0.85 * walls + 0.5 * dais + 0.55 * ring) * (0.12 + clumps) * aisle;
    };
    for (let tries = 0; tries < 60000 && out.length < want; tries++) {
      const x = (rnd() * 2 - 1) * xm, z = z0 + rnd() * (z1 - z0);
      if (rnd() * 2.2 > density(x, z)) continue;
      let ok = true;
      for (const [c, r] of clear) if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < r * r) { ok = false; break; }
      for (let k = 0; ok && k < this.cols.length; k++) { const c = this.cols[k], r = c.r + 0.35; if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < r * r) ok = false; }
      for (let k = 0; ok && k < out.length; k++) { const dx = x - out[k].x, dz = z - out[k].z; if (dx * dx + dz * dz < 0.17) ok = false; }
      if (ok) out.push({ x, z });
    }
    return out;
  }

  /** Group the candles by where they were set down: each group can carry one of the renderer's candle lights. */
  makeClusters() {
    const n = this.floating, K = Math.min(CLUSTERS, Math.max(1, n)), cx = new Float32Array(K), cz = new Float32Array(K);
    const of = this.clusterOf = new Uint8Array(this.count);
    // start from candles far from each other, then a few rounds of k-means
    const d = new Float32Array(n).fill(FAR);
    let pick = 0;
    for (let k = 0; k < K && n; k++) {
      cx[k] = this.hx[pick]; cz[k] = this.hz[pick];
      let far = -1, fd = -1;
      for (let i = 0; i < n; i++) { const dd = (this.hx[i] - cx[k]) ** 2 + (this.hz[i] - cz[k]) ** 2; if (dd < d[i]) d[i] = dd; if (d[i] > fd) { fd = d[i]; far = i; } }
      pick = far;
    }
    const sx = new Float32Array(K), sz = new Float32Array(K), sn = new Float32Array(K);
    for (let round = 0; round < 8; round++) {
      sx.fill(0); sz.fill(0); sn.fill(0);
      for (let i = 0; i < n; i++) {
        let b = 0, bd = FAR;
        for (let k = 0; k < K; k++) { const dd = (this.hx[i] - cx[k]) ** 2 + (this.hz[i] - cz[k]) ** 2; if (dd < bd) { bd = dd; b = k; } }
        of[i] = b; sx[b] += this.hx[i]; sz[b] += this.hz[i]; sn[b]++;
      }
      for (let k = 0; k < K; k++) if (sn[k]) { cx[k] = sx[k] / sn[k]; cz[k] = sz[k] / sn[k]; }
    }
    for (let i = n; i < this.count; i++) {                               // candles on ledges join the nearest group
      let b = 0, bd = FAR;
      for (let k = 0; k < K; k++) { const dd = (this.hx[i] - cx[k]) ** 2 + (this.hz[i] - cz[k]) ** 2; if (dd < bd) { bd = dd; b = k; } }
      of[i] = b;
    }
    this.K = K; this.cB = new Float32Array(K); this.cX = new Float32Array(K); this.cZ = new Float32Array(K); this.cScore = new Float32Array(K); this.cUsed = new Int8Array(K).fill(-1);
  }

  /** Move the renderer's candle lights to the brightest groups near the fighters and the camera. */
  lights(dt, regroup) {
    const lights = this.ctx.gfx.lights, slots = this.slots; if (!slots.length || !lights || !lights.setCandle) return;
    const K = this.K, B = this.cB, X = this.cX, Z = this.cZ, score = this.cScore, used = this.cUsed, tune = this.tune;
    if (regroup) {
      B.fill(0); X.fill(0); Z.fill(0);
      for (let i = 0; i < this.count; i++) { const k = this.clusterOf[i], b = this.burn[i]; B[k] += b; X[k] += this.px[i] * b; Z[k] += this.pz[i] * b; }
      const ctx = this.ctx, p = ctx.player, bo = ctx.boss, cam = ctx.camera;
      // where the camera is looking, on the floor, but no farther than a dozen metres
      cam.getWorldDirection(_v); const reach = _v.y < -0.05 ? Math.min(12, (cam.position.y - WATER_Y) / -_v.y) : 12;
      const fx = cam.position.x + _v.x * reach, fz = cam.position.z + _v.z * reach;
      used.fill(-1); for (let s = 0; s < slots.length; s++) if (slots[s].c >= 0) used[slots[s].c] = s;
      for (let k = 0; k < K; k++) {
        if (B[k] < 0.05) { score[k] = 0; continue; }
        X[k] /= B[k]; Z[k] /= B[k];
        let near = 1 / (1 + ((X[k] - fx) ** 2 + (Z[k] - fz) ** 2) / 60);
        if (p) near = Math.max(near, 1.15 / (1 + ((X[k] - p.pos.x) ** 2 + (Z[k] - p.pos.z) ** 2) / 45));
        if (bo) near = Math.max(near, 0.8 / (1 + ((X[k] - bo.pos.x) ** 2 + (Z[k] - bo.pos.z) ** 2) / 60));
        score[k] = Math.pow(B[k], 0.7) * near * (used[k] >= 0 ? 1.4 : 1);   // a group that has a light keeps it unless clearly beaten
      }
      // the best groups, as many as there are lights: mark them by flipping the sign of their score
      for (let s = 0; s < slots.length; s++) {
        let b = -1, bs = 0;
        for (let k = 0; k < K; k++) if (score[k] > bs) { bs = score[k]; b = k; }
        if (b < 0) break;
        score[b] = -score[b];
      }
      // lights whose group dropped out fade; free lights take the chosen groups that have none
      for (let s = 0; s < slots.length; s++) {
        const sl = slots[s];
        if (sl.c >= 0 && score[sl.c] < 0) { sl.want = tune.light * Math.pow(B[sl.c], 0.75); continue; }
        sl.want = 0;
        if (sl.i < 0.03) {
          sl.c = -1;
          for (let k = 0; k < K; k++) if (score[k] < 0 && used[k] < 0) { used[k] = s; sl.c = k; sl.x = X[k]; sl.z = Z[k]; sl.i = 0; sl.want = tune.light * Math.pow(B[k], 0.75); break; }
        }
      }
    }
    const kp = 1 - Math.exp(-3 * dt), ki = 1 - Math.exp(-6 * dt);
    for (let s = 0; s < slots.length; s++) {
      const sl = slots[s];
      if (sl.c >= 0 && B[sl.c] > 0.05) { sl.x += (X[sl.c] - sl.x) * kp; sl.z += (Z[sl.c] - sl.z) * kp; }
      sl.i += (sl.want - sl.i) * ki; if (sl.i < 1e-3) sl.i = 0;
      lights.setCandle(s, sl.x, tune.lightY, sl.z, sl.i);
    }
  }

  update(dt) {
    const t0 = performance.now();
    const t = this.time += dt, n = this.count, nf = this.floating, ctx = this.ctx, water = ctx.water;
    this.uniforms.uTime.value = t;
    if (water && water.uniforms && water.uniforms !== this.waterU) this.link(water.uniforms);      // the water was replaced: the streaks follow the new one's rings
    if (water && water.tune && water.uniforms) this.uniforms.uRings.value = water.tune.rings;
    const px = this.px, pz = this.pz, vx = this.vx, vz = this.vz, size = this.size, seed = this.seed;

    // ---- everything solid at the water, and how fast it moves
    this.stepN++;
    this.gather(dt);
    const P = this.P, act = this.act, nAct = this.nAct, boss = ctx.boss;

    // ---- how each one burns
    let glow = 0, alight = 0, smoking = 0;
    for (let i = 0; i < n; i++) {
      // one a blow put out catches again by itself, in phase one
      if (this.back[i] < FAR && t >= this.back[i]) { this.back[i] = FAR; if (!this.on[i] && !(boss && boss.phase === 2)) this.set(i, 1, 0, true, 0, 0); }
      if (this.at[i] < FAR && t >= this.at[i]) {
        this.at[i] = FAR;
        if (this.on[i]) this.flare[i] = 1; else { this.ember[i] = 1; this.smoke[i] = 0; if (this.hissOn[i]) { this.hissOn[i] = 0; this.hiss(i); } }
      }
      const b = this.burn[i];
      if (this.on[i] && this.at[i] === FAR) { if (b < 1) this.burn[i] = Math.min(1, b + dt * (2.5 + 9 * b)); }
      else if (!this.on[i] && this.at[i] === FAR) { if (b > 0) this.burn[i] = Math.max(0, b - dt * 6.5); }
      if (this.flare[i] > 0) this.flare[i] = Math.max(0, this.flare[i] - dt * 3.2);
      if (this.ember[i] > 0) this.ember[i] = Math.max(0, this.ember[i] - dt * (0.7 + 0.6 * seed[i]));
      if (this.smoke[i] >= 0) { this.smoke[i] += dt; if (this.smoke[i] > SMOKE_LIFE) this.smoke[i] = -1; else smoking++; }
      glow += this.burn[i]; if (this.burn[i] > 0.004 || this.ember[i] > 0.004) alight++;
    }
    this.burning = n ? glow / n : 0; this.alight = alight; this.smoking = smoking;      // (with none alight or smoking, flames, streaks and smoke are not drawn at all)

    // ---- how each one floats
    const head = this.cellHead, next = this.cellNext; head.fill(-1);
    const drag = Math.exp(-1.15 * dt), airK = 1 - Math.exp(-7 * dt), zMin = this.zMin, zMax = this.zMax, xMax = this.xMax, cols = this.cols;
    for (let i = 0; i < nf; i++) {
      let x = px[i], z = pz[i], ax = 0, az = 0;
      const rB = BOWL.radius * size[i];
      // the water under it: height, and the shove of a strong ring
      let h = 0;
      if (water && water.sample) { water.sample(x, z, _s); h = _s.h; ax += _s.fx * 3.0; az += _s.fz * 3.0; }
      // it wanders a little round where it was set down
      const wx = this.hx[i] + 0.24 * Math.sin(t * (0.05 + 0.04 * seed[i]) + seed[i] * 50), wz = this.hz[i] + 0.24 * Math.cos(t * (0.043 + 0.05 * seed[i]) + seed[i] * 31);
      ax += (wx - x) * 0.022; az += (wz - z) * 0.022;
      // whatever is solid at the water: out of its way; and the air a fighter drags along (a flame leans from someone striding or rolling past)
      let tx = _s.fx * 0.5, tz = _s.fz * 0.5;
      for (let m = 0; m < nAct; m++) {
        const k = act[m], o = k * PW;
        if (x < P[o + 9] || x > P[o + 10] || z < P[o + 11] || z > P[o + 12]) continue;
        const ex = P[o + 2] - P[o], ez = P[o + 3] - P[o + 1], l2 = ex * ex + ez * ez;
        let u = l2 > 1e-8 ? ((x - P[o]) * ex + (z - P[o + 1]) * ez) / l2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x - (P[o] + ex * u), dz = z - (P[o + 1] + ez * u), d2 = dx * dx + dz * dz, R = P[o + 4] + rB, out = R + P[o + 5], air = out + P[o + 8];
        if (d2 >= air * air || dx * P[o + 14] + dz * P[o + 15] < 0) continue;        // too far, or on the side of it that is not its business
        const d = Math.sqrt(d2) || 1e-3, nx = dx / d, nz = dz / d, pvx = P[o + 6], pvz = P[o + 7], sp = P[o + 13];
        if (P[o + 8] > 0 && sp > 0.5) { const f = 1 - d / air, w = Math.min(1.4, sp * 0.22) * f * f; tx += (nx * 0.6 + pvx / sp * 0.4) * w; tz += (nz * 0.6 + pvz / sp * 0.4) * w; }
        if (d >= out) continue;
        if (d < R) {                                                     // touched: it is carried out of the way, a little faster than what touched it
          x += nx * (R - d); z += nz * (R - d);
          const vn = vx[i] * nx + vz[i] * nz, want = Math.max(0, pvx * nx + pvz * nz) + 0.35 + 0.25 * sp;
          if (vn < want) { vx[i] += nx * (want - vn); vz[i] += nz * (want - vn); }
          this.spin[i] += (seed[i] - 0.5) * (2 + sp) * dt * 12;
          // struck hard (a roll, her foot, a blade), it may go under for a moment: out, heard, and alight again by itself later
          if (sp > 3.6 && k < WAKE0 && this.on[i] && this.at[i] === FAR && this.rand() < 0.02 * sp) { this.set(i, 0, 0.04, true, nx, nz); this.back[i] = t + 3 + 4 * this.rand(); this.hissOn[i] = 1; }
        } else {                                                         // the water pushed ahead of it
          const k2 = 1 - (d - R) / P[o + 5]; ax += nx * k2 * k2 * (0.5 + 0.9 * sp); az += nz * k2 * k2 * (0.5 + 0.9 * sp);
        }
      }
      this.wx[i] += (tx - this.wx[i]) * airK; this.wz[i] += (tz - this.wz[i]) * airK;
      vx[i] = (vx[i] + ax * dt) * drag; vz[i] = (vz[i] + az * dt) * drag;
      x += vx[i] * dt; z += vz[i] * dt;
      // stones in the water, the dais, the walls
      for (let k = 0; k < cols.length; k++) {
        const c = cols[k], dx = x - c.x, dz = z - c.z, R = c.r + rB, d2 = dx * dx + dz * dz;
        if (d2 < R * R) { const d = Math.sqrt(d2) || 1e-3, nx = dx / d, nz = dz / d; x = c.x + nx * R; z = c.z + nz * R; const vn = vx[i] * nx + vz[i] * nz; if (vn < 0) { vx[i] -= 1.4 * vn * nx; vz[i] -= 1.4 * vn * nz; } }
      }
      if (x > xMax) { x = xMax; if (vx[i] > 0) vx[i] *= -0.4; } else if (x < -xMax) { x = -xMax; if (vx[i] < 0) vx[i] *= -0.4; }
      if (z > zMax) { z = zMax; if (vz[i] > 0) vz[i] *= -0.4; } else if (z < zMin) { z = zMin; if (vz[i] < 0) vz[i] *= -0.4; }
      // each other
      const gx = Math.min(GNX - 1, Math.max(0, Math.floor((x - GX0) / CELL))), gz = Math.min(GNZ - 1, Math.max(0, Math.floor((z - GZ0) / CELL)));
      for (let cz = gz > 0 ? gz - 1 : 0; cz <= gz + 1 && cz < GNZ; cz++) for (let cx = gx > 0 ? gx - 1 : 0; cx <= gx + 1 && cx < GNX; cx++) {
        for (let j = head[cz * GNX + cx]; j >= 0; j = next[j]) {
          const dx = x - px[j], dz = z - pz[j], R = rB + BOWL.radius * size[j], d2 = dx * dx + dz * dz;
          if (d2 < R * R && d2 > 1e-8) {
            const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, half = (R - d) * 0.5;
            x += nx * half; z += nz * half; px[j] -= nx * half; pz[j] -= nz * half;
            const rel = (vx[i] - vx[j]) * nx + (vz[i] - vz[j]) * nz;
            if (rel < 0) { const imp = rel * 0.6; vx[i] -= imp * nx; vz[i] -= imp * nz; vx[j] += imp * nx; vz[j] += imp * nz; }
          }
        }
      }
      next[i] = head[gz * GNX + gx]; head[gz * GNX + gx] = i;
      px[i] = x; pz[i] = z;
      this.yaw[i] += this.spin[i] * dt; this.spin[i] *= drag;
      // it rides the rings and rocks after them
      const dh = (h - this.lastH[i]) / dt; this.lastH[i] = h;
      this.rockV[i] += (-42 * this.rock[i] - 3.2 * this.rockV[i] + Math.max(-3, Math.min(3, dh)) * 5) * dt; this.rock[i] = Math.max(-0.09, Math.min(0.09, this.rock[i] + this.rockV[i] * dt));
      this.py[i] = WATER_Y + Math.max(-0.014 * size[i], Math.min(0.035 * size[i], h));        // as far as the bowl can ride without leaving the sheet or letting it in
    }

    if (this.sheets) this.uncover();
    this.write(dt);
    this.lights(dt, (this.lightTick++ & 3) === 0);
    this.cost.update += (performance.now() - t0 - this.cost.update) * 0.05;
  }

  /** Every candle's place and state, as the GPU wants them (once a step). Which mesh draws which bowl is prepare()'s business. */
  write(dt) {
    const n = this.count, nf = this.floating, t = this.time;
    const M = this.M, S = this.S;
    const P = this.aPos.array, Fl = this.aFlame.array, L = this.aLean.array, Sm = this.aSmoke.array;
    for (let i = 0; i < n; i++) {
      const s = this.size[i], sd = this.seed[i], floats = i < nf;
      // a small rocking: its own, and what the last ring left it
      let ta = 0, tb = 0;
      if (floats) {
        const r = this.rock[i];
        ta = 0.012 * Math.sin(t * (0.9 + sd) + sd * 20) + r * this.rockC[i]; tb = 0.012 * Math.cos(t * (0.8 + sd * 0.7) + sd * 9) + r * this.rockS[i];
      }
      const y = this.py[i] + (floats ? 0.0015 * Math.sin(t * 1.3 + sd * 20) : 0), c = Math.cos(this.yaw[i]), sn = Math.sin(this.yaw[i]);
      const x = this.px[i], z = this.pz[i], o = i * 16;
      M[o] = c * s; M[o + 1] = (tb * c + ta * sn) * s; M[o + 2] = -sn * s; M[o + 3] = 0;
      M[o + 4] = -tb * s; M[o + 5] = s; M[o + 6] = ta * s; M[o + 7] = 0;
      M[o + 8] = sn * s; M[o + 9] = (tb * sn - ta * c) * s; M[o + 10] = c * s; M[o + 11] = 0;
      M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
      const b = this.burn[i], q = i * 4;
      S[q] = b; S[q + 1] = this.ember[i]; S[q + 2] = this.wax[i]; S[q + 3] = sd;
      // the wick's tip, carried by the bowl
      const wy = wickY(this.wax[i]) * s, p3 = i * 3;
      P[p3] = x - tb * wy; P[p3 + 1] = y + wy; P[p3 + 2] = z + ta * wy;
      // the flame: how it burns, and which way it leans (away from its own motion; flat before the wind that kills it)
      let gust = 0;
      if (this.at[i] < FAR && !this.on[i]) gust = Math.max(0, 1 - (this.at[i] - t) / 0.28);
      else if (!this.on[i] && b > 0) gust = 1;
      Fl[q] = b; Fl[q + 1] = Math.max(this.flare[i], this.on[i] ? 0 : gust * 0.45 * b); Fl[q + 2] = this.ember[i];   // it gutters brighter as the wind takes it
      let lx = -this.vx[i] * 0.35 + this.wx[i] + this.gx[i] * gust * 0.85, lz = -this.vz[i] * 0.35 + this.wz[i] + this.gz[i] * gust * 0.85;
      const ll = Math.hypot(lx, lz); if (ll > 1.1) { lx *= 1.1 / ll; lz *= 1.1 / ll; }
      L[q] = lx; L[q + 1] = lz; L[q + 3] = gust;
      const sa = this.smoke[i];
      const sl = 0.16 * Math.min(1, sa * 0.6 + 0.4); Sm[q] = sa; Sm[q + 2] = (this.gx[i] + this.wx[i]) * sl; Sm[q + 3] = (this.gz[i] + this.wz[i]) * sl;
    }
    this.aPos.needsUpdate = true; this.aFlame.needsUpdate = true; this.aLean.needsUpdate = true; this.aSmoke.needsUpdate = true;
  }

  /**
   * What is drawn of every bowl in the frame about to be drawn with `cam`: nothing if the candle is outside the
   * camera's view; otherwise one of four meshes by how many pixels wide the bowl is in the picture (the sixteen
   * widest above tune.heroPx get the fine one). The mirror's simpler shapes are drawn from the same buffers, so they
   * follow. Called once a frame: by the water before its mirror pass, or else by the hook made in the constructor.
   * It only copies: a few hundred candles, a few hundredths of a millisecond.
   */
  prepare(cam) {
    if (this.disposed || (this.prepared && this.hooked)) return;
    this.prepared = true;
    const t0 = performance.now();
    const n = this.count, nf = this.floating, tune = this.tune, lod = this.lod, pxs = this.pxs, size = this.size, isHero = this.isHero, gfx = this.ctx.gfx;
    const all = !(tune.lod > 0), tHero = tune.heroPx, tNear = all ? 0 : tune.nearPx, tMid = all ? 0 : tune.midPx;
    cam.updateMatrixWorld();
    const cw = cam.matrixWorld.elements, camX = cw[12], camY = cw[13], camZ = cw[14];
    // the four sides of the camera's view, as planes (they are the same however depth is stored)
    const m = _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements, pl = this.planes;
    for (let k = 0; k < 4; k++) {
      const r = k >> 1, sg = k & 1 ? -1 : 1;
      const a = m[3] + sg * m[r], b = m[7] + sg * m[4 + r], c = m[11] + sg * m[8 + r], d = m[15] + sg * m[12 + r], l = 1 / (Math.hypot(a, b, c) || 1);
      pl[k * 4] = a * l; pl[k * 4 + 1] = b * l; pl[k * 4 + 2] = c * l; pl[k * 4 + 3] = d * l;
    }
    // a bowl of size 1, one metre away, is this many pixels wide in the picture the scene is drawn into
    const viewH = gfx && gfx.resolution ? gfx.resolution.y : gfx.renderer.getDrawingBufferSize(_size).y;
    const K = BOWL.radius * viewH * Math.abs(cam.projectionMatrix.elements[5]);

    // who is in view, how large, and the sixteen largest
    const heroOf = this.heroOf, heroPx = this.heroPx; let nh = 0, hidden = 0;
    for (let i = 0; i < n; i++) {
      const x = this.px[i], y = this.py[i], z = this.pz[i], s = size[i], r = 0.32 * s;
      if (!all && (pl[0] * x + pl[1] * y + pl[2] * z + pl[3] < -r || pl[4] * x + pl[5] * y + pl[6] * z + pl[7] < -r || pl[8] * x + pl[9] * y + pl[10] * z + pl[11] < -r || pl[12] * x + pl[13] * y + pl[14] * z + pl[15] < -r)) { pxs[i] = 0; lod[i] = 0; hidden++; continue; }
      const dx = x - camX, dy = y - camY, dz = z - camZ, w = s * K / Math.sqrt(dx * dx + dy * dy + dz * dz + 1e-6);
      pxs[i] = w;
      if (w > tHero * (lod[i] === 4 ? 0.92 : 1)) {
        let k = nh < HERO ? nh++ : (w > heroPx[HERO - 1] ? HERO - 1 : -1);
        if (k >= 0) { while (k > 0 && heroPx[k - 1] < w) { heroPx[k] = heroPx[k - 1]; heroOf[k] = heroOf[k - 1]; k--; } heroPx[k] = w; heroOf[k] = i; }
      }
    }
    isHero.fill(0); for (let k = 0; k < nh; k++) isHero[heroOf[k]] = 1;

    // deal them out. A candle changes level only when it is clearly past the line, so one sitting on it does not flicker.
    const Lv = this.levels, SM = this.M, SS = this.S, SL = this.Lk;
    Lv[1].n = Lv[2].n = Lv[3].n = Lv[4].n = 0;
    for (let i = 0; i < n; i++) {
      const w = pxs[i]; if (!(w > 0)) continue;
      const was = lod[i]; let lv;
      if (isHero[i]) lv = 4;
      else if (was === 1) lv = w > tNear * 0.9 ? 1 : w > tMid ? 2 : 3;
      else if (was === 2) lv = w > tNear * 1.1 ? 1 : w < tMid * 0.9 ? 3 : 2;
      else if (was === 3) lv = w > tMid * 1.1 ? (w > tNear ? 1 : 2) : 3;
      else lv = w > tNear ? 1 : w > tMid ? 2 : 3;
      lod[i] = lv;
      const v = Lv[lv], k = v.n++, o = k * 16, q = k * 4, so = i * 16, sq = i * 4, M = v.M, S = v.S, Lk = v.L;
      for (let c = 0; c < 16; c++) M[o + c] = SM[so + c];
      // the plainer levels have no lid: far off, a bowl is not let down far enough for the water's sheet to show inside it
      if (lv === 2 || lv === 3) { const low = WATER_Y + 0.001 * size[i]; if (i < nf && M[o + 13] < low) M[o + 13] = low; }
      S[q] = SS[sq]; S[q + 1] = SS[sq + 1]; S[q + 2] = SS[sq + 2]; S[q + 3] = SS[sq + 3];
      Lk[q] = SL[sq]; Lk[q + 1] = SL[sq + 1];
    }
    const D = this.drawn; D.triangles = 0; D.mirrorTriangles = 0; D.hidden = hidden;
    const off = this.benchHide;                                         // dev (the water's bench): 1 no bowls, 2 no streaks, 4 no flames
    // While the renderer warms up (gfx.warm draws two frames) everything goes through the renderer, drawn or not, so
    // that every program exists before play: a mesh left out here would compile on the frame it first shows.
    const warm = this.warming > 0; if (warm) this.warming--;
    this.glitter.visible = warm || (tune.glitter > 0 && !(off & 2) && this.alight > 0); this.flames.visible = warm || (!(off & 4) && this.alight > 0); this.smokes.visible = warm || (!(off & 4) && this.smoking > 0);
    for (let lv = 1; lv <= 4; lv++) {
      const v = Lv[lv], k = v.n, on = warm || (k > 0 && !(off & 1));
      v.mesh.count = k; v.mesh.visible = on;
      if (v.image) { v.image.count = k; v.image.visible = on; }
      if (v.lid) { v.lid.count = k; v.lid.visible = on; }
      D[v.name] = k; D.triangles += k * v.tris; D.mirrorTriangles += k * v.imageTris;
      if (!k) continue;
      // only what is drawn is sent to the graphics card
      const im = v.mesh.instanceMatrix;
      v.rM.count = k * 16; im.updateRanges.length = 0; im.updateRanges.push(v.rM); im.needsUpdate = true;
      v.rS.count = k * 4; v.aState.updateRanges.length = 0; v.aState.updateRanges.push(v.rS); v.aState.needsUpdate = true;
      v.rL.count = k * 4; v.aLook.updateRanges.length = 0; v.aLook.updateRanges.push(v.rL); v.aLook.needsUpdate = true;
    }
    this.cost.prepare += (performance.now() - t0 - this.cost.prepare) * 0.05;
  }

  dispose() {
    this.disposed = true;
    if (typeof this.unhook === 'function') this.unhook();
    for (const [name, fn] of this.listeners) this.ctx.bus.off(name, fn);
    const lights = this.ctx.gfx.lights;
    if (lights && lights.setCandle) for (let s = 0; s < this.slots.length; s++) lights.setCandle(s, 0, 0, 0, 0);
    this.ctx.scene.remove(this.group);
    for (let lv = 1; lv <= 4; lv++) {
      const v = this.levels[lv];
      for (const mesh of [v.mesh, v.image, v.lid]) if (mesh) { mesh.geometry.dispose(); mesh.dispose(); }
    }
    this.bowlMat.dispose(); this.lidMat.dispose();
    this.flames.geometry.dispose(); this.flames.material.dispose(); this.smokes.geometry.dispose(); this.smokes.material.dispose();
    this.glitter.geometry.dispose(); this.glitter.material.dispose(); if (this.blank) this.blank.dispose();
  }
}
