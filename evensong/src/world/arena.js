// The place: the Drowned Choir. A ruined gothic cathedral, roofless, its nave under a few centimetres of water.
// The kit is modelled by script in Blender (tools/kit/*.py -> assets/models/arena/*.glb) and put together here.
// The contract's surface is docs/engine.md, "Arena"; what this module offers beyond it is in docs/modules/world.md.
//
//   src/world/layout.js     the measurements and what stands where
//   src/world/build.js      placing and merging the kit
//   src/world/materials.js  stone, floor, wood, pipes
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { Kit, Builder, rng } from './build.js';
import { makeMaterials, TEXTURES } from './materials.js';
import * as L from './layout.js';

export { WATER_Y };

const M = 'assets/models/arena/';
// Only files that exist are listed (a missing file is a page error in every picture): add a line when a kit file lands.
export const ASSETS = {
  'arena.bay': M + 'bay.glb',
  'arena.east': M + 'east.glb',
  'arena.organ': M + 'organ.glb',
  'arena.west': M + 'west.glb',
  'arena.props': M + 'props.glb',
  'arena.statues': M + 'statues.glb',
  ...TEXTURES,
};

const _p = new THREE.Vector3();
const side = (s) => (s === 's' ? 1 : -1);
// Only the masses throw shadows (walls and pier shafts are ashlar); mouldings, shafts and tracery ride on them and
// would add nothing but triangles to the shadow pass. The rose window's tracery is the exception (see eastEnd).
const MASS = ['ashlar'];
// ... and of most pieces only the masses are drawn in the water's mirror (build.js, "The mirror"): the reflection is
// dark and rippled, and it is the frame's dearest pass. Whole in the mirror: piers, the east wall with the rose, the
// organ, the dais, the doors, the fallen head and whatever lies in the play area.
const MIRROR = MASS;

