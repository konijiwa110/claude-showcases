// The rescue: the pilgrim cannot lose. Kevin, 10 Nov: "make it so you CANT LOSE. when you lose, there's a spotlight
// on you (so get rid of the you died message). and then a french fries (in the french fries container that's red but
// no logo) falls down from the spot light. When it reaches you, you go back to full life. cinematic with great camera
// work but happens fast". A woman nobody sees says one of two lines each time (LINES in src/cine/cues.js, recorded with
// ElevenLabs v4 by tools/voice.py; the subtitles lower case, as he wrote them).
//
// The game holds the fall for a moment in the play camera first (src/game.js, RESCUE.wait), then:
//
//    0.00  1 'spot'    from high over him, looking down: the hall has gone dark. On 0.12 a lamp clunks on over him:
//                      a circle of white on the black water with him lying in it. Her line begins (0.40).
//    1.15  2 'up'      from the water by his head, up the beam: out of the light high above, a red carton falls
//                      (1.20), the camera tilting down with it
//    2.50  3 'catch'   low beside him: it lands on his chest (about 2.8), stands there a breath, and goes up in warm
//                      light; he is whole again (Player.revive) and begins to get up
//    3.30  4 'rise'    he gets up inside the circle; the lamp clunks off (3.80) and the hall comes back; the camera
//                      comes round to where the play camera will be. 4.60 the end: the fight goes on where it was.
//
// He is not moved: he gets up where he fell. She is: if she stands nearer than KEEP she is put back along the line
// between them (in the cut that opens it), so the cameras have room and he has a moment when it ends.
import * as THREE from 'three';
import { Scene } from './timeline.js';
import { Curve, clamp, lerp, smoother } from './ease.js';
import { line } from './cues.js';
import { playPose } from './intro.js';
import { RESCUE_LINES } from '../core/constants.js';

const KEEP = 7.5;                                              // metres: the least room between them while it plays
const G = 9.8;
/** The carton's fall: it comes out of the light `from` metres up at `drop` seconds and falls onto his chest, as a
 *  paper carton does, against the air: it would come no faster than `vt` m/s however far it fell (about right for a
 *  box of a hundred grams with this face to the air), so the last metre lasts long enough to be seen. */
export const DROP = { drop: 1.2, from: 9, vt: 9 };
/** The two ways he lies: on his back (thrown back, flung) or on his face (struck from behind), and how each gets up. */
const UP = { back: { clip: 'getup', at: 4.25, speed: 1.75 }, face: { clip: 'getup_front', at: 1.95, speed: 1.6 } };
// Her lines come in turn (RESCUE_LINES, src/core/constants.js): the first fall of a fight always has the first.
/** Seconds he cannot be hurt once it is over (the fight goes on at once: she may be in the middle of a stride). */
export const RESCUE_GRACE = 1.5;

