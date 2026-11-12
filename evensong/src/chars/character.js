// A rigged character: one Mixamo skeleton, a set of clips, and what a game needs from them.
//
//   - play(name, opts) cross-fades to a clip; play('@move') puts the blended walk and run in front (locomotion(), move()).
//   - Clips that travel (attacks, rolls, turns) were exported with their travel. Here the hips' travel over the
//     ground, and for turning clips the turn itself, is taken out of the clip when it is loaded, and update()
//     hands it back step by step in the character's own frame. So the body never slides away from `root`, and the
//     owner decides what the travel does (move, be stopped by a wall, be scaled).
//   - overlay() plays a clip on part of the body over all that; additive() adds a flinch; look() turns head and chest.
//   - Clip events (a foot lands, a blade starts to cut) come from the clip data and are reported through on().
//   - socket(bone) gives an Object3D riding on a bone: weapons hang there.
//
// The blending itself is in animgraph.js (no three.js mixer: every bone is written every step). The contract is in
// docs/engine.md ("Fighters"); every signature, with the clip table, in docs/modules/animation.md. Everything else
// about a fighter (rules, states) lives in player.js and boss.js.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { Rig, Graph, Move, plain, compileClip, extractRoot, removeRoot, detrend, namedMask } from './animgraph.js';

// which clips go round when the clip data does not say (it says, for every clip of the knight and the Cantor)
const LOOPING = /^(idle|(walk|run)_[fblr]$|sprint$|walk_careful_ip$|block_idle$|kneel_idle|pray_idle$|hurt_idle$|strafe)/;
const DEG = Math.PI / 180;

