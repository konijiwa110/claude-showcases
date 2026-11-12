// Cinematics: the camera rig. A shot describes its camera as keyed tracks (where the camera is, what it looks at, the
// lens, the focus) and the rig turns them into ctx.camera and ctx.gfx.post.dof once a step, adding what makes a
// camera feel held and heavy: a slow breathing wander, an operator's lag when the aim follows something that moves,
// and a shake that dies away after a blow.
//
// A shot's camera (times are seconds from the start of the shot):
//   pos      [x, y, z] | [[t, [x, y, z], flag?], ...] | (out, t, T) => void      where the camera is
//   look     the same                                                             the point it aims at
//   lag      0 | rate      when `look` is a function: follow it like an operator (about 3 = lazy, 8 = tight)
//   fov      degrees | [[t, degrees], ...]                 (vertical; 50 is the play camera, 15 to 25 a long lens)
//   roll     degrees | keys
//   focus    metres | keys | (out, t, T) => void (a point to hold sharp) | omitted: the look point
//   aperture 0..1 | keys     0 = everything sharp (depth of field off); 1 = the shallowest we use
//   depth    metres: how deep the subject is along the lens (a standing figure seen from the side: about 0.7). The focus
//            is laid on its near side and the lens is stopped down until the whole of it is sharp (see `apply`).
//   breathe  degrees of wander (default 0.1), sway: metres of wander (default 0.008), pace: how fast (default 1)
import * as THREE from 'three';
import { Curve, track, wobble, Spring3, DEG, clamp } from './ease.js';

/**
 * How my aperture (0..1) becomes the renderer's depth-of-field numbers. The renderer's `aperture` is the blur of
 * things infinitely far away, as a share of the half picture's height, whatever the focus distance. A real lens
 * blurs the distance less the farther it is focused and the wider it is, so that is done here: a macro shot of a
 * candle falls away at once, a wide shot focused across the nave holds everything.
 */
export const LENS = { k: 0.022, max: 0.08, maxBlur: 0.02, crisp: 0.55 };      // crisp: the blur (pixels of the half picture) a subject's far side may have

const _p = new THREE.Vector3(), _l = new THREE.Vector3(), _f = new THREE.Vector3(), _d = new THREE.Vector3();

const vecTrack = (v) => (typeof v === 'function' ? null : v instanceof Curve ? v : Array.isArray(v[0]) ? new Curve(v) : new Curve([[0, v]]));

/** Normalise a shot's camera description (done once, when the cutscene is built). */
export function camera(c) {
  const out = {
    pos: vecTrack(c.pos), posFn: typeof c.pos === 'function' ? c.pos : null,
    look: vecTrack(c.look), lookFn: typeof c.look === 'function' ? c.look : null, lag: c.lag || 0,
    fov: track(c.fov === undefined ? 40 : c.fov), roll: track(c.roll || 0),
    focus: c.focus === undefined || typeof c.focus === 'function' ? null : track(c.focus), focusFn: typeof c.focus === 'function' ? c.focus : null,
    aperture: track(c.aperture || 0), depth: c.depth || 0,
    breathe: c.breathe === undefined ? 0.1 : c.breathe, sway: c.sway === undefined ? 0.008 : c.sway, pace: c.pace || 1,
  };
  return out;
}

/** A focus pull between two points: `k(t)` 0 = the first sharp, 1 = the second. Pulled in dioptres, as a lens is. */
export function rack(a, b, k) {
  const curve = track(k), pa = new THREE.Vector3(), pb = new THREE.Vector3();
  const fn = (out, t, T) => { a(pa, t, T); b(pb, t, T); fn.k = clamp(curve.at(t)); fn.a = pa; fn.b = pb; };
  fn.rack = true;
  return fn;
}

/** A camera position that circles a point: azimuth in degrees (0 = west of the centre, on +z; 90 = on +x), radius, height. */
export function orbit({ center, az, r, y }) {
  const A = track(az), R = track(r), Y = track(y), c = new THREE.Vector3(), fixed = Array.isArray(center);
  if (fixed) c.fromArray(center);
  return (out, t, T) => {
    if (!fixed) center(c, t, T);
    const a = A.at(t) * DEG, rad = R.at(t);
    out.set(c.x + Math.sin(a) * rad, Y.at(t), c.z + Math.cos(a) * rad);
  };
}

export class Rig {
  constructor(ctx) {
    this.ctx = ctx; this.aim = new Spring3(); this.fresh = true;
    this.trauma = 0; this.shakeT = 0; this.shakeLen = 1; this.shakeHz = 9;
    this.pos = new THREE.Vector3(); this.look = new THREE.Vector3();          // what the rig decided this step, before the wander
    this.fov = 40; this.focus = 10; this.aperture = 0;
  }
  /** A cut: nothing carries over from the last shot. */
  cut() { this.fresh = true; }
  /** A blow the camera feels. amount 0..1; hz about 9 for a strike, 3 for a rumble. */
  shake(amount, seconds = 0.5, hz = 9) { if (amount >= this.trauma * (this.shakeT / this.shakeLen || 0)) { this.trauma = amount; this.shakeT = this.shakeLen = seconds; this.shakeHz = hz; } }

