// Effects (ctx.vfx): sparks, spray, crowns of water, rings of light, weapon trails, and the air itself.
// The contract is in docs/engine.md ("Effects"); everything this module offers beyond it, the bus events it answers
// by itself, and what it costs are in docs/modules/effects.md.
//
//   vfx.sparks(point, dir, count = 12, power = 1)      steel on steel: hot streaks that fall, bounce once on the water, die
//   vfx.spray(point, dir, count = 20, power = 1)       water thrown up: droplets and a veil; power >= 1.6 adds a torn sheet
//   vfx.splashRing(pos, radius, power)                 a crown of water and mist where something slams down
//   vfx.sheet(point, dir, width, power)                a wall of water thrown one way from a line (a blade laid along the floor)
//   vfx.dust(point, count), vfx.embers(point, count), vfx.motes(point, count, color)
//   vfx.shock(pos, radius, color, seconds, from, glint) -> ring   a ring of light running out along the water; ring.radius is where it is
//                                                      now; glint (default 1) scales the ball of light it starts with (0: none)
//   vfx.trail(weapon, opts) -> { start(), stop(), set(opts) }
//   vfx.hitFlash(character, seconds, color, power)     light over a fighter's whole body for a moment
//   vfx.dissolve(object3d, seconds, opts) -> { progress, done, cancel() }
//   vfx.impact(point, dir, power = 1)                  flash, sparks and a ring in one call
//   vfx.gust(pos, power)                               blow the mist open (slams do it themselves)
//   vfx.demo(name)                                     fire one effect near the fighters (see DEMOS at the end)
//   vfx.reset()                                        everything in flight gone (the fight begins again)
//
// Positions and directions are THREE.Vector3 (or anything with x, y, z); they are read at once and never kept.
// All motion advances in update(dt) only; frame() only smooths what is drawn (one exception, on purpose: while the
// world is held for a hit-stop, what has been thrown flies on in real time; see `pt` in the constructor).
//
// Every hit is felt (docs/impact.md, Part 2): on the bus's `hit`, `clash` and `boss-slam` effects throw, at the true
// point of contact and turned along the blow, a set scaled by the blow's weight (WEIGHT below; _onHit, _strike,
// _onClash, _slams). Nobody has to call anything for that.
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { Rng, LightProbe, makeNoiseTexture } from './fx_common.js';
import { Pool, P, KIND, makeParticleMaterial } from './particles.js';
import { Sheets } from './fx_splash.js';
import { Shocks } from './fx_shock.js';
import { Trail, TRAIL_LOOKS } from './trails.js';
import { Mist, Dust, Moths } from './fx_air.js';
import { Bodies } from './fx_body.js';

export const ASSETS = {};

const UP = new THREE.Vector3(0, 1, 0);
// _a.._d are used inside the calls themselves; _e.._g carry arguments INTO a call (never pass _a.._d to one)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();
const _col = new THREE.Color(), _gold = new THREE.Color(0xffd890), _pale = new THREE.Color(0xfff1d8);
const REBASE = 512;                                   // seconds: the shaders' clock is kept small so it stays exact
const G = 9.8;
// carried through one blow (_onHit, _strike, _onClash, _onSlam): the struck surface's normal, the blow along it, and spares
const _hn = new THREE.Vector3(), _ht = new THREE.Vector3(), _hr = new THREE.Vector3(), _hp = new THREE.Vector3(), _hx = new THREE.Vector3();

// The three weights of docs/impact.md (Part 2): what a blow throws at its point of contact. Scale, do not repeat:
// a light hit is a dozen sparks and a glint; a colossal one is a blast, two lines of light and a ring across the water.
//   n, sp    sparks: how many, how hard thrown        long   sparks that arc, fall and bounce (the ones the eye follows)
//   glint    the ball of light at the point (metres, seconds)      line   the line of light along the cut (metres; 0 = none)
//   ring     the ring of pressure (metres across, seconds, how bright)   light  our point light (lantern's worth, seconds)
//   motes    pale chips of light off the Cantor                    flash  the struck body's flash (seconds, strength)
//   spray    where the blow ends in the water (drops, power)       gust   how far the mist is pushed aside (0 = not at all)
const WEIGHT = [
  { n: 10, sp: 1.0, long: 2, glint: 0.4, gl: 0.09, line: 0, ring: 1.1, rl: 0.16, rb: 0.75, light: 2.4, ls: 0.08, motes: 3, flash: 0.06, fp: 0.8, spray: 12, sprayP: 0.8, gust: 0 },
  { n: 34, sp: 1.9, long: 6, glint: 0.65, gl: 0.12, line: 1.8, ring: 2.0, rl: 0.22, rb: 1, light: 4.5, ls: 0.12, motes: 7, flash: 0.10, fp: 1.1, spray: 22, sprayP: 1.3, gust: 0.35 },
  { n: 90, sp: 3.2, long: 16, glint: 0.95, gl: 0.16, line: 3.4, ring: 3.4, rl: 0.3, rb: 1.1, light: 8, ls: 0.2, motes: 16, flash: 0.15, fp: 1.45, spray: 44, sprayP: 2.4, gust: 0.75 },
];
export const LIGHT = 0, HEAVY = 1, COLOSSAL = 2;

export class Vfx {
  constructor(ctx) {
    this.ctx = ctx; this.calls = {};
    this.off = !!(ctx.params && ctx.params.has('novfx'));          // dev: build nothing, so its cost can be measured
    this.time = 0; this.clock = 0; this.lead = 0; this.DT = ctx.DT || 1 / 60;
    // Three clocks. `clock` never goes back (mist, moths, "did this just happen"). `time` is the shaders' clock for
    // what follows the rules step by step (rings of light, trails): it stands still while the world is held (hit-stop).
    // `pt` is the clock of everything thrown (sparks, flashes, spray, sheets): it runs on through a hit-stop, so the
    // two bodies hold and the sparks keep flying. In a picture run the world is never held and all three agree.
    this.pt = 0; this.stepped = false; this.brokeAt = -10;
    this.rng = new Rng(20261107);
    // strengths, for tuning against the renderer (also from the address: &fx=mist:0.15,hot:1.4)
    this.tune = { hot: 1, soft: 1, sheets: 1, shock: 1, trails: 1, mist: 0.4, dust: 1, moths: 1, air: 1, live: 1 };
    const fx = ctx.params && ctx.params.get('fx');
    if (fx) for (const part of fx.split(',')) { const [k, v] = part.split(':'); if (k in this.tune && !Number.isNaN(+v)) this.tune[k] = +v; }
    this.cpu = { update: 0, frame: 0 };
    if (this.off) return;
    const group = this.group = new THREE.Group(); group.name = 'vfx'; ctx.scene.add(group);
    this.noise = makeNoiseTexture();
    this.probe = new LightProbe(ctx);
    this.hot = new Pool(ctx, makeParticleMaterial(this.probe, this.noise), { capacity: 8192, layer: 0, renderOrder: 16, name: 'fx.hot' });
    this.soft = new Pool(ctx, makeParticleMaterial(this.probe, this.noise), { capacity: 1536, layer: 2, renderOrder: 13, soft: true, name: 'fx.soft' });
    this.sheets = new Sheets(ctx, this.probe, this.noise, 24);
    this.shocks = new Shocks(ctx, this.probe, this.noise, 8);
    this.mist = new Mist(ctx, this.probe, this.noise, new Rng(11), 84);
    this.dustAir = new Dust(ctx, this.probe, new Rng(12), 1500);
    this.moths = new Moths(ctx, this.probe, new Rng(13), 26);
    this.bodies = new Bodies(ctx, group, this.noise, (x, y, z, color) => {       // what a dissolving body sheds: a mote, sometimes a larger slower one
      const r = this.rng, big = r.next() < 0.25;
      this._mote(x, y, z, r.signed() * 0.3, 0.1 + 0.55 * r.next(), r.signed() * 0.3, color, big ? 1.6 : 2.4, 2.6 + 3 * r.next(), big ? 2.4 : 1.2);
    });
    group.add(this.mist.mesh, this.dustAir.mesh, this.moths.mesh, this.sheets.mesh, this.soft.mesh, this.shocks.mesh, this.hot.mesh);
    // one light of our own for the instant of a blow (the number of lights never changes in play)
    const lights = ctx.gfx && ctx.gfx.lights;
    this.flashLight = lights && lights.add ? lights.add('flash') : null;
    if (this.flashLight) this.flashLight.intensity = 0;
    this.probe.skip = this.flashLight;                 // it lights the fighters and the hall; spray and mist a hand away from it would burn white
    this.flash = { t: 0, dur: 0.1, peak: 0, hold: false };
    // trails: the two fighters' blades get theirs by themselves (see update); owners may take them over
    this.trails = []; this.own = [null, null];
    // a blade of our own, for looking at trails without a fighter (demo "trail", "trailBig")
    const gh = this.ghost = { pivot: new THREE.Object3D(), base: new THREE.Object3D(), tip: new THREE.Object3D(), t: 0, dur: 0, from: 0, to: 0, tilt: 0, trail: null, big: false };
    gh.pivot.add(gh.base, gh.tip); group.add(gh.pivot);
    gh.small = this._newTrail(gh, TRAIL_LOOKS.pilgrim); gh.large = this._newTrail(gh, TRAIL_LOOKS.cantor);
    // things that go on for a moment (the spray of a roll)
    this.jobs = []; for (let i = 0; i < 6; i++) this.jobs.push({ on: false, kind: '', t: 0, dur: 0, who: null, dx: 0, dz: 0, power: 1, acc: 0, n: 0 });
    this.last = { x: 0, z: 0, t: -10 };                // the last crown, so one slam told twice is thrown once
    this.struck = { x: 0, y: 0, z: 0, t: -10 };        // the last burst of sparks, for the same reason
    this.wring = { x: 0, z: 0, t: -10 };               // the last ring of pressure across the water, for the same reason
    this.slams = []; for (let i = 0; i < 4; i++) this.slams.push({ on: false, x: 0, z: 0, R: 3, power: 1 });      // slams told this step, thrown in our update
    this.acc = { embers: 0 };
    // dev: &fxab=name.json measures what drawing the effects costs, inside one timing run (&perf=...): they are
    // shown for twelve frames and hidden for twelve, over and over, and the two sets of frame times are compared, so
    // whatever else the laptop is doing cancels out. The result is sent to .shots/name.json.
    const ab = ctx.params && ctx.params.get('fxab');
    this.ab = ab ? { name: ab, n: 0, last: 0, on: true, tOn: [], tOff: [], sent: false, from: +(ctx.params.get('fxabt') || 1), frames: +(ctx.params.get('fxabn') || 228) } : null;
    // dev: &fxlog=0.5 prints what the effects are doing every so many seconds (as page errors, so the picture tools show it)
    this.log = ctx.params && ctx.params.has('fxlog') ? { every: +ctx.params.get('fxlog') || 0.5, next: 0, peak: [0, 0, 0, 0] } : null;
    this.prime = 3;                                    // frames for which everything is drawn (as nothing), so every shader exists
    this.hot.mesh.visible = this.soft.mesh.visible = this.sheets.mesh.visible = this.shocks.mesh.visible = true; for (const tr of this.trails) tr.mesh.visible = true;
    this.unsub = [];
    const bus = ctx.bus, on = (name, fn) => { if (bus) this.unsub.push(bus.on(name, fn)); };
    on('hit', (h) => this._onHit(h));
    on('clash', (e) => this._onClash(e));                          // blade on shield (the blocked hit has already thrown its sparks) or on stone
    on('boss-slam', (e) => this._onSlam(e));
    // her poise breaks, or she is driven into her second phase: the blow that did it is told right after, in the same step
    on('boss-stagger', () => { this.brokeAt = this.clock; });
    on('boss-phase', () => { this.brokeAt = this.clock; });
    on('roll', (e) => this._onRoll(e));
    on('step', (e) => this._onStep(e));
    on('land', (e) => this._onLand(e));
    on('candles', (e) => { if (e && e.how === 'snuff') { const b = ctx.boss; this.moths.scatter(b ? b.pos.x : 0, b ? b.pos.z : 0, 80, 2.8); this.moths.nextLook = 0; } });
    on('state', (e) => { if (e && (e.to === 'fight' || e.to === 'title' || e.to === 'intro') && e.from !== 'phase' && e.from !== 'intro') this.reset(); });
  }

