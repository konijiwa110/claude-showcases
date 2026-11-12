// The opening. Cut to the score's cues (assets/audio/music/music.json → intro.cues; docs/modules/score.md):
//
//    0.0  candle   1  'candle'  black; one candle on black water comes into focus, a great pale shape far behind it
//    6.0  nave     2  'nave'    the nave from high in the west: one crane down to the water, the moon in the rose window
//   15.0  doors    3a 'doors'   the great doors: his lantern and his shape coming in out of the dark, at a man's own walk
//   18.0           3b 'boots'   his boots at water level, a ring from each step
//   21.0  sight    4  'sight'   over his shoulder, far off: the Cantor standing before her standing sword, tall and still
//   24.0  mask     5a 'mask'    her mask in profile, the moon behind it; the candles round her gutter; her head turns; her line (25.5)
//   27.5           5b 'listen'  his helm, close: the light of his lantern shrinks under her words
//   30.0  rise     6a 'rise'    from the nave, low and wide: she turns to face him, a quarter turn on two heavy steps
//   33.0  chord       ...       and her pipes open like wings on the great chord, the moon behind them
//   36.0           6b 'gaze'    closer and from below: the mask against the open fan looks down the nave at him
//   39.0  draw     7a 'hilt'    the wind of it reaches his cloak; his flame gutters; his hand starts across his body
//   40.0           7b 'grip'    close on his left hip: the fist closes on the hilt (40.4) and the steel leaves the scabbard (40.5 to 40.9)
//   40.9           7c 'draw'    the point swings free and up and he is in his guard; the lantern flares
//   42.0           7d 'regard'  her face: she looks from him to her sword
//   45.0  sweep    8a 'hand'    her hand closes on the grip of the standing sword
//   46.4           8b 'windup'  both fists on the grip, the great blade drawn back
//   48.0  fall     8c 'ring'    from above: one sweep; a ring runs out over the water and a circle of candles dies
//   51.0  name     9  'name'    both in one frame across the water; her name; she comes on two steps; the camera settles
//   57.0  end                   behind the pilgrim exactly where the play camera is, and play begins
//
// She is the Cantor: she stands and sings, without a sound. She stands facing south across the choir (as the cantoris
// side does), so from the nave she is in profile with the moon behind her, her sword standing in the floor before her,
// her pipes folded: still and tall, her hands open at her sides, a statue that breathes. Nobody kneels and nobody
// prays, here or anywhere in the game (Kevin, 8 Nov). She turns to the pilgrim on the bar before the great chord.
// From 33.0 on everything is as it was when she rose from her knees there: the same stance in the same place.
import * as THREE from 'three';
import { Scene } from './timeline.js';
import { Curve, DEG, clamp, lerp, ramp, smoother, wobble } from './ease.js';
import { orbit, rack } from './rig.js';
import { cues, line } from './cues.js';

export const STAND_YAW = Math.PI / 2;                 // she stands facing +x (south): in profile from the nave
export const SWORD_YAW = Math.PI / 2;                 // her planted sword's cross lies across the nave: the nave sees it whole
export const NAME = 'Ondine, Cantor of the Drowned Choir';
const CANTOR_WALK = 1.177;                            // hers, in her own units (times her scale)
/** How the boss wears her things at rest in phase one: the opening leaves her so, and nothing jumps when play begins. */
export const REST = { wings: 0.1, halo: 0.15 };
const WINGS_OPEN = 1.05;                              // seconds her wings take from folded to spread in the opening (the harp's sweep)
const STAND = 5.5;                                    // his look_around: a moment at which he simply stands, arms hanging

/**
 * Where her sword stands while she sings: before her (she stands facing south) and a little toward the nave.
 * Far enough out that it stands clear of her spread arm when she has turned to the nave.
 */
export function swordSpot(ctx, out) { const k = ctx.arena.spawn.kneel; return out.set(k.x + 3.7, 0, k.z + 1.0); }

// How she stands while she waits. (The clip called `singing` is a singer with a fist at her mouth for a microphone, who
// dances, bends double and turns her back: not her. .shots/np_sing_close.png) She stands still instead: the quiet last
// stretch of `look_down` (she stands tall, arms at her sides, her weight shifting a little), gone through there and
// back over twelve seconds. Over it her arms open a little from her sides and sink again with each phrase of a song
// nobody hears (`cast_wide`'s spread arms at a small, breathing weight: her hands are never together and never before
// her body), and her face is lifted to the vault.
const STILL = { clip: 'look_down', from: 3.05, to: 4.7, period: 12 };
const PHRASE = 7.4;                                   // seconds: one breath of her song

/**
 * The Cantor standing before her sword: the picture behind the title, and the opening's first state. She stands
 * where the hall's mark for her is (arena.spawn.kneel: the name is the arena's, from when she knelt there).
 * Returns the handle of the quiet clip she stands in, for `sing`.
 */
export function stageStanding(ctx, stage) {
  const B = ctx.boss, k = ctx.arena.spawn.kneel, s = swordSpot(ctx, new THREE.Vector3());
  B.puppet = true;
  stage.place(B, k.x, k.z, STAND_YAW);
  const h = stage.play(B, STILL.clip, { fade: 0, at: STILL.from, speed: 0 });
  stage.plant(s.x, s.z, SWORD_YAW);
  stage.wings(0, 0); stage.halo(0.12); stage.blade(0); stage.fade(0);
  return h;
}

const _sing = new THREE.Vector3(), TAU = Math.PI * 2;
/**
 * She sings without a sound: one step of her life while she stands, for the title and the opening alike.
 * h: the handle `stageStanding` gave; t: the seconds she has stood; o: { arms: 0..1 (how much of her arms' opening;
 * default all of it), head: false (her eyes belong to someone else now) }.
 */
export function sing(ctx, stage, h, t, dt, o = {}) {
  const B = ctx.boss;
  if (h && dt > 0 && B.char.clipName === STILL.clip) h.timeScale = (STILL.from + (STILL.to - STILL.from) * (0.5 - 0.5 * Math.cos((t + dt) * TAU / STILL.period)) - h.time) / dt;
  const p = 0.5 - 0.5 * Math.cos(t * TAU / PHRASE);                              // 0 between two phrases, 1 at a phrase's height
  stage.pose(B, 'cast_wide', 1.9, (o.arms === undefined ? 1 : o.arms) * (0.1 + 0.17 * p + 0.03 * wobble(t * 0.6, 21)));
  if (o.head === false) return;
  // her face lifted to the vault before her, higher as the phrase rises, wandering a little to either side
  const yaw = B.yaw + 0.07 * wobble(t * 0.35, 22), up = (5 + 9 * p) * DEG, far = 24;
  stage.look(B, _sing.set(B.pos.x + Math.sin(yaw) * far, 1.53 * (B.char.scale || 3.667) + Math.tan(up) * far, B.pos.z + Math.cos(yaw) * far), { weight: 0.8, rate: 1.1, limit: 0.6 });
}

