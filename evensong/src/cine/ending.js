// The ending. As long as the score's `ending` (D major, strings and harp; docs/modules/score.md):
//
//    0.0          1  'fall'   it begins where the two stand 0.55 s after the killing blow (src/game.js), her sword still in
//                             her fist (both are taken up a long step back under the cut): struck, she staggers back,
//                             the blade goes over and its point drops (0.85); her knees give and she drives it into the
//                             floor as she comes down beside it (1.6 to 2.0), and hangs by one hand from its grip,
//                             breathing hard; he backs away from her, his guard up, to where he will stand (0.35 to 2.95)
//    3.0  tune    2  'sag'    the tune, in the major: close from below: her hand slips on the grip (3.35, 3.8, 4.2) and
//                             comes off (4.55): the arm falls and hangs; she sits back on her heels, her head sinking in
//                             stages and caught again; she nods off and starts awake (7.6 to 8.4); her wings close; the
//                             gold of phase two leaves her and the hall (gone by 8.6)
//    9.0          3  'mask'   her mask, close, as at the beginning; she lifts her face for her last line (10.2): "Let
//                             them wake." When it is said (12.16) SHE FALLS, at full length, toward him, slowly at first
//                             and then fast: the camera stays on her face as she tips, then goes up and tilts down ahead
//                             of her; her hand, then her head come down on the water (13.2) and she lies there, face
//                             down, the water thrown up round her
//   13.5          4  'light'  wide and still: she lies on the water under the standing sword, the rose window and the
//                             moon, and becomes light; it climbs in a column from the length of her past the window;
//                             the pilgrim whole and small at her head, his sword put up, his eyes on her, then on it
//   20.5          5  'lift'   the candles relight in a wave from where she sank to the doors; the camera lifts away over
//                             the water; the pilgrim bows his head to the standing sword
//   27.0  last       ...      the last phrase: the camera comes down behind the pilgrim, where the play camera is
//   33.0  end                 (the game lets the hall go to black under the logo: src/game.js; the pilgrim stays as he
//                             stands, at rest: src/cam/cine.js)
//
// She does not kneel to pray, here or anywhere (Kevin, 8 Nov): hers is a body giving out, and nobody is on their knees
// before the sword when the picture is wide. And it moves as a body moves that is struck, fails and falls (Kevin, 9 Nov:
// "Her death animation should look more natural"): nothing is held in one frame and nothing is morphed between two
// poses. One clip carries her from the blow to the floor, `death_knees2` (she reels, her knees give, she pitches onto
// her face), at its own speed wherever she falls; between its moments she is a weight, a breath, a head and two arms
// that hang (the block HER BODY). Both of them are moved together under the first cut: a long step back, so that her
// feet stand where she sets them, and whatever a wall or a fallen stone asks. Every camera is laid out from where she
// will sink and the line from her to him, and kept inside the hall.
import * as THREE from 'three';
import { Scene } from './timeline.js';
import { Curve, DEG, Spring3, clamp, lerp, ramp, smoother, wobble } from './ease.js';
import { Dangle, Weight } from './stage.js';
import { cues, line } from './cues.js';
import { playPose } from './intro.js';
import { PIER_X, PIER_Z } from '../world/layout.js';

const WINDOW = { x: 0, z: -21.5 };                    // the rose window, over the organ in the east wall
// Dev: &cinedebug prints, when the sword stands, how near its steel came to the pilgrim and how far her arm was short
// of it (read with tools/shot.py --keep: the line begins "ENDING sword").
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('cinedebug');
const STAND = 5.5;                                    // his look_around: a moment at which he simply stands, arms hanging