export class Arena {
  constructor(ctx) {
    this.ctx = ctx;
    // ---- the contract
    this.bounds = { ...L.BOUNDS };
    this.colliders = L.COLLIDERS.map((c) => ({ ...c }));
    this.spawn = JSON.parse(JSON.stringify(L.SPAWN));
    this.dais = { z: L.DAIS.z, top: L.DAIS.top, step: L.DAIS.step, rise: L.DAIS.rise };
    this.organ = { x: 0, z: -22 };
    this.window = { x: 0, y: 15, z: L.EAST_Z, r: 5 };
    // The moon stands on the nave's axis, low in the east: from the pilgrim's first steps it hangs in the upper
    // half of the rose window, from mid-nave in the lower half.
    this.moonDir = new THREE.Vector3(0, 13.3, -35.5).normalize();
    // ---- beyond the contract
    this.ledges = [];                         // { x, y, z }: dry places where a candle can stand
    this.waterY = WATER_Y;                    // the water's surface (the camera and the blades ask for it)
    this.water = { x0: -30, x1: 30, z0: -40, z1: 46 };       // what the water's sheet must cover: on through the porch to the mist beyond it
    this.piers = [];                          // { x, z }: the sixteen piers of the arcades
    this.time = 0;

    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const kit = this.kit = new Kit();
    for (const name of ['arena.bay', 'arena.east', 'arena.organ', 'arena.west', 'arena.props', 'arena.statues']) if (ctx.assets.has(name)) kit.add(ctx.assets.gltf(name));
    this.materials = makeMaterials(ctx);
    this.group = new THREE.Group(); this.group.name = 'arena';
    // Which things become one mesh (build.js): the masses and the mouldings stay apart by stretch (east end, nave, west
    // end: the camera skips the end that is behind it); everything small (statues, ivy, rubble, rib stumps, the far
    // ruins) and every material that is only in one place is one mesh for the whole building.
    const bucket = (zone, mat, cast, mirror) => {
      if (zone === 'head' || zone === 'floor' || zone === 'sea') return zone;
      if (mat === 'ashlar') return mirror ? zone : 'all';
      if (mat === 'plain') return cast && !mirror ? 'all' : zone;
      return 'all';
    };
    const b = this.builder = new Builder(kit, { bucket, shade: (x, y, z) => this.shade(x, y, z), light: (zone, x, y, z, nx, ny, nz, out) => this.light(zone, x, y, z, nx, ny, nz, out) });
    this.floor(b);
    this.nave(b);
    this.aisles(b);
    this.eastEnd(b);
    this.westEnd(b);
    this.beyond(b);
    this.fallen(b);
    this.figures(b);
    this.rubble(b);
    this.ivy(b);
    this.ledges = this.orderLedges(b.anchored('ledge'));
    this.lamps = this.makeLamps();
    b.build(this.materials, this.group);
    this.stats = { pieces: b.count, triangles: Math.round(b.triangles), meshes: this.group.children.length };
    this.chandeliers();
    this.stats.buildMs = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0);
    ctx.scene.add(this.group);
    if (ctx.params && ctx.params.has('worldstats')) {            // &worldstats: what the place is made of, sent to the picture tool -> .shots/world_stats.json
      const meshes = {}; let triangles = 0, shadow = 0;
      this.group.traverse((o) => { if (o.isMesh) { const n = o.geometry.index.count / 3; triangles += n; if (o.castShadow) shadow += n; meshes[o.name] = (meshes[o.name] || 0) + n; } });
      fetch('/__shot/world_stats.json', { method: 'POST', body: JSON.stringify({ buildMs: this.stats.buildMs, pieces: b.count, meshes: Object.keys(meshes).length + this.swing.length * 2 - Math.min(2, this.swing.length * 2), triangles, shadowCasters: shadow, ledges: this.ledges.length, byMesh: meshes }, null, 1) }).catch(() => {});
    }
  }

  /** Large-scale darkness the kit's own baked light cannot know about: the aisles lie deeper in shadow than the nave. */
  shade(x, y, z) {
    const ax = Math.abs(x);
    const aisle = THREE.MathUtils.smoothstep(ax, 12.6, 15.5);
    let s = 1 - 0.22 * aisle * (1 - THREE.MathUtils.smoothstep(y, 9, 15));
    // The back of the fallen head lies in the one beam of moonlight on the north side and shone like a lamp when
    // seen from the east: its weathered back is darker stone than its face.
    const hx = x - L.FACE.x, hz = z - L.FACE.z;
    if (y < 3.6 && hx * hx + hz * hz < 5.3) s *= 1 - 0.66 * THREE.MathUtils.smoothstep(-hz, -0.55, 0.8);
    // The west wall above the portal is the largest plain surface of the building and the moon strikes it head on:
    // from the east it was a pale sheet behind whoever stood before it (the Cantor is ivory). Its upper stone is
    // darker, weathered stone, darkest at the top.
    if (z > 20.4 && y > 6) s *= 1 - 0.46 * THREE.MathUtils.smoothstep(y, 6, 12.5);
    return s;
  }

  /** Where a thing stands: the east end, the west end, or the nave between (the baked light and the merging go by it). */
  zone(x, z) { return z < -14 ? 'e' : z > 14 ? 'w' : 'c'; }

  /**
   * Dry places where a candle can stand, the best first (the candles owner stands one on each of the first eighty):
   * the dais and the organ, the threshold, the fallen head and the heap of stones, then the nave side of every
   * pier's plinth, then whatever is left (the far sides of the plinths, the benches in the aisles).
   */
  orderLedges(anchors) {
    const rank = (a) => {
      if (a.piece === 'organ') return 0;
      if (a.piece === 'dais') return 1;
      if (a.piece.startsWith('west')) return 2;
      if (a.piece === 'face' || a.piece === 'block_pile') return 3;
      if (a.piece === 'pier') return Math.abs(a.pos.x) < L.PIER_X - 0.2 ? 4 : 6;
      return 7;
    };
    const list = anchors.map((a, i) => ({ x: a.pos.x, y: a.pos.y, z: a.pos.z, rank: rank(a), i }));
    // within a rank: spread along the nave rather than pier by pier (so a short list still reaches both ends)
    const r = rng(4242); for (const l of list) l.k = l.rank + r() * 0.999;
    list.sort((p, q) => p.k - q.k || p.i - q.i);
    return list.map(({ x, y, z }) => ({ x, y, z }));
  }

  /**
   * The lamps behind the baked light (build.js, `wdLit`): [x, y, z, strength, kind] five numbers each. Kind 0 is
   * candlelight: the field of floating candles as a grid of lamps just over the water (380 flames of about a third
   * of a candela each), and one for each candle that stands on a ledge at either end of the hall. Kind 1 is the
   * organ's own glow in phase two: lamps at the mouths of its pipes.
   */
  makeLamps() {
    const out = [], per = 380 * 0.35 / 45;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 9; j++) out.push(-8.8 + i * 4.4, 0.25, -15 + j * 3.75, per, 0);
    for (const l of this.ledges.slice(0, 80)) if (l.z < -17 || l.z > 19) out.push(l.x, l.y + 0.12, l.z, 0.5, 0);
    this.organAt = out.length;                                                 // from here on: the organ's lamps
    for (const sx of [1, -1]) {
      out.push(sx * 8, 6.2, -18.3, 9, 1, sx * 8, 11.5, -18.0, 7, 1);          // the towers' mouths, and their bodies higher up
      for (const x of [3, 4.6]) out.push(sx * x, 5.6, -19.6, 2.2, 1);           // the flats
      out.push(sx * 1.1, 5.4, -19.6, 1.4, 1);
    }
    return new Float32Array(out);
  }

  /** Light the game's own lamps cannot give (see build.js): candlelight on the two ends of the hall, the organ's glow. */
  light(zone, x, y, z, nx, ny, nz, out) {
    // how much of the candlelight a place takes: the organ and the choir in full; the west wall less, dying with
    // height (a great flat wall under an even wash looks painted); the porch only what comes in through the doorway
    // The arcades (zone 'arcade': every pier, the wall over it and what rides on it, from end to end of the nave)
    // take NO baked candlelight: the renderer's own candle light reaches all of them alike. (They used to take it by
    // where they stood: the end piers at z = +-19 and the bays beside them were lit to their tops and their
    // neighbours were not.) The organ's glow is another matter: it reaches whatever is near the organ, as far as it
    // reaches, wherever that stands.
    let share = 0;
    if (zone === 'e' || zone === 'organ') share = 1;
    else if (zone === 'w') share = z > 22.9 && Math.abs(x) < 5.4 ? 0.8 * Math.exp(-(z - 21.5) * 0.3) : 0.62 * Math.exp(-Math.max(0, y - 1) / 3.4);
    else if (zone === 'head') share = 0.5;
    const organ = z < 4;                                                               // (beyond that the organ's glow is nothing)
    if (share <= 0 && !organ) return false;
    const P = this.lamps, n0 = share > 0 ? 0 : this.organAt;                           // the organ's lamps are the last of the list
    let c = 0, g = 0;
    for (let i = n0; i < P.length; i += 5) {
      const dx = P[i] - x, dy = P[i + 1] - y, dz = P[i + 2] - z, d2 = dx * dx + dy * dy + dz * dz + 0.3;
      const cos = ((nx * dx + ny * dy + nz * dz) / Math.sqrt(d2) + 0.25) / 1.25;        // a little light creeps round the corner
      if (cos <= 0) continue;
      if (P[i + 4]) g += P[i + 3] * cos / d2; else c += P[i + 3] * cos / d2;
    }
    out[0] = c * share; out[1] = organ ? g : 0;
    return out[0] > 0.002 || out[1] > 0.002;
  }

  floor(b) {
    // one sheet of flagstones under the whole building (the water lies over it), uvs in metres
    const x0 = -21, x1 = 21, z0 = -27, z1 = 23.4, nx = 14, nz = 17;
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz); g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const P = g.attributes.position, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) U.setXY(i, P.getX(i), -P.getZ(i));
    b.addGeometry(g, new THREE.Matrix4(), { mat: 'floor', zone: 'floor', cast: false, shade: false, mirror: false });      // (under the water: never in its mirror)
    // ... and on through the porch beyond the doors (the same water lies over it)
    const pf = new THREE.PlaneGeometry(8.8, 9.3, 2, 3); pf.rotateX(-Math.PI / 2); pf.translate(0, 0, z1 + 4.65);
    const PP = pf.attributes.position, PU = pf.attributes.uv;
    for (let i = 0; i < PP.count; i++) PU.setXY(i, PP.getX(i), -PP.getZ(i));
    b.addGeometry(pf, new THREE.Matrix4(), { mat: 'floor', zone: 'floor', cast: false, shade: false, mirror: false });
    // Outside the walls the sea has taken everything: one dark sheet round the building, out to where the air hides it
    // (a frame of four slabs, so nothing lies under the church's own floor).
    const far = 420, y = -0.05, I = new THREE.Matrix4();
    const slab = (ax, az, bx, bz) => { const q = new THREE.PlaneGeometry(bx - ax, bz - az, 1, 1); q.rotateX(-Math.PI / 2); q.translate((ax + bx) / 2, y, (az + bz) / 2); b.addGeometry(q, I, { mat: 'sea', zone: 'sea', cast: false, receive: false, shade: false, mirror: false }); };
    slab(-far, -far, far, z0); slab(-far, z1 + 9.4, far, far); slab(-far, z0, x0, z1 + 9.4); slab(x1, z0, far, z1 + 9.4);
    slab(x0, z1, -5.4, z1 + 9.4); slab(5.4, z1, x1, z1 + 9.4);          // either side of the porch
  }

  nave(b) {
    for (const sd of ['s', 'n']) {
      const sx = side(sd), x = sx * L.PIER_X, states = L.NAVE[sd].map((code) => ({ ...L.STATES[code.replace('~', '')], turn: code.endsWith('~') }));
      // the wall, bay by bay
      states.forEach((st, i) => {
        const z = L.BAY_Z[i];
        for (const name of st.stack) b.place(name, { x, z, sx, sz: st.turn ? -1 : 1 }, { zone: this.zone(x, z), lit: 'arcade', cast: MASS, mirror: MIRROR });
      });
      // the piers and what rides on them
      for (let j = 0; j < 8; j++) {
        const z = L.PIER_Z[j], zone = this.zone(x, z);
        this.piers.push({ x, z });
        b.place('pier', { x, z, sx }, { zone, lit: 'arcade', cast: MASS });
        const bayE = j > 0 ? states[j - 1] : null, bayW = j < 7 ? states[j] : null;       // the bays east and west of pier j
        // how high the wall still stands at this pier: the west end of the bay to its east, the east end of the bay to its west
        const lvl = Math.max(bayE ? (bayE.turn ? bayE.e : bayE.w) : 0, bayW ? (bayW.turn ? bayW.w : bayW.e) : 0, j === 0 || j === 7 ? 3 : 0);
        const up = { zone, lit: 'arcade', cast: false, mirror: false };          // what rides on the piers above the arcade: thin, high, not in the mirror
        if (lvl >= 1) b.place('vshaft_a', { x, z, sx }, up); else b.place('vshaft_a_broken', { x, z, sx, sz: j % 2 ? -1 : 1 }, up);
        if (lvl >= 2) b.place('vshaft_b', { x, z, sx }, up); else if (lvl >= 1) b.place('vshaft_b_broken', { x, z, sx, sz: j % 2 ? 1 : -1 }, up);
        if (lvl >= 3) {
          b.place('vshaft_c', { x, z, sx }, up);
          if (!L.RIBS.whole.includes(j)) b.place(L.RIBS.long[sd].includes(j) ? (j % 2 ? 'springer_b' : 'springer_a') : 'springer_c', { x, z, sx, sz: j > 3 ? -1 : 1 }, { zone, lit: 'arcade', mirror: false });
        }
      }
    }
    for (const j of L.RIBS.whole) b.place('rib_full', { x: 0, z: L.PIER_Z[j] }, { zone: this.zone(0, L.PIER_Z[j]), mirror: false });
  }

  aisles(b) {
    for (const sd of ['s', 'n']) {
      const sx = side(sd), x = sx * L.PIER_X, A = L.AISLE[sd];
      A.wall.forEach((code, i) => {
        const z = L.BAY_Z[i], turn = code.endsWith('~');
        b.place('aisle_' + code.replace('~', ''), { x, z, sx, sz: turn ? -1 : 1 }, { zone: this.zone(x, z), tint: 0.92, cast: MASS, mirror: MIRROR });
      });
      A.arch.forEach((code, j) => {
        const z = L.PIER_Z[j], zone = this.zone(x, z);
        const lowWall = (i) => i >= 0 && i < 7 && A.wall[i].startsWith('low');
        if (!(lowWall(j - 1) && lowWall(j))) b.place('respond', { x, z, sx }, { zone, tint: 0.92, cast: false, mirror: false });
        if (code) b.place(code === 'full' ? 'aisle_arch' : 'aisle_arch_broken', { x, z, sx }, { zone, tint: 0.95, cast: MASS, mirror: MIRROR });
      });
    }
  }

  /** The choir: one more bay beyond the easternmost piers, the dais, the east wall with the rose window, the aisles' ends. */
  eastEnd(b) {
    const zc = L.PIER_Z[0] - L.BAY / 2, zp = L.PIER_Z[0] - L.BAY, zone = 'e';
    for (const sx of [1, -1]) {
      const x = sx * L.PIER_X;
      for (const name of ['arcade_full', 'trif_full', sx > 0 ? 'clere_full' : 'clere_bare']) b.place(name, { x, z: zc, sx }, { zone, cast: MASS, mirror: MIRROR });
      for (const name of ['pier', 'vshaft_a', 'vshaft_b', 'vshaft_c', 'springer_c']) b.place(name, { x, z: zp, sx }, { zone, cast: name === 'pier' ? MASS : false, mirror: name === 'pier' });      // half buried in the east wall
      b.place('aisle_full', { x, z: zc, sx }, { zone, tint: 0.92, cast: MASS, mirror: MIRROR });
      b.place('respond', { x, z: zp, sx }, { zone, tint: 0.92, cast: false, mirror: false });
      b.place('aisle_arch', { x, z: zp, sx }, { zone, tint: 0.95, cast: MASS, mirror: MIRROR });
      if (this.kit.has('east_aisle')) b.place(sx > 0 ? 'east_aisle' : 'east_aisle_ruin', { sx }, { zone, tint: 0.92, cast: MASS, mirror: MIRROR });
    }
    if (this.kit.has('dais')) b.place('dais', {}, { zone, cast: false, vary: 0 });
    if (this.kit.has('east_wall')) b.place('east_wall', {}, { zone, vary: 0 });
    // the great organ stands wholly in the east wall's shadow and under the window's light: it casts nothing that is seen
    if (this.kit.has('organ')) b.place('organ', {}, { zone: 'organ', cast: false, vary: 0 });
    if (this.kit.has('organ_fallen')) b.place('organ_fallen', {}, { zone: 'organ', cast: false, vary: 0 });
    // ... except that the whole south tower stands in front of the south lancet and must stop its light; one unseen
    // slab does that. (The north tower has lost pipes: the north lancet's beam gets through, down the north side of
    // the nave, and finds the fallen head.)
    const slab = new THREE.BoxGeometry(4.3, 13.2, 0.3); slab.translate(8.0, 11.0, -22.3);
    b.addGeometry(slab, new THREE.Matrix4(), { mat: 'blocker', zone: 'organ', cast: true, receive: false, shade: false, mirror: false });
  }

  /**
   * The west front: the wall with the great portal and the west window, the vaulted porch beyond (its floor level
   * with the nave's, under the same water), the doors standing open, and the night's mist seen through the outer arch.
   */
  westEnd(b) {
    const zone = 'w';
    if (!this.kit.has('west_wall')) return;
    b.place('west_wall', {}, { zone, vary: 0, tint: 0.8, cast: false, mirror: MIRROR });        // its shadow falls outside the church
    b.place('west_porch', {}, { zone, vary: 0, tint: 0.5, cast: false, mirror: MIRROR });   // no moon reaches the porch: it lives on what comes through its two arches
    // the two leaves hang on the doorway's jambs and stand open into the nave (the north one thrown right back)
    b.place('door_leaf', { x: -2.77, y: 0.02, z: L.WEST_Z - 0.75, ry: THREE.MathUtils.degToRad(104) }, { zone, tint: 0.72, cast: false });
    b.place('door_leaf', { x: 2.77, y: 0.02, z: L.WEST_Z - 0.75, ry: THREE.MathUtils.degToRad(-76), sx: -1 }, { zone, tint: 0.72, cast: false });
    // the aisles' west ends: the east end's pieces, turned round
    if (this.kit.has('east_aisle')) {
      const tz = (L.WEST_Z + 0.35) + L.EAST_Z;
      b.place('east_aisle', { z: tz, ry: Math.PI }, { zone, tint: 0.92, cast: false, mirror: MIRROR });
      b.place('east_aisle_ruin', { z: tz, ry: Math.PI, sx: -1 }, { zone, tint: 0.92, cast: false, mirror: MIRROR });
    }
    // Beyond the porch's outer arch: mist over the sea with the moon on it, far off. One sheet that holds its own
    // light (palest at the water, gone by the height of the arch), so whoever stands in the doorway is a shape
    // against it. It is what "darkness and mist beyond" is made of; the air in front of it does the rest.
    const x0 = -26, x1 = 26, y0 = -0.4, y1 = 20, nx = 26, ny = 20, zc = 46;
    const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0, nx, ny); g.rotateY(Math.PI); g.translate(0, (y0 + y1) / 2, zc);
    const P = g.attributes.position, col = new Float32Array(P.count * 4);
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i);
      let k = Math.exp(-Math.max(0, y) / 4.6) * Math.exp(-(x * x) / 260) * (1 - THREE.MathUtils.smoothstep(y, 13, 20));
      k *= 0.86 + 0.14 * Math.sin(x * 0.27 + 0.7) + 0.12 * Math.sin(y * 1.45 + x * 0.33 + 1.9) * Math.exp(-y / 6);       // banks of it, not a clean gradient
      col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = Math.max(0, k); col[i * 4 + 3] = 1;        // the material holds the colour
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    b.addGeometry(g, new THREE.Matrix4(), { mat: 'mist', zone, cast: false, receive: false, shade: false, raw: true });
    // and two columns of what stood before the west front, still upright in the sea: shapes in the mist, to the
    // south of the line the pilgrim walks in on (so his own shape stays clear of them in the opening's doors shot).
    // (The kit's "respond" stands 6.48 m out from its own origin along x: the places below are the columns' own.)
    if (this.kit.has('respond')) {
      const column = (cx, cz, base, sc, rz) => b.place('respond', { x: cx - 6.48 * sc * Math.cos(rz), y: base - 6.48 * sc * Math.sin(rz), z: cz, s: sc, rz }, { zone, tint: 0.3, vary: 0, cast: false, shade: false });
      column(1.9, 37.2, -4.4, 0.8, -0.09);          // a stump: three metres of it stand out of the water
      column(0.2, 42.0, -0.7, 0.92, 0.05);          // a whole one further out
    }
  }

  /**
   * Beyond the walls: what is left of the rest of the abbey, standing in the sea. Pieces of the same kit, bigger and
   * far off, so the air turns them into silhouettes: seen over the broken aisle walls and through their windows.
   * Nothing stands behind the rose window (that sky belongs to the moon).
   */
  beyond(b) {
    const far = [
      // north of the church
      ['rib_full', -62, -19, 6, 0.5, 1.0], ['aisle_gap', -48, 0, 14, 1.9, 1.7], ['arcade_ruin_a', -72, -9.3 * 2.0 + 14, -24, 0.25, 2.0], ['trif_down', -72, -9.3 * 2.0 + 14, -24, 0.25, 2.0],
      ['arcade_ruin_b', -70, -9.3 * 2.2 + 9, -40, 0.2, 2.2], ['respond', -41, 0, -14, 1.2, 1.5], ['respond', -44, 0, -5, 0.3, 1.3], ['aisle_low', -55, 0, 30, 2.4, 2.0],
      ['respond', -38, 0, 22, 2.0, 1.2],
      // south of it
      ['rib_full', 74, -19, -12, -0.9, 1.25], ['aisle_down', 46, 0, -8, -1.5, 1.8], ['aisle_gap', 58, 0, 18, -1.9, 2.1], ['arcade_ruin_b', 86, -9.3 * 2.4 + 16, 26, 2.7, 2.4],
      ['trif_low', 86, -9.3 * 2.4 + 16, 26, 2.7, 2.4], ['respond', 40, 0, 6, 0.7, 1.4], ['respond', 43, 0, 30, 2.9, 1.6], ['aisle_arch_broken', 52, -9.3 * 1.6 + 2, -26, 0.4, 1.6],
      ['aisle_full', 66, 0, 44, 2.2, 1.8],
    ];
    // (shapes in the haze: of each piece only its mass, where it has one; and never in the mirror)
    for (const [name, x, y, z, ry, sc] of far) if (this.kit.has(name)) b.place(name, { x, y, z, ry, s: sc }, { zone: 'far', mat: 'ashlar', cast: false, tint: 0.36, vary: 0.05, shade: false, only: MASS, mirror: false });
  }

  /** What lies in the play area (each is a collider in layout.js): the toppled pier's drums, the heap of vault stones. */
  fallen(b) {
    if (!this.kit.has('drum_a')) return;
    const c = L.COLUMN, dir = Math.atan2(-(c[2].z - c[0].z), c[2].x - c[0].x);       // the drums' own axis is +x: from the wall toward the middle
    // [piece, turned about its own axis, turned on the floor away from the shaft's line, sunk (m), tipped end over end]
    const drums = [['drum_a', 0.5, 0.06, 0.02, 0, 0], ['drum_b', 2.3, -0.09, -0.05, 0, 0], ['drum_c', 4.0, L.CAPITAL.yaw, L.CAPITAL.sink, L.CAPITAL.tip, L.CAPITAL.along]];
    // Each drum lies on its side where it fell and is turned about ITS OWN axis (a line along its x through its
    // middle, 0.98 m above its underside), so that each shows another side of the pier. (They used to be turned about
    // the line they lie on: the second and third swung down through the floor, and only a sliver and a tilted capital
    // stood out of the water, a metre away from the colliders.) The third drum lies turned end for end, its capital
    // against the second drum and its broken shaft toward the nave: the capital's flat bed is a blank disc 2.9 m
    // across, and the other way round it faced the fight.
    const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z), along = new THREE.Vector3(Math.cos(dir), 0, -Math.sin(dir));
    drums.forEach(([name, roll, yaw, sink, tip, more], i) => {
      const m = T(c[i].x + along.x * more, -0.1 + sink, c[i].z + along.z * more).multiply(new THREE.Matrix4().makeRotationY(dir + yaw)).multiply(T(0, L.DRUM_AXIS, 0)).multiply(new THREE.Matrix4().makeRotationZ(tip)).multiply(new THREE.Matrix4().makeRotationX(roll)).multiply(T(0, -L.DRUM_AXIS, 0));
      b.place(name, m, { zone: this.zone(c[i].x, c[i].z), vary: 0.05, cast: false });
    });
    const k = L.BLOCKS;
    b.place('block_pile', { x: k.x, z: k.z, ry: 0.7 }, { zone: this.zone(k.x, k.z), cast: false });
    b.place('rib_piece', { x: k.x - 1.9, y: -0.02, z: k.z + 1.2, ry: 2.1 }, { zone: this.zone(k.x, k.z), cast: false });
  }

  /** The great fallen head (a collider) and the statues in their niches: aisle walls, the organ's case, beside the doors. */
  figures(b) {
    if (!this.kit.has('face')) return;
    const f = L.FACE;
    b.place('face', { x: f.x, z: f.z, ry: f.yaw }, { zone: 'head', vary: 0, tint: 0.8, cast: false });           // its own zone: it takes baked candlelight (the face looks at the candles; the moon's beam only finds the back of the head)       // the moon's light never reaches the sides of the nave
    const kinds = ['statue_angel', 'statue_chorister'].filter((k) => this.kit.has(k));
    if (!kinds.length) return;
    const r = rng(77), m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), e = new THREE.Euler();
    let n = 0;
    for (const a of b.anchored('niche').slice()) {
      let kind = kinds[n % kinds.length], scale = 1, cast = false;
      if (a.piece.startsWith('aisle_')) {                           // out of the wall, as the wall piece itself was placed
        if (r() < 0.22) continue;                                   // some niches stand empty
        if (this.kit.has(kind + '_far')) kind += '_far';            // never seen close: the lighter model
        m.copy(a.matrix).setPosition(a.pos);
      } else {
        const organ = a.piece === 'organ';
        kind = organ ? kinds[0] : kinds[kinds.length - 1];
        scale = organ ? 1.12 : 1.5;
        m.compose(a.pos, q.setFromEuler(e.set(0, organ ? Math.PI / 2 : -Math.PI / 2, 0)), sc.set(scale, scale, scale));
      }
      b.place(kind, m, { zone: this.zone(a.pos.x, a.pos.z), cast, vary: 0.04, mirror: false });
      n++;
    }
  }

  /** Stones at the feet of the walls and under the broken bays: never where a fighter can walk. */
  rubble(b) {
    if (!this.kit.has('rubble_a')) return;
    const r = rng(2011), names = ['rubble_a', 'rubble_b', 'rubble_c', 'rubble_a', 'rubble_c', 'block_c'];
    const drop = (x, z, name, o = {}) => {
      if (this.clear(x, z, 0.75)) return;                           // inside the play area and not against a collider: leave it clear
      if (Math.abs(x) > L.AISLE_FACE - 0.4 || z < -24 || z > 20.4) return;
      b.place(name || names[Math.floor(r() * names.length)], { x, y: this.ground(x, z) - 0.03, z, ry: r() * 6.283, s: o.s || 0.8 + r() * 0.5 }, { zone: this.zone(x, z), cast: false, vary: 0.12, mirror: false });
    };
    for (const sd of ['s', 'n']) {
      const sx = side(sd);
      // round every pier, on its far side
      for (const z of L.PIER_Z) for (let i = 0; i < 2; i++) { const a = (r() - 0.5) * 2.4; drop(sx * (L.PIER_X + Math.cos(a) * (1.9 + r() * 0.9)), z + Math.sin(a) * (1.9 + r() * 0.9)); }
      // under what fell: the broken bays of the arcade and of the aisle wall
      L.NAVE[sd].forEach((code, i) => {
        const broken = /^(R|Rb|H|X|Tl|Td)/.test(code) ? (/^(H|X)/.test(code) ? 7 : 4) : 1;
        for (let k = 0; k < broken; k++) drop(sx * (L.PIER_X + (r() - 0.35) * 3.2), L.BAY_Z[i] + (r() - 0.5) * 4.2, k === 0 && broken > 4 ? 'block_a' : k === 1 && broken > 3 ? 'block_b' : null);
      });
      L.AISLE[sd].wall.forEach((code, i) => {
        const n = /low|down|gap/.test(code) ? 5 : 2;
        for (let k = 0; k < n; k++) drop(sx * (L.AISLE_FACE - 0.5 - r() * 2.2), L.BAY_Z[i] + (r() - 0.5) * 5, k === 0 && n > 2 ? 'block_b' : null);
      });
    }
    // in the corners the play area leaves, and round what fell into it
    for (const [x, z] of [[10.2, 16.2], [-10.4, 15.8], [10.5, -16.1], [-10.1, -16.4], [9.4, 16.8], [-9.5, -16.9]]) drop(x, z, r() < 0.5 ? 'rubble_b' : 'rubble_a');
    for (const c of this.colliders) for (let i = 0; i < 2; i++) { const a = r() * 6.283; drop(c.x + Math.cos(a) * (c.r + 0.1), c.z + Math.sin(a) * (c.r + 0.1), 'rubble_c'); }
  }

  /** Ivy with small white flowers: on a few piers, beside the doors, spilling from broken wall heads. Sparse. */
  ivy(b) {
    if (!this.kit.has('ivy_pier_a')) return;
    const o = (x, z) => ({ zone: this.zone(x, z), cast: false, vary: 0.1, mirror: false }), X = L.PIER_X, Z = L.PIER_Z, H = Math.PI / 2;
    b.place('ivy_pier_a', { x: -X, z: Z[6], sx: -1 }, o(-X, Z[6]));              // the pilgrim's left as he comes in
    b.place('ivy_pier_b', { x: X, z: Z[5] }, o(X, Z[5]));
    b.place('ivy_pier_b', { x: -X, z: Z[3], sx: -1, ry: H }, o(-X, Z[3]));
    b.place('ivy_pier_a', { x: X, z: Z[2], ry: -H }, o(X, Z[2]));
    b.place('ivy_pier_b', { x: -X, z: Z[1], sx: -1 }, o(-X, Z[1]));
    // on the west wall beside the doors (its face looks toward -z) and on the aisles' walls
    b.place('ivy_wall_a', { x: -7.2, y: 0.95, z: L.WEST_Z - 1.02, ry: -H }, o(-6, 20));
    b.place('ivy_wall_b', { x: 9.7, y: 0.95, z: L.WEST_Z - 1.02, ry: -H }, o(9, 20));
    b.place('ivy_wall_a', { x: L.AISLE_FACE - 0.02, z: L.BAY_Z[5] }, o(19, L.BAY_Z[5]));
    b.place('ivy_wall_b', { x: -(L.AISLE_FACE - 0.02), z: L.BAY_Z[2], sx: -1 }, o(-19, L.BAY_Z[2]));
    // hanging from the broken heads of the arcade wall
    const face = X - 0.75 - 0.02;
    b.place('ivy_hang_a', { x: face, y: 12.9, z: L.BAY_Z[3] + 0.6 }, o(face, L.BAY_Z[3]));
    b.place('ivy_hang_a', { x: -face, y: 13.4, z: L.BAY_Z[5] - 0.4, sx: -1 }, o(-face, L.BAY_Z[5]));
  }

  /** Broken chandeliers on long chains from the ribs that still cross the nave. They sway a little (update). */
  chandeliers() {
    this.swing = [];
    if (!this.kit.has('chandelier')) return;
    const len = this.kit.get('chain').extra.length || 4;
    L.CHANDELIERS.forEach((c, i) => {
      const z = L.PIER_Z[c.line], top = L.ribY(c.x), b = new Builder(this.kit, { seed: 90 + i });
      const cast = Math.abs(c.x) < 6 && z < 8;                     // only one that hangs in the window's light throws a shadow
      for (let k = 0; k < c.chains; k++) b.place('chain', { y: -len * k, ry: k * 1.3 }, { vary: 0, cast: false, mirror: false });
      b.place('chandelier', { y: -len * c.chains, ry: c.yaw }, { vary: 0, cast });
      const g = b.build(this.materials);
      g.position.set(c.x, top, z); g.name = 'arena:chandelier' + i;
      for (const m of g.children) m.frustumCulled = true;
      this.group.add(g);
      const ring = b.anchored('ring')[0];
      this.swing.push({ group: g, a: 0.006 + 0.0015 * i, w: 0.62 + 0.07 * i, p: i * 1.9, ring: ring ? ring.pos.clone().add(g.position) : null });       // 16 m of chain: about ten centimetres of sway
    });
  }

  // ------------------------------------------------------------------------------------------------ collision

  /** Push a circle (pos.x, pos.z, radius) out of the walls and the colliders, in place. Returns true if it touched anything. */
  resolve(pos, radius) {
    const { hx, hz, r } = this.bounds, ix = hx - r, iz = hz - r, lim = Math.max(0, r - radius), cs = this.colliders;
    let hit = false;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], ex = pos.x - c.x, ez = pos.z - c.z, min = c.r + radius, e2 = ex * ex + ez * ez;
        if (e2 < min * min) {
          const e = Math.sqrt(e2);
          if (e > 1e-5) { const k = min / e; pos.x = c.x + ex * k; pos.z = c.z + ez * k; } else { const l = Math.hypot(c.x, c.z) || 1; pos.x = c.x - (c.x / l) * min; pos.z = c.z - (c.z / l) * min; }   // dead centre: toward the middle of the hall
          moved = true;
        }
      }
      // the walls last, so the answer is always inside the play area (a rounded rectangle: a smaller rectangle grown by r)
      const cx = Math.max(-ix, Math.min(ix, pos.x)), cz = Math.max(-iz, Math.min(iz, pos.z)), dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
      if (d2 > lim * lim) { const k = lim / Math.sqrt(d2); pos.x = cx + dx * k; pos.z = cz + dz * k; moved = true; }
      if (!moved) break;
      hit = true;
    }
    return hit;
  }

  /** Is a circle of this radius at (x, z) clear of the walls and the colliders? */
  clear(x, z, radius = 0) {
    const { hx, hz, r } = this.bounds, ix = hx - r, iz = hz - r, lim = Math.max(0, r - radius);
    const dx = x - Math.max(-ix, Math.min(ix, x)), dz = z - Math.max(-iz, Math.min(iz, z));
    if (dx * dx + dz * dz > lim * lim) return false;
    for (const c of this.colliders) { const ex = x - c.x, ez = z - c.z, min = c.r + radius; if (ex * ex + ez * ez < min * min) return false; }
    return true;
  }

  /** Does a fat segment from a to b (their x and z) touch a collider or leave the play area? Exact. */
  segmentBlocked(a, b, radius = 0.2) {
    const { hx, hz, r } = this.bounds, ix = hx - r, iz = hz - r, lim = Math.max(0, r - radius);
    // the play area is convex: the segment stays inside if both ends do
    let dx = a.x - Math.max(-ix, Math.min(ix, a.x)), dz = a.z - Math.max(-iz, Math.min(iz, a.z));
    if (dx * dx + dz * dz > lim * lim + 1e-9) return true;
    dx = b.x - Math.max(-ix, Math.min(ix, b.x)); dz = b.z - Math.max(-iz, Math.min(iz, b.z));
    if (dx * dx + dz * dz > lim * lim + 1e-9) return true;
    const sx = b.x - a.x, sz = b.z - a.z, len2 = sx * sx + sz * sz, cs = this.colliders;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], min = c.r + radius;
      let t = len2 > 1e-12 ? ((c.x - a.x) * sx + (c.z - a.z) * sz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + sx * t - c.x, pz = a.z + sz * t - c.z;
      if (px * px + pz * pz < min * min) return true;
    }
    return false;
  }

  /** Height of the stone under a point (the floor, or the dais's steps east of the play area). */
  ground(x, z) {
    const d = L.DAIS;
    if (z > d.z) return 0;
    return Math.min(d.top, (Math.floor((d.z - z) / d.step) + 1) * d.rise);
  }

  update(dt) {
    this.time += dt;
    // the great organ answers the Cantor: its pipes glow with her gold (their mouths most), breathing slowly
    const gold = this.ctx.gfx && this.ctx.gfx.mood ? this.ctx.gfx.mood.gold : 0;
    const k = gold * (0.82 + 0.18 * Math.sin(this.time * 1.7));
    this.materials.gold.emissiveIntensity = 2.6 * k;
    this.materials.tin.emissiveIntensity = 1.5 * k;
    // the light baked into the two ends of the hall follows the candles and the organ
    const candle = this.ctx.gfx && this.ctx.gfx.mood ? this.ctx.gfx.mood.candle : 1, lit = this.materials.lit;
    lit.uWdLamp.value.setRGB(1.0 * candle, 0.52 * candle, 0.2 * candle);
    lit.uWdOrgan.value.setRGB(1.0 * k, 0.74 * k, 0.36 * k);
    for (const s of this.swing) { s.group.rotation.x = s.a * Math.sin(this.time * s.w + s.p); s.group.rotation.z = s.a * 0.8 * Math.sin(this.time * s.w * 0.83 + s.p * 1.7); }
  }

  dispose() {
    this.ctx.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials.all) m.dispose();
    for (const t of this.materials.textures) t.dispose();
  }
}