  _n(k) { this.calls[k] = (this.calls[k] || 0) + 1; }

  // ------------------------------------------------------------------------------------------------- small helpers
  /** A direction near `dir` (unit), spread 0 = exactly dir, 1 = anywhere. Result in _d. */
  _cone(dir, spread) {
    const r = this.rng, z = r.signed(), a = r.next() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    _d.set(s * Math.cos(a), z, s * Math.sin(a)).multiplyScalar(spread).addScaledVector(dir, 1 - spread);
    if (_d.lengthSq() < 1e-6) _d.copy(dir);
    return _d.normalize();
  }
  /** `dir` as a unit vector in _a (straight up when there is none). */
  _dir(dir) { if (dir && (dir.x || dir.y || dir.z)) _a.set(dir.x, dir.y, dir.z).normalize(); else _a.set(0, 1, 0); return _a; }

  /** The light of a blow: our point light, for a moment. strength 1 is about the lantern's worth. */
  _flash(x, y, z, color, strength, seconds) {
    const l = this.flashLight, f = this.flash; if (!l) return;
    const lantern = this.ctx.player && this.ctx.player.kit && this.ctx.player.kit.lantern && this.ctx.player.kit.lantern.light;
    const unit = lantern && lantern.intensity > 0.01 ? lantern.intensity : 6;
    const peak = unit * strength;
    if (f.t > 0 && l.intensity > peak) return;                     // a stronger one is still burning
    l.position.set(x, y, z); l.color.set(color); f.peak = peak; f.t = f.dur = seconds; l.intensity = peak; f.hold = true;      // full for the frame of the blow
  }

  _newTrail(weapon, look, opts) { const t = new Trail(this.ctx, this.noise, weapon, Object.assign({}, look, opts)); t.acc = 0; t.cut = 0; this.group.add(t.mesh); this.trails.push(t); return t; }

  // ------------------------------------------------------------------------------------------------------ the calls
  sparks(point, dir, count = 12, power = 1) {
    this._n('sparks'); if (this.off) return;
    const pw = Math.sqrt(power);
    this._sparks(point.x, point.y, point.z, this._dir(dir), count, power, 0.5, 0);
    this._glint(point.x, point.y, point.z, 0.34 * pw, 0.11, 13, 10, 6);
    this._flash(point.x, point.y, point.z, 0xffc890, 2.2 * pw, 0.09);
  }
  /** The sparks alone, thrown about the unit direction D (not kept). `spread` 0 = all one way, 1 = anywhere. `long`:
   *  how many more that are thrown slower and burn longer: they arc, fall, bounce once on the water and go out. */
  _sparks(x, y, z, D, count, power, spread = 0.5, long = 0) {
    const r = this.rng, pw = Math.sqrt(power); _c.copy(D);
    for (let i = 0; i < count; i++) {
      const fine = r.next() < 0.45, v = this._cone(_c, fine ? spread + 0.1 : spread - 0.1), sp = (fine ? 6 + 10 * r.next() : 2.5 + 6.5 * r.next() * r.next()) * pw;
      P.kind = KIND.SPARK; P.x = x; P.y = y; P.z = z; P.vx = v.x * sp; P.vy = v.y * sp + 1.2 * pw; P.vz = v.z * sp;
      P.life = fine ? 0.15 + 0.25 * r.next() : 0.5 + 0.8 * r.next(); P.size = fine ? 0.005 + 0.004 * r.next() : 0.007 + 0.01 * r.next() * r.next();
      P.seed = r.next(); P.stretch = 0.028 + 0.022 * r.next(); const hot = fine ? 6 + 5 * r.next() : 8 + 9 * r.next(); P.r = hot; P.g = hot; P.b = hot; P.a = 1;
      P.gravity = -G * 0.9; P.drag = fine ? 3.5 : 0.9 + 1.2 * r.next(); P.growth = 0.6; P.extra = 0;
      this.hot.emit(P);
    }
    for (let i = 0; i < long; i++) {
      const v = this._cone(_c, Math.min(0.9, spread + 0.2)), sp = (3 + 5 * r.next()) * pw;
      P.kind = KIND.SPARK; P.x = x; P.y = y; P.z = z; P.vx = v.x * sp; P.vy = v.y * sp + 2.2 * pw; P.vz = v.z * sp;
      P.life = 1.0 + 0.9 * r.next(); P.size = 0.011 + 0.009 * r.next(); P.seed = r.next(); P.stretch = 0.04 + 0.015 * r.next();
      const hot = 11 + 8 * r.next(); P.r = hot; P.g = hot; P.b = hot; P.a = 1; P.gravity = -G * 0.9; P.drag = 0.45 + 0.4 * r.next(); P.growth = 0.6; P.extra = 0;
      this.hot.emit(P);
    }
  }

  spray(point, dir, count = 20, power = 1) {
    this._n('spray'); if (this.off) return;
    const r = this.rng, pw = Math.sqrt(power);
    const D = this._dir(dir), down = D.y < -0.3;                    // pointed down: water running off something, not thrown up
    if (down) _b.copy(D); else _b.copy(D).addScaledVector(UP, 0.9).normalize();
    const y0 = Math.max(point.y, WATER_Y + 0.02);
    for (let i = 0; i < count; i++) {
      const v = this._cone(_b, down ? 0.25 : 0.42), sp = (down ? 0.3 + 1.2 * r.next() : 1.6 + 4.2 * r.next()) * pw;
      this._drop(point.x + r.signed() * 0.08, y0, point.z + r.signed() * 0.08, v.x * sp, down ? v.y * sp : Math.abs(v.y) * sp, v.z * sp, 1);
    }
    const puffs = down ? 0 : Math.max(1, Math.round(count / 7));
    for (let i = 0; i < puffs; i++) {
      const v = this._cone(_b, 0.5), sp = (1.0 + 2.0 * r.next()) * pw;
      this._veil(point.x + r.signed() * 0.15, y0 + 0.1, point.z + r.signed() * 0.15, v.x * sp, Math.abs(v.y) * sp * 0.8 + 0.4, v.z * sp, (0.28 + 0.3 * r.next()) * pw, 0.75 + 0.7 * r.next(), 0.2, 0.75);
    }
    if (power >= 1.6) {                                            // a sheet torn off the floor, thrown the way `dir` points
      const yaw = Math.atan2(D.x, D.z), flat = Math.hypot(D.x, D.z), ring = flat <= 0.2;
      this.sheets.spawn(point.x - D.x * 0.25, point.z - D.z * 0.25, yaw, ring ? Math.PI : 1.35, 0.3, (1.3 + 1.2 * pw) * Math.max(0.3, flat), 2.2 + 1.3 * pw, 0.5, 0.3, 0, r.next());
      this.sheets.spawn(point.x - D.x * 0.1, point.z - D.z * 0.1, yaw, ring ? Math.PI : 0.7, 0.15, (2.2 + 1.8 * pw) * Math.max(0.3, flat), 3.0 + 1.7 * pw, 0.42, 0.45, 0.04, r.next());
    }
  }

  /** A wall of water thrown toward `dir` from a line `width` metres long centred on `point` (a blade along the floor). */
  sheet(point, dir, width = 3, power = 1) {
    this._n('sheet'); if (this.off) return;
    const D = this._dir(dir), flat = Math.hypot(D.x, D.z) || 1, fx = D.x / flat, fz = D.z / flat, R = 30, pw = Math.sqrt(power), r = this.rng;
    this.sheets.spawn(point.x - fx * R, point.z - fz * R, Math.atan2(fx, fz), (width * 0.5) / R, R, 1.2 + 1.6 * pw, 2.8 + 1.9 * pw, 0.55, 0.3, 0, r.next());
    const n = Math.round(width * 9 * pw);
    for (let i = 0; i < n; i++) {
      const s = r.signed() * width * 0.5, sp = 1.5 + 3.5 * r.next() * pw;
      this._drop(point.x - fz * s, WATER_Y + 0.03, point.z + fx * s, fx * sp + r.signed(), (2.2 + 3.6 * r.next()) * pw, fz * sp + r.signed(), 1);
    }
    for (let i = 0; i < Math.round(width * 1.2); i++) { const s = r.signed() * width * 0.5; this._veil(point.x - fz * s, WATER_Y + 0.2, point.z + fx * s, fx * 1.6, 0.9 + r.next(), fz * 1.6, 0.5 + 0.4 * r.next(), 1.1 + r.next(), 0.2, 0.6); }
  }

