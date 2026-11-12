// Animated character: glTF model + clip playback by exact clip name + root motion + event timeline.
import * as THREE from "three";

const TAU = Math.PI * 2;
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

/** Root-motion sample (x,y,z,yaw) at clip time t (seconds), linear interpolation, clamped. */
function sampleRM(rm, t, out) {
  const s = rm.samples, n = s.length;
  if (!n) return out.set(0, 0, 0, 0);
  const f = Math.max(0, t * rm.fps);
  const i = Math.min(Math.floor(f), n - 1), j = Math.min(i + 1, n - 1), a = Math.min(f - i, 1);
  const p = s[i], q = s[j];
  return out.set(p[0] + (q[0] - p[0]) * a, p[1] + (q[1] - p[1]) * a, p[2] + (q[2] - p[2]) * a, p[3] + (q[3] - p[3]) * a);
}

const _a = new THREE.Vector4(), _b = new THREE.Vector4(), _end = new THREE.Vector4();
const _d = new THREE.Vector3();
const MOVE_SCALE_TYPES = new Set(["moveScale", "rootMotionScale", "EAMScaleType::UsePureScale"]);

/**
 * BANS_GSCalcAMScale: rate for a root-motion scale window so the window's forward travel ends at the target
 * (target distance along the character's forward minus both radii, + offset), clamped to the window's [min,max]
 * (fallback clamp = skill moveScaleClamp). A target behind the character gives distance 0 (-> min rate).
 * Tiger events use minRate/maxRate/moveOffset, player events min/max/offset; pure-scale windows use pureScale.
 */
export function targetMoveScale(ch, e, surfaceDist, fallbackClamp) {
  if (e.type === "EAMScaleType::UsePureScale") return e.pureScale ?? 1;
  if (surfaceDist == null) return 1;
  const anim = ch.forwardMotion(e.start, e.end);
  if (Math.abs(anim) < 1e-3) return 1;
  const min = e.minRate ?? e.min ?? fallbackClamp?.min ?? 0;
  const max = e.maxRate ?? e.max ?? fallbackClamp?.max ?? Infinity;
  const want = Math.max(0, surfaceDist + (e.moveOffset ?? e.offset ?? 0));
  return Math.min(max, Math.max(min, want / anim));
}