export class Character {
  /**
   * @param ctx    the game's context (needs ctx.assets)
   * @param o      { model: asset name of the mesh+skeleton GLB, clips: asset name of the clips GLB, scale = 1,
   *                 data: clip data, see src/chars/clipdata.js: { [clip]: { loop?, root?, yaw?, speed?, fade?, trim?,
   *                 recover?, kind?, groundSpeed?, dir?, events?: [{ t, name, data? }] }, $fix?: {...} } },
   *                 restFix, floorFit, footPlant, bodyFit: true | false to overrule what the clip data says
   *                 (bodyFit: 'all' also lets the body fit act in play and without a fighter: see bodyFitAll)
   */
  constructor(ctx, o) {
    this.ctx = ctx; this.name = o.model; this.data = o.data || {};
    const src = ctx.assets.gltf(o.model);
    this.root = new THREE.Group(); this.root.name = 'character:' + o.model;
    this.model = cloneSkinned(src.scene); this.root.add(this.model);
    this.scale = o.scale || 1; this.model.scale.setScalar(this.scale);
    this.bones = {}; this.meshes = [];
    this.model.traverse((n) => {
      if (n.isBone) this.bones[plain(n.name)] = n;
      if (n.isMesh) { this.meshes.push(n); n.castShadow = true; n.receiveShadow = true; n.frustumCulled = false; }
    });
    const hips = this.bones.Hips;
    if (!hips) throw new Error(`"${o.model}" has no Hips bone: is it a Mixamo rig?`);
    this.hipsName = hips.name;
    this.rig = new Rig(this.model);
    // the clips' rest pose against the model's (see Rig.setRestFix): on when the clip data says so ($restOn), or by
    // the page's address (&restfix=1 / &restfix=0), or by the option { restFix: true | false }
    const want = o.restFix !== undefined ? !!o.restFix : ctx.params && typeof ctx.params.has === 'function' && ctx.params.has('restfix') ? ctx.params.get('restfix') !== '0' : !!this.data.$restOn;
    // a clips file packed with its keys already converted says so on its skeleton's root object (userData.restBaked,
    // a glTF extra): then there is nothing to put right
    let baked = false; ctx.assets.gltf(o.clips).scene.traverse((n) => { if (n.userData && n.userData.restBaked) baked = true; });
    this.restBaked = baked;
    this.restFix = want && !baked && !!this.data.$rest;
    this.listeners = []; this.speed = 1;
    this.graph = new Graph(this.rig, (name) => this.clips.get(name) || null, (name, clip, data) => this.fire(name, clip, data));
    this.clips = new Map();
    for (const raw of ctx.assets.gltf(o.clips).animations) this.addClip(raw);
    this.action = null; this.clip = null; this.mover = null; this.masks = new Map();
    this.motion = { x: 0, z: 0, yaw: 0 };
    this.sockets = new Map();
    this.hurt = this.defaultHurt();
    if (this.data.$fix) this.graph.setFix(this.data.$fix);
    if (this.restFix) this.rig.setRestFix(this.data.$rest);
    // the floor: where the body can touch it ($contact), and the two switches (floorFit, footPlant): each on by the
    // option, else by the page's address (&floorfit=1|0, &footplant=1|0), else as the clip data says ($floorOn, $plantOn)
    if (this.data.$contact) this.graph.setContact(this.data.$contact);
    const sw = (opt, key, def) => (opt !== undefined ? !!opt : ctx.params && typeof ctx.params.has === 'function' && ctx.params.has(key) ? ctx.params.get(key) !== '0' : !!def);
    this.floorFit = sw(o.floorFit, 'floorfit', this.data.$floorOn); this.footPlant = sw(o.footPlant, 'footplant', this.data.$plantOn);
    // the body: its shape as measured on the mesh ($body) and the points on forearm, hand and fingers that are kept
    // out of it ($arm); the switch (bodyFit): by the option, else by the page's address (&bodyfit=0 | 1 | all), else as
    // the clip data says ($bodyOn). 'all' (option or address): it acts in play and without a fighter too (bodyFitAll).
    if (this.data.$body && this.data.$arm) this.graph.setBody(this.data.$body, this.data.$arm);
    const bf = o.bodyFit !== undefined ? o.bodyFit : ctx.params && typeof ctx.params.has === 'function' && ctx.params.has('bodyfit') ? ctx.params.get('bodyfit') : undefined;
    this.bodyFit = bf === undefined ? !!this.data.$bodyOn : bf !== false && bf !== 0 && bf !== '0';
    this.bodyFitAll = bf === 'all';
    this._owner = null; this._trace = null;
  }
  /**
   * Forearms, wrists, hands and fingers are kept out of the character's own body (hips with their plates, thighs,
   * shins, belly, chest): after the pose is made, what would be inside the body's skin is carried out to its surface
   * and a little beyond by bending its own arm (two-bone IK, the hand keeping its turn), eased in time. The body's
   * shape is measured on the mesh (clipdata's $body). false: none of it.
   * It acts only while the character is SHOWN, not ruled: while its fighter (ctx.boss or ctx.player) is a puppet (a
   * cutscene, the title, a dev pose). In play it stands back entirely, and every pose is bit for bit what it was
   * without it: arms carry blades and are struck, so a moved arm could change a fight. A character with no fighter
   * (a lab page, a tool) is left alone too, unless bodyFitAll is set.
   */
  get bodyFit() { return this.graph.bodyFit; }
  set bodyFit(v) { this.graph.bodyFit = !!v && this.graph.arms.length > 0; }
  /**
   * true: the body fit acts whenever it is on: in play too (only where a replayed session proves the fight
   * unchanged), and on a character that has no fighter (lab pages and tools: &bodyfit=all, or { bodyFit: 'all' }).
   */
  get bodyFitAll() { return this._bodyAll; }
  set bodyFitAll(v) { this._bodyAll = !!v; }
  /**
   * For whoever puts a hand somewhere AFTER the pose is made (a cutscene's grasp: the body fit works on the pose and
   * cannot see that): carry a point of the world out of this character's own body. If the point is nearer to the
   * body's skin (hips with their plates, belly, chest, thighs, shins: the shape measured on the mesh) than `margin`
   * (the character's OWN units: 0.07 is a hand's breadth, right for a wrist), it is moved straight out of the part it
   * is nearest until it is that far off. `point` (a Vector3 in the world) is changed in place; returns how far it was
   * moved (metres), 0 when it was clear or the character has no body data. The body is where the bones' world
   * matrices have it now (after update(), and after updateMatrixWorld on the root).
   */
  bodyClear(point, margin = 0.07) { return this.graph.bodyClear(point, margin); }
  /** The fighter this character is the body of (ctx.boss or ctx.player), or null: found when first needed. */
  get owner() {
    if (this._owner) return this._owner;
    const c = this.ctx, b = c && c.boss, p = c && c.player;
    return (this._owner = b && b.char === this ? b : p && p.char === this ? p : null);
  }
  /** Is the character being shown (its fighter is a puppet of a cutscene, the title or a dev tool), not ruled? */
  get shown() { const o = this.owner; return !!(o && o.puppet); }
  /**
   * The body is kept out of the floor: each clip's own correction of the hips' height (clipdata's `floor`, measured
   * on the mesh), feet and hands lifted out of the floor by bending their own limbs, toes bent up. false: none of it
   * (the old lift of the whole body when a foot dips under the floor comes back).
   */
  get floorFit() { return this.graph.floorFit; }
  set floorFit(v) { this.graph.floorFit = !!v && this.graph.limbs.length > 0; }
  /**
   * In the walk blend, a foot that stands on the ground stays where it stood in the world (two-bone IK on the leg),
   * is let go at lift-off or when the leg would have to stretch, and when he stops the feet step to where the
   * standing pose wants them. false: the legs are exactly as the blend makes them.
   */
  get footPlant() { return this.graph.footPlant; }
  set footPlant(v) { this.graph.footPlant = !!v && this.graph.limbs.length > 0; if (!v) this.graph.unplant(); }