export function buildEnding(ctx, st, rig) {
  const c = cues(ctx, 'ending'), P = ctx.player, B = ctx.boss, S = B.char.scale || 3.667, say = line(ctx, 'cantor_end');
  const bd = ctx.arena.bounds, v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), sw = new THREE.Vector3();
  const headB = (out) => st.bone(B, 'Head', out);
  const T3 = 9, T4 = 13.5, T5 = 20.5, T6 = c.last;
  let gone = false;

  // ------------------------------------------------------------------ where the two stand as it begins
  // HER DYING CLIP, and where the ending takes it up (HER BODY, below, says what is done with it). The moments of
  // `death_knees2`: REEL she staggers, thrown back, a foot going back to catch her; KNEES her knees are down and she is
  // tall on them, leaning back; HANGS as she hangs on the grip; SUNK sat back on her heels, her trunk come forward, her
  // arms hanging; BREAST her breast meets the water; LIES still.
  const DIE = 'death_knees2', REEL = 0.55, KNEES = 2.565, HANGS = 2.626, SUNK = 2.758, BREAST = 3.2, LIES = 3.85, BREATH = 'kneel_idle2';
  const car = { x: 0, z: 0, yaw: 0 }, carS = { x: 0, z: 0, yaw: 0 };
  // WHERE SHE STOOD: the place everything is laid out from (the cameras, the sword, his mark, the candles' wave). It is
  // where the blow left her and a hand further on. (Until 9 Nov she died in `death_knees2`, and the boss's own dying
  // let that clip carry her three tenths of its travel in the half second before the ending began: 0.1 m, toward
  // him. Struck in `hit` (she doubles over: src/chars/boss.js, die) she all but stands. The place is reckoned as it
  // was, so that the last shots are laid out as they were.)
  let stoodX = B.pos.x, stoodZ = B.pos.z;
  if (B.char.clipName !== DIE && st.carried(B, DIE, clamp(B.char.time - (B.struckAt || 0), 0, 0.95), car)) {
    const cs = Math.cos(B.yaw), sn = Math.sin(B.yaw), x = car.x * S * 0.3, z = car.z * S * 0.3;      // (the clip's travel: x to her left, z forward)
    stoodX += x * cs + z * sn; stoodZ += -x * sn + z * cs;
  }
  let b0x = clamp(stoodX, -5.5, 5.5), b0z = clamp(stoodZ, -(bd.hz - 5.5), bd.hz - 9);
  let dx = P.pos.x - stoodX, dz = P.pos.z - stoodZ; const far = Math.hypot(dx, dz);
  if (far < 0.3) { dx = 0; dz = 1; } else { dx /= far; dz /= far; }                // the line from her to him
  const d0 = clamp(far, 0.3, 9);                                                  // (only a start from the dev tools finds him further off)
  // Her hips REST, when she has sunk, 0.37 m before where she stood and a hand to her left: where they rested in the
  // first take of this ending (the cameras, the sword's place and the pilgrim's mark were all fitted to that place).
  // From there her way is reckoned BACK along the clip's own travel (the animation runtime takes a clip's travel out of
  // it and hands it back: st.carried), so that every step she takes and every knee she puts down stays where it is put:
  // the clip staggers 0.6 m back, then pitches 1.8 m forward as its knees give. So the ending takes her up 0.9 m BEHIND
  // where the blow left her (START_F): both of them are moved that far together under the first cut, as they always
  // were for a wall. (Until 9 Nov she was slid that way and 0.5 m more in the first half second, on feet that stood.)
  const F_REST = 0.37, R_REST = -0.09;
  st.carried(B, DIE, SUNK, carS); st.carried(B, DIE, REEL, car);
  const START_F = F_REST + (car.z - carS.z) * S, START_R = R_REST - (car.x - carS.x) * S;      // her hips as the ending begins: metres from where she stood, toward him and to her right
  st.bone(B, 'Hips', v1); const hipX = v1.x - B.pos.x, hipZ = v1.z - B.pos.z;       // her hips from her place, as the blow left her posed
  const ahead = far > 9 ? d0 : (P.pos.x - B.pos.x) * dx + (P.pos.z - B.pos.z) * dz;      // he is this far before her, as they stand
  const e0 = ahead + START_F - (hipX * dx + hipZ * dz);                           // and, moved with her, this far from where she stood
  const FALL = 0.5 * S;                                                           // the cameras' mark is this far on from where she stood, toward him (her body comes down 1.4 m short of it)
  // He gives her the room to fall: he backs away to 4.4 m beyond her place (4.2 with a wall behind him). When her last
  // line is said she falls at full length toward him and lies 5.2 m long: her crown comes down 4.8 m from where she
  // stood, her left hand 5.1 m (LIE below). Cornered nearer than that, both stand that much further from the wall under
  // the first cut. (Until she fell he could stand as near as 3.2 m: there she would come down on him.)
  let BACK = 4.4;
  {
    const edge = (g) => (g > e0 + 1e-3 ? 1 : 0.3);                               // (where he stands already he may stay: he is never asked to walk toward her)
    const fits = (g) => Math.abs(b0x + dx * g) <= bd.hx - edge(g) + 1e-3 && Math.abs(b0z + dz * g) <= bd.hz - edge(g) + 1e-3;
    while (BACK > 4.19 && !fits(Math.max(e0, FALL + BACK))) BACK -= 0.2;
    const g = Math.max(e0, FALL + BACK), e = edge(g), tx = b0x + dx * g, tz = b0z + dz * g;
    b0x += clamp(tx, -(bd.hx - e), bd.hx - e) - tx; b0z += clamp(tz, -(bd.hz - e), bd.hz - e) - tz;
  }
  // Where she will lie, in metres from where she stood (toward him, to her right): crown, left hand, right hand, chest,
  // hips, knees, feet. That floor must be free of the fallen stones: where one lies in it, both are moved off it by what
  // is missing, under the first cut, as for a wall.
  // (and so must the place he backs to, and the floor she staggers back over: her feet, and the hem of her skirt)
  const LIE = [[4.85, 0.75], [5.1, -0.9], [4.35, 2.0], [3.5, 0.6], [2.6, 0.6], [1.2, 1.9], [1.35, -0.8], [-0.4, 2.8], [-0.4, -1.4], [START_F - 1.5, 0.4], [START_F - 0.7, -1.4], [START_F - 0.7, 1.4], [Math.max(e0, FALL + BACK), 0]];
  for (let pass = 0; pass < 3; pass++) for (const [f, r] of LIE) for (const o of ctx.arena.colliders || []) {
    const ex = b0x + dx * f - dz * r - o.x, ez = b0z + dz * f + dx * r - o.z, d = Math.hypot(ex, ez) || 1e-3, over = (o.r || 1) + 0.35 - d;
    if (over > 0) { b0x += ex / d * over; b0z += ez / d * over; }
  }
  const bWas = { x: B.pos.x, z: B.pos.z };
  const s0x = b0x + dx * START_F - dz * START_R - hipX, s0z = b0z + dz * START_F + dx * START_R - hipZ;      // her place as the ending begins: her hips where the clip takes her up
  const p0x = far > 9 ? s0x + dx * d0 : P.pos.x + s0x - B.pos.x, p0z = far > 9 ? s0z + dz * d0 : P.pos.z + s0z - B.pos.z;      // his: moved as she is (he stands to her as he stood)
  const kx = b0x + dx * FALL, kz = b0z + dz * FALL;                               // the cameras' mark
  const MARK = Math.max(e0, FALL + BACK);
  const mx = b0x + dx * MARK, mz = b0z + dz * MARK;
  const faceB = Math.atan2(dx, dz), faceP = Math.atan2(-dx, -dz);
  // a frame for the cameras: `f` metres from that mark toward him, `s` metres to HER RIGHT of that line (the sword's side)
  const at = (out, f, s, y) => out.set(kx + dx * f - dz * s, y, kz + dz * f + dx * s);
  // a camera that would stand outside the hall is drawn in toward what it looks at
  const LX = bd.hx + 1.5, LZ0 = -(bd.hz + 2.5), LZ1 = bd.hz + 4, PIER_CLEAR = 2.3;
  const fit = (out) => {
    const ox = out.x - kx, oz = out.z - kz; let k = 1;
    if (out.x > LX) k = Math.min(k, (LX - kx) / ox); else if (out.x < -LX) k = Math.min(k, (-LX - kx) / ox);
    if (out.z > LZ1) k = Math.min(k, (LZ1 - kz) / oz); else if (out.z < LZ0) k = Math.min(k, (LZ0 - kz) / oz);
    if (k < 1) { k = Math.max(0.4, k); out.x = kx + ox * k; out.z = kz + oz * k; }
    // ... and it stands clear of the arcades' piers (on x = +-13, a bay apart, 1.1 m to each side of their axes): the
    // hall's edge above is half a metre INSIDE that line, so a camera drawn in to it beside a pier began inside the
    // stone (the films' last shot did, where the session's fight ended: a black wedge across the picture for eight
    // frames after the cut at 20.5 s; found 9 Nov). It is put PIER_CLEAR from the pier's axis, on the nave's side.
    for (const pz of PIER_Z) {
      const px = out.x > 0 ? PIER_X : -PIER_X, ex = out.x - px, ez = out.z - pz, d = Math.hypot(ex, ez);
      if (d >= PIER_CLEAR) continue;
      let ux = ex, uz = ez; if (d < 0.05 || Math.sign(ux) === Math.sign(px)) { ux = -Math.sign(px); uz = ez >= 0 ? 0.6 : -0.6; }      // (never pushed outward through the arcade)
      const l = Math.hypot(ux, uz); out.x = px + ux / l * PIER_CLEAR; out.z = pz + uz / l * PIER_CLEAR;
    }
    return out;
  };
  // and one whose view of her would pass through a fallen stone stands on the other side of the line, or above the stones
  const stones = ctx.arena.colliders || [];
  const blocked = (f, s) => {
    at(v1, f, s, 0); fit(v1);
    const ax = v1.x, az = v1.z, sx = kx - ax, sz = kz - az, l2 = sx * sx + sz * sz || 1;
    for (const o of stones) {
      const t = clamp(((o.x - ax) * sx + (o.z - az) * sz) / l2, 0, 1), ex = ax + sx * t - o.x, ez = az + sz * t - o.z, m = (o.r || 1) + 0.9;
      if (ex * ex + ez * ez < m * m) return true;
    }
    return false;
  };
  /** Which side of the line a camera `f` along it and `s` off it should stand on: the side asked for, the other, or 0 (neither is clear: go up). */
  const sideOf = (f, s) => (!blocked(f, s) ? 1 : !blocked(f, -s) ? -1 : 0);
  /** How far from her a camera asked for at (f, s) really stands once it has been drawn into the hall. */
  const room = (f, s) => { at(v1, f, s, 0); fit(v1); return Math.hypot(v1.x - kx, v1.z - kz); };
  // HER SWORD stands where it always stood: a hand behind where she stood, 1.35 m to her right (her hips come to rest
  // 0.37 m before where she stood: F_REST, above; her knees are wide: her right shin lies a forearm inside the blade).
  at(sw, -FALL - 0.04 * S, 0.368 * S, 0);                                           // (1.35 m: the cross's inner end stands a forearm clear of her temple)
  const SWORD_YAW = faceB + Math.PI / 2;                                           // its cross across the line between them
  const SINK = 0.16 * S;                                                           // driven in with her falling weight: this much deeper than the wardrobe plants it (the grip at 4.2 m: where her hand can still hold it as her knees come down)
  /** Her sword as it stands at the end: planted by the wardrobe, then as deep as she drove it. */
  const stand = () => { if (!B.kit.plantSword) return; st.plant(sw.x, sw.z, SWORD_YAW); const o = B.kit.sword.object; o.position.y -= SINK; o.updateMatrixWorld(true); };

  const end = (skipped) => {
    // she is gone; her sword stands where she left it; every candle burns again; he stands at rest, his sword put up
    st.wings(0, 0); st.halo(0); st.blade(0); st.fade(1);
    if (breath) { breath.end = breath.time; breath = null; }                      // (a skip while she breathes: the layer goes with her)
    st.look(B, null, { rate: 7, limitPitch: 40 * DEG });                          // (and the look's own limit is as the animation runtime has it)
    stand();
    if (!gone && ctx.vfx && ctx.vfx.dissolve) { ctx.vfx.dissolve(B.root, 0.01); gone = true; }
    st.place(P, mx, mz, faceP); st.sheathe(true);
    if (skipped) { st.play(P, 'look_around', { fade: 0, at: STAND, speed: 0.1 }); st.relight(1, 0); }      // (at the natural end he stands so and they burn already)
    st.mood(1, 0);
    st.flush();
  };

  const sc = new Scene(ctx, st, rig, {
    name: 'ending', duration: c.end, end,
    letterbox: [[0, 0], [0.8, 1, 's'], [c.end - 1.6, 1], [c.end, 0, 's']],
  });

  // ------------------------------------------------------------------ 1. she plants the blade and her knees give beside it
  const gold0 = ctx.gfx.mood.gold, yaw0 = B.yaw, pyaw0 = P.yaw;
  const wrap = (a) => { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; };
  sc.at(0, () => {
    st.puppets(true);
    carry();                                                                       // (the sword, from where it is in her fist as last drawn: before anything is moved)
    st.place(B, s0x, s0z, yaw0); st.place(P, p0x, p0z, pyaw0);                     // both together, under the cut: her long step back, and what a wall or a stone asks
    B.root.updateMatrixWorld(true); P.root.updateMatrixWorld(true);              // (her joints are read in this same step: they go with her)
    st.look(P, headB(v1), { weight: 0.8, rate: 2.5 }); st.look(B, null);
  });
  // HE BACKS AWAY, as these notes always said and as he never did: until 8 Nov (21:50) he stood where the blow had left
  // him, two or three metres before her, all through the ending, and was put on his mark when it was over. She falls
  // where he stood, now. So in the first shot he goes back to his mark, his eyes on her and his guard up (the blended
  // walk, backwards: the animation runtime plants his feet), and stands there; the end finds him where it puts him.
  const BACKS = [0.35, 2.95], goes = Math.hypot(mx - p0x, mz - p0z);
  if (goes > 0.05) {
    const backK = new Curve([[BACKS[0], 0, 's'], [BACKS[1], 1, 's']]), turnP = wrap(faceP - pyaw0);
    sc.at(BACKS[0], () => { if (st.has(P, '@move')) st.play(P, '@move', { fade: 0.2 }); });
    sc.during(BACKS[0], BACKS[1], (T, dt, u) => {
      const k = backK.at(T);
      P.pos.x = lerp(p0x, mx, k); P.pos.z = lerp(p0z, mz, k); P.yaw = pyaw0 + turnP * smoother(u * 2.5);
      if (P.char.move) P.char.move(0, u >= 1 ? 0 : -backK.speed(T) * goes);
    });
    sc.at(BACKS[1], () => st.play(P, 'idle', { fade: 0.35, loop: true }));
  }
  // HER BODY, from the blow to lying still. (Kevin, 9 Nov: "Her death animation should look more natural". Until then
  // she bent backward in slow motion at the blow, was HELD in one frame of her dying clip for seconds, morphed by one
  // eased blend into another frame, held again through her last line, and the rest was let run fast.) Now nothing is
  // held and nothing is morphed between two poses:
  //   - the blow itself is a blow (src/chars/boss.js, die: `hit`: she doubles over it, and is rearing up at the cut);
  //   - one clip carries her from there to the floor, `death_knees2`, at its own speed wherever a body falls: the
  //     stagger (clip REEL to 2.3 in 1.62 s: 1.0 to 1.14 times: a foot goes back to catch her, the other is dragged
  //     after it, she sways), her knees giving (2.3 to KNEES at 0.7 times: she is 6.6 m tall, and falls as slowly as
  //     that), and at the end the fall (SHE FALLS, below);
  //   - on her knees she is a WEIGHT (stage.js): where that clip has her between tall on her knees (KNEES) and sunk
  //     on her heels (SUNK) is not keyed, it is pulled at. She comes down with the speed the clip gives her, runs
  //     on, is hauled back by the arm that holds the grip, and hangs there; each time her hand slips she drops a
  //     little: starts slowly, gathers speed, overshoots, settles (FLOORS: when, how far, how hard she is caught);
  //   - she BREATHES: the pack's kneeling idle (`kneel_idle2`: a mocap of breathing on both knees) is added over the
  //     whole of her as a difference, three times life size at first and fast, ragged, then shallower and slower;
  //   - her HEAD is a weight of its own on her neck: it follows her chest a moment late and nods past (the blow of her
  //     knees on the floor throws it down and it comes up again), sinks in stages, is lifted half way, sinks again;
  //   - her ARMS hang from her shoulders (HER ARMS, below): the left from the moment her knees are down, the right
  //     when her hand has slipped from the grip.
  // When her last line is said she falls: FALLS (her line's end + 0.1 s = 12.16).
  const FALLS = clamp(T3 + 1.2 + say.seconds + 0.1, T3 + 2.6, T4 - 1.3), TIP = 1.05;      // (TIP: how long she takes from there to the water)
  const T_KNEES = 2.0, stag = new Curve([[0, REEL], [0.55, 1.1], [1.25, 1.9], [1.62, 2.3], [T_KNEES, KNEES]]);
  const SLIPS = [3.35, 3.8, 4.2], OFF = 4.55;                                      // her hand slips on the grip, three times, and is off (HER ARMS, below)
  const FLOORS = [                                                                 // [from when, where in the clip, how fast (rad/s), how damped]
    [T_KNEES, HANGS, 6.5, 0.45],                                                   // caught on the grip: she runs on down and is hauled back
    [SLIPS[0], 2.645, 9, 0.5], [SLIPS[1], 2.664, 9, 0.5], [SLIPS[2], 2.683, 9, 0.5],      // each slip of her hand lets her down a little
    [OFF + 0.05, 2.728, 6, 0.4],                                                   // it is off: she sits back on her heels, her trunk comes forward over them
    [6.5, 2.75, 4.5, 0.5],                                                         // she gives out further
    [7.55, 2.772, 3.2, 0.7],                                                       // and begins to go: she nods forward ...
    [8.1, 2.746, 6.5, 0.45],                                                       // ... and catches herself, with a start
    [T3 + 0.85, 2.742, 3, 0.8],                                                    // a breath drawn to speak
    [FALLS - 0.3, 2.766, 4, 0.7],                                                  // and let go
  ];
  const trunk = new Weight(KNEES, 0); let die = null, floorI = 0, passed = false;
  sc.at(0, () => { die = st.play(B, DIE, { fade: 0.5, at: REEL, speed: 0 }); });
  sc.during(0, T_KNEES, (T, dt, u) => {
    if (!die || B.char.clipName !== DIE) return;
    if (u >= 1) { trunk.set(die.time, stag.speed(T_KNEES - 0.02)); return; }       // (the weight takes her over as she is, at the speed she has)
    die.timeScale = (stag.at(Math.min(T_KNEES, T + dt)) - die.time) / dt;
  });
  sc.during(T_KNEES, FALLS, (T, dt, u) => {
    if (!die || B.char.clipName !== DIE || u >= 1) return;
    while (floorI < FLOORS.length - 1 && T >= FLOORS[floorI + 1][0]) floorI++;
    const F = FLOORS[floorI];
    trunk.step(F[1] + 0.003 * wobble(T * 0.7, 9), F[2], F[3], dt);                 // (she is never quite still: a degree of sway)
    // (the clip tells her left knee's fall at 2.617: once past it she does not go back over it, or the water would ring again)
    if (trunk.x > 2.624) passed = true;
    if (passed && trunk.x < 2.6205) trunk.set(2.6205, Math.max(0, trunk.v));
    die.timeScale = (Math.min(trunk.x, 2.772) - die.time) / dt;
  });
  // (Staggering, the clip stands arched back from the waist, 25 degrees, for more than a second: at the blow that was
  // "the backbend". A third of the way back toward the trunk of her guard takes the bow out of it and leaves the
  // lean: she reels, she does not bend backward. Let go before her knees give: on her knees the lean is what hangs
  // her on the grip.)
  const UPRIGHT = new Curve([[0, 0, 's'], [0.45, 0.36], [1.35, 0.36], [1.9, 0, 's']]);
  sc.during(0, 1.92, (T, dt, u) => st.pose(B, 'idle', 0.5, u >= 1 ? 0 : UPRIGHT.at(T), 'torso'));
  // her breath
  const BREATHES = [0.3, FALLS + 0.45];
  const breathRate = new Curve([[0.3, 1.9], [3, 1.8], [5, 1.5], [7, 1.2], [9, 1.0], [FALLS, 0.8]]);      // (1 = a breath in 2.1 s, as the clip has it)
  const breathDeep = new Curve([[0.3, 0, 's'], [1.1, 2.6], [2.3, 3.6], [4.5, 3.4], [6, 3.2], [8, 3.0], [9, 2.4], [FALLS - 0.2, 1.6], [FALLS + 0.4, 0, 's']]);
  let breath = null, breathAt = 0;
  sc.at(BREATHES[0], () => { if (B.char.additive && st.has(B, BREATH)) { breath = B.char.additive(BREATH, { weight: 0, at: 0, end: 1e9, fadeIn: 0, fadeOut: 0 }); if (breath) breath.speed = 0; } });
  sc.during(BREATHES[0], BREATHES[1], (T, dt, u) => {
    if (!breath) return;
    if (u >= 1) { breath.end = breath.time; breath = null; return; }               // (her last breath is out: the layer is dropped)
    breathAt = (breathAt + dt * breathRate.at(T) * (1 + 0.22 * wobble(T * 1.3, 2))) % 4.2667;      // (ragged: no two breaths alike)
    breath.time = breathAt; breath.gain = breathDeep.at(T) * (1 + 0.25 * wobble(T * 0.9, 5));
  });
  // her head
  const HEADS = [                                                                  // [from when, her face this far above level (degrees), how fast, how damped]
    [0, -24, 3.5, 0.6],                                                            // staggering: it comes round from the blow and down, to him at her feet
    [T_KNEES + 0.03, -20, 9, 0.35],                                                // her knees strike the floor: it is thrown down
    [T_KNEES + 0.6, -10, 3.5, 0.8],                                                // hanging on the grip she raises her face to him
    [SLIPS[0] + 0.08, -14, 8, 0.4], [SLIPS[1] + 0.08, -18, 8, 0.4], [SLIPS[2] + 0.08, -22, 8, 0.4],      // each slip jolts it lower
    [OFF + 0.22, -36, 7, 0.38],                                                    // her hand is off: it falls
    [5.7, -24, 2.6, 0.9],                                                          // and is caught again, half way
    [6.6, -37, 6, 0.45], [7.15, -30, 2.5, 0.9],                                    // sinks, is lifted a little
    [7.6, -40, 5, 0.5],                                                            // goes, with her trunk
    [8.15, -21, 7, 0.45],                                                          // and comes up with a start as she catches herself
    [8.7, -29, 2, 0.9],                                                            // sinking again, slowly
    [T3 + 0.75, -24, 2.4, 0.85],                                                   // she lifts her face to him to say it
    [FALLS - 0.45, -40, 5, 0.6],                                                   // the last word: it goes
  ];
  const LOLL = new Curve([[0, 0], [2.2, 0], [3.2, 9], [4.4, 7], [5.4, -6], [8, 4], [FALLS, 3]]);      // degrees to her left: a hanging head does not hang straight
  const headUp = new Weight(), headTurn = new Weight(), hq = new THREE.Quaternion(), htq = new THREE.Quaternion(), hf = new THREE.Vector3(), gaze = new THREE.Vector3();
  let headI = 0, headOn = false, chestSlow = 0;
  /** Where a joint of hers faces, as Mixamo has it (z is where the face or the breast looks): out.x = above level, out.y = turn in the world (radians). */
  const facing = (name, out) => {
    const b = B.char.bones[name]; if (!b || !B.char.tposeWorld) { out.x = 0; out.y = B.yaw; return out; }
    b.getWorldQuaternion(hq); B.char.tposeWorld(name, htq); hq.multiply(htq.invert()); hf.set(0, 0, 1).applyQuaternion(hq);
    out.x = Math.asin(clamp(hf.y, -1, 1)); out.y = Math.atan2(hf.x, hf.z); return out;
  };
  // (Falling, it HANGS: it stays down against her breast as she goes over, a dead weight's head. The clip cranes it up
  // to see the floor come, as a living faller does. When her breast meets the water it is let go, and rolls onto its
  // cheek as the clip has it. For that the look may take her face further down than its forty degrees: put back after.)
  sc.during(0, FALLS + TIP + 0.4, (T, dt, u) => {
    if (u >= 1) { st.look(B, null, { rate: 7, limitPitch: 40 * DEG }); return; }
    if (T >= FALLS && die && die.time >= BREAST) { st.look(B, null, { rate: 7 }); return; }      // (her eyes are nobody's now: the head goes as the body goes)
    facing('Spine2', v2); const chest = v2.x, chestYaw = v2.y;
    if (!headOn) { headOn = true; facing('Head', v2); headUp.set(clamp(v2.x, -0.6, 0.45)); headTurn.set(clamp(wrap(v2.y - B.yaw), -0.9, 0.9)); chestSlow = chest; }      // (it begins where the blow left it)
    let yw;
    if (T < FALLS) {
      while (headI < HEADS.length - 1 && T >= HEADS[headI + 1][0]) headI++;
      const H = HEADS[headI];
      chestSlow += (chest - chestSlow) * (1 - Math.exp(-dt * 1.5));
      headUp.step(H[1] * DEG + 0.45 * (chest - chestSlow), H[2], H[3], dt);       // (what her chest does suddenly reaches her head late, and it nods past)
      const toHim = clamp(wrap(Math.atan2(P.pos.x - B.pos.x, P.pos.z - B.pos.z) - B.yaw), -0.9, 0.9);
      headTurn.step(toHim + LOLL.at(T) * DEG, 4, 0.8, dt);
    } else {
      headUp.step(chest - 20 * DEG, 9, 0.7, dt);
      headTurn.step(clamp(wrap(chestYaw - B.yaw), -0.9, 0.9), 4, 0.8, dt);
    }
    const up = clamp(headUp.x, T < FALLS ? -0.69 : -1.45, 0.5); yw = B.yaw + headTurn.x;
    headB(gaze); gaze.x += Math.sin(yw) * Math.cos(up) * 50; gaze.z += Math.cos(yw) * Math.cos(up) * 50; gaze.y += Math.sin(up) * 50;
    st.look(B, gaze, { weight: 1, rate: 150, head: 1, chest: 0, limitPitch: T < FALLS ? undefined : 1.48 });      // (her face is put where the weight has it: all of it in her neck)
  });
  // her last turn is to him
  // (struck from behind she comes round over her LEFT shoulder: her sword arm then goes round on the side away from him;
  // and a long turn is a quick one: she is whirled round by the blow, and stands to him before the blade comes down)
  let dyaw = wrap(faceB - yaw0); if (dyaw < -2.5) dyaw += Math.PI * 2;
  const TURN = lerp(1.4, 1.0, ramp(0.5, 1.5, Math.abs(dyaw)));
  const turnK = new Curve([[0.05, 0, 's'], [TURN, 1, 's']]); let turned = 0;
  sc.during(0.05, TURN, (T) => { const w = dyaw * turnK.at(T); B.yaw += w - turned; turned = w; });
  // WHERE SHE IS. Her hips go where the clip itself carries them, reckoned back from where they must rest (F_REST, at
  // the top): so her feet stand where she sets them as she staggers, her knees stay where they come down while she
  // sags (the clip's own knees creep 0.15 m there, no more), and when she falls she travels as the clip falls (2.2 m
  // toward him). Her place (`boss.pos`) is put each step where her hips then come over that point, whatever way she
  // faced when she was struck and whatever the clips in the blend do: she turns about her hips, and never swings
  // through the hall like a door.
  const DRIFT = new Curve([[2.76, 0, 's'], [2.9, 0.3], [3.06, 0.55, 's']]);         // (falling, 0.55 m to her right: her right leg goes round the standing sword)
  let unseen = false;
  const body = new THREE.Vector3(b0x, 0, b0z);                                    // where her body is on the floor (her hips), for whatever is laid out round her
  // (Under the cut to the last shot, when nothing of her is left to see, her unseen body is put back where she had sunk,
  // as she was then, her place where it was at this time in the first take: see that cut, below.)
  const wasX = b0x - dx * 0.335 - dz * 0.1, wasZ = b0z - dz * 0.335 + dx * 0.1;
  sc.during(0, c.end, (T) => {
    if (unseen) { B.pos.x = wasX; B.pos.z = wasZ; return; }
    st.bone(B, 'Hips', v1); const ox = v1.x - B.pos.x, oz = v1.z - B.pos.z;
    const ct = die && B.char.clipName === DIE ? die.time : REEL;
    st.carried(B, DIE, ct, car);
    const f = F_REST + (car.z - carS.z) * S, r = R_REST - (car.x - carS.x) * S + DRIFT.at(ct);
    body.set(b0x + dx * f - dz * r, 0, b0z + dz * f + dx * r);
    B.pos.x = body.x - ox; B.pos.z = body.z - oz;
  });
  // SHE FALLS. When her last line is said she goes down at full length, toward him, as a dead weight does: the rest of
  // the same clip, from where she has sunk through BREAST to LIES. A body that tips over its knees starts slowly and
  // gathers speed (it is a pendulum stood on its end: the further over, the faster): so the clip's time follows
  // cosh over TIP seconds, and she meets the water at 1.2 times the clip's own speed, which is the speed of that fall;
  // from there the clip runs on at its own speed (her head and her arms run on, her legs, flung up by the blow of her
  // breast on the floor, come down: but only a third as high as the clip has them, the rest is held down by the legs
  // she will lie with: a late small rebound, not a tumble) and comes to rest. Her head goes first: it has dropped as
  // her line ended. Her hands meet the water at clip 3.08 (two rings), her breast and her face at BREAST (the water is
  // thrown up and rings, the candles near her are shoved away: the bus's `land`), her feet come down behind her (that
  // clip tells them itself). She lies face down, 5.2 m long, her crown 1.5 m before his feet, the sword standing
  // behind her, between her heels.
  const KAPPA = 2.4, COSH1 = Math.cosh(KAPPA) - 1, SETTLE = 0.95; let tip0 = SUNK, fallen = 0, rest = null;
  /** Where in the clip she is, t seconds after she began to tip. */
  const tipped = (t) => (t <= TIP ? tip0 + (BREAST - tip0) * (Math.cosh(KAPPA * t / TIP) - 1) / COSH1 : rest.at(t));
  sc.at(FALLS, () => {
    tip0 = die && B.char.clipName === DIE ? clamp(die.time, 2.74, 2.78) : SUNK;
    rest = new Curve([[TIP, BREAST], [TIP + 0.5, 3.75], [TIP + SETTLE, LIES, 's']]);
  });
  const fdbg = DEBUG ? { sword: 1e9, swordT: 0, swordB: '', him: 1e9, himT: 0, himB: '' } : null;
  sc.during(FALLS, FALLS + TIP + SETTLE, (T, dt, u) => {
    if (!die || !rest || B.char.clipName !== DIE) return;
    if (fdbg) {                                                                    // (&cinedebug: how near her limbs come to the standing sword and to him as she falls)
      for (const n of ['RightLeg', 'RightFoot', 'RightToeBase', 'LeftFoot', 'LeftToeBase', 'RightHand', 'RightForeArm', 'Hips']) { st.bone(B, n, v1); const d = Math.hypot(v1.x - sw.x, v1.z - sw.z); if (d < fdbg.sword) { fdbg.sword = d; fdbg.swordT = T; fdbg.swordB = n; } }
      for (const n of ['LeftHand', 'RightHand', 'HeadTop_End', 'Head']) { st.bone(B, n, v1); const d = Math.hypot(v1.x - P.pos.x, v1.z - P.pos.z); if (d < fdbg.him) { fdbg.him = d; fdbg.himT = T; fdbg.himB = n; } }
      if (u >= 1) console.log(`ENDING fall: she falls at ${FALLS.toFixed(2)} s; nearest to the standing sword's middle ${fdbg.sword.toFixed(2)} m (${fdbg.swordB} at ${fdbg.swordT.toFixed(2)} s); nearest to him ${fdbg.him.toFixed(2)} m (${fdbg.himB} at ${fdbg.himT.toFixed(2)} s); he stands ${Math.hypot(P.pos.x - b0x, P.pos.z - b0z).toFixed(2)} m from where she stood`);
    }
    die.timeScale = u >= 1 ? 0 : (tipped(Math.min(TIP + SETTLE, T + dt - FALLS)) - die.time) / dt;
    st.pose(B, DIE, LIES, 0.65 * Math.min(ramp(2.95, 3.15, die.time), 1 - ramp(3.55, 3.82, die.time)), 'legs');      // (her legs: two thirds the legs she will lie with)
    if (fallen < 1 && die.time >= 3.08) { fallen = 1; for (const h of ['LeftHand', 'RightHand']) { st.bone(B, h, v1); st.ripple(v1.x, v1.z, 0.9, 0.5); } }
    if (fallen < 2 && die.time >= BREAST) { fallen = 2; st.bone(B, 'Spine2', v1); v1.y = 0; ctx.bus.emit('land', { who: 'boss', pos: v1, hard: false }); rig.shake(0.4, 0.7, 7); }      // (her body meets the water: what answers one of her landings answers this: water, spray, candles, the thud)
  });
  // THE SWORD. It is in her fist when the ending begins and it stays in her fist until it stands in the floor. From the
  // first frame the cutscene carries the blade, beginning exactly where it was last drawn in her hand, and her right arm
  // goes with it at full weight (stage.js, Grasp: the fist closed on the grip in every frame). The grip is never taken
  // further from her shoulder than her arm is long: where she cannot reach, the sword waits for her.
  //   0 .. OVER    she lifts the hilt before her right shoulder while the blade, upright in her fist, goes over OUTWARD:
  //                to her right, away from the man (he stands on the line before her; the blade stays a metre and more to
  //                the right of that line and above his head until it is beyond him), until it hangs point down
  //   .. DROP      staggering, she carries it so to the place where it will stand, its point trailing in the water (the
  //                water answers when the point first touches)
  //   DROP .. LAND her knees give, and with her falling weight she drives it into the floor (1.07 m of it)
  //   .. SLIPS     her hand stays on the grip while she comes down on her knees beside it and hangs there; it slips in the
  //                close shot (HER ARMS, below)
  // (Until 8 Nov 04:00 the sword stayed on her hand's socket for the first half second, where the clip's hanging arm
  // sloped it across the pilgrim, and was then flown to its place with the arm following a third of a second behind:
  // docs/castcheck.md, R3.3, "the sword is in nobody's hand".)
  const OVER = 0.85, HANG = 1.3, DROP = 1.5, LAND = 1.97, PUT = 5.0;     // (it has gone over by OVER; it is in the floor as her knees come down: T_KNEES)
  const REACH = 0.52 * S;                                        // her shoulder to the middle of her fist, the arm all but straight (0.545 is all of it)
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qm = new THREE.Quaternion(), qd = new THREE.Quaternion(), qt = new THREE.Quaternion(), qi = new THREE.Quaternion();
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), ph = new THREE.Vector3(), sca = new THREE.Vector3(), dir = new THREE.Vector3(), outv = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0), NOTURN = new THREE.Quaternion();
  const dbg = DEBUG ? { him: 1e9, himT: 0, over: 0, overT: 0, last: 0 } : null;
  let flying = false, wet = false, grasp = null, split = 0.4;
  /** At the first frame: the sword becomes the scene's, where it is in her fist. */
  function carry() {
    const s = B.kit.sword, o = s && s.object; if (!o || !B.kit.plantSword || B.kit.swordPlanted) return;
    o.updateWorldMatrix(true, false); o.matrixWorld.decompose(pa, qa, sca);        // in her fist, as it was last drawn
    pa.x += s0x - B.pos.x; pa.z += s0z - B.pos.z;                                  // (moved under the cut, it goes with her)
    stand(); pb.copy(o.position); qb.copy(o.quaternion);                           // how it will stand
    o.position.copy(pa); o.quaternion.copy(qa); o.updateMatrixWorld(true);
    ph.copy(pb); ph.y += SINK + 0.22 * S;                                          // over that place, the point a hand above the water
    // the blade's way over: from where it points now, by way of level and outward (a little above level), to straight down
    dir.set(0, 1, 0).applyQuaternion(qa).normalize(); outv.set(-dz, 0.3, dx).normalize();
    qm.setFromUnitVectors(dir, outv).multiply(qa); qd.setFromUnitVectors(outv, DOWN).multiply(qm);
    qt.copy(qd).invert().multiply(qb);                                             // what is left is a turn about the blade's own length: the cross comes square to the line between them
    const a1 = dir.angleTo(outv), a2 = outv.angleTo(DOWN); split = clamp(a1 / (a1 + a2), 0.1, 0.9);
    flying = true; wet = false;
    grasp = st.grasp(B); grasp.swing = 0.35; grasp.weight = 1; grasp.grip = 1;
    grasp.point.copy(pa); grasp.axis.set(0, -1, 0).applyQuaternion(qa);            // along the grip, toward the pommel
  }
  sc.during(0, LAND, (T, dt, u) => {
    if (!flying) return;
    const s = B.kit.sword, o = s.object;
    if (u >= 1) { o.position.copy(pb); o.quaternion.copy(qb); o.updateMatrixWorld(true); flying = false; rig.shake(0.3, 0.45, 9); if (dbg) console.log(`ENDING sword: she turns ${(dyaw * 57.3).toFixed(0)} deg in ${TURN.toFixed(2)} s; moved under the cut ${Math.hypot(s0x - bWas.x, s0z - bWas.z).toFixed(2)} m; he backs to ${MARK.toFixed(1)} m; nearest to him ${dbg.him.toFixed(2)} m at ${dbg.himT.toFixed(2)} s; her arm short by at most ${dbg.over.toFixed(2)} m at ${dbg.overT.toFixed(2)} s while she carried it (the sword waits), by ${(dbg.late || 0).toFixed(2)} m from the hang to the floor (the hand is that far off the grip)`); return; }
    // where the middle of her fist is wanted: up to the place over the floor, then down
    // (it hangs a moment; then it goes down as she goes down: the point is in the floor at once and her weight takes it deep)
    if (T < DROP) v2.lerpVectors(pa, ph, smoother(T / HANG)); else v2.lerpVectors(ph, pb, Math.pow((T - DROP) / (LAND - DROP), 1.6));
    // ... and no further from her shoulder than her arm reaches
    // (until it hangs over its place; from there it goes straight down, and an arm a hand short of it is not seen: a
    // blade that slid sideways through the floor after her shoulder would be)
    st.bone(B, 'RightArm', v3); v2.sub(v3); const l = v2.length(), free = ramp(HANG, DROP, T); if (l > REACH) v2.multiplyScalar(lerp(REACH / l, 1, free)); v2.add(v3);
    // (and as she drops it goes down no slower than her fist takes it: over its place the grip is never higher than her
    // arm reaches, until it stands as deep as it will. Her falling weight drives it; it does not follow her down.)
    if (T >= DROP) { const hx = v2.x - v3.x, hz = v2.z - v3.z, up2 = REACH * REACH - hx * hx - hz * hz; if (up2 > 0 && v2.y > v3.y + Math.sqrt(up2)) v2.y = Math.max(pb.y, v3.y + Math.sqrt(up2)); }
    o.position.copy(v2);
    const off = Math.max(0, v2.distanceTo(v3) - REACH);                           // how far the grip really is beyond her reach now
    const ko = smoother((T - 0.06) / (OVER - 0.06));
    if (ko < split) o.quaternion.copy(qa).slerp(qm, ko / split); else o.quaternion.copy(qm).slerp(qd, (ko - split) / (1 - split));
    o.quaternion.multiply(qi.copy(NOTURN).slerp(qt, ko));
    o.updateMatrixWorld(true);
    if (s.tip) {
      s.tip.getWorldPosition(v2);
      if (!wet && v2.y < 0.12) {                                                   // the point meets the water
        wet = true; rig.shake(0.4, 0.7, 7); st.ripple(v2.x, v2.z, 2.2, 1.2);
        ctx.bus.emit('boss-slam', { pos: v1.set(v2.x, 0, v2.z), radius: 1.6, power: 0.55 });
      }
      if (dbg) {                                                                   // how near the steel comes to the man (his middle line, to the top of his head), and how far the arm was short
        for (let i = 0; i <= 16; i++) { v1.lerpVectors(o.position, v2, i / 16); const d = Math.hypot(v1.x - P.pos.x, Math.max(0, v1.y - 1.9), v1.z - P.pos.z); if (d < dbg.him) { dbg.him = d; dbg.himT = T; } }
        dbg.last = Math.max(0, l - REACH); if (dbg.last > dbg.over && T < HANG) { dbg.over = dbg.last; dbg.overT = T; } if (T >= HANG) dbg.late = Math.max(dbg.late || 0, off);
      }
    }
  });
  // HER ARMS. An arm that nothing holds up HANGS: from her shoulder, straight down, whatever her trunk does (stage.js,
  // Dangle: the hand is a weight on a string from the shoulder: let go, it falls slowly at first and then fast, comes
  // down beside her, is stopped by her side, swings out a little and hangs; the arm is carried to it by the same
  // solve that holds a grip).
  //   her LEFT: the clip flings it out as she reels, holds it out level while she sways, and flings it out again as her
  //     knees give (and until 9 Nov it stayed flung out, level, for as long as that frame was held). It is let go as
  //     she staggers (ARM_L): it falls, and hangs; as her knees strike the floor it is thrown out a little once more.
  //   her RIGHT holds the grip while she hangs on it. Then her weight drags at it: three times it SLIPS (the grip
  //     works out of her palm toward her finger tips, the fingers opening; each slip lets her trunk down a little:
  //     FLOORS, above), and at OFF it comes away and falls. (Until 9 Nov the hand was moved from the grip to her
  //     side along an eased line in a second and a half: it floated down.)
  // They hang so until she falls: beside her hips while she is tall on her knees, over her knees when she has sunk
  // between her heels (ARM_OUT: the hand a hand's breadth above the knee; further out and the arm is held, not hung). (The clip's own arms are not used on her knees: where the ending keeps her they are caught
  // in the middle of a swing, hands held out before her over the water, and the right goes the long way round, by a
  // closed fist held before her breast: .shots/np_end5_sag.png.) Falling, they hang until her hands meet the water
  // (clip 2.84 to 3.02): then they are the clip's, which lays them out before her as she comes down over them.
  const gp = new THREE.Vector3(), ga = new THREE.Vector3(), hp = new THREE.Vector3();
  const slip = new Curve([[SLIPS[0], 0, 's'], [SLIPS[0] + 0.14, 1, 's'], [SLIPS[1], 1, 's'], [SLIPS[1] + 0.14, 2, 's'], [SLIPS[2], 2, 's'], [SLIPS[2] + 0.14, 3, 's']]);
  const ARM_G = 7.4, ARM_DRAG = 2.2, ARM_STOP = 0.07;                              // a straight arm of two metres hung by its end; her side stops it four degrees past the plumb line
  const armR = new Dangle(), armL = new Dangle(), ARM_L = 0.7; let graspL = null;
  const clipAt = () => (die && B.char.clipName === DIE ? die.time : REEL);
  /** How much of a hanging arm is the Dangle's: all of it, until she falls and her hands meet the water. */
  const hung = () => 1 - ramp(2.84, 3.02, clipAt());
  /** The hand of an arm that hangs: under the shoulder `sh`, out to her right (side 1) or her left (-1), a little forward. Returns how far it has come down (0..1). */
  const hangs = (dg, sh, side, g, dt) => {
    dg.step(ARM_G, ARM_DRAG, ARM_STOP, dt);
    const k = smoother(dg.down), out = side * lerp(0.45, 0.58, ramp(2.69, 2.75, clipAt()));     // (ARM_OUT: beside her hip; over her knee once she has sunk between her heels)
    dg.point(sh, lerp(dg.len, 0.94 * REACH, k), g.point);
    g.point.x += (-dz * out + dx * 0.1) * k; g.point.z += (dx * out + dz * 0.1) * k;
    if (g.point.y < 0.3) g.point.y = 0.3;                                          // (the water: her knuckles lie on it)
    return k;
  };
  sc.during(0, FALLS + TIP, (T, dt, u) => {
    if (!grasp) return;
    if (u >= 1) { grasp.weight = 0; grasp.grip = 0; return; }                     // (a span's own last call lets the arm go: see the log, 8 Nov 01:28)
    const o = B.kit.sword.object;
    gp.copy(o.position); ga.set(0, -1, 0).applyQuaternion(o.quaternion);           // the grip, and along it toward the pommel
    if (T <= SLIPS[0]) { grasp.point.copy(gp); grasp.axis.copy(ga); grasp.weight = 1; grasp.grip = 1; return; }
    st.bone(B, 'RightArm', v3);                                                    // her shoulder
    if (T < OFF) {                                                                 // it slips: out of the palm toward her, and a little down
      const k = slip.at(T), hx = v3.x - gp.x, hz = v3.z - gp.z, hl = Math.hypot(hx, hz) || 1;
      grasp.point.copy(gp); grasp.point.x += hx / hl * 0.09 * k; grasp.point.z += hz / hl * 0.09 * k; grasp.point.y -= 0.03 * k;
      grasp.axis.copy(ga); grasp.weight = 1; grasp.grip = 1 - 0.18 * k;
      return;
    }
    if (!armR.on) armR.release(v3, grasp.point);                                   // let go: it falls from where it is
    const k = hangs(armR, v3, 1, grasp, dt);
    grasp.axis.set(lerp(ga.x, dx, k), lerp(ga.y, 0, k), lerp(ga.z, dz, k)).normalize();      // (the thumb comes round from the pommel to point ahead of her)
    grasp.swing = 0.35 * (1 - k); grasp.grip = lerp(0.46, 0.3, k);
    grasp.weight = hung();
  });
  sc.during(ARM_L, FALLS + TIP, (T, dt, u) => {
    if (!graspL) { graspL = st.grasp(B, 'Left'); graspL.swing = 0; graspL.grip = 0.3; graspL.axis.set(dx, 0, dz); }
    if (u >= 1) { graspL.weight = 0; graspL.grip = 0; return; }
    st.bone(B, 'LeftArm', v3);
    if (!armL.on) { st.bone(B, 'LeftHand', hp); armL.release(v3, hp, 0.6); }       // (as the clip flung it: still going out and up a little)
    hangs(armL, v3, -1, graspL, dt);
    graspL.weight = Math.min(ramp(ARM_L, ARM_L + 0.4, T) * (1 - 0.4 * Math.min(ramp(T_KNEES - 0.3, T_KNEES - 0.05, T), 1 - ramp(T_KNEES, T_KNEES + 0.35, T))), hung());
  });
  // her pipes keep off the standing steel (the wardrobe's wings take things to keep out of, a step at a time)
  sc.during(0, T4 + 7, () => { const w = B.kit.wings; if (w && w.obstacle && flying === false && B.kit.swordPlanted) w.obstacle(sw.x, sw.z, 0.4, 5.3); });      // (as high as its pommel: a low thing turns pipes aside, the wing is not drawn in for it)
  // her light goes out of the pipes first, then they close; the gold of phase two leaves her and the hall before her close-up
  sc.during(0.2, 9, (T, dt, u) => { st.wings(1 - smoother(u), 0.12 + 0.8 * (1 - smoother(u * 2.2))); st.blade(0.6 * (1 - u)); });
  sc.during(0.4, 8.6, (T, dt, u) => { const k = smoother(u); st.mood(undefined, gold0 * (1 - k)); st.bossLight(lerp(1, 0.2, k)); st.halo(lerp(1, 0.4, k)); });
  // From the water on her left, well back: the whole of her coming down, her sword going into the floor beyond her, and
  // him small and whole before her, backing away. (Her raised right arm is on the far side: see docs/news.md, 02:30.)
  // (Where he stands between her and a wall there is no room beyond him: then it is filmed from the side, both in profile.
  // Of the four places the one with the most room that no stone hides is taken, the first named winning a near tie.)
  // (And a stone that stands near the lens inside the picture counts against a place: from the nave's middle the toppled
  // pier filled the right fifth of this shot, black, five metres from the lens: docs/castcheck.md, R3.1.)
  // `pan`: the aim taken this many metres to the camera's right (left if negative), to turn a stone out of the picture.
  const fore = (f, s, pan) => {
    at(v1, f, s, 0); fit(v1); at(v2, 0.8, 0.3, 0);
    const ax = v1.x, az = v1.z, bx = v2.x - ax, bz = v2.z - az, l0 = Math.hypot(bx, bz) || 1;
    const lx = bx - bz / l0 * pan, lz = bz + bx / l0 * pan, ll = Math.hypot(lx, lz) || 1; let worst = 0;      // (the level unit to the camera's right is (-bz, bx) / l0)
    // (he must stay in the picture where he will stand, and she where she sinks: a pan that loses either is no pan)
    for (const [qx, qz, lim] of [[mx, mz, 30], [b0x + dx * 0.4, b0z + dz * 0.4, 22]]) {
      const ox = qx - ax, oz = qz - az, d = Math.hypot(ox, oz) || 1;
      if (Math.acos(clamp((ox * lx + oz * lz) / (d * ll), -1, 1)) > lim * DEG) worst = 6;
    }
    for (const o of stones) {
      const ox = o.x - ax, oz = o.z - az, d = Math.hypot(ox, oz); if (d > l0 + 4 || d < 0.01) continue;
      const off = Math.acos(clamp((ox * lx + oz * lz) / (d * ll), -1, 1)) - Math.asin(Math.min(1, (o.r || 1) / d));      // how far its near edge is from the middle of the picture
      // (by how tall it stands in the picture: the toppled pier, 2.2 m high and unlit, ten metres off, is a black wall at
      // the picture's edge; the heap of vault stones, a metre high and sixteen metres off, is part of the hall)
      if (off < 38 * DEG) worst = Math.max(worst, 10 * (o.h || 2) / d * (0.4 + 0.6 * (1 - Math.max(0, off) / (38 * DEG))));
    }
    return worst;
  };
  let fallF = 11.5, fallSd = -5.5, fallY = 3.6, fallPan = 0;
  {
    let best = -1e9;
    // (the last four: three-quarter and profile places further round, for when she fell facing a wall with stones either side:
    // drawn in to five metres from her, the first two cut her at the knees and him at the neck)
    for (const [f, sd, pen] of [[11.5, -5.5, 0], [11.5, 5.5, 0.6], [2.5, -12.5, 1.2], [2.5, 12.5, 1.8], [6, -10.5, 1.5], [6, 10.5, 2.1], [-1.5, -12.5, 1.9], [-1.5, 12.5, 2.5]]) {
      const hid = blocked(f, sd); let pan = 0, cost = hid ? 100 : 1e9;
      if (!hid) for (const p of [0, -1.2, 1.2, -2.4, 2.4]) { const c = fore(f, sd, p) + Math.abs(p) * 0.12; if (c < cost - 1e-6) { cost = c; pan = p; } }
      const score = room(f, sd) - pen - cost;
      if (score > best) { best = score; fallF = f; fallSd = sd; fallY = hid ? 3.6 : 0.9; fallPan = pan; }
    }
  }
  at(v1, fallF, fallSd, 0); fit(v1); at(v2, 0.8, 0.3, 0);
  const panV = new THREE.Vector3(-(v2.z - v1.z), 0, v2.x - v1.x).setLength(Math.abs(fallPan) || 1e-9).multiplyScalar(Math.sign(fallPan));
  sc.shot('fall', 0, {
    pos: (out, t) => fit(at(out, fallF - t * 0.2 * (fallF > 6 ? 1 : 0), fallSd * (1 - t * 0.016), fallY + t * 0.03)),
    look: [[0, at(v1, 0.0, 0.3, 3.8).add(panV).toArray()], [3, at(v1, 1.0, 0.3, 2.8).add(panV).toArray()]],      // (it comes on and down with her)
    fov: 46, breathe: 0.1,
  });

  // ------------------------------------------------------------------ 2. she sags; her hand slides from the grip and falls; her wings close
  // close from the water between them, on her left: her face and, beyond it, her hand on the standing sword
  const sagS = sideOf(4.6, -2.9) || 1;
  sc.shot('sag', c.tune, {
    pos: (out, t) => at(out, 4.6 - t * 0.12, (-2.9 + t * 0.07) * sagS, 1.25 + t * 0.03),
    look: (out) => { headB(out); out.lerp(v1.set(sw.x, out.y + 0.9, sw.z), 0.4); out.y += 0.05; },      // (her face and, beside it, the grip her hand leaves)
    lag: 2.5, fov: [[0, 40], [6, 38]], aperture: 0.4, focus: headB, breathe: 0.07,
  });
  // he puts up his sword (out of the picture) and stands at rest
  sc.at(PUT, () => st.play(P, 'sheath', { fade: 0.4 }));
  sc.at(PUT + 1.05, () => st.sheathe(true));
  sc.at(PUT + 1.5, () => st.play(P, 'look_around', { fade: 0.8, at: STAND, speed: 0.1 }));

  // ------------------------------------------------------------------ 3. her mask; her last line
  sc.at(T3 + 1.2, () => st.voice('cantor_end', say.text, say.seconds + 0.6));
  // (from below and in front on her left, away from the sword: the mask, sunk; her hands are out of the picture, at her sides)
  // When she falls the camera lets go of her head: she comes down beside it, on its right. It goes up (3 m) and back a
  // little from where she will lie as the lens opens. The operator stays on her face as she tips (a third of a second),
  // then tilts down AHEAD of her to the water where her head and shoulders will lie: her arm and then her head come
  // down into the picture, at full length, the water thrown up round her. The cut to the wide shot is on her lying there.
  // (The operator does not ride on her head: he follows it, a moment late and softly, so that her breath and the
  // lifting of her face are SEEN in the picture. Until 9 Nov lens and aim were measured from her head each step, and
  // whatever her head did the mask stood still in the frame: she looked frozen however she moved.)
  const maskAt = new THREE.Vector3(), maskAim = new Spring3(), maskOut = new THREE.Vector3(), maskLie = new THREE.Vector3(), maskOn = new Spring3(), maskHead = new THREE.Vector3(); let maskT = -1, maskP = -1;
  /** Her head as the operator has it (followed at 1.6 a second), into maskHead. */
  const follow = (T) => { headB(v3); if (maskP < 0) maskOn.reset(v3); else if (T > maskP) maskOn.step(v3, 1.6, Math.min(0.05, T - maskP)); maskP = T; return maskHead.set(maskOn.x, maskOn.y, maskOn.z); };
  sc.shot('mask', T3, {
    pos: (out, t, T) => {
      if (T < FALLS || maskT < 0) { out.copy(follow(T)); const a = (30 - t * 2.2) * DEG, r = 4.3; out.x += (dx * Math.cos(a) + dz * Math.sin(a)) * r; out.z += (dz * Math.cos(a) - dx * Math.sin(a)) * r; out.y -= 1.75 - t * 0.05; maskAt.copy(out); at(maskLie, 2.0, 0.58, 0.45); maskOut.copy(out).sub(maskLie).setY(0).normalize(); return; }
      const k = smoother((T - FALLS - 0.4) / 1.1); out.copy(maskAt).addScaledVector(maskOut, 1.3 * k); out.y += 3.0 * k;
    },
    look: (out, t, T) => {
      if (T < FALLS || maskT < 0) { out.copy(maskHead).lerp(headB(v3), 0.35); out.x += dx * 0.3; out.z += dz * 0.3; out.y += 0.02; maskAim.reset(out); maskT = T; return; }
      headB(out); out.x += dx * 0.3; out.z += dz * 0.3; out.y += 0.02;
      maskAim.step(out, 4, Math.min(0.05, T - maskT)); maskT = T;                  // (her head, followed a moment late ...)
      out.set(maskAim.x, maskAim.y, maskAim.z).lerp(maskLie, smoother((T - FALLS - 0.62) / 0.5));     // (... and then let go for the place she falls to)
    },
    fov: [[0, 19], [FALLS - T3, 18.3], [FALLS - T3 + 0.35, 18.6], [T4 - T3, 36]], aperture: [[0, 0.9], [FALLS - T3, 0.9], [T4 - T3, 0.3]], focus: (out, t, T) => { headB(out); if (T > FALLS) out.lerp(maskLie, smoother((T - FALLS - 0.62) / 0.5)); }, breathe: 0.05, sway: 0.004,
  });

  // ------------------------------------------------------------------ 4. she becomes light
  // (where she lies: the middle of her, between her hips and her head; her light rises from there and he looks to it)
  const lies = new THREE.Vector3(), lieA = new THREE.Vector3(), lieB = new THREE.Vector3();
  const lying = () => { st.bone(B, 'Hips', lieA); headB(lieB); return lies.lerpVectors(lieA, lieB, 0.5); };
  sc.at(FALLS + 0.3, () => st.look(P, at(v1, 2.4, 0.6, 0.6), { weight: 0.85, rate: 3 }));      // (his eyes go down with her: to where her head will lie)
  sc.at(T4, () => { st.sound('hymn_cast', B.pos, 0.8); if (ctx.vfx && ctx.vfx.dissolve) { ctx.vfx.dissolve(B.root, 6); gone = true; } });
  sc.at(T4 + 0.9, () => { lying(); st.look(P, v1.set(lies.x, 9, lies.z), { weight: 0.7, rate: 0.8 }); });      // (and rise with her light)
  // (the effects' dissolve fades what she wears with her; a draught stirs her cloth as she goes)
  sc.during(T4, T4 + 6, (T, dt, u) => { st.halo(0.4 * (1 - u) + Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.8); st.bossLight(0.2 + 0.5 * Math.sin(Math.min(1, u * 1.4) * Math.PI)); if (u >= 1) st.wind(B); else st.wind(B, 0.2, 2.2 * smoother(u * 2), -0.3); });
  // her light climbs: a column of motes from where she lies up past the rose window, to the end of the shot and beyond
  sc.during(T4 + 0.4, T5 + 1.2, (T, dt, u) => {
    if (!(ctx.vfx && ctx.vfx.motes) || u >= 1) return;
    const n = Math.floor(T * 6); if (Math.floor((T - dt) * 6) === n) return;
    // (a band of light three metres deep whose top climbs from her body to eleven metres: from the wide shot's lens the
    // rose window stands behind what is five to nine metres over her. Spread thin over the whole height it could not be seen.)
    // (It rises from the length of her, hips to head: from where she lay, when nothing of her is left to see.)
    if (!unseen) { st.bone(B, 'Hips', lieA); headB(lieB); }
    const top = 1.5 + 9.5 * smoother(u * 1.25), y = Math.max(0.4, top - 3 * ((n * 0.618) % 1)), r = 0.9, along = (n * 0.4142) % 1;      // (0.4142, not 0.382: that is 1 - 0.618, and the band was one slanting line)
    ctx.vfx.motes(v1.set(lerp(lieA.x, lieB.x, along) + Math.sin(n * 2.4) * r, y, lerp(lieA.z, lieB.z, along) + Math.cos(n * 2.4) * r), 36, 0xfff0c8);
  });
  // Wide and still, from down the line that runs from the rose window through her, a little to one side of it: she
  // lies on the water under the window and the moon, the sword standing over her, her light going up past them; he
  // stands whole and small before her, his eyes on her and then on her light. (Aimed 0.6 m lower than when she knelt
  // here: lying, the near side of her touched the lower bar; lower still, and her light climbed out of the picture.)
  let ux = kx - WINDOW.x, uz = kz - WINDOW.z; { const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l; }
  let side = (dx * -uz + dz * ux) > 0 ? -1 : 1, lightY = 0.9;                      // on the side of that line he does not stand on
  {
    const seen = (sd) => { v1.set(kx + ux * 17 - uz * sd * 4, 0, kz + uz * 17 + ux * sd * 4); fit(v1); const ax = v1.x, az = v1.z, sx = kx - ax, sz = kz - az, l2 = sx * sx + sz * sz || 1;
      for (const o of stones) { const t = clamp(((o.x - ax) * sx + (o.z - az) * sz) / l2, 0, 1), ex = ax + sx * t - o.x, ez = az + sz * t - o.z, m = (o.r || 1) + 0.9; if (ex * ex + ez * ez < m * m) return false; } return true; };
    if (!seen(side)) { if (seen(-side)) side = -side; else lightY = 3.4; }
  }
  sc.shot('light', T4, {
    pos: (out, t) => fit(out.set(kx + ux * (17 - t * 0.2) - uz * side * 4, lightY, kz + uz * (17 - t * 0.2) + ux * side * 4)),
    look: [[0, [kx - ux * 2, 3.7, kz - uz * 2]], [7, [kx - ux * 2, 4.2, kz - uz * 2]]],
    fov: 46, breathe: 0.06,
  });

  // ------------------------------------------------------------------ 5. the candles; the camera lifts away
  // Under this cut nothing of her is left to see, and her unseen body is put back where she had sunk, as she was then,
  // her place where it was at this time in the first take (0.7 m behind where her hips rested). Much hangs on where she
  // is, seen or not: the candles catch again "nearest the Cantor first" and their wave must run out from beside the
  // standing sword as it did; the candles' lights are given out by where she and he stand; what floats keeps clear of
  // her; the moths keep away from her. So the last shot is lit and laid out as it was when she knelt there.
  // (She is taken there by way of the air: lifted clear of the water for one step and set down the next. To the water
  // that is a cut, not a body dragged four metres through it: no wake runs from where she lay.)
  sc.at(T5, () => {
    unseen = true; B.pos.x = wasX; B.pos.z = wasZ; B.pos.y = 4;
    st.play(B, DIE, { fade: 0, at: 2.75, speed: 0 });                               // (the moment of the clip she was held in when the last shot was laid out)
    st.relight(1, 5.6); st.look(P, null, { rate: 1.5 });
  });
  sc.at(T5 + 0.01, () => { B.pos.y = 0; st.dirty.add(B); });
  sc.during(T5, T5 + 6, (T, dt, u) => st.mood(smoother(u)));
  sc.at(T5 + 2.4, () => st.play(P, 'bow', { fade: 0.5 }));
  sc.at(T5 + 2.4 + 2.5, () => st.play(P, 'look_around', { fade: 0.7, at: STAND, speed: 0.1 }));

  // ------------------------------------------------------------------ 6. and comes down behind the pilgrim
  const playPos = new THREE.Vector3(), playDir = new THREE.Vector3(), playLook = new THREE.Vector3(); let playFov = 50;
  const hand = (T) => smoother((T - T6 + 0.5) / (c.end - T6 + 0.5));
  // In the world's own metres: from low behind him (he is whole in the picture from its first frame), up and away to
  // the middle of the nave west of them both, wherever they stood, to look down on the water as the candles catch.
  const liftS = sideOf(13, 3.6) || 1;
  at(v1, 13, 3.6 * liftS, 1.1); fit(v1); const L0 = v1.toArray();
  const hiZ = clamp(Math.max(kz, mz) + 12, -4, bd.hz + 2), midX = (kx + mx) * 0.5;
  const hiX = hiZ > 12 ? Math.min(midX * 0.3, -1.5) : midX * 0.3;                 // (a chandelier hangs at x = 5 over the west end: keep north of the axis there)
  const liftP = new Curve([[T5, L0], [T5 + 3, [lerp(L0[0], hiX, 0.45), 5.5, lerp(L0[2], hiZ, 0.45)], 'c'], [T6, [hiX, 11.5, hiZ], 'c'], [c.end, [hiX, 12, hiZ + 1]]]);
  const liftL = new Curve([[T5, at(v1, 1.5, 0.6 * liftS, 2.2).toArray()], [T5 + 3.5, [lerp(kx, mx, 0.5), 0.8, lerp(kz, mz, 0.5)], 'c'], [T6, [lerp(kx, mx, 0.8), 0.3, lerp(kz, mz, 0.8)]]]);
  const probe = () => { playFov = playPose(ctx, playPos, playDir, st.playMode); playLook.copy(playPos).addScaledVector(playDir, 14); };
  sc.at(T5, probe);
  sc.during(T6 - 0.5, c.end, probe);
  sc.shot('lift', T5, {
    pos: (out, t) => { liftP.into(T5 + t, out); out.lerp(playPos, hand(T5 + t)); },
    look: (out, t) => { liftL.into(T5 + t, out); out.lerp(playLook, hand(T5 + t)); },
    fov: { at: (t) => lerp(42, playFov, hand(T5 + t)) }, breathe: 0.05,
  });

  return sc.ready();
}