export function buildRescue(ctx, st, rig) {
  const P = ctx.player, B = ctx.boss, props = ctx.cine.props, bnd = ctx.arena.bounds;
  const n = ctx.game.rescues || 0, name = RESCUE_LINES[n % RESCUE_LINES.length], say = line(ctx, name);
  const v1 = new THREE.Vector3(), chest = new THREE.Vector3(), head = new THREE.Vector3(), hips = new THREE.Vector3(), drop = new THREE.Vector3();
  const lying = /fwd/.test(P.char.clipName || '') ? 'face' : 'back';

  // where he lies, and a frame of reference on him: `f` from his head toward his feet, `s` to the side of him that
  // looks toward the middle of the hall (the cameras stand there: there is always room on that side). He may still be
  // going down when it begins (thrown, he is in the air 0.7 s after the blow): it is measured again as the carton
  // appears (DROP.drop), when he has come to rest, and every shot from then on stands on that.
  let fx = 0, fz = 1, sx = 1, sz = 0, sideSign = 0, land = 0.3;
  // the top of him over a point (what a ray straight down meets first: armour, cloak, shield), or a hand over his chest
  const ray = new THREE.Raycaster(), hits = [];
  const surface = (x, z, y0) => {
    ray.set(v1.set(x, y0 + 1.5, z), new THREE.Vector3(0, -1, 0)); ray.far = 2.5; hits.length = 0;
    P.root.updateMatrixWorld(true); ray.intersectObject(P.root, true, hits);
    const h = hits.find((q) => q.object.visible && q.object.isMesh && !q.object.userData.fxTwin);
    return h ? h.point.y : y0 + 0.13;
  };
  const measure = () => {
    st.bone(P, 'Spine2', chest); st.bone(P, 'Head', head); st.bone(P, 'Hips', hips);
    const fx0 = hips.x - head.x, fz0 = hips.z - head.z, fl = Math.hypot(fx0, fz0) || 1; fx = fx0 / fl; fz = fz0 / fl;
    sx = -fz; sz = fx;
    if (!sideSign) sideSign = sx * -chest.x + sz * -chest.z < 0 ? -1 : 1;
    sx *= sideSign; sz *= sideSign;
    land = surface(chest.x, chest.z, chest.y) + 0.004;           // the carton's foot meets the top of him there
  };
  measure();
  const at = (out, along, side, y) => out.set(chest.x + fx * along + sx * side, y, chest.z + fz * along + sz * side);
  // fallen in t seconds from rest with drag: vt^2 / g * ln(cosh(g t / vt)). How long it falls is fixed when this is
  // built (every moment after it is keyed to LAND); where it starts is set when it appears, from where he lies then.
  const fallen = (t) => (DROP.vt * DROP.vt / G) * Math.log(Math.cosh(G * t / DROP.vt));
  const fallT = (() => { const h = DROP.from - 0.35; let lo = 0, hi = 6; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (fallen(m) < h) lo = m; else hi = m; } return hi; })();
  const LAND = DROP.drop + fallT;
  let top = DROP.from;
  const cartonAt = (out, T) => out.set(chest.x, Math.max(land, top - fallen(Math.max(0, T - DROP.drop))), chest.z);

  // her place: back along the line between them if she is near (the cut hides it), facing him
  const room = (() => {
    let dx = B.pos.x - P.pos.x, dz = B.pos.z - P.pos.z; const d = Math.hypot(dx, dz);
    if (d >= KEEP) return null;
    if (d > 0.2) { dx /= d; dz /= d; } else { dx = 0; dz = P.pos.z > 0 ? -1 : 1; }
    const lim = (x, z) => [clamp(x, -(bnd.hx - 3), bnd.hx - 3), clamp(z, -(bnd.hz - 4.5), bnd.hz - 4.5)];
    let [x, z] = lim(P.pos.x + dx * KEEP, P.pos.z + dz * KEEP);
    if (Math.hypot(x - P.pos.x, z - P.pos.z) < KEEP * 0.85) { const w = P.pos.z > 0 ? -1 : 1; [x, z] = lim(P.pos.x, P.pos.z + w * KEEP); }      // no room that way: along the nave
    return { x, z, yaw: Math.atan2(P.pos.x - x, P.pos.z - z) };
  })();

  const dim = (k) => { const L = ctx.gfx.lights; if (L) L.dim = k; };
  const key = ctx.gfx.materials && ctx.gfx.materials.key, keyRest = key ? key.power : 1;
  const end = (skipped) => {
    props.hide(); dim(1); if (key) key.power = keyRest;
    if (P.alive === false || P.hp < P.hpMax) P.revive();      // (a skip lands here before the carton has)
    if (skipped) { st.play(P, 'idle', { fade: 0, loop: true }); st.play(B, 'idle', { fade: 0, loop: true }); }
    P.afterPuppet = RESCUE_GRACE;
    ctx.game.rescues = n + 1;
  };

  const level = new Curve([[0, 0], [0.11, 0], [0.12, 1], [0.15, 0.55], [0.18, 1], [3.79, 1], [3.80, 0.5], [3.84, 0.15], [3.92, 0]]);
  const sc = new Scene(ctx, st, rig, {
    name: 'rescue', duration: 4.6, end,
    letterbox: [[0, 1], [4.0, 1], [4.6, 0, 's']],
    // (the hall falls away, the lamp is twice what it would be at 1; the picture flares as the carton goes into him)
    exposure: [[0, 0.55], [LAND + 0.31, 0.55], [LAND + 0.36, 0.72], [LAND + 0.9, 0.55, 's'], [3.8, 0.55], [4.3, 1, 's']],
  });

  // ------------------------------------------------------------------ 1. the lamp
  sc.at(0, () => {
    P.puppet = 'root';                                         // what is left of his fall goes on
    if (room) st.place(B, room.x, room.z, room.yaw);
    st.play(B, 'idle', { fade: 0.25, loop: true }); st.look(B, chest, { weight: 0.6, rate: 2 });
    dim(0.2); if (key) key.power = keyRest * 0.25;
    ctx.gfx.post.hurt = 0;                                     // (the red of his fall: the play camera leaves it as it was while a cutscene has the picture)
    // the cut skips a moment: the water is still and what her blow threw up has fallen (the circle of light lay on
    // her slam's spray and rings like broken glass)
    if (ctx.water && ctx.water.calm) ctx.water.calm(); if (ctx.vfx && ctx.vfx.reset) ctx.vfx.reset();
    props.show(false);
    if (ctx.audio && ctx.audio.duck) ctx.audio.duck(0.75, 4.0);
  });
  // a follow spot: on him while he comes to rest, then still
  const sideV = new THREE.Vector3();
  sc.during(0, 4.0, (T) => { const k = level.at(T); if (T < DROP.drop) st.bone(P, 'Spine2', v1); else v1.copy(chest); props.spot(v1.x, v1.z, k, sideV.set(sx, 0, sz)); });
  sc.at(0.08, () => st.sound('spot_on', v1.set(chest.x, 4, chest.z)));          // (its blow lands 0.04 s in: with the light)
  sc.at(0.4, () => st.voice(name, say.text, say.seconds + 0.5, 'stranger'));
  sc.at(0.42, () => { if (ctx.audio && ctx.audio.duck) ctx.audio.duck(0.75, 3.5); });        // (a line's start puts the music's bow back to its own; the rescue's is deeper)
  // (high over his feet and to the side, outside the beam: looking down through it the haze filled the picture)
  const live = new THREE.Vector3();
  sc.shot('spot', 0, {
    pos: (out, t) => { at(out, 3.3 + t * 0.1, 1.5, 6.2 - t * 0.35); },
    look: (out, t) => { st.bone(P, 'Spine2', live); out.set(live.x, live.y + 0.1, live.z); },
    lag: 4,
    fov: [[0, 36], [1.15, 34]], breathe: 0.03, sway: 0.004,
  });

  // ------------------------------------------------------------------ 2. it falls
  sc.at(DROP.drop, () => {
    measure(); top = land + fallen(fallT);                     // where he has come to rest: the carton falls onto that
    props.show(true); cartonAt(drop, DROP.drop); props.carton.position.copy(drop);
  });
  sc.during(DROP.drop, LAND, (T, dt, u) => {
    cartonAt(drop, T); props.carton.position.copy(drop);
    const k = T - DROP.drop; props.carton.rotation.set(0.35 * Math.sin(k * 2.1), 0.6 + k * 1.3, 0.25 * Math.sin(k * 1.7 + 1));       // it turns a little as it falls
    if (u >= 1) props.carton.rotation.set(0, 0.6 + fallT * 1.3, 0);
  });
  const upLook = new THREE.Vector3();
  sc.shot('up', 1.15, {                                          // (to 2.5: it falls toward the lens out of the light)
    pos: (out, t) => { at(out, -0.9, 2.5, 0.32 + t * 0.03); },              // on the water beside his head, outside the beam
    look: (out, t, T) => { cartonAt(upLook, Math.max(T, DROP.drop)); if (T < DROP.drop) upLook.y = DROP.from + 1.2; out.set(chest.x + sx * 0.1, upLook.y - 0.35, chest.z + sz * 0.1); },
    lag: 7, fov: [[0, 46], [1.2, 42]], focus: (out, t, T) => cartonAt(out, Math.max(T, DROP.drop)), aperture: 0.2, breathe: 0.06,
  });

  // ------------------------------------------------------------------ 3. it lands
  sc.at(LAND, () => { st.ripple(chest.x, chest.z, 0.6, 0.4); rig.shake(0.12, 0.25, 9); });
  // The carton goes into him (Kevin, 10 Nov: "have more of a magic effect or spark and sound effect when the fries goes
  // itno the character"): it sinks into his breastplate as it turns to gold and is gone; at that moment a burst of
  // light runs over the whole of him, gold sparks are thrown up off his chest and fall back round him, embers rise, a
  // ring of light runs out across the water, the picture flares for a moment, and the heal sounds (`rescue_heal`: a
  // timpani stroke, a harp swept up, strings swelling). Then, as he gets up, pale gold motes wind up round him from
  // his feet to over his head: the light he was given leaving him slowly. All of it from where the carton went in.
  const GO = LAND + 0.32, at3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  sc.at(GO, () => {
    P.revive();
    const fx = ctx.vfx; at3.set(chest.x, land + 0.06, chest.z);
    if (fx) {
      if (fx.hitFlash) fx.hitFlash(P, 0.8, 0xffd48a, 1.1);
      if (fx.sparks) fx.sparks(at3, up, 48, 1.35);
      if (fx.embers) fx.embers(at3, 36);
      if (fx.motes) { fx.motes(v1.copy(at3).setY(at3.y + 0.2), 70, 0xffd98a); fx.motes(v1.copy(at3).setY(at3.y + 0.45), 30, 0xffc46a); }
      if (fx.shock) fx.shock(v1.set(chest.x, 0, chest.z), 2.7, 0xc49a5c, 0.85, 0.3, 0);      // (without its ball of light: beside the lens it filled the picture)
    }
    st.ripple(chest.x, chest.z, 1.4, 0.7); rig.shake(0.22, 0.45, 11);
    st.sound('rescue_heal', v1.copy(at3));
  });
  // it is seen standing on him for a breath, red and whole; then it sinks into him as warm light
  sc.during(GO, GO + 0.28, (T, dt, u) => { props.burst(u); props.carton.position.y = land - props.height * 0.55 * u * u; });
  const hip = new THREE.Vector3(), mote = new THREE.Vector3(); let wind = 0;
  sc.during(GO + 0.1, GO + 1.35, (T, dt, u) => {
    const fx = ctx.vfx; if (u >= 1 || !fx || !fx.motes || (wind++ % 2)) return;
    st.bone(P, 'Hips', hip);
    const a = (T - GO) * 10, h = 0.08 + u * 2.0, r = 0.6 - 0.3 * u;
    for (const k of [0, Math.PI]) fx.motes(mote.set(hip.x + Math.cos(a + k) * r, h, hip.z + Math.sin(a + k) * r), 1, k ? 0xffe8b8 : 0xffd27a);
  });
  sc.at(GO + 0.08, () => { const U = UP[lying]; st.play(P, U.clip, { fade: 0.3, at: U.at, speed: U.speed }); });
  // (beside him, outside the beam, low: it comes in at the top and the camera comes down with it onto his chest, where
  // the picture holds on the two of them)
  const catchLook = new THREE.Vector3();
  sc.shot('catch', 2.5, {
    pos: (out, t) => { at(out, 0.2, 1.85 - t * 0.08, 0.62 + t * 0.02); },
    look: (out, t, T) => { cartonAt(catchLook, T); const k = smoother((T - 2.5) / Math.max(0.1, LAND - 2.5)); out.set(chest.x, lerp(Math.min(catchLook.y - 0.15, chest.y + 1.4), land + 0.1, k), chest.z); out.x += sx * 0.05; out.z += sz * 0.05; },
    lag: 16, fov: 31, focus: (out) => out.copy(chest), aperture: 0.3, breathe: 0.04,
  });

  // ------------------------------------------------------------------ 4. he gets up
  sc.at(3.62, () => st.sound('spot_off', v1.set(chest.x, 4, chest.z)));          // (a lever, then the housing 0.18 s in: with the dark)
  sc.during(3.8, 4.3, (T, dt, u) => { dim(lerp(0.2, 1, smoother(u))); if (key) key.power = keyRest * lerp(0.25, 1, smoother(u)); });
  const playPos = new THREE.Vector3(), playDir = new THREE.Vector3(), playLook = new THREE.Vector3(); let playFov = 50;
  const probe = () => { playFov = playPose(ctx, playPos, playDir, st.playMode); playLook.copy(playPos).addScaledVector(playDir, 16); };
  const hand = (t) => smoother((t - 0.45) / 0.7);
  sc.during(3.3, 4.6, probe);
  const riseLook = new THREE.Vector3();
  sc.shot('rise', 3.3, {
    pos: (out, t) => { at(out, 2.6 - t * 0.3, 2.0 + t * 0.2, 0.6 + t * 0.35); out.lerp(playPos, hand(t)); },
    look: (out, t) => { st.bone(P, 'Spine2', riseLook); out.set(riseLook.x, riseLook.y + 0.25, riseLook.z); out.lerp(playLook, hand(t)); },
    lag: 6, fov: { at: (t) => lerp(40, playFov, hand(t)) }, breathe: 0.05,
  });

  return sc.ready();
}