  splashRing(pos, radius = 2, power = 1) {
    this._n('splashRing'); if (this.off) return;
    if (this._slam(pos.x, pos.z, radius, power)) { const w = this.ctx.water; if (w && w.ripple) w.ripple(pos.x, pos.z, 1.5 + power, Math.max(0.3, radius * 0.35)); }
  }

  dust(point, count = 6) {
    this._n('dust'); if (this.off) return;
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      P.kind = KIND.PUFF; P.x = point.x + r.signed() * 0.2; P.y = point.y + r.signed() * 0.1; P.z = point.z + r.signed() * 0.2;
      P.vx = r.signed() * 1.3; P.vy = 0.3 + 0.9 * r.next(); P.vz = r.signed() * 1.3; P.life = 1.3 + 1.2 * r.next(); P.size = 0.35 + 0.35 * r.next(); P.seed = r.next(); P.stretch = 0;
      P.r = 0.44; P.g = 0.45; P.b = 0.5; P.a = 0.26; P.gravity = 0.12; P.drag = 2.2; P.growth = 3.2; P.extra = 0; this.soft.emit(P);
    }
  }

  embers(point, count = 10) {
    this._n('embers'); if (this.off) return;
    const r = this.rng;
    for (let i = 0; i < count; i++) this._ember(point.x + r.signed() * 0.12, point.y + r.signed() * 0.12, point.z + r.signed() * 0.12, r.signed() * 0.7, 0.5 + 1.5 * r.next(), r.signed() * 0.7, 3.2, 1.7, 0.55, 1.2 + 1.6 * r.next());
  }

  motes(point, count = 10, color = 0xffe2a0) {
    this._n('motes'); if (this.off) return;
    const r = this.rng; _col.set(color);
    for (let i = 0; i < count; i++) this._mote(point.x + r.signed() * 0.3, point.y + r.signed() * 0.3, point.z + r.signed() * 0.3, r.signed() * 0.35, 0.1 + 0.4 * r.next(), r.signed() * 0.35, _col, 1.6, 2 + 2.2 * r.next());
  }

  /** A ring of light running out along the water from `pos` to `radius` in `seconds`. The ring's `radius` is where it is now. */
  shock(pos, radius = 14, color = 0xffe2a0, seconds = 2.2, from = 0.8, glint = 1) {
    this._n('shock'); if (this.off) return { alive: false, radius, x: pos.x, z: pos.z, progress: 1, width: 0.35, height: 1 };
    _col.set(color);
    const h = this.shocks.spawn(pos.x, WATER_Y, pos.z, from, radius, seconds, _col, 1.15, this.rng.next());
    if (glint > 0) this._glint(pos.x, WATER_Y + 0.4, pos.z, 1.6 * glint, 0.16, _col.r * 3 * glint, _col.g * 3 * glint, _col.b * 3 * glint);
    return h;
  }

  /** A ribbon behind a blade. weapon = { base, tip } (Object3D). opts: see TRAIL_LOOKS in trails.js; { look: 'pilgrim' | 'cantor' } picks one. */
  trail(weapon, opts = {}) {
    if (this.off || !weapon || !weapon.tip || !weapon.base) return { start() {}, stop() {}, set() {} };
    let t = null; for (const x of this.trails) if (x.weapon.tip === weapon.tip) { t = x; break; }
    const who = opts.look || opts.who, named = who === 'cantor' || who === 'boss' ? TRAIL_LOOKS.cantor : who === 'pilgrim' || who === 'player' || who === 'knight' ? TRAIL_LOOKS.pilgrim : null;
    if (!t) {
      // whose blade is it? told, or the Cantor's own, or by its length (a fighter being built is not in ctx yet)
      const boss = this.ctx.boss && this.ctx.boss.kit && this.ctx.boss.kit.sword && this.ctx.boss.kit.sword.tip === weapon.tip;
      weapon.base.getWorldPosition(_f); weapon.tip.getWorldPosition(_g);
      t = this._newTrail(weapon, named || (boss || _f.distanceTo(_g) > 2.2 ? TRAIL_LOOKS.cantor : TRAIL_LOOKS.pilgrim), opts);
    } else { if (named) t.set(named); t.set(opts); }
    if (opts.auto !== true) { t.manual = true; t.on = false; }      // the owner says when from now on
    if (!t.handle.dispose) t.handle.dispose = () => this._dropTrail(t);
    return t.handle;
  }
  _dropTrail(t) { const i = this.trails.indexOf(t); if (i >= 0) this.trails.splice(i, 1); for (let k = 0; k < 2; k++) if (this.own[k] === t) this.own[k] = null; t.dispose(); }

  hitFlash(character, seconds = 0.14, color = 0xffe9c4, power = 1.6) { this._n('hitFlash'); if (this.off) return; this.bodies.flash(character, seconds, color, power); }

  /** The ending: turn a body to light and drifting motes, from the ends of its limbs inward. opts: { color, kit }. */
  dissolve(object3d, seconds = 4, opts = {}) { this._n('dissolve'); if (this.off) return { progress: 1, done: true, cancel() {} }; return this.bodies.dissolve(object3d, seconds, opts); }

  /** Flash, sparks and a ring in one call, for a clean hit with nobody named. `dir` is the way the blow was going.
   *  The weight is taken from `power`: under 1.4 light, under 2.5 heavy, from there colossal (docs/impact.md). */
  impact(point, dir, power = 1) {
    this._n('impact'); if (this.off) return;
    _e.copy(this._dir(dir)); _hn.set(-_e.x * 0.6, 0.8, -_e.z * 0.6).normalize();      // the surface is taken to face up and against the blow
    this._strike(point, _e, _hn, power >= 2.5 ? COLOSSAL : power >= 1.4 ? HEAVY : LIGHT, 0);
  }

  /**
   * What a blow throws at its point of contact, in the three weights (WEIGHT above). Everything is placed at `p` and
   * turned along the blow: `d` is the way the blade was going, `n` the struck surface's outward normal (unit vectors,
   * read at once). what: 0 steel on plate or shield (sparks), 1 light (motes of gold, no sparks), 2 water or a body
   * (no sparks). All of it is born on the same step, so it shows complete on the frame of the contact.
   */
  _strike(p, d, n, w, what = 0) {
    const W = WEIGHT[w], r = this.rng, x = p.x, y = p.y, z = p.z, cam = this.ctx.camera;
    // the blow along the surface: what is left of it when the part going into the body is taken out
    const into = Math.min(0, d.x * n.x + d.y * n.y + d.z * n.z);
    _ht.set(d.x - n.x * into, d.y - n.y * into, d.z - n.z * into);
    if (_ht.lengthSq() < 0.02) _ht.set(-n.z, 0.35, n.x);            // a thrust straight in has no way along: any will do
    _ht.normalize();
    if (what === 0) {                                              // sparks skitter off the way the blade goes, and off the surface
      _hx.copy(_ht).multiplyScalar(0.85).addScaledVector(n, 0.5); _hx.y += 0.12; _hx.normalize();
      this._sparks(x, y, z, _hx, W.n, W.sp, w === 0 ? 0.36 : 0.45, W.long);
    } else if (what === 1) {                                       // light on a body: it bursts into motes
      for (let i = 0; i < 8 + W.motes * 2; i++) { const v = this._cone(n, 0.8), s = 0.6 + 2.6 * r.next(); this._mote(x, y, z, v.x * s + d.x, v.y * s + 0.5, v.z * s + d.z, _gold, 1.7, 0.5 + 0.8 * r.next()); }
    }
    // the flash: a ball of light at the point and, from a heavy blow up, a line of light along the cut
    const warm = what === 1 ? 0.8 : 1;
    this._glint(x, y, z, W.glint, W.gl, 16, 13.5 * warm, 9.5 * warm * warm);
    if (W.line > 0 && what !== 2) {
      this._line(x, y, z, _ht, W.line, W.gl * 0.9, 0.05 + 0.03 * w, 15, 12.5, 9);
      if (w === COLOSSAL) { _hx.crossVectors(n, _ht); if (_hx.lengthSq() > 0.01) this._line(x, y, z, _hx.normalize(), W.line * 0.55, W.gl * 0.75, 0.06, 13, 11.5, 9); }
    }
    // the ring of pressure: on the struck surface, turned part way to the eye so that it is never seen edge on
    _hr.copy(n).multiplyScalar(0.7);
    if (cam) { _hp.set(cam.position.x - x, cam.position.y - y, cam.position.z - z); const l = _hp.length(); if (l > 1e-3) _hr.addScaledVector(_hp, 0.6 / l); }
    if (_hr.lengthSq() < 0.01) _hr.copy(n); _hr.normalize();
    this._ring(x, y, z, _hr, W.ring, W.rl, 1.5 * W.rb, 1.32 * W.rb, 1.05 * W.rb, 1);
    if (w === COLOSSAL) this._waterRing(x, z, 11, 0.5);            // and the full set: a ring running out across the water
    if (W.gust > 0) this.mist.blow(x, z, W.gust, this.clock);       // the mist is pushed aside
    this._flash(x, y, z, what === 1 ? 0xffd890 : 0xffd9a8, W.light, W.ls);
  }
  /** The ring of pressure a colossal blow sends across the water: thin, pale, quick, nothing like her rings of light.
   *  One blow gives one: a slam and the hit of the same stroke do not each throw theirs. */
  _waterRing(x, z, size, life) {
    const L = this.wring;
    if (this.clock - L.t < 0.35 && Math.hypot(x - L.x, z - L.z) < 9) return;
    L.x = x; L.z = z; L.t = this.clock;
    this._ring(x, WATER_Y + 0.03, z, UP, size, life, 0.34, 0.42, 0.55, 1.7 / size);
  }
  /** A ring of pressure: a thin circle of light opening out to `size` metres across, facing the unit vector f. */
  _ring(x, y, z, f, size, life, cr, cg, cb, thick = 1) {
    P.kind = KIND.RING; P.x = x; P.y = y; P.z = z; P.vx = f.x; P.vy = f.y; P.vz = f.z; P.life = life; P.size = size; P.seed = this.rng.next(); P.stretch = 0;
    P.r = cr; P.g = cg; P.b = cb; P.a = 1; P.gravity = 0; P.drag = 0; P.growth = 1.25; P.extra = thick; this.hot.emit(P);
  }
  /** A line of light `len` metres long through a place, along the unit vector t: the cut itself, for an instant. */
  _line(x, y, z, t, len, life, width, cr, cg, cb) {
    const sp = 2.5, k = len * 0.5 - sp * life * 0.5;               // it slides a little the way the blade went; centred on the place at half its life
    P.kind = KIND.FLASH; P.x = x + t.x * k; P.y = y + t.y * k; P.z = z + t.z * k; P.vx = t.x * sp; P.vy = t.y * sp; P.vz = t.z * sp; P.life = life; P.size = width;
    P.seed = this.rng.next(); P.stretch = len / sp; P.r = cr; P.g = cg; P.b = cb; P.a = 1; P.gravity = 0; P.drag = 0; P.growth = 0.35; P.extra = 0; this.hot.emit(P);
  }
  /** A chip of stone: it tumbles, catches the light now and then, falls into the water. */
  _chip(x, y, z, vx, vy, vz) {
    const r = this.rng, s = 0.3 + 0.25 * r.next();
    P.kind = KIND.DROP; P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz; P.life = 1.8; P.size = 0.006 + 0.012 * r.next() * r.next(); P.seed = r.next(); P.stretch = 0.01;
    P.r = 1.15 * s; P.g = 1.0 * s; P.b = 0.82 * s; P.a = 1; P.gravity = -G; P.drag = 0.5 + 0.6 * r.next(); P.growth = 1; P.extra = 0;
    this.hot.emit(P);
  }

  /** Blow the mist open round a place; power 0..1. */
  gust(pos, power = 0.8) { if (this.off) return; this.mist.blow(pos.x, pos.z, power, this.clock); }

  /** Everything in flight gone at once, and anything dissolved back as it was (the fight begins again). */
  reset() {
    if (this.off) return;
    this.hot.clear(); this.soft.clear(); this.sheets.clear(); this.shocks.clear(); this.bodies.cancelAll();
    for (const t of this.trails) t.clear();
    for (const j of this.jobs) j.on = false; for (const q of this.slams) q.on = false;
    if (this.flashLight) this.flashLight.intensity = 0; this.flash.t = 0;
  }

  // ------------------------------------------------------------------------------------------- single particles
  _drop(x, y, z, vx, vy, vz, bright) {
    const r = this.rng;
    P.kind = KIND.DROP; P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz; P.life = 2.2; P.size = 0.003 + 0.007 * r.next() * r.next(); P.seed = r.next(); P.stretch = 0.018;
    P.r = 0.8 * bright; P.g = 0.9 * bright; P.b = 1.0 * bright; P.a = 1; P.gravity = -G; P.drag = 0.35 + 0.8 * r.next(); P.growth = 1; P.extra = 0;
    this.hot.emit(P);
  }
  _veil(x, y, z, vx, vy, vz, size, life, alpha, speck) {
    P.kind = KIND.PUFF; P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz; P.life = life; P.size = size; P.seed = this.rng.next(); P.stretch = 0;
    P.r = 0.6; P.g = 0.68; P.b = 0.78; P.a = alpha; P.gravity = -0.7; P.drag = 2.6; P.growth = 2.6; P.extra = speck;
    this.soft.emit(P);
  }
  _mote(x, y, z, vx, vy, vz, color, gain, life, scale = 1) {
    const r = this.rng;
    P.kind = KIND.MOTE; P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz; P.life = life; P.size = (0.02 + 0.026 * r.next()) * scale; P.seed = r.next(); P.stretch = 0;
    P.r = color.r * gain; P.g = color.g * gain; P.b = color.b * gain; P.a = 1; P.gravity = 0.16; P.drag = 1.3; P.growth = 0.7; P.extra = 0.15 + 0.2 * r.next();
    this.hot.emit(P);
  }
  _ember(x, y, z, vx, vy, vz, cr, cg, cb, life, scale = 1) {
    const r = this.rng;
    P.kind = KIND.EMBER; P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz; P.life = life; P.size = (0.014 + 0.016 * r.next()) * scale; P.seed = r.next(); P.stretch = 0;
    P.r = cr; P.g = cg; P.b = cb; P.a = 1; P.gravity = 0.9; P.drag = 1.1; P.growth = 0.5; P.extra = 0.1 + 0.12 * r.next();
    this.hot.emit(P);
  }
  /** The instant of a blow: a small ball of light that is gone in a few frames. */
  _glint(x, y, z, size, life, cr, cg, cb) {
    P.kind = KIND.FLASH; P.x = x; P.y = y; P.z = z; P.vx = P.vy = P.vz = 0; P.life = life; P.size = size; P.seed = this.rng.next(); P.stretch = 0;
    P.r = cr; P.g = cg; P.b = cb; P.a = 1; P.gravity = 0; P.drag = 0; P.growth = 1.6; P.extra = 0; this.hot.emit(P);
  }

  // --------------------------------------------------------------------------------------------- water thrown up
  /** A crown where something came down at (x, z). Returns false when the same slam was already thrown a moment ago. */
  _slam(x, z, radius, power) {
    const L = this.last, r = this.rng;
    if (this.clock - L.t < 0.15 && Math.hypot(x - L.x, z - L.z) < 1) return false;
    L.x = x; L.z = z; L.t = this.clock;
    const pw = Math.sqrt(Math.max(0.05, power)), R = Math.max(0.3, radius);
    const up = Math.sqrt(2 * G * Math.min(3.4, 0.3 + 0.8 * Math.pow(power, 0.8)));
    // two crowns: a wide low one at the rim of the blow, and a taller, thinner one inside it, a beat later
    this.sheets.spawn(x, z, r.next() * 6.28, Math.PI, R * 0.5, R * 0.75, up, 0.65, 0.2, 0, r.next());
    this.sheets.spawn(x, z, r.next() * 6.28, Math.PI, R * 0.2, R * 0.3, up * 1.25, 0.55, 0.4, 0.05, r.next());
    const drops = Math.min(220, Math.round(50 * pw * (0.6 + 0.4 * R)));
    for (let i = 0; i < drops; i++) {
      const a = r.next() * 6.283, rad = R * (0.2 + 0.4 * r.next()), out = (0.6 + 2.6 * r.next()) * (0.5 + 0.5 * R * 0.4), vy = up * (0.45 + 0.85 * r.next());
      this._drop(x + Math.sin(a) * rad, WATER_Y + 0.03, z + Math.cos(a) * rad, Math.sin(a) * out, vy, Math.cos(a) * out, 1);
    }
    const puffs = Math.min(22, Math.round(6 + 5 * pw * R * 0.6));
    for (let i = 0; i < puffs; i++) {
      const a = (i + r.next()) / puffs * 6.283, rad = R * (0.35 + 0.3 * r.next()), out = 1.5 + 2.4 * r.next() * pw;
      this._veil(x + Math.sin(a) * rad, WATER_Y + 0.15 + 0.3 * r.next(), z + Math.cos(a) * rad, Math.sin(a) * out, 0.5 + 1.4 * r.next() * pw, Math.cos(a) * out, (0.5 + 0.5 * r.next()) * (0.6 + 0.4 * pw), 1.5 + 1.3 * r.next(), 0.2, 0.35);
    }
    this.mist.blow(x, z, Math.min(0.92, 0.35 + 0.2 * power), this.clock);
    this.moths.scatter(x, z, R + 5, 3 + power);
    return true;
  }
  /** A foot coming down in the water. size 1 = the pilgrim at a run. (dx, dz) is the way he is going. */
  _foot(x, z, dx, dz, size) {
    const r = this.rng, n = Math.round(9 + 6 * size), s = Math.sqrt(size);
    for (let i = 0; i < n; i++) { const a = r.next() * 6.283, o = 0.5 + 1.5 * r.next(); this._drop(x + r.signed() * 0.08 * size, WATER_Y + 0.02, z + r.signed() * 0.08 * size, Math.sin(a) * o + dx * 1.3, (1.1 + 2.2 * r.next()) * s, Math.cos(a) * o + dz * 1.3, 1); }
    this.sheets.spawn(x, z, r.next() * 6.28, Math.PI, 0.07 * size, 0.55 * s, 2.3 * s, 0.5, 0.55, 0, r.next());           // a small crown round the boot
    this._veil(x, WATER_Y + 0.1, z, dx * 0.5, 0.5, dz * 0.5, 0.3 * size, 0.55 + 0.3 * r.next(), 0.2, 0.75);
  }

  // ------------------------------------------------------------------------------------------- what the bus says
  /**
   * The weight of a blow, as docs/impact.md has it: LIGHT his ordinary cuts; HEAVY his charged blow and her ordinary
   * blows; COLOSSAL her cleave and leap (the blows that throw him down), the blow that breaks her poise, and any
   * killing blow. Combat says it on every hit (`hit.weight`: 'light' | 'heavy' | 'colossal') and effects take its
   * word, so the sparks agree with the hit-stop, the camera and the sound. Only a hit that comes without one (a demo,
   * an older caller) is weighed here, from heavy, damage, knockdown, fatal, kind and a 'boss-stagger' in the same step.
   */
  _weight(h) {
    const k = h.weight;
    if (k === 'light') return LIGHT; if (k === 'heavy') return HEAVY; if (k === 'colossal') return COLOSSAL;
    if (h.target === this.ctx.boss && h.target) return h.fatal || this.clock - this.brokeAt < 0.01 ? COLOSSAL : h.heavy ? HEAVY : LIGHT;
    if (h.fatal || h.knockdown || (!h.blocked && h.damage >= 46)) return COLOSSAL;
    if (h.kind === 'hymn' && !h.heavy) return LIGHT;               // one of seven small blades of light
    return HEAVY;
  }

  _onHit(h) {
    if (this.off || !h || !h.point) return;
    const ctx = this.ctx, p = h.point, t = h.target, a = h.attacker, w = this._weight(h), W = WEIGHT[w];
    this.lastHit = w;
    // the way the blade was going, in full (effects are turned along the blow)
    if (h.dir && (h.dir.x || h.dir.y || h.dir.z)) _e.set(h.dir.x, h.dir.y, h.dir.z).normalize(); else _e.set(0, 0, 0);
    // the struck surface: it faces whoever struck it (a blade arrives from its owner's side) and out of the body's own middle
    _hn.set(0, 0, 0);
    if (a && a.pos) { _hp.set(a.pos.x - p.x, 0, a.pos.z - p.z); const l = _hp.length(); if (l > 1e-3) _hn.addScaledVector(_hp, 0.7 / l); }
    if (t && t.pos) { _hp.set(p.x - t.pos.x, 0, p.z - t.pos.z); const l = _hp.length(); if (l > 1e-3) _hn.addScaledVector(_hp, 0.3 / l); }
    if (_hn.lengthSq() < 1e-4) _hn.set(-_e.x, 0, -_e.z);
    if (_hn.lengthSq() < 1e-4) _hn.set(0, 0, 1);
    _hn.normalize();
    if (_e.lengthSq() < 0.5) _e.copy(_hn).negate();
    const light = h.kind === 'chorale' || h.kind === 'hymn' || h.kind === 'tide', water = h.kind === 'leap' || h.kind === 'stomp';
    if (h.blocked) {                                               // steel on his shield: sparks, a flash, a ring; he is not hurt, so his body does not flash
      if (this._twice(p)) return;
      // at the shield itself (combat tells where the blade crossed his body; the blow was stopped a forearm before that)
      const sh = t && t.kit && t.kit.shield && t.kit.shield.object; let q = p;
      if (sh && sh.getWorldPosition) { sh.getWorldPosition(_g); if (_g.distanceTo(p) < 1.8) { _g.addScaledVector(_hn, 0.1); q = _g; } }
      if (h.guardBreak) {                                          // the blow that breaks his guard: one weight up at the board, and he lights up with it (he is beaten open, not cut)
        this._strike(q, _e, _hn, Math.min(COLOSSAL, w + 1), light ? 1 : 0);
        this.bodies.flash(t, 0.1, 0xffd2b0, 0.8, 2.4);
      } else this._strike(q, _e, _hn, w, light ? 1 : 0);
    } else if (t === ctx.boss) {                                   // his blade on her plate
      this._twice(p);
      this._strike(p, _e, _hn, w, 0);
      this.bodies.flash(t, W.flash, 0xfff0d0, W.fp * 0.9, W.fp * 1.1);           // she is the lightest thing in the hall already: a little goes far
      const r = this.rng;                                          // chips of her pale light
      for (let i = 0; i < W.motes; i++) this._mote(p.x, p.y, p.z, _ht.x * 1.6 + _hn.x + r.signed(), 0.5 + 1.1 * r.next(), _ht.z * 1.6 + _hn.z + r.signed(), _pale, 1.1, 0.7 + 0.9 * r.next());
    } else {                                                       // her blade, her light or her water on him
      this._twice(p);
      this._strike(p, _e, _hn, w, light ? 1 : water ? 2 : 0);
      this.bodies.flash(t, W.flash, light ? 0xffe0a0 : 0xffd2b0, W.fp, W.fp * 3.2);      // dark steel: it takes more to show
      const lan = t && t.kit && t.kit.lantern && t.kit.lantern.object;
      if (lan) { lan.getWorldPosition(_f); this.embers(_f, h.fatal ? 36 : w === COLOSSAL ? 18 : 8); }      // his flame gutters
    }
    // a blow that ends in the water throws it up, the way the blow was going
    if (p.y < WATER_Y + 0.45 || water) { _f.set(p.x, WATER_Y, p.z); _g.set(_e.x, 0, _e.z); this.spray(_f, _g, W.spray, W.sprayP); }
  }

  /**
   * `clash`: blade on shield (the blocked `hit` has thrown its sparks already: told twice, thrown once), or the
   * pilgrim's blade on stone: { point, stone: true, dir, normal, floor? }. A pier or a block gives sparks off its
   * face along the blow, chips and dust. The floor of the nave lies under the water: there the blow ends in spray,
   * with a few sparks off the stone beneath.
   */
  _onClash(e) {
    if (this.off || !e || !e.point || this._twice(e.point)) return;
    const p = e.point, r = this.rng;
    if (!e.stone) { this.sparks(p, UP, 16, 1.2); return; }
    // the face of the stone: told, or else looking out of the nearest pier or block of the hall
    _hn.set(0, 0, 0);
    if (e.normal && (e.normal.x || e.normal.y || e.normal.z)) _hn.set(e.normal.x, e.normal.y, e.normal.z);
    else {
      const cols = this.ctx.arena && this.ctx.arena.colliders; let best = 1e9;
      if (cols) for (const c of cols) { const dx = p.x - c.x, dz = p.z - c.z, l = Math.hypot(dx, dz), d = l - (c.r || 0); if (d < best && l > 1e-3) { best = d; _hn.set(dx, 0, dz); } }
      if (_hn.lengthSq() < 1e-6) { const pl = this.ctx.player; if (pl) _hn.set(pl.pos.x - p.x, 0, pl.pos.z - p.z); }
    }
    if (_hn.lengthSq() < 1e-6) _hn.set(0, 0, 1);
    _hn.normalize();
    // the blow, and what is left of it along the face
    if (e.dir && (e.dir.x || e.dir.y || e.dir.z)) _e.set(e.dir.x, e.dir.y, e.dir.z).normalize(); else _e.copy(_hn).negate();
    const into = Math.min(0, _e.dot(_hn)); _ht.copy(_e).addScaledVector(_hn, -into);
    if (_ht.lengthSq() < 0.02) _ht.set(-_hn.z, 0.3, _hn.x); _ht.normalize();
    const heavy = !!e.heavy || e.weight === 'heavy' || e.weight === 'colossal', hers = e.who === 'boss';
    if (hers) {                                                    // five metres of her blade on a pier or a fallen stone: the full set of a heavy (or colossal) blow, off the stone's face, and the stone answers
      const w = e.weight === 'colossal' ? COLOSSAL : HEAVY, n = w === COLOSSAL ? 46 : 30;
      this._strike(p, _e, _hn, w, 0);
      for (let i = 0; i < n; i++) {                                // chips of stone thrown out of the face and along the cut
        const o = 1.5 + 4.5 * r.next(), al = 3.5 * r.next();
        this._chip(p.x + _hn.x * 0.06, p.y + r.signed() * 0.25, p.z + _hn.z * 0.06, _hn.x * o + _ht.x * al + r.signed() * 1.8, 0.6 + 3.4 * r.next(), _hn.z * o + _ht.z * al + r.signed() * 1.8);
      }
      for (let i = 0; i < (w === COLOSSAL ? 16 : 11); i++) {       // and its dust, hanging before the face
        P.kind = KIND.PUFF; P.x = p.x + _hn.x * 0.15 + r.signed() * 0.3; P.y = p.y + r.signed() * 0.4; P.z = p.z + _hn.z * 0.15 + r.signed() * 0.3;
        const o = 0.6 + 1.8 * r.next(); P.vx = _hn.x * o + _ht.x * 0.9 + r.signed() * 0.6; P.vy = 0.1 + 0.6 * r.next(); P.vz = _hn.z * o + _ht.z * 0.9 + r.signed() * 0.6;
        P.life = 1.3 + 1.2 * r.next(); P.size = 0.25 + 0.3 * r.next(); P.seed = r.next(); P.stretch = 0;
        P.r = 0.5; P.g = 0.49; P.b = 0.5; P.a = 0.22; P.gravity = -0.25; P.drag = 2.2; P.growth = 3.2; P.extra = 0.3; this.soft.emit(P);
      }
      if (p.y < WATER_Y + 0.6) { _f.set(p.x, WATER_Y, p.z); _g.set(_ht.x, 0, _ht.z); this.spray(_f, _g, 24, 1.5); }
      return;
    }
    if ((e.floor || _hn.y > 0.7) && p.y < WATER_Y + 0.05) {         // the floor under the water: the blow ends in spray
      _f.set(p.x, WATER_Y, p.z); _g.set(_ht.x, 0, _ht.z);
      this.spray(_f, _g, heavy ? 26 : 16, heavy ? 1.4 : 0.9);
      _hx.set(_ht.x * 0.6, 0.8, _ht.z * 0.6).normalize();
      this._sparks(p.x, WATER_Y + 0.04, p.z, _hx, heavy ? 12 : 7, 0.9, 0.5, heavy ? 2 : 1);
      this._glint(p.x, WATER_Y + 0.06, p.z, heavy ? 0.3 : 0.2, 0.07, 9, 8.6, 8);
      return;
    }
    _hx.copy(_ht).multiplyScalar(0.7).addScaledVector(_hn, 0.7); _hx.y += 0.2; _hx.normalize();
    this._sparks(p.x, p.y, p.z, _hx, heavy ? 34 : 16, heavy ? 1.9 : 1.0, 0.5, heavy ? 6 : 2);      // by the blow's weight (combat says it since the fight polish): a tap and a charged blow do not throw the same
    this._glint(p.x, p.y, p.z, heavy ? 0.6 : 0.32, heavy ? 0.12 : 0.09, 14, 10.5, 6.5);
    if (heavy) { this._line(p.x, p.y, p.z, _ht, 1.5, 0.1, 0.05, 14, 11, 7); this._ring(p.x, p.y, p.z, _hn, 1.7, 0.2, 1.3, 1.1, 0.85, 1); }
    this._flash(p.x, p.y, p.z, 0xffc890, heavy ? 4 : 2.2, heavy ? 0.12 : 0.08);
    for (let i = 0; i < (heavy ? 18 : 11); i++) {                   // chips off the stone: out of its face and along the cut, falling into the water
      const o = 1.0 + 3.0 * r.next(), al = 2.2 * r.next();
      this._chip(p.x + _hn.x * 0.04, p.y + r.signed() * 0.05, p.z + _hn.z * 0.04, _hn.x * o + _ht.x * al + r.signed() * 1.2, 0.4 + 2.4 * r.next() + _hn.y * o, _hn.z * o + _ht.z * al + r.signed() * 1.2);
    }
    for (let i = 0; i < (heavy ? 9 : 6); i++) {                     // and its dust, drifting out of the face and sinking
      P.kind = KIND.PUFF; P.x = p.x + _hn.x * 0.1 + r.signed() * 0.08; P.y = p.y + r.signed() * 0.1; P.z = p.z + _hn.z * 0.1 + r.signed() * 0.08;
      const o = 0.5 + 1.3 * r.next(); P.vx = _hn.x * o + _ht.x * 0.6 + r.signed() * 0.5; P.vy = 0.1 + 0.5 * r.next(); P.vz = _hn.z * o + _ht.z * 0.6 + r.signed() * 0.5;
      P.life = 1.0 + 1.0 * r.next(); P.size = 0.12 + 0.16 * r.next(); P.seed = r.next(); P.stretch = 0;
      P.r = 0.5; P.g = 0.49; P.b = 0.5; P.a = 0.2; P.gravity = -0.25; P.drag = 2.4; P.growth = 3.4; P.extra = 0.3; this.soft.emit(P);
    }
  }

  /** Blade or body strikes the floor (`boss-slam`). It is told in the middle of her step, before her blade has its
   *  place for that step, so it is only noted here and thrown in our own update of the same step (_slams). */
  _onSlam(e) {
    if (this.off || !e || !e.pos) return;
    for (const q of this.slams) if (!q.on) { q.on = true; q.x = e.pos.x; q.z = e.pos.z; q.R = e.radius || 3; q.power = e.power || 1; return; }
  }
  /**
   * The slams noted this step: the crown by radius and power; a blow of power 1 or more (her cleave, her leap) is
   * colossal: steel on the stone under the water, a flash, a ring of pressure across the water, and where the blade
   * lies along the floor a wall of water torn up on either side of it.
   * The place is the one she tells: since her second pass she tells every slam after her posture, at the very place
   * the blade (its point, or the middle of a blade lying on the water), her heel or her knee meets the floor
   * (measured headless, fight polish, 8 Nov: 0.00 m from the blade as it stands at the end of her step, in every
   * move). Only whether the blade LIES along the water there is read from the blade itself.
   */
  _slams() {
    const boss = this.ctx.boss, sw = boss && boss.kit && boss.kit.sword;
    for (const q of this.slams) {
      if (!q.on) continue; q.on = false;
      const x = q.x, z = q.z, R = q.R, power = q.power; let lying = false;
      if (sw && sw.tip && sw.base && power >= 1) {                  // a great blow: does the blade lie along the floor through this place?
        sw.tip.getWorldPosition(_f); sw.base.getWorldPosition(_g);
        const dx = _f.x - _g.x, dz = _f.z - _g.z, l2 = dx * dx + dz * dz, u = l2 > 1e-6 ? Math.min(1, Math.max(0, ((x - _g.x) * dx + (z - _g.z) * dz) / l2)) : 0;
        lying = _f.y < 0.9 && _g.y < 3.2 && l2 > 4.8 && Math.hypot(x - _g.x - dx * u, z - _g.z - dz * u) < 0.9;
      }
      const small = power < 0.6;                                    // the point of a cut touching down (0.4): a splash where it meets the water, no more
      if (!this._slam(x, z, small ? Math.min(R, 2.4) * 0.42 : R, small ? power * 0.6 : power)) continue;
      if (small) { this._ring(x, WATER_Y + 0.03, z, UP, 2.2, 0.3, 0.32, 0.4, 0.5, 0.5); continue; }
      if (power >= 1) {
        this._sparks(x, WATER_Y + 0.06, z, UP, 40, 2.6, 0.8, 12);
        this._glint(x, WATER_Y + 0.25, z, 0.9, 0.14, 12, 11.5, 10);
        this._waterRing(x, z, R * 3.2, 0.6);
        this._flash(x, 1.4, z, 0xe6ecff, 5, 0.18);
        if (lying) {                                               // the blade lies along the floor: the water goes up on both sides of it
          const dx = _f.x - _g.x, dz = _f.z - _g.z, l = Math.hypot(dx, dz) || 1, px = -dz / l, pz = dx / l, r = this.rng;
          for (let i = 0; i < 3; i++) {
            const u = 0.38 + 0.23 * i, qx = _g.x + dx * u, qz = _g.z + dz * u, up = 3.6 + 1.2 * r.next();
            this.sheets.spawn(qx - px * 0.25, qz - pz * 0.25, Math.atan2(px, pz), 1.0, 0.3, 2.4, up, 0.5, 0.35, 0.03 * i, r.next());
            this.sheets.spawn(qx + px * 0.25, qz + pz * 0.25, Math.atan2(-px, -pz), 1.0, 0.3, 2.4, up, 0.5, 0.35, 0.03 * i, r.next());
            for (let k = 0; k < 14; k++) { const side = k & 1 ? 1 : -1, o = 1 + 3.5 * r.next(); this._drop(qx + r.signed() * 0.5, WATER_Y + 0.03, qz + r.signed() * 0.5, px * side * o + r.signed(), 2 + 4 * r.next(), pz * side * o + r.signed(), 1); }
          }
        }
      } else {
        this._ring(x, WATER_Y + 0.03, z, UP, R * 2.2, 0.42, 0.5, 0.6, 0.75, 0.35);
        this._flash(x, 1.2, z, 0xdfe8ff, 2.6, 0.12);
      }
    }
  }
  _onRoll(e) {
    if (this.off || !e || !e.pos) return;
    const j = this._job(); if (!j) return;
    const d = e.dir, l = d ? Math.hypot(d.x, d.z) || 1 : 1;
    j.kind = 'roll'; j.who = this.ctx.player; j.t = 0; j.dur = 0.55; j.dx = d ? d.x / l : 0; j.dz = d ? d.z / l : 1; j.power = 1; j.acc = 0; j.n = 0;
  }
  _onStep(e) {
    if (this.off || !e || !e.pos) return;
    const f = e.who === 'boss' ? this.ctx.boss : this.ctx.player, yaw = f ? f.yaw : 0, dx = Math.sin(yaw), dz = Math.cos(yaw);
    if (e.who === 'boss') this._foot(e.pos.x, e.pos.z, dx * 0.5, dz * 0.5, e.run ? 4 : 3);     // she is six metres tall: every step throws water
    else if (e.run) this._foot(e.pos.x, e.pos.z, dx, dz, 1);
  }
  _onLand(e) {
    if (this.off || !e || !e.pos) return;
    if (e.who === 'boss') this._slam(e.pos.x, e.pos.z, e.hard ? 4 : 2.6, e.hard ? 3 : 1.6);
    else { this._foot(e.pos.x, e.pos.z, 0, 0, e.hard ? 2.2 : 1.4); }
  }
  _job() { for (const j of this.jobs) if (!j.on) { j.on = true; return j; } return null; }
  /** Has a burst of sparks just been thrown at this place (one blow told as two events)? Remembers this one. */
  _twice(p) {
    const s = this.struck, again = this.clock - s.t < 0.06 && Math.abs(p.x - s.x) + Math.abs(p.y - s.y) + Math.abs(p.z - s.z) < 0.6;
    s.t = this.clock; s.x = p.x; s.y = p.y; s.z = p.z;
    return again;
  }

  // ---------------------------------------------------------------------------------------------------- the clock
  /** Once per fixed step. A fault in here must never stop the game: effects switch themselves off and say so. */
  update(dt) { if (this.off) return; try { this._update(dt); } catch (e) { this._fail(e); } }
  frame(dt, alpha = 0) { if (this.off) return; try { this._frame(dt, alpha); } catch (e) { this._fail(e); } }
  _fail(e) { this.off = true; if (this.group) this.group.visible = false; if (this.flashLight) this.flashLight.intensity = 0; console.error('vfx: switched off after an error: ' + (e && e.stack ? e.stack : e)); }

  _update(dt) {
    const t0 = performance.now(), ctx = this.ctx, r = this.rng;
    this.time += dt; this.clock += dt; this.pt += dt; this.stepped = true;
    if (this.time > REBASE) { this.time -= REBASE; this.shocks.rebase(REBASE); for (const tr of this.trails) tr.rebase(REBASE); }
    if (this.pt > REBASE) { this.pt -= REBASE; this.hot.rebase(REBASE); this.soft.rebase(REBASE); this.sheets.rebase(REBASE); }
    const t = this.time, pt = this.pt;
    this.hot.now = pt; this.soft.now = pt; this.sheets.now = pt; this.shocks.now = t;
    this.probe.update(this.clock);
    this._slams();
    const mood = ctx.gfx && ctx.gfx.mood ? ctx.gfx.mood : null, gold = mood ? mood.gold : 0, boss = ctx.boss, player = ctx.player;
    // our light: full on the frame of the blow, then gone in a few steps
    const f = this.flash;
    if (f.t > 0 && this.flashLight) { if (f.hold) f.hold = false; else f.t -= dt; const k = Math.max(0, f.t / f.dur); this.flashLight.intensity = f.peak * k * k; }
    // the two fighters' blades: a ribbon each, without anyone asking
    this._own(0, player, TRAIL_LOOKS.pilgrim); this._own(1, boss, TRAIL_LOOKS.cantor);
    this._ghost(dt);
    for (const tr of this.trails) {
      if (tr === this.ghost.small || tr === this.ghost.large) { if (tr !== this.ghost.trail) continue; }
      tr.update(t, dt);
      if (tr === this.own[1] || tr === this.ghost.large) tr.boost = 1 + 0.5 * gold;
      if (tr.o.motes > 0 && tr.count > 3) {                        // light shed from where the great blade passed
        tr.acc += tr.o.motes * dt;
        while (tr.acc >= 1) { tr.acc -= 1; if (tr.pick(r.next() * 0.75, 0.25 + 0.75 * r.next(), _a)) this._mote(_a.x, _a.y, _a.z, r.signed() * 0.3, -0.1 - 0.5 * r.next(), r.signed() * 0.3, _gold, 1.3, 0.7 + 0.9 * r.next()); }
      }
      if (tr.dip.was) this._cut(tr);
    }
    // rings of light shed motes where they pass
    for (const h of this.shocks.handles) {
      if (!h.alive) continue;
      const n = Math.min(5, 1 + Math.floor(h.radius * 0.35));
      for (let i = 0; i < n; i++) { const a = r.next() * 6.283; this._mote(h.x + Math.sin(a) * h.radius, WATER_Y + 0.05, h.z + Math.cos(a) * h.radius, Math.sin(a) * 0.6, 0.5 + 0.9 * r.next(), Math.cos(a) * 0.6, _gold, 1.2, 0.5 + 0.7 * r.next()); }
    }
    // her own light, in phase two: embers rising from her
    if (gold > 0.03 && boss && boss.alive !== false) {
      this.acc.embers += 46 * gold * dt;
      while (this.acc.embers >= 1) {
        this.acc.embers -= 1; const a = r.next() * 6.283, rad = 0.7 + 2.0 * r.next();
        this._ember(boss.pos.x + Math.sin(a) * rad, 0.5 + 6.2 * r.next() * r.next(), boss.pos.z + Math.cos(a) * rad, Math.sin(a) * 0.3, 0.3 + 0.8 * r.next(), Math.cos(a) * 0.3, 7.5, 5.2, 1.9, 2 + 2.4 * r.next(), 2.2);
      }
    }
    // things that go on for a moment
    for (const j of this.jobs) {
      if (!j.on) continue;
      j.t += dt; if (j.t >= j.dur || !j.who) { j.on = false; continue; }
      if (j.kind === 'roll') {                                     // an arc of spray thrown off either side of him as he goes over
        const p = j.who.pos, k = Math.sin(Math.PI * Math.min(1, j.t / j.dur)); j.acc += (40 + 90 * k) * dt;
        while (j.acc >= 1) {
          j.acc -= 1; const side = r.next() < 0.5 ? -1 : 1, o = 1.2 + 2.2 * r.next();
          this._drop(p.x + r.signed() * 0.25, WATER_Y + 0.03, p.z + r.signed() * 0.25, -j.dz * side * o - j.dx * 0.8, 1.2 + 2.4 * r.next() * k, j.dx * side * o - j.dz * 0.8, 1);
        }
        if (j.n < 4 && j.t > j.n * 0.12) {                           // and a low fan of water off each side, four times along the way
          j.n++; const yaw = Math.atan2(j.dx, j.dz);
          this.sheets.spawn(p.x, p.z, yaw + 1.5708, 0.9, 0.2, 1.3, 2.5, 0.45, 0.5, 0, r.next()); this.sheets.spawn(p.x, p.z, yaw - 1.5708, 0.9, 0.2, 1.3, 2.5, 0.45, 0.5, 0, r.next());
          this._veil(p.x, WATER_Y + 0.15, p.z, -j.dx * 0.8, 0.7, -j.dz * 0.8, 0.5, 0.8 + 0.3 * r.next(), 0.24, 0.7);
        }
      }
    }
    this.sheets.update(pt); this.shocks.update(t, dt); this.hot.update(pt); this.soft.update(pt);
    // Whatever is thrown before our next update (a blow told on the bus during the next step, a call from a fighter)
    // is first drawn after that update: it is stamped with that moment, so it is whole on the frame of the contact
    // and nothing of a tenth-of-a-second flash is spent before anybody has seen it.
    this.hot.now = this.soft.now = this.sheets.now = pt + dt;
    this.mist.update(this.clock); this.dustAir.update(this.clock);
    this.moths.update(this.clock, dt, ctx.candles && typeof ctx.candles.lit === 'number' ? ctx.candles.lit : 1, this.flashLight);
    this.bodies.update(dt);
    if (this.prime > 0) { this.hot.mesh.visible = this.soft.mesh.visible = this.sheets.mesh.visible = this.shocks.mesh.visible = true; for (const tr of this.trails) tr.mesh.visible = true; }
    this.cpu.update += (performance.now() - t0 - this.cpu.update) * 0.05;
    if (this.log) {
      const L = this.log; this.trails.forEach((tr, i) => { if (i < 4 && tr.speed > L.peak[i]) L.peak[i] = tr.speed; });
      if (this.clock >= L.next) {
        L.next = this.clock + L.every;
        console.error('fx ' + this.clock.toFixed(2) + ' trails ' + this.trails.map((tr, i) => `[len ${tr.length.toFixed(2)} manual ${tr.manual} on ${tr.on} peak ${(L.peak[i] || 0).toFixed(1)} m/s samples ${tr.count} dip ${tr.dip.was}]`).join(' ') + ' moths at ' + this.moths.nAnchors + ' lights ' + this.probe.count + ' cpu ' + this.cpu.update.toFixed(3));
        L.peak.fill(0);
      }
    }
  }

  /** The fighters' own blades get a trail each as soon as they exist (and a new one if the blade is ever replaced). */
  _own(slot, fighter, look) {
    const sw = fighter && fighter.kit && fighter.kit.sword;
    if (!sw || !sw.tip || !sw.base) return;
    const cur = this.own[slot];
    if (cur && cur.weapon.tip === sw.tip) return;
    let t = null; for (const x of this.trails) if (x.weapon.tip === sw.tip) { t = x; break; }
    this.own[slot] = t || this._newTrail(sw, look);
  }

  /** A blade is in the water: throw spray where it cuts the surface, the way the cut runs. */
  _cut(tr) {
    const d = tr.dip, r = this.rng, big = tr.length > 2.2;
    if (d.enter) {
      if (d.speed > 2.5) { if (big) this._slam(d.x, d.z, 1.1, Math.min(2.2, 0.4 + d.speed * 0.05)); else { _f.set(d.x, WATER_Y, d.z); this.spray(_f, UP, 8, 0.6); } }
      tr.cut = this.clock; return;
    }
    if (d.speed < 1.5 || this.clock - tr.cut < (big ? 0.07 : 0.09)) return;
    tr.cut = this.clock;
    const dx = d.vx / d.speed, dz = d.vz / d.speed, s = Math.min(1, d.speed / (big ? 26 : 12));
    if (big) {
      this.sheets.spawn(d.x - dx * 0.4, d.z - dz * 0.4, Math.atan2(dx, dz), 0.8, 0.4, 1.5 + 4.5 * s, 3 + 3.6 * s, 0.5, 0.3, 0, r.next());
      for (let i = 0; i < 12; i++) { const o = (2 + 7 * r.next()) * (0.4 + 0.6 * s); this._drop(d.x + r.signed() * 0.4, WATER_Y + 0.03, d.z + r.signed() * 0.4, dx * o + r.signed() * 1.4, (2 + 5 * r.next()) * (0.5 + 0.5 * s), dz * o + r.signed() * 1.4, 1); }
      this._veil(d.x, WATER_Y + 0.3, d.z, dx * 2.5, 1.3, dz * 2.5, 0.8, 1.2 + 0.8 * r.next(), 0.2, 0.5);
      // five metres of steel dragged over the stone under the water: it strikes sparks as it goes
      if (s > 0.2) { _hx.set(dx * 0.7, 0.7, dz * 0.7).normalize(); this._sparks(d.x, WATER_Y + 0.05, d.z, _hx, 3 + Math.round(6 * s), 0.8 + s, 0.5, s > 0.6 ? 1 : 0); }
    } else {
      for (let i = 0; i < 5; i++) { const o = (1 + 3 * r.next()) * (0.4 + 0.6 * s); this._drop(d.x, WATER_Y + 0.02, d.z, dx * o + r.signed() * 0.6, 0.8 + 2.2 * r.next(), dz * o + r.signed() * 0.6, 1); }
      if (r.next() < 0.5) this._veil(d.x, WATER_Y + 0.08, d.z, dx, 0.5, dz, 0.2, 0.5, 0.15, 0.8);
    }
  }

  /** The demo blade: swung through an arc by us, so a trail can be looked at without a fighter. */
  _ghost(dt) {
    const g = this.ghost; if (!g.trail) return;
    g.t += dt; const k = Math.min(1, g.t / g.dur), e = k * k * (3 - 2 * k);
    g.pivot.rotation.set(g.tilt, g.from + (g.to - g.from) * e, 0); g.pivot.updateMatrixWorld(true);
    if (g.t > g.dur + 1.2) { g.trail.clear(); g.trail = null; }
  }
  _swing(big) {
    const g = this.ghost, c = this._stage(big ? 6 : 2.6);
    g.trail = big ? g.large : g.small; g.t = 0; g.dur = big ? 0.5 : 0.2; g.big = big; g.trail.clear();
    g.pivot.position.set(c.x, big ? 4.6 : 1.35, c.z); g.tilt = big ? 0.5 : -0.35;
    g.base.position.set(0, 0, big ? 1.6 : 0.55); g.tip.position.set(0, 0, big ? 6.2 : 1.5);
    g.from = big ? 2.3 : -2.0; g.to = big ? -0.9 : 1.9;
    g.pivot.rotation.set(g.tilt, g.from, 0); g.pivot.updateMatrixWorld(true);
  }

  _frame(dt, alpha) {
    const t0 = performance.now(), T = this.tune;
    this.lead = Math.min(1, Math.max(0, alpha)) * this.DT;
    // The world is being held (hit-stop: no step since the last frame, and the loop says alpha = 1): the two bodies
    // stand still, what was thrown flies on in real time. Never in a picture run (the world is not held there).
    if (!this.stepped && alpha >= 1 && dt > 0 && T.live > 0) { this.pt += Math.min(dt, 0.05) * T.live; this.hot.now = this.soft.now = this.sheets.now = this.pt + this.DT; }
    this.stepped = false;
    const t = this.time + this.lead, c = this.clock + this.lead, pt = this.pt + this.lead;
    this.hot.material.uniforms.uGain.value = T.hot; this.soft.material.uniforms.uGain.value = T.soft;
    this.sheets.material.uniforms.uGain.value = T.sheets; this.shocks.material.uniforms.uGain.value = T.shock;
    this.mist.uniforms.uOpacity.value = T.mist * T.air; this.dustAir.uniforms.uGain.value = T.dust * T.air; this.moths.uniforms.uGain.value = T.moths;
    this.hot.frame(pt); this.soft.frame(pt); this.sheets.frame(pt); this.shocks.frame(t);
    for (const tr of this.trails) tr.frame(t, T.trails);
    this.mist.frame(c); this.dustAir.frame(c); this.moths.frame(c, this.lead);
    if (this.prime > 0 && --this.prime === 0) { this.bodies.primed(); for (const tr of this.trails) tr.mesh.visible = tr.count >= 2; }
    this.cpu.frame += (performance.now() - t0 - this.cpu.frame) * 0.05;
    if (this.ab && !this.ab.sent && this.clock >= this.ab.from) this._ab();
  }

  /** dev (&fxab): one frame of the shown-and-hidden measurement. */
  _ab() {
    const a = this.ab, now = performance.now();
    if (a.last) (a.on ? a.tOn : a.tOff).push(now - a.last);                     // the time since the last frame belongs to how that frame was drawn
    a.last = now; a.n++;
    a.on = Math.floor(a.n / 12) % 2 === 0; this.group.visible = a.on;
    if (a.n < a.frames) return;
    a.sent = true; this.group.visible = true;
    const stat = (l) => { const s = l.slice().sort((x, y) => x - y), n = s.length; return n ? { n, median: +s[n >> 1].toFixed(2), mean: +(s.reduce((x, y) => x + y, 0) / n).toFixed(2), p90: +s[Math.floor(n * 0.9)].toFixed(2), min: +s[0].toFixed(2) } : { n: 0 }; };
    const on = stat(a.tOn), off = stat(a.tOff);
    const out = { shown: on, hidden: off, costMedianMs: +(on.median - off.median).toFixed(2), costMeanMs: +(on.mean - off.mean).toFixed(2), costP90Ms: +(on.p90 - off.p90).toFixed(2), cpu: this.stats() };
    console.warn('THREE fx ab: ' + JSON.stringify(out).slice(0, 150));
    fetch('/__shot/' + a.name, { method: 'POST', body: JSON.stringify(out) }).catch(() => {});
  }

  /** What effects cost on the CPU, in milliseconds a step and a frame (smoothed), and how much is alive. */
  stats() { return { updateMs: +this.cpu.update.toFixed(3), frameMs: +this.cpu.frame.toFixed(3), calls: this.calls }; }

  // ------------------------------------------------------------------------------------------------------- looking
  /** Where demos happen: a few steps in front of the pilgrim, toward the Cantor. Result in _c (on the floor). */
  _stage(ahead = 3.2) {
    const p = this.ctx.player, b = this.ctx.boss;
    if (!p) return _c.set(0, 0, 9);
    _c.set(b ? b.pos.x - p.pos.x : 0, 0, b ? b.pos.z - p.pos.z : -1);
    if (_c.lengthSq() < 1e-4) _c.set(0, 0, -1);
    _c.normalize().multiplyScalar(ahead).add(p.pos); _c.y = 0;
    return _c;
  }
  /** Fire one effect near the fighters: &do=vfx.demo("splashRing")@0.5 . Names: Object.keys(DEMOS) below. */
  demo(name = 'sparks') {
    const fn = DEMOS[name];
    if (!fn) { console.warn('vfx.demo: no demo named "' + name + '". There are: ' + Object.keys(DEMOS).join(', ')); return; }
    if (!this.off) fn(this);
  }

  dispose() {
    if (!this.group) return;
    this.off = true;
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.bodies.dispose();
    for (const t of this.trails) t.dispose();
    for (const x of [this.hot, this.soft, this.sheets, this.shocks, this.mist, this.dustAir, this.moths]) x.dispose();
    this.noise.dispose();
    if (this.flashLight) this.flashLight.intensity = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

const _p = new THREE.Vector3(), _q = new THREE.Vector3();
const DEMOS = {
  sparks: (v) => { _p.copy(v._stage()).setY(1.2); v.sparks(_p, _q.set(0.4, 0.5, 0.3), 16, 1); },
  sparksBig: (v) => { _p.copy(v._stage()).setY(1.3); v.sparks(_p, _q.set(-0.4, 0.6, 0.2), 40, 2.5); },
  spray: (v) => { _p.copy(v._stage()).setY(WATER_Y); v.spray(_p, _q.set(0.5, 0, 0.3), 24, 1); },
  sprayBig: (v) => { _p.copy(v._stage(4)).setY(WATER_Y); v.spray(_p, _q.set(0.8, 0, 0.2), 60, 3); },
  sheet: (v) => { _p.copy(v._stage(5)).setY(WATER_Y); v.sheet(_p, _q.set(0, 0, 1), 5, 2); },
  splashRing: (v) => { _p.copy(v._stage(6)); v.splashRing(_p, 3, 3); },
  splashSmall: (v) => { _p.copy(v._stage(3)); v.splashRing(_p, 0.8, 0.5); },
  dust: (v) => { _p.copy(v._stage()).setY(0.5); v.dust(_p, 8); },
  embers: (v) => { _p.copy(v._stage()).setY(0.9); v.embers(_p, 24); },
  motes: (v) => { _p.copy(v._stage()).setY(1.2); v.motes(_p, 30, 0xffe2a0); },
  impact: (v) => { _p.copy(v._stage()).setY(1.25); v.impact(_p, _q.set(0.7, 0, 0.3), 1.2); },
  shock: (v) => { const b = v.ctx.boss; _p.set(b ? b.pos.x : 0, 0, b ? b.pos.z : -9); v.shock(_p, 22, 0xffe2a0, 3); },
  shockNear: (v) => { _p.copy(v._stage(5)); v.shock(_p, 9, 0xffe2a0, 2.5); },
  hitFlash: (v) => { v.hitFlash(v.ctx.boss, 0.6, 0xfff0d0, 1.4); },
  hitFlashPlayer: (v) => { v.hitFlash(v.ctx.player, 0.6, 0xffd2b0, 1.7); },
  dissolve: (v) => { v.dissolve(v.ctx.boss.root, 4); },
  dissolvePlayer: (v) => { v.dissolve(v.ctx.player.root, 3); },
  trail: (v) => v._swing(false),
  trailBig: (v) => v._swing(true),
  gust: (v) => { _p.copy(v._stage(6)); v.gust(_p, 0.9); },
  moths: (v) => { _p.copy(v._stage(0)); v.moths.scatter(_p.x, _p.z, 80, 4); },
  step: (v) => { v._onStep({ who: 'player', pos: v._stage(1.5), run: true }); },
  stepBoss: (v) => { v._onStep({ who: 'boss', pos: v._stage(5), run: false }); },
  roll: (v) => { const p = v.ctx.player; v._onRoll({ pos: p.pos, dir: _q.set(Math.sin(p.yaw), 0, Math.cos(p.yaw)) }); },
  slam: (v) => { _p.copy(v._stage(6)); v._slam(_p.x, _p.z, 3.5, 3); },
  // the kinds of hit, each as the bus would tell it (docs/impact.md): on her in the three weights, on him, on his shield, on stone, on the floor
  hit: (v) => demoHit(v, true, { heavy: false, damage: 16 }),
  hitHeavy: (v) => demoHit(v, true, { heavy: true, damage: 34 }),
  hitColossal: (v) => demoHit(v, true, { heavy: true, damage: 34, fatal: true }),
  hitPlayer: (v) => demoHit(v, false, { heavy: true, damage: 24 }),
  hitPlayerColossal: (v) => demoHit(v, false, { heavy: true, damage: 48, knockdown: true }),
  hitLight: (v) => demoHit(v, false, { heavy: false, damage: 18, kind: 'chorale' }),
  block: (v) => demoHit(v, false, { heavy: true, damage: 3, blocked: true }),
  blockColossal: (v) => demoHit(v, false, { heavy: true, damage: 4, blocked: true, knockdown: true }),
  clashStone: (v) => { const p = v.ctx.player, fx = Math.sin(p.yaw), fz = Math.cos(p.yaw); _p.set(p.pos.x + fx * 1.1, 1.25, p.pos.z + fz * 1.1); v._onClash({ point: _p, stone: true, normal: _q.set(-fx, 0, -fz), dir: _r3.set(fz * 0.9 + fx * 0.4, -0.1, -fx * 0.9 + fz * 0.4) }); },
  clashFloor: (v) => { const p = v.ctx.player, fx = Math.sin(p.yaw), fz = Math.cos(p.yaw); _p.set(p.pos.x + fx * 1.2, WATER_Y, p.pos.z + fz * 1.2); v._onClash({ point: _p, stone: true, floor: true, normal: _q.set(0, 1, 0), dir: _r3.set(fx * 0.5, -0.85, fz * 0.5) }); },
  slamHeavy: (v) => { _p.copy(v._stage(5)); v._onSlam({ pos: _p, radius: 2.7, power: 0.8 }); },
  slamColossal: (v) => { _p.copy(v._stage(6)); v._onSlam({ pos: _p, radius: 5, power: 1 }); },
};
/** One blow, told as the bus tells it. On her: at her near shin, the blade going across her front. On him: at his chest, from her side. */
function demoHit(v, onHer, o) {
  const b = v.ctx.boss, p = v.ctx.player; if (!b || !p) return;
  _q.set(p.pos.x - b.pos.x, 0, p.pos.z - b.pos.z).normalize();                 // from her to him
  const h = { attacker: onHer ? p : b, target: onHer ? b : p, point: _p, dir: _r3, heavy: false, damage: 16, blocked: false, fatal: false };
  if (onHer) { _p.set(b.pos.x + _q.x * 0.9 - _q.z * 0.5, 1.5, b.pos.z + _q.z * 0.9 + _q.x * 0.5); _r3.set(_q.z, -0.25, -_q.x).normalize(); }
  else { _p.set(p.pos.x - _q.x * 0.3 + _q.z * 0.1, 1.2, p.pos.z - _q.z * 0.3 - _q.x * 0.1); _r3.set(_q.z * 0.8 + _q.x * 0.5, -0.3, -_q.x * 0.8 + _q.z * 0.5).normalize(); }
  v._onHit(Object.assign(h, o));
}
const _r3 = new THREE.Vector3();
