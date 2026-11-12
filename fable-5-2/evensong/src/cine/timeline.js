// Cinematics: the timeline. A cutscene is built once, when it starts, out of
//
//   shots     each with a start on the cutscene's clock and a camera (src/cine/rig.js); a shot lasts until the next
//   events    things done once at a moment (place an actor, start a clip, snuff candles, speak)
//   spans     things done every step between two moments (a ramp of light, a walk along a path, a clip scrubbed
//             to the music); a span always gets a last call with u = 1, so what it ramps ends where it should
//
// and then run step by step from src/cam/cine.js. Everything is keyed to the cutscene's clock; nothing reads real
// time or Math.random, so `&ct=31` lands on the same frame every run. Whatever a cutscene changes for good it sets
// again in its end() function, which the natural end and a skip both call.
import { Curve } from './ease.js';
import { camera } from './rig.js';

export class Scene {
  /**
   * @param ctx     the game's context
   * @param stage   Stage (actors, things, room)
   * @param rig     Rig (the camera)
   * @param o       { name, duration, end(skipped), letterbox?: keys, fade?: keys, exposure?: keys }
   */
  constructor(ctx, stage, rig, o) {
    this.ctx = ctx; this.stage = stage; this.rig = rig; this.name = o.name; this.duration = o.duration;
    this.shots = []; this.events = []; this.spans = []; this.endFn = o.end || (() => {});
    this.letterbox = o.letterbox ? new Curve(o.letterbox) : null; this.fade = o.fade ? new Curve(o.fade) : null; this.exposure = o.exposure ? new Curve(o.exposure) : null;
    this.si = -1; this.ei = 0; this.current = null; this.cuts = 0; this.lb = -1;
  }

  /** A shot: from `at` until the next shot starts. cam: see rig.js. o: { enter(), tick(t, dt, T) } */
  shot(name, at, cam, o = {}) { this.shots.push({ name, at, cam: camera(cam), enter: o.enter || null, tick: o.tick || null }); return this; }
  /** Do something once at a moment. */
  at(t, fn) { this.events.push({ at: t, fn, n: this.events.length }); return this; }
  /** Do something every step from `from` to `to`: fn(T, dt, u) with u running 0..1; the last call always has u = 1. */
  during(from, to, fn) { this.spans.push({ from, to, fn, done: false }); return this; }

  /**
   * A performance: a clip whose time follows the cutscene's clock through keys [[T, clip seconds], ...], so a rise
   * can be slowed, held and landed on a beat. o: { fade = 0.3, root (let the clip's own travel move the fighter),
   * then (clip speed afterwards; default 0 = hold the last moment) }
   */
  perform(f, clip, keys, o = {}) {
    const curve = new Curve(keys), st = this.stage, from = keys[0][0], to = keys[keys.length - 1][0];
    let action = null;
    this.at(from, () => {
      action = st.play(f, clip, { fade: o.fade, at: curve.at(from), speed: 0 });
      if (o.root !== undefined) f.puppet = o.root ? 'root' : true;
    });
    this.during(from, to, (T, dt, u) => {
      if (!action || f.char.clipName !== clip) return;                 // another clip has taken over
      if (u >= 1) { action.timeScale = o.then === undefined ? 0 : o.then; return; }
      action.timeScale = (curve.at(Math.min(to, T + dt)) - action.time) / dt;
    });
    return this;
  }

  /** Sort what was declared; call once before running. */
  ready() {
    this.shots.sort((a, b) => a.at - b.at);
    this.events.sort((a, b) => a.at - b.at || a.n - b.n);
    if (!this.shots.length || this.shots[0].at > 0) throw new Error(`cutscene "${this.name}": the first shot must start at 0`);
    return this;
  }

  /** Bring the cutscene to clock time T (one fixed step later than the last call). */
  step(T, dt) {
    const st = this.stage, eps = 1e-6;
    // cuts and events, in the order of their times; a cut comes before the events of the same moment
    for (;;) {
      const ns = this.shots[this.si + 1], ne = this.events[this.ei];
      const ts = ns ? ns.at : Infinity, te = ne ? ne.at : Infinity;
      if (Math.min(ts, te) > T + eps) break;
      if (ts <= te) { this.si++; this.current = ns; this.cuts++; this.rig.cut(); if (ns.enter) ns.enter(); } else { this.ei++; ne.fn(T); }
    }
    for (let i = 0; i < this.spans.length; i++) {
      const s = this.spans[i];
      if (s.done || T + eps < s.from) continue;
      if (T + eps >= s.to) { s.fn(s.to, dt, 1); s.done = true; } else s.fn(T, dt, (T - s.from) / (s.to - s.from));
    }
    st.flush();                                    // fighters placed or re-posed at once take their pose now
    st.update(dt);                                 // heads turned toward something
    const shot = this.current;
    if (shot.tick) shot.tick(T - shot.at, dt, T);
    this.rig.apply(shot.cam, T - shot.at, dt, T);
    const post = this.ctx.gfx.post, ui = this.ctx.ui;
    if (this.letterbox) { const k = this.letterbox.at(T); post.letterbox = k; if (ui && ui.letterbox && Math.abs(k - this.lb) > 1e-4) { this.lb = k; ui.letterbox(k); } }
    if (this.fade) post.fade = this.fade.at(T);
    if (this.exposure) post.exposure = this.exposure.at(T);
  }

  end(skipped) { this.endFn(skipped); }
}
