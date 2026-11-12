// The change of phase. As long as the score's `turn` (docs/modules/score.md):
//
//    0.0          1  'stroke'  the low stroke: she brings the great blade down before her with both hands (the last
//                              frames of `cast`); the water bursts along it and a wind runs out
//    2.5          2  'dark'    from high above and behind the pilgrim: the candles go out in a widening ring; his
//                              lantern is the last flame
//    5.0  out     3  'last'    dark. The pilgrim, lit by his own lantern: the last flame. Her line out of the dark (5.2):
//                              "Then you will sing with them."
//    7.5  chord   4  'pipes'   the chord: she rises with the blade upright before her (both fists on its grip), her
//                              pipes burst to their full span and begin to glow, the moonlight turns to pale gold; she
//                              leaves the water; the pilgrim raises his shield against it
//   12.5  end                  she comes down (a ring on the water); the camera has settled where the play camera is
//
// It can begin anywhere in the arena: she keeps her place (brought in from the walls if need be) and the pilgrim is
// stood ten metres off down the nave, facing her. The sword never leaves her hands.
import * as THREE from 'three';
import { Scene } from './timeline.js';
import { Curve, DEG, clamp, lerp, ramp, smoother, wobble } from './ease.js';
import { cues, line } from './cues.js';
import { playPose } from './intro.js';

/**
 * Marks for a cutscene that starts in the middle of a fight. She keeps her place, brought in toward the nave's axis
 * and away from its ends; he is stood `dist` metres west of her, down the nave, and they face each other. So the
 * moon and the rose window are always behind her, there is always room for the cameras, and the cut that opens the
 * cutscene covers the move. out: { bx, bz, byaw, px, pz, pyaw, dx, dz } (dx, dz: the unit vector from her to him).
 */
export function marks(ctx, dist, out = {}) {
  const B = ctx.boss, b = ctx.arena.bounds;
  const bx = clamp(B.pos.x, -3, 3), bz = clamp(B.pos.z, -(b.hz - 8), b.hz - 4.5 - dist);
  out.bx = bx; out.bz = bz; out.px = bx; out.pz = bz + dist;
  out.byaw = 0; out.pyaw = Math.PI; out.dx = 0; out.dz = 1;
  return out;
}