  /** Register a clip (also used to add clips later, e.g. bespoke cutscene motion). */
  addClip(raw, name = raw.name) {
    const d = this.data[name] || {}, hp = this.hipsName + '.position', hq = this.hipsName + '.quaternion';
    // only bones move: drop any track that would scale a bone or move one other than the hips
    const tracks = raw.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === hp).map((t) => ({ name: t.name, times: t.times, values: t.values, src: t }));
    const loop = d.loop !== undefined ? d.loop : LOOPING.test(name);
    const pos = tracks.find((t) => t.name === hp), rot = tracks.find((t) => t.name === hq);
    let root = null, carried = null;
    const own = (t) => { t.values = t.values.slice(); t.src = null; return t.values; };      // the asset's keys are shared: change a copy
    if (pos && (!loop || d.root)) {
      // travel: taken out of the hips' keys and handed back by update() as root motion
      const yaw = d.yaw && rot && rot.times.length === pos.times.length;
      const r = extractRoot(pos.times, pos.values, yaw ? rot.values : null);
      if (d.root !== undefined ? d.root : (r.net > 0.12 || r.path > 0.5)) { removeRoot(r, own(pos), yaw ? own(rot) : null); root = r; }
    } else if (pos && d.root !== false) {
      // a loop exported with its travel (the knight's sprint): take the steady travel out so it runs in place
      const p = pos.values, n = pos.times.length;
      if (Math.hypot(p[(n - 1) * 3] - p[0], p[(n - 1) * 3 + 2] - p[2]) > 0.25) carried = detrend(pos.times, own(pos));
    }
    const data = carried && d.groundSpeed === undefined ? Object.assign({}, d, { groundSpeed: Math.hypot(carried[0], carried[1]), dir: [carried[0] / Math.hypot(carried[0], carried[1]), carried[1] / Math.hypot(carried[0], carried[1])] }) : d;
    const events = (d.events || []).slice();
    if (typeof d.recover === 'number' && !events.some((e) => e.name === 'recover')) events.push({ t: d.recover, name: 'recover' });
    events.sort((a, b) => a.t - b.t);
    const entry = {
      name, duration: raw.duration, loop, root, speed: d.speed || 1, fade: d.fade, events, data, kind: d.kind || (loop ? 'idle' : 'act'),
      trim: d.trim || null, recover: typeof d.recover === 'number' ? d.recover : null, sampler: compileClip(this.rig, tracks, raw.duration), _clip: null,
      floor: Array.isArray(d.floor) && d.floor.length >= 4 ? Float32Array.from(d.floor) : null,      // how much to raise or lower the hips over the clip (floorFit)
      apart: typeof d.apart === 'number' ? d.apart : 0,                  // how far to move hands apart that the clip presses into each other (floorFit)
      kneel: Array.isArray(d.kneel) && d.kneel.length >= 3 ? Float32Array.from(d.kneel) : null,      // when it kneels and on which knee: [from, to, side, ...] (floorFit puts that knee on the floor)
      headBack: typeof d.headBack === 'number' ? d.headBack : 0,           // the most the head may lean back from the chest in this clip, degrees (floorFit)
      body: d.body !== false,                                              // false: the body fit leaves this clip's arms alone (bodyFit)
      /** The clip as three.js knows it (with the travel taken out), made when someone asks. */
      get clip() {
        if (!this._clip) this._clip = new THREE.AnimationClip(name, raw.duration, tracks.map((t) => t.src || (t.name.endsWith('.position') ? new THREE.VectorKeyframeTrack(t.name, t.times, t.values) : new THREE.QuaternionKeyframeTrack(t.name, t.times, t.values))));
        return this._clip;
      },
    };
    this.clips.set(name, entry);
    return entry;
  }
  has(name) { return name === '@move' ? !!this.mover : this.clips.has(name); }
  /** What clipdata says about a clip (kind, recover, hits, travel, groundSpeed, trim, rate ...), or null. */
  info(name) { return this.data[name] || null; }

  setScale(s) { this.scale = s; this.model.scale.setScalar(s); this.rig.refreshBase(); }

  /**
   * Cross-fade to a clip. opts: { fade = 0.15, loop (default from the clip), speed = 1, at (seconds into the clip),
   * force (start again if already playing), trim (true: play only the clip's useful stretch, clipdata's `trim`) }.
   * Returns a handle with time, timeScale, paused. play('@move', { fade }) puts the walk blend in front.
   */
  play(name, opts = {}) {
    if (name === '@move') return this.playMove(opts);
    const e = this.clips.get(name);
    if (!e) { console.warn(`${this.name}: no clip "${name}"`); return null; }
    const cur = this.action;
    if (cur && this.clip === e && !opts.force && e.loop && this.graph.front === cur) { if (opts.speed) cur.timeScale = opts.speed * e.speed; return cur; }
    const fade = opts.fade !== undefined ? opts.fade : e.fade !== undefined ? e.fade : 0.15;
    const loop = opts.loop !== undefined ? opts.loop : e.loop;
    const trim = opts.trim && e.trim ? e.trim : null, start = trim ? trim[0] : 0, end = trim ? trim[1] : e.duration;
    let at = opts.at !== undefined && opts.at !== null ? opts.at : start;
    if ((opts.at === undefined || opts.at === null) && loop && !opts.force) {
      // a loop that is still fading out underneath carries on from where it is instead of starting again
      const base = this.graph.base; for (let i = base.length - 1; i >= 0; i--) if (!base[i].isMove && base[i].entry === e) { at = base[i].time; break; }
    }
    const p = this.graph.play(e, { fade, loop, speed: (opts.speed || 1) * e.speed, at, start, end });
    this.action = p; this.clip = e;
    return p;
  }

  // ---- the blended walk and run
  /**
   * Say which clips make up walking and running: { idle, walk: { f, b, l, r }, run: { f, b, l, r }, sprint }
   * (leave out what the character has not got). Then play('@move') and move(vx, vz) each step.
   */
  locomotion(set, opts) {
    for (const k of [set.idle, set.sprint, ...Object.values(set.walk || {}), ...Object.values(set.run || {})]) if (k && !this.clips.has(k)) throw new Error(`${this.name}: locomotion() names a clip it has not got: "${k}"`);
    const was = this.mover, front = was && this.graph.front === was;
    this.mover = new Move(this.graph, set, opts);
    if (was) { const i = this.graph.base.indexOf(was); if (i >= 0) { this.mover.alpha = was.alpha; this.mover.fade = was.fade; this.mover.weight = was.weight; this.mover.phase = was.phase; this.graph.base[i] = this.mover; } if (front) { this.graph.front = this.mover; this.action = this.mover; this.clip = this.mover.entry; } }
    return this;
  }
  playMove(opts = {}) {
    const mv = this.mover;
    if (!mv) { console.warn(`${this.name}: play('@move') before locomotion()`); return null; }
    if (this.graph.front === mv) return mv;
    mv.fresh = true; mv.flipT = 0;                                         // (last polish: the blend's guard against a jump of its own pose starts afresh: what it showed last is long ago)
    this.graph.push(mv, opts.fade !== undefined ? opts.fade : 0.2);
    this.action = mv; this.clip = mv.entry;
    return mv;
  }
  /** The velocity he should be seen to have, in his own frame, metres a second: vz forward, vx to his LEFT. */
  move(vx, vz) { const mv = this.mover; if (mv) { mv.vx = vx / this.scale; mv.vz = vz / this.scale; } }

  // ---- layers
  maskFor(mask) {
    if (typeof mask !== 'string') return namedMask(this.rig, mask);
    let m = this.masks.get(mask); if (!m) this.masks.set(mask, m = namedMask(this.rig, mask));
    return m;
  }
  /**
   * Play a clip on part of the body over whatever the base is doing. opts: { mask = 'upper' ('upper' | 'arms' |
   * 'left-arm' | 'right-arm' | 'head' | 'torso' | 'all' | [bone names: each with everything under it]), fade = 0.15,
   * loop, speed = 1, weight = 1, at, trim, hold (a one-shot stays on its last pose instead of letting go), force }.
   */
  overlay(name, opts = {}) {
    const e = this.clips.get(name);
    if (!e) { console.warn(`${this.name}: no clip "${name}"`); return null; }
    const cur = this.graph.overlayFront;
    if (cur && cur.name === name && !opts.force && cur.play.loop) { if (opts.weight !== undefined) cur.gain = opts.weight; if (opts.speed) cur.play.timeScale = opts.speed * e.speed; return cur.play; }
    const trim = opts.trim && e.trim ? e.trim : null, start = trim ? trim[0] : 0, end = trim ? trim[1] : e.duration;
    return this.graph.overlay(e, {
      mask: this.maskFor(opts.mask || 'upper'), fade: opts.fade !== undefined ? opts.fade : 0.15, loop: opts.loop !== undefined ? opts.loop : e.loop,
      speed: (opts.speed || 1) * e.speed, weight: opts.weight !== undefined ? opts.weight : 1, at: opts.at !== undefined && opts.at !== null ? opts.at : start, hold: !!opts.hold, start, end,
    });
  }
  overlayOff(fade = 0.15) { this.graph.overlayOff(fade); }
  /** The clip on the overlay now (not one that is fading away), or null. */
  get overlayName() { const o = this.graph.overlayFront; return o ? o.name : null; }
  /** The overlay's handle (time, timeScale, paused, done), or null. */
  get overlayAction() { const o = this.graph.overlayFront; return o ? o.play : null; }

  /**
   * Add a one-shot on top of anything: the clip's difference from its own first pose (a flinch).
   * opts: { weight = 1, speed = 1, at, end, fadeIn = 0.04, fadeOut = 0.18, mask }, or just a weight.
   * mask: the part of the body that flinches, named as for overlay() ('upper', 'arms', 'head', 'torso', ...) or
   * 'legs' | 'left-leg' | 'right-leg' | 'lower' (hips and both legs) | [bone names]; default: the whole body.
   */
  additive(name, opts = {}) {
    const e = this.clips.get(name);
    if (!e) { console.warn(`${this.name}: no clip "${name}"`); return null; }
    if (typeof opts === 'number') opts = { weight: opts };
    const at = opts.at !== undefined ? opts.at : 0;
    return this.graph.additive(e, { weight: opts.weight !== undefined ? opts.weight : 1, speed: (opts.speed || 1) * e.speed, at, end: opts.end !== undefined ? opts.end : e.duration, fadeIn: opts.fadeIn !== undefined ? opts.fadeIn : 0.04, fadeOut: opts.fadeOut !== undefined ? opts.fadeOut : 0.18, mask: opts.mask ? this.maskFor(opts.mask) : null });
  }

  /**
   * Turn head and chest toward a point in the world (null lets go). The point is kept and read every step, so pass
   * a vector that moves (or call again). opts: { weight = 1, speed = 6 (how fast it follows, per second), head = 0.65,
   * chest = 0.35 (shares of the turn), limit = 1.22 (radians to either side of the chest; over 3.5 is read as degrees),
   * limitPitch = 0.7, offsetY (metres added to the point), always (true: also during rolls, hits and deaths) }, or a weight.
   */
  look(point, opts) {
    const L = this.graph.look;
    if (typeof opts === 'number') opts = { weight: opts };
    L.target = point || null; L.on = !!point;
    if (!opts) return;
    const ang = (v) => (v > 3.5 ? v * DEG : v);
    if (opts.weight !== undefined) L.weight = opts.weight;
    if (opts.speed !== undefined) L.speed = opts.speed;
    if (opts.head !== undefined) L.head = opts.head;
    if (opts.chest !== undefined) L.chest = opts.chest;
    if (opts.limit !== undefined) L.limit = ang(opts.limit);
    if (opts.limitPitch !== undefined) L.limitPitch = ang(opts.limitPitch);
    if (opts.offsetY !== undefined) L.offsetY = opts.offsetY;
    if (opts.always !== undefined) L.always = !!opts.always;
  }

  // ---- the clip in front
  get time() { return this.action ? this.action.time : 0; }
  get duration() { return this.clip ? this.clip.duration : 0; }
  /** 0..1 through the clip in front. */
  get phase() { return this.clip ? this.action.time / this.clip.duration : 0; }
  /** A clip played once has reached its end (the end of its trim, if it was played trimmed). */
  get done() { return !!this.action && this.action.done; }
  get clipName() { return this.clip ? this.clip.name : null; }
  /** When control may come back in the clip in front (clipdata's `recover`, seconds into the clip), or null. */
  get recover() { return this.clip && this.clip.recover !== undefined ? this.clip.recover : null; }
  /** The clip in front has passed its `recover` (or has none and is done). */
  get recovered() { const r = this.recover; return r !== null ? this.time >= r : this.done; }

  /** Advance the pose. Returns this step's root motion in the character's own frame (already times his scale). */
  update(dt) {
    this.graph.realDt = dt;
    if (this._trace && dt > 0) this.traceStep();
    if (this.graph.bodyFit) this.graph.bodyShown = this._bodyAll || this.shown ? 1 : 0;      // (in play the body fit stands back: see bodyFit)
    const m = this.motion, g = this.graph.update(dt * this.speed, this.root.rotation.y, this.root.position);
    m.x = g.x * this.scale; m.z = g.z * this.scale; m.yaw = g.yaw;
    return m;
  }
  /**
   * Dev: record the bones AS THEY WERE DRAWN for so many seconds (what stood on them when each next step began: the
   * pose, and whatever the fighter, its kit and a cutscene did to it afterwards), then send them to the dev server as
   * .shots/<name> for tools/tests/armfit/measure.mjs --trace. From an address: &do=boss.char.trace(3,"name.json")@37.5
   */
  trace(seconds, name) { this._trace = { left: Math.max(1, Math.round(seconds * 60)), name, t0: this.ctx.game && typeof this.ctx.game.time === 'number' ? this.ctx.game.time : 0, bones: this.rig.bones.map((b) => plain(b.name)), steps: [] }; }
  traceStep() {
    const T = this._trace, r5 = (v) => Math.round(v * 1e5) / 1e5, h = this.rig.bones[this.rig.hips].position, row = [r5(h.x), r5(h.y), r5(h.z)];
    for (const b of this.rig.bones) row.push(r5(b.quaternion.x), r5(b.quaternion.y), r5(b.quaternion.z), r5(b.quaternion.w));
    T.steps.push(row);
    if (--T.left > 0) return;
    this._trace = null;
    if (typeof fetch === 'function') fetch('/__shot/' + T.name, { method: 'POST', body: JSON.stringify({ t0: T.t0, bones: T.bones, steps: T.steps }) }).catch((e) => console.error('trace: ' + e.message));
  }
  fire(name, clip, data) { for (const fn of this.listeners) fn({ name, clip, data }); }
  /** Clip events: fn({ name, clip, data }). Returns a function that removes the listener. */
  on(fn) { this.listeners.push(fn); return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }; }

  /**
   * How a bone is turned, in the character's own axes, when the skeleton stands in the clips' rest pose (Mixamo's
   * T-pose: arms straight out along x, legs straight down, every Mixamo joint square to the world). With the rest-pose
   * correction on (or baked into the clips), a bone's turn in the world at any moment is Mixamo's joint's turn times
   * this: so an Object3D hung on the bone with quaternion = this, inverted, is square to the world in the T-pose and
   * keeps Mixamo's joint's own orientation ever after (socket(bone, key, { square: true }) makes one).
   */
  tposeWorld(bone, out = new THREE.Quaternion()) {
    const i = this.rig.index[bone]; if (i === undefined) throw new Error(`${this.name}: no bone "${bone}"`);
    const w = this.rig.tposeWorld(); return out.set(w[i * 4], w[i * 4 + 1], w[i * 4 + 2], w[i * 4 + 3]);
  }

  /** An Object3D that rides on a bone (it inherits the character's scale). Hang weapons and lights on it. */
  socket(bone, key = bone, opts) {
    let s = this.sockets.get(key);
    if (!s) {
      const b = this.bones[bone]; if (!b) throw new Error(`${this.name}: no bone "${bone}"`);
      s = new THREE.Object3D(); s.name = 'socket:' + key; b.add(s); this.sockets.set(key, s);
      if (opts && opts.square) this.tposeWorld(bone, s.quaternion).invert();      // square to the world in the T-pose: Mixamo's joint axes
    }
    return s;
  }

  /** Capsules to be hit on, each between two bones (radii in metres at scale 1; multiply by `scale` when testing). */
  defaultHurt() {
    const B = this.bones, list = [];
    const add = (a, b, r) => { if (B[a] && B[b]) list.push({ a: B[a], b: B[b], r }); };
    add('Hips', 'Spine2', 0.24); add('Spine2', 'Head', 0.2); add('Head', 'HeadTop_End', 0.14);
    for (const s of ['Left', 'Right']) { add(s + 'UpLeg', s + 'Leg', 0.13); add(s + 'Leg', s + 'Foot', 0.1); add(s + 'Arm', s + 'ForeArm', 0.09); add(s + 'ForeArm', s + 'Hand', 0.08); }
    return list;
  }

  dispose() {
    this.listeners.length = 0; this.graph.base.length = 0; this.graph.overlays.length = 0; this.graph.additives.length = 0;
    if (this.root.parent) this.root.parent.remove(this.root);
    // geometries and materials are shared with the loaded asset (a clone): nothing of ours to free
  }
}