export class Character {
  /**
   * @param gltf  loaded glTF ({scene, animations})
   * @param anims contract anims JSON
   */
  constructor(gltf, anims, name) {
    this.name = name;
    this.anims = anims;
    this.root = new THREE.Group();
    this.root.name = name;
    this.model = gltf.scene;
    const f = anims.forward || [0, 0, 1];
    // rotate the model so its native forward maps to the root's +Z
    this.modelYaw = -Math.atan2(f[0], f[2]);
    this.model.rotation.y = this.modelYaw;
    this.root.add(this.model);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        o.frustumCulled = false; // skinned bounds don't follow the animation
      }
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.clips = new Map(gltf.animations.map((c) => [c.name, c]));
    this.bones = new Map();
    this.model.traverse((o) => { if (o.name && !this.bones.has(o.name)) this.bones.set(o.name, o); });
    this.yaw = 0;
    this.cur = null; // {name, action, meta, time, prev, speed, loop, rm, onEnd, ended}
    this.missing = new Set();
  }

  get position() { return this.root.position; }
  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  has(name) { return this.clips.has(name); }
  meta(name) { return this.anims.clips?.[name]; }
  duration(name) { const m = this.meta(name); return m?.duration ?? this.clips.get(name)?.duration ?? 0; }

  /**
   * Merges an animation bundle into this character: an animation-only glb exported for the same skeleton (tracks bind
   * by node name) plus its anims.json (clip metadata: events, root motion, sections). Later bundles win on name clashes.
   */
  addAnimations(gltf, doc) {
    for (const c of gltf.animations) this.clips.set(c.name, c);
    this.anims.clips = { ...this.anims.clips, ...(doc?.clips || {}) };
  }

  bone(name) {
    if (!name) return null;
    return this.bones.get(name) || this.bones.get(THREE.PropertyBinding.sanitizeNodeName(name)) || null;
  }

  bonePos(name, out = new THREE.Vector3()) {
    const b = this.bone(name);
    if (!b) return null;
    return b.getWorldPosition(out);
  }

  /**
   * Plays a clip by exact name. opts: {fade, loop, speed, rootMotion, onEnd, start, section}
   * Montages play section by section following `next` (missing next = end), like UE montage sections.
   * Returns false when the clip does not exist (logged once).
   */
  play(name, opts = {}) {
    const clip = this.clips.get(name);
    if (!clip) {
      if (!this.missing.has(name)) { this.missing.add(name); console.warn(`[${this.name}] missing clip ${name}`); }
      return false;
    }
    const meta = this.meta(name) || {};
    const loop = opts.loop ?? !!meta.loop;
    const speed = (opts.speed ?? 1) * (meta.rateScale || 1);
    const fade = opts.fade ?? 0.12;
    const action = this.mixer.clipAction(clip);
    const prevC = this.cur, prev = prevC?.action;
    if (prev && prev !== action) prev.timeScale = prevC.speed * (prevC.rate || 1); // keeps moving while fading out
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.timeScale = 0; // time is driven explicitly (sections, play-rate windows)
    action.enabled = true;
    action.setEffectiveWeight(1);
    const sections = !loop && meta.sections?.length ? meta.sections : null;
    let secIdx = -1, start = opts.start ?? 0;
    if (sections) {
      secIdx = opts.section ? sections.findIndex((s) => s.name === opts.section) : 0;
      if (secIdx < 0) secIdx = 0;
      if (opts.start == null) start = sections[secIdx].start;
    }
    action.time = start;
    if (prev && prev !== action && fade > 0) action.crossFadeFrom(prev, fade, false);
    else if (prev && prev !== action) prev.stop();
    action.play();
    this.cur = {
      name, action, meta, time: start, prev: start, speed, rate: 1, loop, duration: meta.duration ?? clip.duration,
      sections, secIdx, rm: opts.rootMotion === false ? null : meta.rootMotion || null, onEnd: opts.onEnd || null,
      ended: false, fired: new Set(), moveRates: new Map(), stamp: (this.playCount = (this.playCount || 0) + 1),
    };
    return true;
  }

  /** jumps the current montage to a named section (e.g. jumpSectionIfBuff) */
  jumpToSection(name) {
    const c = this.cur;
    if (!c?.sections) return false;
    const i = c.sections.findIndex((s) => s.name === name);
    if (i < 0) return false;
    c.secIdx = i; c.time = c.prev = c.sections[i].start;
    return true;
  }

  isPlaying(name) { return this.cur?.name === name && !this.cur.ended; }
  get clipTime() { return this.cur?.time ?? 0; }
  get clipName() { return this.cur?.name ?? null; }
  get clipProgress() { return this.cur ? this.cur.time / Math.max(this.cur.duration, 1e-6) : 0; }

  setSpeed(s) { if (this.cur) this.cur.speed = s * (this.cur.meta.rateScale || 1); }

  /** product of active play-rate windows (montage BANS_GSSetAMSpeedRate) */
  rateAt(t) {
    const ev = this.cur?.meta?.events;
    if (!ev) return 1;
    let r = 1;
    for (const e of ev) if ((e.type === "speedRate" || e.type === "playRate") && t >= e.start && t < e.end && e.rate > 0) r *= e.rate;
    return r;
  }

  /**
   * Advances animation by dt. Returns root-motion world delta {x,y,z,w=yaw} for this step (zero if none).
   * Yaw is applied by the caller (so AI/steering can combine it).
   */
  update(dt, outDelta) {
    outDelta.set(0, 0, 0, 0);
    const c = this.cur;
    if (!c) { this.mixer.update(dt); return outDelta; }
    c.prev = c.time;
    c.rate = this.rateAt(c.time);
    let t = c.time + dt * c.speed * c.rate;
    let jumped = null, finished = false;
    if (c.sections) {
      const s = c.sections[c.secIdx];
      const segEnd = Math.min(s.end, c.duration);
      if (t >= segEnd) {
        const ni = s.next ? c.sections.findIndex((x) => x.name === s.next) : -1;
        if (ni >= 0) {
          const ns = c.sections[ni];
          if (Math.abs(ns.start - segEnd) > 1e-3) jumped = { from: segEnd, to: ns.start, over: t - segEnd };
          c.secIdx = ni;
        } else { t = segEnd; finished = true; }
      }
    }
    let wrapped = false;
    if (jumped) t = jumped.to + jumped.over;
    else if (c.loop) { if (t >= c.duration) { t %= Math.max(c.duration, 1e-6); wrapped = true; c.fired.clear(); } }
    else if (t >= c.duration) { t = c.duration; finished = true; }
    c.time = t;
    c.action.time = t;
    this.mixer.update(dt);
    if (c.rm && dt > 0) {
      if (wrapped || jumped) {
        const e1 = wrapped ? c.duration : jumped.from, s2 = wrapped ? 0 : jumped.to;
        this._rmSpan(c, c.prev, e1, outDelta);
        const tmp = new THREE.Vector4(); this._rmSpan(c, s2, t, tmp); outDelta.add(tmp);
      } else this._rmSpan(c, c.prev, t, outDelta);
    }
    if (jumped) c.prev = jumped.to; // events between the jump points are skipped
    if (!c.loop && !c.ended && finished) {
      c.ended = true;
      const cb = c.onEnd; c.onEnd = null;
      if (cb) cb(this);
    }
    return outDelta;
  }

  _rmSpan(c, t0, t1, out) {
    sampleRM(c.rm, t0, _a); sampleRM(c.rm, t1, _b);
    _d.set(_b.x - _a.x, _b.y - _a.y, _b.z - _a.z);
    // moveScale windows (BANS_GSCalcAMScale): scale motion along the model forward axis
    const ms = this.moveScaleAt(c, t0);
    if (ms !== 1) {
      const f = this.anims.forward || [0, 0, 1];
      const along = _d.x * f[0] + _d.y * f[1] + _d.z * f[2];
      _d.x += f[0] * along * (ms - 1); _d.y += f[1] * along * (ms - 1); _d.z += f[2] * along * (ms - 1);
    }
    return this._rmDelta(_a, _b, out);
  }

  /** rate for the moveScale window active at t (computed once per window via this.moveScaleRate(ev, c)) */
  moveScaleAt(c, t) {
    const ev = c.meta?.events;
    if (!ev) return 1;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (!MOVE_SCALE_TYPES.has(e.type) || t < e.start || t >= e.end) continue;
      if (e.axis && !e.axis.endsWith("AxisX")) continue; // vertical landing scale not applied (ground snap owns Y)
      if (!c.moveRates.has(i)) c.moveRates.set(i, this.moveScaleRate ? this.moveScaleRate(e, c) : (e.pureScale ?? 1));
      return c.moveRates.get(i);
    }
    return 1;
  }

  /** model-space forward root displacement inside [t0,t1] */
  forwardMotion(t0, t1) {
    const c = this.cur;
    if (!c?.rm) return 0;
    sampleRM(c.rm, t0, _a); sampleRM(c.rm, t1, _b);
    const f = this.anims.forward || [0, 0, 1];
    return (_b.x - _a.x) * f[0] + (_b.y - _a.y) * f[1] + (_b.z - _a.z) * f[2];
  }

  // model-space cumulative samples a -> b  ==> world delta using current root yaw
  _rmDelta(a, b, out) {
    _d.set(b.x - a.x, b.y - a.y, b.z - a.z);
    // into the root frame at time a, then into world with the character's current facing
    _d.applyAxisAngle(THREE.Object3D.DEFAULT_UP, -a.w + this.modelYaw + this.yaw);
    return out.set(_d.x, _d.y, _d.z, b.w - a.w);
  }

  /** Remaining horizontal root-motion distance from current time to end (meters, model space). */
  rootMotionRemaining() {
    const c = this.cur;
    if (!c?.rm) return 0;
    sampleRM(c.rm, c.time, _a); sampleRM(c.rm, c.duration, _b);
    return Math.hypot(_b.x - _a.x, _b.z - _a.z);
  }

  events(type) { return this.cur?.meta?.events?.filter((e) => e.type === type) ?? []; }

  /** events of `type` whose [start,end) contains the current clip time */
  activeEvents(type) {
    const c = this.cur;
    if (!c?.meta?.events) return [];
    const t = c.time;
    return c.meta.events.filter((e) => e.type === type && e.start != null && t >= e.start && t < (e.end ?? e.start));
  }
  inEvent(type) { return this.activeEvents(type).length > 0; }

  /** point events (type with `time`, or interval starts) crossed during the last update, each fired once per play */
  crossed(type) {
    const c = this.cur;
    if (!c?.meta?.events) return [];
    const out = [];
    c.meta.events.forEach((e, i) => {
      if (e.type !== type) return;
      const at = e.time ?? e.start;
      const key = type + i;
      if (at != null && !c.fired.has(key) && c.time >= at && (c.prev <= at || c.prev > c.time)) { c.fired.add(key); out.push(e); }
    });
    return out;
  }

  setYaw(y) { this.yaw = wrapAngle(y); this.root.rotation.y = this.yaw; }
}