  /** Work out the shot's camera at local time t (T: the cutscene's clock) and put it on ctx.camera. */
  apply(s, t, dt, T) {
    const ctx = this.ctx, cam = ctx.camera, set = ctx.ui && ctx.ui.settings, calm = set && set.reducedMotion ? 0.25 : 1;
    if (s.posFn) s.posFn(_p, t, T); else s.pos.into(t, _p);
    if (s.lookFn) {
      s.lookFn(_l, t, T);
      if (s.lag > 0) { if (this.fresh) this.aim.reset(_l); else this.aim.step(_l, s.lag, dt); _l.set(this.aim.x, this.aim.y, this.aim.z); }
    } else s.look.into(t, _l);
    this.pos.copy(_p); this.look.copy(_l);
    // a camera is held by something: it breathes
    const w = T * s.pace, b = s.breathe * DEG * calm, sw = s.sway * calm;
    cam.position.set(_p.x + wobble(w * 0.43, 1) * sw, _p.y + wobble(w * 0.51, 2) * sw * 0.7, _p.z + wobble(w * 0.39, 3) * sw);
    cam.up.set(0, 1, 0); cam.lookAt(_l);
    let rx = wobble(w * 0.47, 4) * b, ry = wobble(w * 0.37, 5) * b, rz = s.roll.at(t) * DEG + wobble(w * 0.29, 6) * b * 0.35;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT / this.shakeLen), a = this.trauma * k * k * calm, q = T * this.shakeHz * 6.2832;
      rx += Math.sin(q * 1.0 + 1.3) * a * 0.012; ry += Math.sin(q * 1.31 + 4.1) * a * 0.009; rz += Math.sin(q * 0.83 + 2.2) * a * 0.006;
      cam.position.y += Math.sin(q * 1.17) * a * 0.035; cam.position.x += Math.sin(q * 0.91 + 0.7) * a * 0.02;
    }
    cam.rotateX(rx); cam.rotateY(ry); cam.rotateZ(rz);
    const fov = s.fov.at(t);
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    // focus: a distance along the lens axis
    cam.getWorldDirection(_d);
    let focus;
    if (s.focusFn) {
      const fn = s.focusFn; fn(_f, t, T);
      if (fn.rack) {
        const da = Math.max(0.05, _f.copy(fn.a).sub(cam.position).dot(_d)), db = Math.max(0.05, _f.copy(fn.b).sub(cam.position).dot(_d));
        focus = 1 / (1 / da + (1 / db - 1 / da) * fn.k);
      } else focus = _f.sub(cam.position).dot(_d);
    } else if (s.focus) focus = s.focus.at(t);
    else focus = _f.copy(_l).sub(cam.position).dot(_d);
    const ap = clamp(s.aperture.at(t)), dof = ctx.gfx.post.dof;
    this.fov = fov; this.aperture = ap;
    // The renderer's blur is sharp only where it is under about half a pixel of the half picture, and what lies nearer
    // than the focus spreads its blur over what is behind it. So a figure focused at its middle comes out soft all
    // over. With `depth` the focus is laid on the subject's near side and the lens is stopped down until its far side
    // is still sharp: the figure is crisp, the hall behind it soft.
    this.focus = Math.max(0.05, focus - s.depth * 0.5);
    let a = ap * LENS.k / (this.focus * Math.tan(fov * DEG / 2));
    if (s.depth > 0) { const res = ctx.gfx.resolution, hh = (res && res.y ? res.y : 900) * 0.5; a = Math.min(a, LENS.crisp * this.focus / (hh * s.depth)); }
    dof.on = ap > 0.001; dof.focus = this.focus; dof.maxBlur = LENS.maxBlur; dof.aperture = Math.min(LENS.max, a);
    if (Rig.debug && T >= Rig.debug[0] - 0.004 && T <= Rig.debug[1] + 0.004) console.log(`RIG T=${T.toFixed(3)} pos=${cam.position.toArray().map((v) => v.toFixed(2))} look=${_l.toArray().map((v) => v.toFixed(2))} fov=${fov.toFixed(1)} focus=${this.focus.toFixed(2)} dof.aperture=${dof.aperture.toFixed(5)}`);
    this.fresh = false;
  }
}
// Dev: &rigdebug=41.5-41.7 prints the rig's numbers for those seconds of a cutscene (read them with tools/shot.py --keep).
Rig.debug = (() => { if (typeof location === 'undefined') return null; const v = new URLSearchParams(location.search).get('rigdebug'); if (!v) return null; const n = v.split('-').map(Number); return [n[0], n.length > 1 ? n[1] : n[0]]; })();