const _p0 = new THREE.Vector3(), _q0 = new THREE.Quaternion();
/**
 * Where the play camera will be the moment a cutscene gives the picture back: asked of the play camera itself, so
 * the last shot can land exactly there. Returns its field of view; fills pos and dir. Cheap enough to ask each step.
 */
export function playPose(ctx, pos, dir, mode = 'free') {
  const pc = ctx.cam, cam = ctx.camera, f = ctx.player;
  _p0.copy(cam.position); _q0.copy(cam.quaternion);
  let ok = false, fov = 50;
  if (pc && pc.snapBehind) {
    const was = pc.mode;
    pc.mode = mode; pc.snapBehind(); cam.updateMatrixWorld();              // out of 'cine' for a moment, so it places itself
    if (cam.position.distanceToSquared(_p0) > 1e-6 || Math.abs(cam.quaternion.dot(_q0)) < 0.999999) { pos.copy(cam.position); cam.getWorldDirection(dir); ok = true; }
    fov = pc.fovNow || pc.fov || 50;
    pc.mode = was;
  }
  if (!ok) {                                                     // it did not move: where the first play camera stood
    const cp = Math.cos(0.2), d = 5.2;
    pos.set(f.pos.x - Math.sin(f.yaw) * cp * d, 1.45 + Math.sin(0.2) * d, f.pos.z - Math.cos(f.yaw) * cp * d);
    dir.set(f.pos.x, 1.85, f.pos.z).sub(pos).normalize();
  }
  cam.position.copy(_p0); cam.quaternion.copy(_q0); cam.updateMatrixWorld();
  return fov;
}