export function buildPhase2(ctx, st, rig) {
  const c = cues(ctx, 'turn'), P = ctx.player, B = ctx.boss, say = line(ctx, 'cantor_phase');
  const m = marks(ctx, 10.5), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), tip = new THREE.Vector3();
  const headB = (out) => st.bone(B, 'Head', out);
  const tipB = (out) => { const o = B.kit.sword.tip; if (o) { o.updateWorldMatrix(true, false); o.getWorldPosition(out); } else out.set(m.bx, 0, m.bz + 4); return out; };
  // a frame of reference for the cameras: `f` metres from her toward him, `s` metres to his right-hand side of that line
  const at = (out, f, s, y) => out.set(m.bx + m.dx * f - m.dz * s, y, m.bz + m.dz * f + m.dx * s);
  const lift = new Curve([[c.chord + 0.5, 0, 's'], [c.chord + 2.6, 1.3, 's'], [c.end - 1.7, 1.2], [c.end - 0.25, 0, 's']]);

  const end = (skipped) => {
    B.pos.y = 0;
    st.take(); st.place(B, m.bx, m.bz, m.byaw); if (skipped) st.play(B, 'idle', { fade: 0, loop: true });
    st.place(P, m.px, m.pz, m.pyaw); if (skipped) st.play(P, 'idle', { fade: 0, loop: true });
    st.wings(1, 1); st.halo(1); st.blade(0.6); if (skipped) { st.snuffAll(0); st.wingsNow(1); } st.mood(0, 1);
    st.flush();
  };

  const sc = new Scene(ctx, st, rig, {
    name: 'phase2', duration: c.end, end,
    letterbox: [[0, 0], [0.5, 1, 's'], [c.end - 1.3, 1], [c.end, 0, 's']],
    exposure: [[0, 1.18], [0.5, 1, 's'], [c.chord - 0.05, 1], [c.chord + 0.3, 1.22], [c.chord + 2.2, 1, 's']],
  });

  // ------------------------------------------------------------------ 1. the stroke
  const HIT = 0.13;                                                                // the blade meets the water (two frames after the music's stroke)
  sc.at(0, () => {
    st.puppets(true);
    st.place(P, m.px, m.pz, m.pyaw); st.play(P, 'idle', { fade: 0, loop: true }); st.look(P, headB(v1), { weight: 0.8, rate: 3 });
    st.take(); st.place(B, m.bx, m.bz, m.byaw); st.look(B, null);
    st.wings(0.33); st.blade(1);
  });
  // `cast`: the blade comes down from over her head (2.2) and lies along the floor before her (2.36); she stays down
  // over it until 3.7; then rises. Both fists are on the grip throughout.
  sc.perform(B, 'cast', [[0, 2.23], [HIT, 2.37], [2.5, 2.75], [c.out, 3.15], [c.chord - 0.35, 3.66], [c.chord + 1.0, 4.4]], { fade: 0, root: false });
  sc.at(HIT, () => {
    // the stroke itself: the same fact the fight announces when her blade meets the floor (water, spray and sound answer it)
    tipB(tip); v1.set(lerp(m.bx, tip.x, 0.6), 0, lerp(m.bz, tip.z, 0.6));
    ctx.bus.emit('boss-slam', { pos: v1, radius: 2.8, power: 1.3 }); rig.shake(0.75, 0.9, 8);
    st.wake(B.pos.x, B.pos.z + 1.2, tip.x, tip.z, 1.2);
    st.snuff(v1.x, v1.z, 4.5, 1.2);                                                // the flames round the blade first
  });
  sc.at(2.45, () => st.snuffAll(c.out - 2.5));                                     // then all of them, in a ring that reaches the last on the cue
  sc.during(0.2, c.out + 0.6, (T, dt, u) => { st.mood(u >= 1 ? 0 : st.candlelight() * (1 - u * u)); st.blade(1 - 0.7 * u); });
  // the wind: lines of disturbance running out from her
  let ring = 0;
  sc.during(0.2, c.out - 0.3, (T, dt, u) => {
    const r = 2 + u * 24;
    // (short dashes round each ring, staggered from ring to ring: six long chords a ring read as a net laid on the water)
    if (r - ring >= 1.4) { ring = r; const n = 9 + Math.round(r * 0.5), step = 6.2832 / n; for (let k = 0; k < n; k++) { const a = k * step + r * 0.31, b = a + step * 0.42; st.wake(m.bx + Math.cos(a) * r, m.bz + Math.sin(a) * r, m.bx + Math.cos(b) * r, m.bz + Math.sin(b) * r, 0.45); } }
  });
  // low on the water to one side of the blade's line: the blade coming down at us, the burst, her bowed over it
  // (The aim comes down with the blade and stays on her fists: both hands, the guard and the whole of the blade lying on
  // the water are in the picture to the cut. Until 8 Nov 04:20 it stayed at the height of her bowed head: by 2.4 s her
  // hands were under the bottom bar and the blade out of the picture. Six tried in one run: .shots/h2_stroke.png, the third.)
  sc.shot('stroke', 0, {
    pos: (out, t) => { at(out, 9.4 - t * 0.2, 3.4 - t * 0.05, 0.55 + t * 0.03); },
    look: (out, t) => { const k = smoother(t / 0.8); at(out, lerp(1.6, 2.0, k), 0.3, lerp(2.35, 1.6, k) + t * 0.02); },
    fov: 46, breathe: 0.12,
  });

  // ------------------------------------------------------------------ 2. the candles go out
  // the wind reaches him: his cloak streams away from her while the candles round him die
  sc.during(2.9, 5.6, (T, dt, u) => { if (u >= 1) st.wind(P); else { const k = Math.sin(Math.min(1, u * 1.8) * Math.PI * 0.5) * (1 - smoother((u - 0.6) / 0.4)); st.wind(P, m.dx * 8 * k, 0.4 * k, m.dz * 8 * k); } });
  // The lens stays INSIDE the hall. It sat 20.6 m west of her wherever she stood: with her in the western half of the
  // nave (her mark west of z = -3.7) that is outside the west doors, and the doors' wall and a leaf filled a fifth to
  // two fifths of the picture with black (seen in the gameplay film of 8 Nov, at 2:03). Now it comes no further west
  // than WEST_IN, and what it loses in distance it makes up in height, aim and width of lens (`short`: 0 = all the
  // room it wants, 1 = she stands as far west as the marks allow), so that both of them and the dying candles stay in.
  const WEST_IN = 17.4, far = Math.min(20.6, WEST_IN - m.bz - 1.2), short = clamp((20.6 - far) / 7.4, 0, 1);
  sc.shot('dark', 2.5, {
    pos: (out, t) => { at(out, far + t * 0.45, -1.7, 8.2 + t * 0.5 + 4.4 * short); },
    look: (out) => { at(out, lerp(4.6, 5.9, short), 0, 0.6); },
    fov: lerp(44, 60, short), breathe: 0.05,
  });

  // ------------------------------------------------------------------ 3. her mask; her line
  // (she is bowed right over the blade with her veil fallen forward: there is no view of the mask to be had. The dark
  // belongs to him instead: his lantern is the last flame in the hall, and her voice comes out of the dark at it)
  sc.at(c.line, () => st.voice('cantor_phase', say.text, say.seconds + 0.4));
  sc.during(c.out - 0.2, c.chord, (T, dt, u) => st.lantern(u >= 1 ? 1 : 1.5 - 0.55 * Math.sin(Math.min(1, u * 2.2) * Math.PI) * (0.6 + 0.4 * wobble(T * 10, 5))));
  // (from his sword side: his lantern hangs there and lights him, and his visor and sword arm are seen. From his shield
  // side, where this stood, a dark shield filled the picture.)
  sc.shot('last', c.out, {
    pos: (out, t) => { at(out, 10.5 - 2.9 + t * 0.12, -1.35 + t * 0.05, 1.3 + t * 0.02); },
    look: (out) => { st.bone(P, 'Head', out); out.y -= 0.17; },
    lag: 5, fov: [[0, 29], [2.5, 27.5]], aperture: 0.55, focus: (out) => st.bone(P, 'Spine2', out), breathe: 0.07,
  });
  sc.during(c.out + 0.2, c.chord, (T, dt, u) => { st.halo(0.55 * u); st.wings(undefined, 0.12 * u); });        // a first light in the dark: her own

  // ------------------------------------------------------------------ 4. her pipes
  // HER HEAD IS STILL AND PROUD through the whole rise (Kevin, 9 Nov: "when she powers up, don't make her head do that
  // head bob thing"). What moved it was the clip: `powerup`'s own head keys go from bowed 50 degrees (0.55) to thrown
  // back 65 degrees (2.1) with a tremor of 5 to 10 degrees on the way (three or four a second in the clip, two a
  // second here), and it came in after `cast` had already raised her head once: up, down, bob, bob, to the vault, down
  // again. Now her head and neck are HELD as one quiet moment of the same clip (1.58: neck straight, face level with
  // her chest) and her face is PINNED on a point far ahead of her, over the pilgrim: it comes up ONCE, with her, out
  // of the bow of the stroke (from where the stroke left it at 7.2 to eight degrees below level, as her fighting
  // stance carries it, by 8.5), and does not move again while her body straightens under it, leaves the water and
  // comes down: measured with &cinedebug, within a fifth of a degree from 8.5 to the end. (Both are the animation
  // runtime's own layers, inside her pose: her veil, her halo and her pipes go with the head they see.)
  const HEAD = { from: c.chord - 0.3, up: 1.3, to: c.end - 0.3, pitch: -8 * DEG, clip: 'powerup', at: 1.58 }, gaze = new THREE.Vector3();
  const hq = new THREE.Quaternion(), htq = new THREE.Quaternion(); let bowed = -0.5;
  /** How far her face is lifted above level (radians; below is negative), as she is posed now. */
  const facePitch = () => {
    const h = B.char.bones.Head; if (!h || !B.char.tposeWorld) return bowed;
    h.getWorldQuaternion(hq); B.char.tposeWorld('Head', htq); hq.multiply(htq.invert());      // (the joint as Mixamo has it: z is where the face looks)
    return Math.asin(clamp(v2.set(0, 0, 1).applyQuaternion(hq).y, -1, 1));
  };
  sc.at(HEAD.from, () => { st.lookKeep(B, 2); bowed = Math.min(HEAD.pitch, facePitch()); });      // (the fight gets her look back as it was: stage.js)
  sc.during(HEAD.from, HEAD.to, (T, dt, u) => {
    if (u >= 1) { st.look(B, null, { rate: 20 }); st.pose(B, HEAD.clip, HEAD.at, 0, 'head'); return; }      // (she stands in her guard again: its head is where this one was)
    const pitch = lerp(bowed, HEAD.pitch, smoother((T - HEAD.from) / HEAD.up));
    headB(gaze); gaze.x += m.dx * 60; gaze.z += m.dz * 60; gaze.y += Math.tan(pitch) * 60;
    st.look(B, gaze, { weight: 1, rate: 150, head: 1, chest: 0 });                  // (held fast from the first step: it begins where her face already is)
    st.pose(B, HEAD.clip, HEAD.at, Math.min(ramp(HEAD.from, c.chord + 0.9, T), 1 - ramp(c.end - 1.05, c.end - 0.4, T)), 'head');
  });
  // she stands, the blade upright before her
  sc.perform(B, 'powerup', [[c.chord + 0.75, 0.55], [c.chord + 2.0, 1.25], [c.end - 1.2, 2.2]], { fade: 0.7, root: false });
  sc.at(c.chord - 0.12, () => { st.wingSpeed(2.4); st.wings(1); });                // they burst open on the chord
  sc.at(c.chord, () => {
    st.pulse(1); st.halo(1); rig.shake(0.45, 1.8, 3);
    st.ripple(m.bx, m.bz, 3, 2.5); st.gust(m.bx, m.bz, 1); st.play(P, 'block_idle', { fade: 0.5, loop: true });
    if (ctx.vfx && ctx.vfx.motes) ctx.vfx.motes(v1.set(m.bx, 5, m.bz), 60, 0xffe2a0);
  });
  sc.at(c.chord + 1.5, () => st.wingSpeed());
  sc.at(c.chord + 2.5, () => st.pulse(0.8));
  sc.during(c.chord + 0.5, c.end - 0.25, (T, dt, u) => { B.pos.y = u >= 1 ? 0 : lift.at(T); });
  sc.during(c.chord, c.chord + 3.6, (T, dt, u) => { st.wings(undefined, 0.12 + 0.88 * smoother(u)); st.mood(0, smoother(u)); st.blade(0.3 + 0.3 * u); });
  sc.at(c.end - 1.2, () => { st.play(B, 'idle', { fade: 0.9, loop: true }); st.play(P, 'idle', { fade: 0.8, loop: true }); });
  sc.at(c.end - 0.3, () => { st.ripple(m.bx, m.bz, 3, 2.2); rig.shake(0.25, 0.5, 7); if (ctx.vfx && ctx.vfx.splashRing) ctx.vfx.splashRing(v1.set(m.bx, 0.07, m.bz), 3.5, 0.7); });

  const playPos = new THREE.Vector3(), playDir = new THREE.Vector3(), playLook = new THREE.Vector3(); let playFov = 50;
  const len = c.end - c.chord, hand = (t) => smoother((t - len * 0.5) / (len * 0.5));
  const probe = () => { playFov = playPose(ctx, playPos, playDir, st.playMode); playLook.copy(playPos).addScaledVector(playDir, 16); };
  sc.at(c.chord, probe);
  sc.during(c.chord + len * 0.45, c.end, probe);                                  // locked on, the play camera frames her as well: ask as she comes down
  // from the water beside him, low: the whole of her against the rose window, the fan bursting; then round behind him
  sc.shot('pipes', c.chord, {
    // (it begins on the water before him, so nothing of him is cut by a corner of the picture: he comes into it only as
    // the camera goes back past him to where the play camera is)
    pos: (out, t) => { at(out, 9.1 - t * 0.2, -2.6, 0.9 + t * 0.1); out.lerp(playPos, hand(t)); },
    look: (out, t) => { at(out, 0, 0.5, 5.9 + t * 0.25); out.lerp(playLook, hand(t)); },
    fov: { at: (t) => lerp(46, playFov, hand(t)) }, breathe: 0.07,
  });

  return sc.ready();
}