export function buildIntro(ctx, st, rig) {
  const c = cues(ctx, 'intro'), A = ctx.arena, K = A.spawn.kneel, PS = A.spawn.player, BS = A.spawn.boss, D = A.spawn.door;
  const P = ctx.player, B = ctx.boss, S = B.char.scale || 3.667, say = line(ctx, 'cantor_intro');
  const sword = swordSpot(ctx, new THREE.Vector3());
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), candle = new THREE.Vector3();
  const headB = (out) => st.bone(B, 'Head', out), headP = (out) => st.bone(P, 'Head', out), chestP = (out) => st.bone(P, 'Spine2', out);
  const gripB = (out) => { const o = B.kit.sword.object; o.updateWorldMatrix(true, false); return o.getWorldPosition(out); };

  // ------------------------------------------------------------------ the end state (natural end and skip alike)
  let legs = null;                                               // the step laid over her legs while she turns (section 6)
  const RING = 8.5;                                              // the circle of candles her sweep puts out
  const end = (skipped) => {
    // at its natural end both stand in their idles already: only a skip has to put them there at once
    st.relax(P, false, 0);
    st.place(P, PS.x, PS.z, PS.yaw); if (skipped) st.play(P, 'idle', { fade: 0, loop: true }); st.sheathe(false); st.lantern(1);
    st.take(); st.place(B, BS.x, BS.z, BS.yaw || 0); if (skipped) st.play(B, 'idle', { fade: 0, loop: true });
    if (skipped && legs) legs.time = legs.end;                     // (skipped in the middle of her turn: the step laid over her legs lets go at once)
    if (skipped) st.wingsNow(REST.wings); st.wings(REST.wings, 0); st.halo(REST.halo); st.blade(0); st.fade(0);
    if (skipped) { st.relight(1, 0); st.snuff(K.x, K.z, RING, 0); }              // (at the natural end the candles are so already: no call, no sound)
    st.mood(st.candlelight(), 0);
    st.flush();
  };

  const sc = new Scene(ctx, st, rig, {
    name: 'intro', duration: c.end, end,
    letterbox: [[0, 1], [c.end - 1.6, 1], [c.end, 0, 's']],
    fade: [[0, 1], [0.7, 1], [3.6, 0, 's']],
    exposure: [[0, 1], [c.chord - 0.05, 1], [c.chord + 0.22, 1.25], [c.chord + 1.8, 1, 's']],
  });

  // ------------------------------------------------------------------ before the first frame
  let still = null;                                              // the quiet clip she stands in (stageStanding)
  sc.at(0, () => {
    st.relight(1, 0); st.mood(1, 0);
    still = stageStanding(ctx, st);
    P.puppet = true; st.sheathe(true); st.play(P, 'look_around', { fade: 0, at: STAND, speed: 0 }); st.hidePilgrim();
    st.candleNear(1.6, 5.5, candle);
  });

  // ================================================================== 1. the candle
  // One flame alone on black water; as it comes sharp the camera sinks and the lights beyond rise into the picture.
  const flame = (out) => out.set(candle.x, candle.y + 0.03, candle.z);
  sc.shot('candle', 0, {
    pos: (out, t) => { const k = smoother((t - 1.2) / 4.8); out.set(candle.x + 0.24 - t * 0.01, lerp(0.56, 0.2, k), candle.z + lerp(0.5, 0.66, k)); },
    look: (out, t) => { const k = smoother((t - 1.2) / 4.8); out.set(candle.x, candle.y + lerp(-0.02, 0.09, k), candle.z); },
    fov: 21, aperture: 1, breathe: 0.05, sway: 0.003,
    focus: rack((out) => out.set(candle.x + 0.2, 0.4, candle.z + 0.45), flame, [[0, 0], [1.2, 0.05], [3.9, 1, 's']]),
  });

  // ================================================================== 2. the nave
  // One move: from high over the candles down to the water, tilting up as it lands, so that the rose window comes
  // into the picture with the moon sinking through its tracery and the kneeling figure small beneath it.
  const naveLen = c.doors - c.nave;
  sc.shot('nave', c.nave, {
    pos: [[0, [0.6, 12.6, 20.2]], [naveLen * 0.55, [-0.4, 5.8, 15.4], 'c'], [naveLen, [-1.3, 1.1, 9.8]]],
    look: [[0, [0, 0.5, 6.0]], [naveLen * 0.5, [0, 2.6, -10], 'c'], [naveLen, [0.4, 5.5, -22]]],
    fov: [[0, 40], [naveLen, 38]], breathe: 0.06,
  });

  // ================================================================== 3. the doors
  // He walks in as a man walks: a performer's own walk (`walk_in`, src/chars/motiondata.js: upright, his arms swinging
  // at his sides, his sword in its scabbard), with the performer's own slowing and his own stop, at the pace it was
  // performed. The clip carries him: at every step he stands where its travel puts him on one straight line from the
  // porch to the place he stops, so no foot slides. His footfalls are the clip's own, and water, spray and sound answer
  // them: they fall where his feet fall, not on the beats of the score. (Until 10 Nov he came in on the fight's guard
  // walk at half speed with his arms held still: Kevin: "he looks kind of weak walking in".)
  const WALK = 'walk_in', STOPPED = st.mark(P, WALK, 'stopped', 7.9), T0 = c.sight + 1.25 - STOPPED;      // he has stopped 1.25 s into 'sight'; he sets out in the porch, before the cut to the doors
  const gone = { x: 0, z: 0, yaw: 0 }, by = { x: 0, z: 0, yaw: 0 }, carries = st.carried(P, WALK, STOPPED, gone);
  const stopX = D.x - 0.75, stopZ = D.z - 4.0;                   // (a little north of the axis by the time he stops: from the porch he stands clear of her)
  // he sets out on the axis and walks straight to that place: the heading that takes the clip's travel there
  const far = Math.hypot(gone.x, gone.z), across = stopX - D.x;
  const walkYaw = carries ? Math.atan2(across, -Math.sqrt(Math.max(1e-6, far * far - across * across))) - Math.atan2(gone.x, gone.z) : Math.PI;
  const wc = Math.cos(walkYaw), ws = Math.sin(walkYaw);
  const startX = stopX - (gone.x * wc + gone.z * ws), startZ = stopZ - (-gone.x * ws + gone.z * wc);
  /** Where the clip has carried him at its time t. */
  const walkAt = (t, out) => { st.carried(P, WALK, t, by); return out.set(startX + by.x * wc + by.z * ws, 0, startZ - by.x * ws + by.z * wc); };
  /** The moment of the film at which he crosses a line across the nave: the light, his lantern and his eyes answer where he is. */
  const passes = (z) => { for (let t = 0; t < STOPPED; t += 1 / 60) if (walkAt(t, v3).z <= z) return T0 + t; return T0 + STOPPED; };
  const LEAVES = D.z + 1.75;                                     // the line of the open door leaves
  let walk = null;
  sc.at(T0, () => {
    st.place(P, startX, startZ, walkYaw); st.lantern(1.5);       // (in the doorway his lantern is the only warm thing: it burns high out in the night, and sinks as the hall's light finds him)
    walk = st.play(P, WALK, { fade: 0, loop: false }); st.dirty.add(P);
    st.look(P, v1.set(0.4, 2.6, -6), { weight: 0.6, rate: 2 });
    st.key(P, 0);                                                // in the porch he is a shape against the lit mist, and a lantern
  });
  // (the fighters take their pose before the cutscene's step: the clip's time here is the time of the pose that is drawn)
  sc.during(T0, c.mask + 3.5, () => { if (walk && P.char.clipName === WALK) { walkAt(walk.time, v3); P.pos.x = v3.x; P.pos.z = v3.z; } });
  const lit0 = passes(LEAVES + 0.9), lit1 = passes(LEAVES - 0.7);
  sc.during(lit0, lit1, (T, dt, u) => st.key(P, u >= 1 ? undefined : smoother(u)));      // the hall's light finds him as he comes through the doorway
  sc.during(lit0 - 0.3, lit1, (T, dt, u) => st.lantern(1.5 - 0.5 * smoother(u)));
  // the hall takes his eyes as he comes in: up into the dark of the north arcade, then down the nave
  sc.at(passes(LEAVES + 0.2), () => st.look(P, v1.set(-10, 7.5, 9), { weight: 0.6, rate: 1.8, limit: 0.5 }));
  // (`limit` stays on him as it was last set, and the fight never sets it: he fights with the limit this opening
  // leaves him, 0.7, and his chest's turn carries his sword arm. Left at the glance's 0.5, the recorded session became
  // another fight 101 s in: tools/capture.py --check, and --trace with tools/tracediff.mjs, which named it.)
  sc.at(passes(LEAVES - 1.3), () => st.look(P, v1.set(0.4, 3, -6), { weight: 0.75, rate: 1.6, limit: 0.7 }));
  // he slows and stands: he has seen her (the stop is the performer's own; only his eyes are added)
  sc.at(c.sight + 0.5, () => st.look(P, headB(v1), { weight: 0.85, rate: 2.5 }));

  // a. the doorway, from low on the water inside: he comes out of the porch's dark into the moon's pool of light
  // (Nearer and to one side, on the water just inside the doors: he stands a third in from the left and grows as he comes
  // on, the great open leaf fills the right of the picture, the porch's arches and the columns in the sea stand behind
  // him. Until 8 Nov 04:20 this stood 11 m off on the axis: he was a small figure dead centre between two dark leaves.
  // Six places tried in one run: .shots/h1_doors.png, the second panel.)
  sc.shot('doors', c.doors, {
    pos: [[0, [2.3, 0.3, 14.9]], [3, [2.1, 0.32, 14.2]]],
    look: [[0, [-1.3, 1.88, 22.2]], [3, [-1.1, 1.78, 20.2]]],
    fov: 30, aperture: 0.5, focus: chestP, breathe: 0.07,
  });
  // b. his boots, from his lantern side: the camera lies on the water and he walks through the picture, a ring from each step
  const bz = walkAt(c.doors + 4.4 - T0, v3).z, bx = v3.x + 0.25;      // (where he is when he is nearest the lens; the camera keeps its distance from his path)
  let bootX = bx + 1.95, bootY = 0.15;
  sc.shot('boots', c.doors + 3, {
    pos: (out, t) => out.set(bootX - t * 0.017, bootY + t * 0.003, bz + 0.15 - t * 0.117),
    look: (out) => { st.bone(P, 'LeftFoot', v1); st.bone(P, 'RightFoot', v2); out.lerpVectors(v1, v2, 0.5); out.y = 0.13; out.z -= 0.6; },      // (aimed ahead of him: he walks into the room the picture leaves him; low: the ragged hem of his cloak stays under the top bar)
    // (sharp on his boots themselves: the aim is ahead of him and the lens stands askew to his path, so the aim's own distance left them soft)
    lag: 3.2, fov: 32, aperture: 0.5, focus: (out) => { st.bone(P, 'LeftFoot', v1); st.bone(P, 'RightFoot', v2); out.lerpVectors(v1, v2, 0.5); }, breathe: 0.1,
  }, {
    // the candles drift: stand where none floats against the lens (the nearer side of his path that is clear)
    enter: () => {
      let best = -1;
      for (const off of [1.95, 1.6, 2.3, 1.3, 2.65]) {
        const x = bx + off, mid = bx + off * 0.62;
        const gap = Math.min(st.candleGap(x, bz), st.candleGap(x, bz - 0.3), st.candleGap(mid, bz) * 1.5, st.candleGap(mid, bz - 0.5) * 1.5);
        if (gap > best) { best = gap; bootX = x; }
        if (gap > 0.9) break;
      }
      bootY = best < 0.55 ? 0.4 : 0.15;                          // nowhere is clear: look over the flames instead
      st.lantern(0.5);                                           // (it hangs on the camera's side of him, a hand from his cloak: at full flame it bleached the hem white)
    },
  });
  sc.at(c.sight, () => st.lantern(1));

  // ================================================================== 4. he sees her (the painting)
  // From the porch behind him, through the great doorway, on a long lens: his back and cloak in the doorway's dark
  // frame, the candles, and far down the nave the Cantor standing under the rose window. As the camera drifts, the
  // open door leaf uncovers her standing sword.
  sc.shot('sight', c.sight, {
    pos: [[0, [1.42, 1.25, D.z + 10.0]], [3, [1.08, 1.3, D.z + 9.3]]],
    look: [[0, [-3.3, 4.9, K.z]], [3, [-3.1, 5.1, K.z]]],
    fov: 26, aperture: 0.5, breathe: 0.07,
    focus: rack(headP, headB, [[0, 0.35], [0.5, 0.35], [1.8, 1, 's']]),
  });

  // ================================================================== 5. her mask; her line
  // from below and to the nave's side of her: the mask in profile, the rose window a soft light behind it
  sc.shot('mask', c.mask, {
    pos: (out, t) => { const a = lerp(10, 27, t / 3.5) * DEG; headB(out); out.x += Math.sin(a) * 3.5; out.y -= 1.15 - t * 0.03; out.z += Math.cos(a) * 3.5; },
    look: (out) => { headB(out); out.x += 0.32; out.y += 0.3; },      // (the head's joint is at the nape: her eyes are 0.4 m above it)
    fov: [[0, 19.5], [3.5, 18.5]], aperture: 1, focus: headB, breathe: 0.05, sway: 0.004,
  });
  sc.at(c.mask + 0.8, () => st.snuff(K.x + 0.6, K.z, 3.4, 1.8));                 // the candles round her gutter
  sc.at(c.mask + 0.9, () => st.look(B, v1.set(PS.x, 1.6, PS.z + 4), { weight: 0.75, rate: 1.9, limit: 0.75 }));
  sc.at(c.line, () => st.voice('cantor_intro', say.text, say.seconds + 0.4));

  const lampT = c.mask + 3.5;
  sc.at(lampT, () => {
    st.place(P, PS.x, PS.z, PS.yaw); st.play(P, 'look_around', { fade: 0, at: STAND, speed: 0.12 }); st.relax(P, false, 0);
    st.look(P, headB(v1), { weight: 0.8, rate: 4 }); P.puppet = 'root';
  });
  // his helm, close, lit from below by the lantern at his hip: as she speaks the light on it shrinks, and steadies
  sc.shot('listen', lampT, {
    pos: [[0, [PS.x + 0.75, 1.46, PS.z - 2.4]], [2.5, [PS.x + 0.62, 1.48, PS.z - 2.2]]],      // on his sword side: he looks left, to answer her look right
    look: (out) => { headP(out); out.x -= 0.1; out.y -= 0.1; },
    fov: [[0, 18], [2.5, 17.4]], aperture: 0.8, focus: (out) => { headP(out); out.z -= 0.13; }, breathe: 0.06, sway: 0.004,      // (sharp on the visor, not the back of the helm)
  });
  sc.during(lampT + 0.3, c.rise + 0.4, (T, dt, u) => st.lantern(u >= 1 ? 1 : 1 - 0.6 * Math.sin(u * Math.PI) * (0.75 + 0.25 * wobble(T * 9, 7))));
  // (When the picture leaves him his eyes go to the point they rested on through these bars in the first take, where her
  // face was when she knelt: out of sight, and by 38.8, when they go to her face again, he is as he was then.)
  sc.at(c.rise, () => st.look(P, v1.set(K.x + 0.6264124014506807, 3.4670078837380927, K.z - 0.131809335787068), { weight: 0.8, rate: 4 }));

  // ================================================================== 6. she turns to him; the pipes open
  // She stands in profile for a breath after the cut. Then a quarter turn to her right, toward the nave, on two heavy
  // steps, and she draws herself up as her pipes burst open on the chord:
  //   TURN0 .. TURN1  the turn. The hips and legs of `turn_r` (her great sword's own quarter turn) are laid over the way
  //                   she stands as what they do SINCE their own first pose (an additive layer: her feet step from
  //                   where they stand and come back to it; her chest and her arms stay hers, and empty hands never
  //                   come together before her as they do in that clip). Her place turns and travels as that clip
  //                   carries its fighter, the quarter made a true 90 degrees, and half a pace further toward the nave.
  //                   Her right foot comes down in the middle of the turn, her left near its end: the water rings.
  //   TURN1 .. JOIN   she comes up into the stance she holds while the pipes open, her hips carried to where they were
  //                   at that moment in the first take (she rose from her knees then)
  //   JOIN ..         as it was. The stance and the way her weight settles in it are the LAST, UPRIGHT MOMENTS of the
  //                   clip she used to rise with (`pray_to_stand` from 6.40 s of its 6.87: she is on her feet, her arms
  //                   at her sides; nothing of its kneeling or of its hands is ever shown), on the same clock, her
  //                   place travelling as that clip carries it. From 33.0 on nothing differs from the first take but
  //                   what cloth, water and moths remember.
  const TURN = 'turn_r', TURN0 = c.rise + 0.25, TURN1 = c.chord - 0.75, DRIFT = [0.135, 0.591];
  const UP = 'pray_to_stand', STEP = 1 / 60, JOIN = c.chord - 0.05;               // JOIN: the step from which the first take is taken up (32.95)
  // (the clock of that rise: clip seconds against the cutscene's)
  const riseK = new Curve([[lampT, 2.3], [c.rise, 4.45], [c.chord - 0.35, 6.25], [c.chord + 0.6, 6.7]]);
  // where she was at JOIN in the first take (her place, her turn), a third of a second later, and where her hips stand
  // from her place in that clip (0.20 m to its left, 0.70 m before it)
  const WAS = { x: K.x + 0.48685288676008864, z: K.z - 0.047458355832585, yaw: -2.220446049250313e-16 }, SOON = [K.x + 0.3911015514110838, K.z - 0.029287819030115], AT = [0.05350838974118233 * S, 0.1923195868730545 * S];
  // ---- until then she stands and sings without a sound: her eyes go to him at 24.9, her arms come to her sides as her line ends
  sc.during(0, TURN1, (T, dt, u) => { if (u < 1) sing(ctx, st, still, T, dt, { arms: 1 - ramp(c.rise - 1.6, c.rise + 0.1, T), head: T < c.mask + 0.89 }); });
  // ---- the turn
  const car = { x: 0, z: 0, yaw: 0 }, whole = { x: 0, z: 0, yaw: 0 }, knows = st.carried(B, TURN, 99, whole) && Math.abs(whole.yaw) > 0.5;
  const info = B.char.info ? B.char.info(TURN) : null, feet = ((info && info.events) || [{ t: 0.367, name: 'foot-r' }, { t: 0.65, name: 'foot-l' }]).filter((e) => /^foot-/.test(e.name)).map((e) => ({ t: e.t, side: e.name === 'foot-l' ? 'l' : 'r', done: false }));
  let turnT = null;
  sc.at(TURN0, () => {
    B.puppet = true;
    if (B.char.additive && st.has(B, TURN)) { legs = B.char.additive(TURN, { weight: 1, at: 0, fadeIn: 0, fadeOut: 0, mask: 'lower' }); if (legs) { legs.speed = 0; turnT = new Curve([[TURN0, 0, 's'], [TURN1, legs.end, 's']]); } }
    if (!turnT) turnT = new Curve([[TURN0, 0, 's'], [TURN1, 0.733, 's']]);
  });
  sc.during(TURN0, TURN1, (T, dt, u) => {
    const t = turnT.at(T), len = turnT.at(TURN1);                                // the moment of the step she is seen in now
    if (legs) { if (u >= 1) legs.time = legs.end; else legs.speed = (turnT.at(T + dt) - legs.time) / dt; }      // (at its end the layer lets go: its last pose is its first)
    if (knows) st.carried(B, TURN, t, car); else { car.x = 0; car.z = 0; car.yaw = -STAND_YAW * smoother(t / len); }
    B.yaw = u >= 1 ? 0 : STAND_YAW * (1 - car.yaw / (knows ? whole.yaw : -STAND_YAW));
    const d = smoother(u), fx = Math.sin(STAND_YAW), fz = Math.cos(STAND_YAW);  // (she stood facing (fx, fz); her left was (fz, -fx))
    B.pos.x = K.x + (fz * car.x + fx * car.z) * S + DRIFT[0] * d; B.pos.z = K.z + (-fx * car.x + fz * car.z) * S + DRIFT[1] * d;
    for (const f of feet) if (!f.done && t >= f.t) { f.done = true; st.step(B, f.side); }
  });
  // ---- up into the stance, and on as it was
  let rest = null, hipPath = null;
  sc.at(TURN1, () => {
    B.yaw = 0;
    if (!st.has(B, UP)) return;
    rest = st.play(B, UP, { fade: 0.5, at: riseK.at(JOIN - STEP), speed: 0 });      // held where the first take had it a step before JOIN: upright, on both feet
    st.bone(B, 'Hips', v1);
    hipPath = new Curve([[TURN1, [v1.x, 0, v1.z], 's'], [JOIN, [WAS.x + AT[0], 0, WAS.z + AT[1]]], [JOIN + 0.3, [SOON[0] + AT[0], 0, SOON[1] + AT[1]]]]);
  });
  // her hips on their way there, whatever the two poses make of them between them (her place follows)
  sc.during(TURN1, JOIN - 1e-4, (T, dt, u) => { if (!hipPath || u >= 1) return; st.bone(B, 'Hips', v1); hipPath.into(T, v2); B.pos.x += v2.x - v1.x; B.pos.z += v2.z - v1.z; });
  // At JOIN she is where she was, and what remembers the moments before is set to what it was at this moment of the first
  // take, so that nothing of the turn is carried across 33.0: where her eyes were on their way up to the vault (the
  // animation's look is eased: its turn, its tip and how much of it there is), and, a step later, the operator's hand
  // (the rig's lagging aim and its speed). From here the clip's own travel moves her, as it did.
  sc.at(JOIN - 1e-4, () => {
    if (!rest) return;
    B.pos.x = WAS.x; B.pos.z = WAS.z; B.yaw = WAS.yaw; B.puppet = 'root';
    const L = B.char.graph && B.char.graph.look; if (L && 'amount' in L) { L.yaw = -0.21493624279395177; L.pitch = 0.04945199208764268; L.amount = 0.8415173589945328; }
  });
  sc.at(JOIN + STEP - 1e-4, () => { const a = rig.aim; if (rest && a) { a.x = K.x + 0.7215267691217789; a.y = 5.890370800402197; a.z = K.z + 0.605187248590134; a.vx = -0.13077497663503165; a.vy = 0.7496919058477124; a.vz = 0.08800922469347801; } });
  sc.during(JOIN - STEP - 1e-4, c.chord + 0.6, (T, dt, u) => { if (rest && B.char.clipName === UP) rest.timeScale = u >= 1 ? 0 : (riseK.at(Math.min(c.chord + 0.6, T + dt)) - rest.time) / dt; });
  // Her arms open WITH her pipes and never stand still: `cast_wide`'s spread arms laid over the standing figure at a
  // weight that is keyed. They are widest just after the downbeat (short of level: arms held straight out are a
  // T-pose, not a gesture), sink through the chord to the open-handed stance of a statue of grace (about half way,
  // palms forward) on the B flat at 36, and are at her sides on the A at 38.
  const armsK = new Curve([[c.chord - 0.55, 0, 's'], [c.chord + 0.12, 0.74], [c.chord + 1.0, 0.71], [c.chord + 3.0, 0.53], [c.chord + 4.2, 0.47], [c.draw - 0.3, 0, 's']]);
  sc.during(c.chord - 0.55, c.draw - 0.3, (T, dt, u) => st.pose(B, 'cast_wide', 1.9, u >= 1 ? 0 : armsK.at(T)));
  // her face lifts to the vault as they open (a little: the mask must still be seen from the water), and comes down to him in `gaze`
  // (the point it lifts to is the one of the first take: ten metres up, fourteen before where her place was then)
  sc.at(c.chord - 0.45, () => st.look(B, v1.set(K.x + 0.6596189718485985, 10, K.z + 13.853813709388202), { weight: 0.9, rate: 2.4 }));
  sc.during(c.rise + 0.3, c.chord - 0.2, (T, dt, u) => {                          // water falls from her hem as it swings round
    if (u >= 1) return;
    const n = Math.floor(T * 14), a = n * 2.399963, r = (0.9 + 0.7 * ((n * 0.618) % 1)) * S * 0.3;
    if (Math.floor((T - dt) * 14) !== n) {
      st.bone(B, 'Hips', v3);
      const x = v3.x + Math.cos(a) * r, z = v3.z + Math.sin(a) * r;
      st.ripple(x, z, 0.45, 0.3);
      // (as many drops, thrown the same way, as ran off her when she rose here: the effects draw their chances from one
      // stream, and every spark after this moment, the fight's too, falls as it did only if nothing is added or left out)
      if (ctx.vfx && ctx.vfx.spray) ctx.vfx.spray(v1.set(x, 0.3 + 0.5 * ((n * 0.382) % 1), z), v2.set(0, -1, 0), 5, 0.35);
    }
  });
  sc.at(c.chord - WINGS_OPEN, () => { st.wingSpeed(1 / WINGS_OPEN); st.wings(1); });     // they burst open through the last second of the build: wide on the downbeat
  sc.at(c.chord + 1, () => st.wingSpeed());
  sc.at(c.chord, () => {
    st.pulse(1); st.halo(1); rig.shake(0.5, 1.6, 3.2);
    st.ripple(B.pos.x, B.pos.z, 3, 2.4); st.gust(B.pos.x, B.pos.z, 1);
    if (ctx.vfx && ctx.vfx.motes) ctx.vfx.motes(v1.set(B.pos.x, 5.2, B.pos.z), 40, 0xffe2a0);
  });
  sc.during(c.chord, c.chord + 3, (T, dt, u) => st.wings(undefined, u >= 1 ? 0.6 : 0.9 * smoother(u * 4) - 0.3 * smoother((u - 0.4) / 0.6)));
  // the wind of the chord: a line of disturbance running west down the nave to him
  let windZ = 0;
  sc.at(c.chord + 0.1, () => { windZ = K.z + 2; });
  sc.during(c.chord + 0.1, c.chord + 4.6, (T, dt, u) => {
    const z = lerp(K.z + 2, PS.z + 3, u);
    if (z - windZ >= 0.9 || u >= 1) { windZ = z; st.wake(-9.5, z, 9.5, z, 0.42 * (1 - 0.5 * u)); }
  });

  // a. from the nave, on the water: she stands in profile; she comes round to us; the camera tilts up as her pipes
  //    open, so the rose window and the moon rise into the picture behind the opening fan
  // (Until JOIN the aim is where it was, moment by moment, in the first take, when it rode up with her head
  // as she rose from her knees: the move still serves, and the operator's lag carries what came before across 33.0.)
  const aimWas = new Curve([[0, [0.536, 4.176, 0.075]], [0.2, [0.52, 4.157, 0.268]], [0.4, [0.534, 4.197, 0.373]], [0.6, [0.571, 4.248, 0.518]], [0.8, [0.576, 4.172, 0.646]], [1, [0.607, 4.054, 0.596]],
    [1.2, [0.681, 4.103, 0.474]], [1.4, [0.755, 4.396, 0.391]], [1.6, [0.81, 5.096, 0.39]], [1.8, [0.835, 5.57, 0.494]], [2, [0.815, 5.945, 0.589]], [2.2, [0.771, 6.164, 0.651]], [2.4, [0.722, 6.258, 0.674]],
    [2.6, [0.678, 6.279, 0.67]], [2.8, [0.633, 6.292, 0.648]], [2.94, [0.601, 6.293, 0.635]]].map((k) => [k[0], [K.x + k[1][0], k[1][1], K.z + k[1][2]], 'c']));
  sc.shot('rise', c.rise, {
    pos: [[0, [0.1, 0.4, 7.4]], [3, [0.35, 0.5, 5.8]], [6, [0.6, 0.72, 3.6]]],
    look: (out, t, T) => { if (st.has(B, UP) && T < JOIN + STEP * 0.5) { aimWas.into(t, out); return; } st.bone(B, 'Hips', v1); headB(out); out.lerp(v1, 0.42); out.x = lerp(out.x, 0.5, 0.5); out.y += 1.5; },
    lag: 2.6, fov: [[0, 41], [6, 38.5]], breathe: 0.08,
  });
  // b. closer and from below: the mask against the fan; her eyes on him
  sc.shot('gaze', c.chord + 3, {
    pos: [[0, [-1.15, 1.05, K.z + 9.6]], [3, [-0.7, 1.4, K.z + 7.9]]],
    look: (out) => { headB(out); out.y -= 0.7; },
    lag: 4, fov: 36, aperture: 0.3, focus: headB, breathe: 0.07,
  });
  sc.at(c.chord + 2.3, () => st.look(B, v1.set(PS.x, 1.6, PS.z), { weight: 0.85, rate: 1.5, limit: 1.0 }));      // her face comes down to him across the cut
  sc.at(c.chord + 3.1, () => st.pulse(0.7));
  sc.at(c.chord + 5, () => st.pulse(0.7));

  // ================================================================== 7. he draws; the lantern flares
  // the wind reaches him as he makes up his mind: his cloak streams away from her, his flame shrinks, and then
  const blow = (from, len, power) => sc.during(from, from + len, (T, dt, u) => { if (u >= 1) st.wind(P); else { const k = Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5) * (1 - smoother((u - 0.55) / 0.45)); st.wind(P, 0.35, 0.4 * k, -0.5 + (power + 0.5) * k); } });
  blow(c.draw - 0.3, 2.4, 6.5);
  blow(c.name - 0.4, 2.6, 8);
  sc.during(c.draw + 0.05, c.draw + 1.0, (T, dt, u) => st.lantern(u >= 1 ? 1 : 1 - 0.55 * Math.sin(u * Math.PI) * (0.6 + 0.4 * wobble(T * 11, 3))));
  sc.at(c.draw - 0.2, () => { st.play(P, 'look_around', { fade: 0, at: STAND, speed: 0.1 }); st.look(P, headB(v1), { weight: 0.9, rate: 3 }); });
  // a. his right hand crosses to the hilt at his left hip, and closes
  const HILT = c.draw + 1.5;                                                      // the cut: the hand is on the hilt
  sc.perform(P, 'draw_sword', [[c.draw + 0.5, 0], [HILT - 0.12, st.mark(P, 'draw_sword', 'hilt', 0.45) + 0.01], [HILT, 0.49]], { fade: 0.3, root: true });
  sc.shot('hilt', c.draw, {
    pos: [[0, [PS.x + 1.05, 1.0, PS.z - 2.3]], [1.5, [PS.x + 0.95, 1.04, PS.z - 2.15]]],
    look: (out) => { st.bone(P, 'Spine', out); out.y += 0.12; },
    lag: 5, fov: 32, aperture: 0.5, focus: (out) => st.bone(P, 'Spine1', out), depth: 0.7, breathe: 0.09,
  });
  // a2. the draw itself, close: from his sword side, looking down past his forearm at his LEFT hip. The fist comes onto
  //     the hilt and closes (the scabbard tips into it: the wardrobe's doing); he turns toward us as he pulls and the
  //     steel comes out of the scabbard's mouth across his breast, until the point is free: that is the cut.
  //     (Every view from in front or from his shield side is filled by the shield, which he brings round before him as
  //     he draws: tried with &cineprobe at 40.4 and 40.8, sheets .shots/d3_probe.png and d4_probe.png.)
  const GRIP = c.draw + 1.0, FREE = HILT + 0.4;                                    // draw_sword2: the point leaves the scabbard at 0.3
  sc.shot('grip', GRIP, {
    pos: [[0, [PS.x + 0.90, 1.56, PS.z - 0.59]], [FREE - GRIP, [PS.x + 0.95, 1.6, PS.z - 0.61]]],
    // (the lens stays on the hip: the fist goes out of the top of the picture and the eye is left on the steel sliding out
    // of the scabbard. Following the fist put the scabbard behind the shield, and focusing on it blurred everything else.)
    look: (out, t, T) => { out.set(PS.x - 0.16, 1.03, PS.z - 0.2); st.bone(P, 'RightHand', v1); out.lerp(v1, 0.2 * ramp(HILT + 0.02, HILT + 0.3, T)); },
    // (stopped right down: at 0.45 his forearm, half a metre from the lens, was a large blur across the top of the picture
    // for the whole shot and the fist went soft as it came toward us with the steel)
    lag: 9, fov: 28, aperture: 0.1, breathe: 0.08,
  });
  // b. the blade comes out across his body and up, and he is in his guard
  sc.at(HILT, () => { st.sheathe(false); st.sound('sword_draw', P.pos); });
  sc.perform(P, 'draw_sword2', [[HILT, 0], [HILT + 0.95, 0.75]], { fade: 0.05, root: true });
  sc.at(HILT + 0.95, () => st.play(P, 'idle', { fade: 0.5, loop: true }));
  // (it is on the camera's side of him: it lifts as his fist closes, so the hilt can be seen, and leaps as he comes into his guard)
  const flare = new Curve([[GRIP, 1], [HILT, 1.4], [HILT + 0.8, 2.5, 's'], [HILT + 2.6, 1.3], [c.name, 1.0, 's']]);
  sc.during(GRIP, c.name, (T) => st.lantern(flare.at(T)));
  // From his sword side, a little above his shoulder: his lantern is on this side, so he is lit here and nowhere else.
  // The fist draws back toward us with the blade coming out across his body, the point swings round and up, and he
  // turns to us into his guard (the clip ends 54 degrees to his right) with the blade standing before his visor and the
  // flame leaping at his hip. From above, his pauldron covers the armpit, where the armour's skin stretches until it
  // is repaired (docs/castcheck.md): what shows under the arm from here reads as the mail of the armhole.
  // The camera rises with the blade. (From in front on his shield side, where this shot stood before, he was a black
  // figure behind a black shield: the draw could not be seen at all.)
  // (It follows the close view on the same line, twice as far off: the point swings free as the picture opens.)
  sc.shot('draw', FREE, {
    pos: [[0, [PS.x + 2.5, 1.76, PS.z - 0.56]], [1.1, [PS.x + 2.64, 1.88, PS.z - 0.46]]],
    look: [[0, [PS.x, 1.24, PS.z - 0.21]], [0.6, [PS.x, 1.37, PS.z - 0.18], 's']],
    fov: 30, aperture: 0.4, focus: chestP, depth: 0.8, breathe: 0.1,
  });
  // c. her face: she looks from him to her sword (her arms have come down)
  const REGARD = c.draw + 3;
  sc.at(c.draw + 0.3, () => st.play(B, 'look_down', { fade: 1.4, at: 0.02, speed: 0 }));
  sc.at(REGARD + 0.9, () => { st.look(B, gripB(v1), { weight: 0.9, rate: 1.6, limit: 1.1 }); st.pulse(0.6); });
  const regardTurn = new Curve([[REGARD + 1.0, 0, 's'], [c.sweep - 0.1, 0.62, 's']]);
  let regarded = 0;
  sc.during(REGARD + 1.0, c.sweep - 0.1, (T) => { const y = regardTurn.at(T); B.yaw += y - regarded; regarded = y; });
  // From below on her SWORD side (the south), arcing a little ahead of her turn: she turns TOWARD the lens, so her face
  // opens to us as her eyes leave him and go past us to the sword, and her veil stays behind her. (From the north side,
  // where this stood, she turned away: the last second was a profile behind a white sheet of veil. The sword stands
  // 35 degrees outside this picture, nowhere near the lens. And he looks screen-right in `draw`: from here she looks left.)
  sc.shot('regard', REGARD, {
    pos: (out, t) => { const a = (33 + t * 5) * DEG; headB(out); out.x += Math.sin(a) * 5.0; out.y -= 2.0; out.z += Math.cos(a) * 5.0; },
    look: (out) => { headB(out); out.y -= 0.1; },
    lag: 4, fov: 22, aperture: 0.7, focus: headB, breathe: 0.06,
  });

  // ================================================================== 8. she takes up the blade and sweeps it once
  // a. her hand closes on the grip. She is stood where her arm can reach it; the arm is brought the last of the way
  //    onto the grip and the fingers close round it (stage.js, Grasp). The sword stands taller than she kneels: its
  //    grip is at the height of her eyes.
  const TAKE_YAW = 0.95;                                                          // turned from the nave toward her sword
  const GRASP = 1.4;                                                              // pull_lever: her right hand has come up to chest height in front of her, her head turned to it
  const REACH = 0.045 * S;                                                        // the grip stands this far beyond where the clip leaves her wrist (the hollow of her palm)
  const hold = new THREE.Vector3(), takeAt = new THREE.Vector3();
  let grasp = null;
  sc.at(c.sweep, () => {
    // stand her so that the reach in the clip, carried on in its own direction, ends on the grip
    st.place(B, K.x, K.z, TAKE_YAW); st.play(B, 'pull_lever', { fade: 0, at: GRASP, speed: 0 }); st.dirty.add(B); st.flush();
    st.bone(B, 'RightArm', v1); st.bone(B, 'RightHand', v2); gripB(hold);
    v2.sub(v1).setY(0); const reach = v2.length() + REACH; v2.normalize();
    takeAt.set(K.x + hold.x - v2.x * reach - v1.x, 0, K.z + hold.z - v2.z * reach - v1.z);
    st.place(B, takeAt.x, takeAt.z, TAKE_YAW); st.dirty.add(B);
    grasp = st.grasp(B); grasp.point.copy(hold); grasp.axis.set(0, 1, 0); grasp.weight = 0; grasp.grip = 0; grasp.swing = 0.35;
    st.look(B, hold, { weight: 0.9, rate: 6, limit: 1.1 });
    B.puppet = true;
  });
  const TAKE = c.sweep + 1.4;                                                     // the cut: she has it
  sc.perform(B, 'pull_lever', [[c.sweep, 0.72], [c.sweep + 0.8, GRASP], [TAKE, GRASP + 0.2]], { fade: 0, root: false });
  // (a span's last call, u = 1, comes AFTER the events of that moment: it is the one that must let the arm go. Until
  // 8 Nov the reach stayed on at full weight after the take: her right arm was held to where the sword had stood and
  // her left hand swung through the air beside the grip, all through the wind-up, the sweep and the last shot.)
  sc.during(c.sweep, TAKE, (T, dt, u) => {
    if (!grasp) return;
    if (u >= 1) { grasp.weight = 0; grasp.grip = 0; return; }
    grasp.weight = ramp(c.sweep + 0.05, c.sweep + 0.72, T); grasp.grip = ramp(c.sweep + 0.66, c.sweep + 1.0, T);
  });
  sc.shot('hand', c.sweep, {
    // from beyond the sword and below its cross, looking up past the grip at her face: the hand comes in and closes
    pos: (out, t) => { headB(v2); out.copy(hold).sub(v2).setY(0).normalize(); const sx = -out.z, sz2 = out.x; out.multiplyScalar(2.5 - t * 0.12).add(hold); out.x += sx * 0.9; out.z += sz2 * 0.9; out.y = hold.y - 1.55; },
    look: (out) => { headB(v2); out.copy(hold).lerp(v2, 0.3); out.y += 0.05; },
    fov: 31, aperture: 0.5, focus: (out) => out.copy(hold), breathe: 0.06,
  });
  // b. the blade drawn back: both fists on the grip
  sc.at(TAKE, () => { if (grasp) { grasp.weight = 0; grasp.grip = 0; } st.look(B, v1.set(PS.x, 1.6, PS.z), { weight: 0.6, rate: 3 }); st.place(B, takeAt.x, takeAt.z, TAKE_YAW); st.take(); st.blade(0.3); st.ripple(hold.x, hold.z, 1.6, 0.8); });
  // (slash_low is the great sword's own clip: both fists on the grip from first frame to last. The blade goes straight
  // up before her, 0.25; back over her shoulder, 0.7; one level sweep right to left, 0.70 to 1.12; and home to her guard)
  sc.perform(B, 'slash_low', [[TAKE, 0.03], [TAKE + 0.7, 0.27], [c.fall - 0.5, 0.34], [c.fall, 0.7], [c.fall + 0.66, 1.13], [c.fall + 1.7, 1.45], [c.name - 0.15, 1.8]], { fade: 0, root: true });
  sc.at(c.name - 0.15, () => st.play(B, 'idle', { fade: 0.5, loop: true }));
  // (from the nave, below her: the mask, the two fists on the long grip, the blade going back; the moon behind)
  // (20 degrees to her right of straight before her, not 46: the moon stands behind her fists, the fan is seen broad, and
  // the lens does not look up into her raised right armpit, where the repaired model shows a near-black under-layer: 8 Nov, 02:30)
  const WA = TAKE_YAW - 0.35;
  sc.shot('windup', TAKE, {
    pos: (out, t) => { const d = 7.8 - t * 0.35; out.set(takeAt.x + Math.sin(WA) * d, 1.1 + t * 0.12, takeAt.z + Math.cos(WA) * d); },
    // (her head stays in the upper third and her fists in the picture all the way: the aim used to climb after the blade,
    // which goes back over her shoulder and out of sight, so she sank to the bottom of a picture of organ pipes)
    look: (out) => { st.bone(B, 'RightHand', v1); headB(out); const y = out.y - 0.5; out.lerp(v1, 0.3); out.y = y; },
    lag: 4, fov: 40, breathe: 0.08,
  });
  sc.at(c.fall - 0.15, () => { st.wingSpeed(1.4); st.wings(0.55); });             // the pipes sweep back into two wings as she turns
  // c. the sweep, which is also her turn to face him
  const turn = new Curve([[c.fall, TAKE_YAW, 's'], [c.fall + 1.35, 0, 's']]);
  let lastYaw = TAKE_YAW;
  sc.at(c.fall - 0.25, () => st.blade(1));                                        // the blade takes light as it starts round
  sc.at(c.fall, () => { lastYaw = TAKE_YAW; ctx.bus.emit('swing', { who: 'boss', heavy: true, weapon: B.weapon }); });
  sc.during(c.fall, c.fall + 1.35, (T) => { const y = turn.at(T); B.yaw += y - lastYaw; lastYaw = y; });
  sc.at(c.fall + 0.3, () => {
    st.snuff(K.x, K.z, RING, 2.3); rig.shake(0.35, 0.8, 7); st.gust(K.x, K.z, 1);
    if (ctx.vfx && ctx.vfx.splashRing) ctx.vfx.splashRing(v1.set(B.pos.x, 0.07, B.pos.z), 5.5, 1); else st.ripple(B.pos.x, B.pos.z, 4, 3);
  });
  sc.during(c.fall + 0.3, c.name + 1.5, (T, dt, u) => st.blade(u >= 1 ? 0 : 1 - smoother(u)));
  // From high in the nave, three-quarters down on her: the blade goes round in both her fists, the water stands up in a
  // ring round her feet, and as the candles die outward from her the camera rises to hold the widening dark circle.
  // (Straight down from the vault, where this shot was first, she was a heap of cloth and pipes: no figure, no blade.)
  // (The cut is a quarter second BEFORE the sweep, which still begins on the bar: in the last quarter second of `windup` she
  // turned her back to the low lens: her skirt a white dome, a smooth ball of under-layer on her shoulder; docs/castcheck.md, R3.3.)
  const RING_CUT = c.fall - 0.27;
  sc.shot('ring', RING_CUT, {
    pos: [[0, [4.6, 8.1, K.z + 15.5]], [0.27, [4.5, 8.4, K.z + 15.2]], [3.27, [2.8, 12.2, K.z + 11.4]]],
    look: (out) => { st.bone(B, 'Hips', out); out.y = 2.7; },
    lag: 3, fov: 40, breathe: 0.05,
  });

  // ================================================================== 9. both in one frame; her name; the hand-over
  const playPos = new THREE.Vector3(), playDir = new THREE.Vector3(), playLook = new THREE.Vector3(); let playFov = 50;
  // (he stands a third of the way in from the left, his back to us, small and near; she is as tall in the picture as he
  // is, 34 m off under the rose window, and grows as she comes on: that is what gives her her size. Deep focus: both read.)
  const wideP = new Curve([[0, [5.3, 0.85, 19.6]], [6, [4.6, 0.95, 19.2]]]), wideL = new Curve([[0, [-1.9, 3.3, 0.5]], [6, [-1.5, 3.4, 0.2]]]);
  const hand = (t) => smoother((t - 1.9) / (c.end - c.name - 1.9));               // 0 the wide picture .. 1 the play camera, with no speed left
  const probe = () => { playFov = playPose(ctx, playPos, playDir, st.playMode); playLook.copy(playPos).addScaledVector(playDir, 24); };
  sc.at(c.name, () => { st.place(P, PS.x, PS.z, PS.yaw); st.look(P, null); st.look(B, null, { rate: 2 }); probe(); });
  sc.during(c.name + 1.5, c.end, probe);                                          // the play camera frames her too: ask again as she moves
  sc.shot('name', c.name, {
    pos: (out, t) => { wideP.into(t, out); out.lerp(playPos, hand(t)); },
    look: (out, t) => { wideL.into(t, out); out.lerp(playLook, hand(t)); },
    fov: { at: (t) => lerp(38, playFov, hand(t)) },
    breathe: 0.06,
  });
  sc.at(c.name + 0.5, () => st.nameCard(NAME, 4.4));
  // she comes on: two steps that the water feels, and takes her guard where the fight begins
  // (her feet come down on the beats at 53 and 54: worked out from the clip's footfalls, 0.317 and 1.017 s)
  let stride = null, fromX = 0, fromZ = 0;
  const adv = new Curve([[c.name + 1.2, 0, 's'], [c.name + 3.4, 1, 's']]);
  sc.at(c.name + 1.1, () => { B.puppet = true; fromX = B.pos.x; fromZ = B.pos.z; stride = st.play(B, 'walk_f', { fade: 0.45, at: 0.6, speed: 0.6, loop: true }); });
  sc.during(c.name + 1.2, c.name + 3.4, (T, dt, u) => {
    const k = adv.at(T); B.pos.x = lerp(fromX, BS.x, k); B.pos.z = lerp(fromZ, BS.z, k);
    if (stride && B.char.clipName === 'walk_f') stride.timeScale = clamp(Math.abs(adv.speed(T)) * Math.hypot(BS.x - fromX, BS.z - fromZ) / (CANTOR_WALK * S), 0.25, 1.2);
  });
  sc.at(c.name + 3.0, () => st.play(B, 'idle', { fade: 0.6, loop: true }));
  sc.at(c.name + 2.6, () => { st.wingSpeed(); st.wings(REST.wings); });
  sc.during(c.name, c.end - 0.3, (T, dt, u) => { st.wings(undefined, 0.6 * (1 - smoother(u))); st.halo(lerp(1, REST.halo, smoother(u))); });
  sc.during(c.fall, c.end, () => st.mood(st.candlelight()));                      // the hall darkens by the circle she put out

  return sc.ready();
}
