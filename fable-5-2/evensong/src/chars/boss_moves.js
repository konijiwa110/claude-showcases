// The Cantor's moves: data, and the little code some of them need. boss.js plays them.
//
// A move is a list of PARTS played one after another. A part is a stretch of a clip (seconds into the clip, at the
// clip's own speed 1) played at `speed`, or a `hold` (the clip all but frozen for so many seconds). Her clips are
// Mixamo's, made for a man: at 3.67 times his size the same key frames last far too short a time, so every part
// says how fast it runs. docs/modules/boss.md has the resulting wind-up, active and recovery times of every move.
//
//   part = {
//     clip, at        start this clip `at` seconds in (cross-fade `fade`); without `clip` the clip in front carries on
//     to              the part ends when the clip reaches this time        | hold: seconds (number or (boss) => number)
//     speed           playback rate of this part (1 = Mixamo's)
//     stage           'windup' | 'active' | 'recover': told on the bus as `boss-move` when it changes (beat: true tells an
//                     'active' again although the stage did not change: one for each ring of the Chorale)
//     track           how fast she may turn toward the pilgrim in this part, radians a second (0 = committed)
//     travel, back    how much of the clip's own forward / backward travel she takes (1 = all of it, 3.67 times a man's);
//                     side: the same for its sideways drift (default: travel, but never more than 1)
//     arm             { damage, poise, heavy, knockdown, weight }: the blade can hurt for the length of this part; parts
//                     that follow one another with the same `arm` are one window (one hit)
//     aim             from this part on she turns her whole body to put him at this bearing in her own frame (radians,
//                     + is her left) instead of the move's `aim`
//     stoop, lower    radians: she bows her whole body the way the blade points / lowers the sword arm from the shoulder
//     up              0..1: both arms are turned from the shoulders until the blade stands upright, whatever her trunk does
//                     ('near': only while stone stands in the line of her guard)
//                     (the lunge, the Tide: a man is a third her size). Never the wrist. snap: true eases them in fast
//     touch           { r, power, line, on }: the first time the blade's point comes down to the floor while this window is
//                     live is the slam: `boss-slam` at that very place, the water struck there (line: true bursts it along
//                     the whole blade), then on(boss) (the leap's ring, the Tide's wave)
//     arms            { clip, t0, t1 }: both arms are taken from another clip while this part plays, running from its t0
//                     to its t1 across the part (the leap: a mutant's body, a swordswoman's arms)
//     spin            radians: she turns this much on the spot over the part, on top of the clip
//     glow, wings     the blade's light and how far the pipes flare (the tell: light announces what can hurt)
//     slam            { r, power, at: 'tip' | 'feet' }: blade or body strikes the floor as this part begins
//     on, each        (boss) at the part's start / (boss, dt) every step of it: the little code
//     when            (boss) => bool, asked once when the move begins: leave this part out
//   }
//   move = { phase (the first phase that has it), range [min, max] metres, arc (how far off her line he may stand,
//            radians), fits(boss, s) (false: the stroke would not reach him where he stands), reach (the ground its
//            blade sweeps: REACH below), aim (the bearing, in her own frame, where the stroke lands: she turns so that he stands there;
//            minus is to her right), weight, cool (seconds before she may choose it again; times coolPressed while
//            he presses her from at her feet), w(boss, s) (extra weight
//            from the situation s = { dist, bearing }), begin(boss), end(boss), parts }
//
// Nothing here draws: rings, blades of light and the wave are boss_fx.js.

// WHAT HER BLOWS COST HIM (he has 100 health and four flasks of 45). Raised by about 40 % in the fight polish (8 Nov):
// three ordinary blows or two great ones and a third fell him from full health, so standing at her feet and trading
// blows loses (docs/logs/fightpolish.md has the fight tables before and after). DAMAGE is exported so the numbers that
// are dealt elsewhere (the rings and the wave in boss.js, the Hymn's blades in boss_fx.js) sit beside these.
export const DAMAGE = { cut: 30, cut2: 24, cleave: 48, thrust: 42, spin: 34, stomp: 30, tide: 34, wave: 28, chorale: 21, leapRing: 20, hymn: 14 };      // (her light and her water, which no shield stops, went up least: they are what a middling player is struck by most, and they do not punish trading)
const CUT = { damage: DAMAGE.cut, poise: 20, heavy: false };          // a cut of the sweep
const CUT2 = { damage: DAMAGE.cut2, poise: 20, heavy: false };        // a cut of the Descant (five of them: each a little lighter)
const CLEAVE = { damage: DAMAGE.cleave, poise: 60, heavy: true, knockdown: true, weight: 'colossal' };        // the overhead cleave, the leap's blade: it throws him down
const THRUST = { damage: DAMAGE.thrust, poise: 50, heavy: true };
const SPIN = { damage: DAMAGE.spin, poise: 40, heavy: true };
export const STOMP = { damage: DAMAGE.stomp, poise: 50, heavy: true, radius: 3.4 };      // radius: round HER (not her heel), so the man behind her feet is in it as well as the man before them
const GUARD = { clip: 'idle', t0: 0.2, t1: 0.2 };       // both arms as she stands on guard, the blade upright in both fists (a layer over a clip whose own arms would swing it, dead, across the floor)
const TIDE = { damage: DAMAGE.tide, poise: 40, heavy: true };

// THE BLADE. Since 22:16 on 7 Nov the sword lies in her hands by Mixamo's own measured hold (docs/grips.md), so every
// great-sword clip carries the blade exactly as its animators saw it, both fists on the grip. No stroke here aims the
// blade by turning her wrist any more (the first pass did, and broke it): each move uses a clip whose OWN stroke comes
// down to a man, and she turns her whole body (`aim`) so that he stands where that stroke lands. A right-handed cut
// lands low and to her LEFT front, at the end of the stroke: that is where she puts him. Where the point would go
// under the floor it rides on it (boss.js, rideFloor). Measured landing zones, standing man, her own frame:
//   slash_combo 0.92-1.07   30..75 deg left, 2.3-6.8 m     the forehand: over her right shoulder, down across her front
//   heavy_swing 2.68-2.87   15..120 deg left, 1.5-6.8 m    the chop after a full circle behind her; then 3.05-3.95 the
//                                                          blade comes back round low: her front left, and all behind her
//   slash_low   0.83-0.90   90..30 deg left, 3.8-7.5 m     a level sweep 0.7 m over the floor (the Tide)
//   cast        2.37-2.45   straight ahead, a line 2.3-7.5 m   the overhead cleave, she on her knees behind it
const SIDE = 0.87;        // where the forehand and the chop both land (50 degrees to her left): she turns to put him there
const REAP = 0.42;        // the round stroke: how far she bows over the blade (radians). Upright, the blade passed over a man nearer than 3.8 m behind her; bowed, it reaps from 2.1 m all round
const TOUCH_CUT = { r: 2.4, power: 0.4 };

// The cleave, shared by the move of that name, the leap and the Descant: Mixamo's "great sword casting", both fists on
// the grip from first frame to last. 0.3-0.68 the blade goes up over her head; there it is held (0.68-1.3); 1.35-1.85
// it tips over and drops behind her back; 1.85-2.25 she heaves it up again and starts to fall with it; 2.25-2.45 over
// the top and down: it lies on the floor straight ahead of her and she is on her knees. She stays down until 3.7.
const RAISE = (speed, track, more) => Object.assign({ clip: 'cast', at: 0.3, fade: 0.35, to: 0.68, speed, stage: 'windup', track, glow: 0.7, wings: 0.5, travel: 0 }, more);
const HEAVE = [
  { clip: 'cast', at: 1.35, fade: 0.12, to: 1.85, speed: 2.3, track: 0.5, glow: 1, wings: 0.7, travel: 0 },      // the blade drops behind her back: the last moment she still turns with him
  { to: 2.25, speed: 2.0, track: 0, glow: 1, wings: 0.7, travel: 0 },
];
const FALL = (touch) => [
  { to: 2.47, speed: 1.05, stage: 'active', arm: CLEAVE, track: 0, glow: 1, wings: 0.7, travel: 0, touch },
  { to: 3.7, speed: 0.7, stage: 'recover', glow: 0.2, travel: 0 },          // on her knees, the blade on the water: the longest opening she gives
  { to: 4.35, speed: 1, travel: 0 },
];
const CLEAVE_TOUCH = { r: 5, power: 1, line: true };

// The two cuts her combos are made of.
// A, the forehand: slash_combo's first cut. The blade comes over from behind her right shoulder and down across her
//    front; its point meets the floor on her left and rides on.
// B, the chop: heavy_swing. From where A ended the blade is drawn back round her left side, behind her and over the
//    top (a full circle: the great sword never stops), and comes down again on her left front.
const cutA = (arm, wind, cut, first) => [
  { clip: 'slash_combo', at: first ? 0.3 : 0.5, fade: first ? 0.3 : 0.25, to: 0.74, speed: wind, stage: 'windup', track: first ? 1.8 : 1.2, glow: 0.6, wings: 0.3, travel: 0.45, aim: SIDE },
  { to: 1.08, speed: cut, stage: 'active', arm, glow: 1, travel: 0.45, touch: TOUCH_CUT },
];
const cutB = (arm, wind, cut) => [
  { clip: 'heavy_swing', at: 2.08, fade: 0.25, to: 2.47, speed: wind, stage: 'windup', track: 1.2, glow: 0.6, travel: 0, aim: SIDE },
  { to: 2.93, speed: cut, stage: 'active', arm, glow: 1, travel: 0, touch: TOUCH_CUT },
];

export const MOVES = {
  // 1. Sweep combo: two or three wide cuts. The forehand comes over her right shoulder and down to her left; the chop
  //    follows out of a full circle behind her; the third, when it comes, is the forehand again, late.
  sweep: {
    phase: 1, range: [2.6, 6.6], arc: 1.5, aim: SIDE, weight: 3, cool: 4,
    begin(b) { b.var.cuts = b.phase === 2 || b.rand() < 0.45 ? 3 : 2; },
    parts: [
      ...cutA(CUT, 0.5, 0.75, true),
      ...cutB(CUT, 0.58, 1.25),
      { when: (b) => b.var.cuts === 2, to: 3.0, speed: 0.1, stage: 'recover', travel: 0 },      // the blade rests where it fell (the clip's own return would drag it, dead, back across him)
      ...cutA(CUT, 0.26, 0.75, false).map((p) => Object.assign({ when: (b) => b.var.cuts === 3 }, p)),      // the third is late: it waits for the roll that came too soon
      { when: (b) => b.var.cuts === 3, to: 1.3, speed: 0.4, stage: 'recover', travel: 0.2 },
    ],
  },

  // 2. Overhead cleave: a slow raise, a held pause (short or long: she chooses), the blade drops behind her back and
  //    comes over in a full arc: it lies on the water in a line straight ahead of her.
  cleave: {
    phase: 1, range: [3.0, 7.0], arc: 1.3, aim: 0, weight: 2.4, cool: 7,      // nearer than 2.3 m he stands under her hands: she does not choose it then
    begin(b) { b.var.hold = b.rand() < 0.5 ? 0.45 : 0.95; },
    parts: [
      RAISE(0.36, 1.5),
      { hold: (b) => b.var.hold - 0.2, speed: 0.04, track: 0.7, glow: 1, wings: 0.7 },
      ...HEAVE,
      ...FALL(CLEAVE_TOUCH),
    ],
  },

  // 3. Thrust lunge from range: the blade comes up and levels down at him along a line; she holds; then the point
  //    comes a long way very fast down that line. Her whole body leans into it and the sword arm comes down from the
  //    shoulder (a man is a third her size: Mixamo's thrust goes up and over his head). One-handed, as the long
  //    thrust of the longsword is: the left hand lets go for reach. Sidestep.
  lunge: {
    phase: 1, range: [6.8, 15.5], arc: 1.1, aim: -0.08, weight: 2, cool: 7,      // the point runs down her own centre line, a hand to its right
    w: (b, s) => (b.punish > 0 ? 4 : 1),
    begin(b) { b.var.hold = 0.05 + b.rand() * 0.4; },
    parts: [
      { clip: 'upward_thrust', at: 0, fade: 0.4, to: 0.44, speed: 0.36, stage: 'windup', track: 2.2, travel: 0, glow: 0.7, wings: 0.4 },
      { to: 0.62, speed: 0.5, track: 1.6, travel: 0, glow: 1, wings: 0.5, stoop: 0.55, lower: 0.42 },
      { hold: (b) => b.var.hold, speed: 0.03, track: 1.3, glow: 1, wings: 0.5, stoop: 0.55, lower: 0.42 },                       // levelled, still following him: how long, she chooses
      { hold: 0.3, speed: 0.03, track: 0, glow: 1, wings: 0.5, stoop: 0.55, lower: 0.42, on: (b) => b.lungeAim() },         // the line is fixed three tenths before she goes
      { to: 0.92, speed: 0.7, stage: 'active', arm: THRUST, track: 0, travel: (b) => b.var.reach, side: 0, glow: 1, stoop: 0.55, lower: 0.42 },
      { to: 1.0, speed: 0.6, arm: THRUST, travel: 0, back: 0, glow: 1, stoop: 0.55, lower: 0.42 },
      { to: 1.3, speed: 0.4, stage: 'recover', travel: 0, back: 0, glow: 0.3, stoop: 0.55, lower: 0.42 },
      { to: 1.7, speed: 0.75, travel: 0, back: 0.15 },
      { to: 2.25, speed: 0.6, travel: 0, back: 0.15 },
    ],
  },

  // 4. The round stroke (still called `spin`): the blade swings out behind her, she chops it down on her left, and
  //    without stopping it comes back round low: across her front, and all the way round behind her. For the man who
  //    stands behind her or circles her. She bows over the blade as it goes round (REAP), so it reaps the ground from
  //    1.9 m of her middle at her sides and before her, and from 2.6 m behind her (upright it passed over everyone
  //    nearer than 3.8 m behind her). Measured: tools/tests/fightpolish/moves.mjs spin <distances> 1 <bearing>.
  spin: {
    phase: 1, range: [1.5, 5.6], arc: 1.9, aim: SIDE, weight: 1.5, cool: 8, coolPressed: 0.6,
    w: (b, s) => (Math.abs(s.bearing) > 1.4 ? 3.5 : 1) * (b.hugged > 1.5 ? 1.5 : 1) * (b.pressed > 30 ? 1.5 : 1),
    fits: (b, s) => !(Math.abs(s.bearing) > 2.5 && s.dist < 2.9),      // the one place it still passes over: a man within a metre of her heels, straight behind her (the stomp is for him)
    parts: [
      { clip: 'heavy_swing', at: 1.95, fade: 0.35, to: 2.47, speed: 0.46, stage: 'windup', track: 1, travel: 0, glow: 0.7, wings: 0.5 },
      { to: 2.93, speed: 1.15, stage: 'active', arm: SPIN, track: 0, travel: 0, glow: 1, wings: 0.6, touch: TOUCH_CUT, stoop: REAP },
      { to: 3.95, speed: 1.3, arm: SPIN, travel: 0, glow: 1, wings: 0.6, stoop: REAP },      // she bows over the blade as it goes round: it reaps the ground at her feet, behind her too
      { to: 4.4, speed: 0.6, stage: 'recover', travel: 0, glow: 0.3 },
      { to: 5.2, speed: 0.9, travel: 0 },
    ],
  },

  // 5. Leap: a deep crouch with the blade going up over her head, then she goes six metres up and comes down blade
  //    first where he stood when she left the floor; a ring of water runs out from the blow. From close by she goes up
  //    and back (it is also how she gets away from a man who will not leave her feet). The body is Mixamo's leaping
  //    mutant; its two fists hold nothing, so both arms are the cleave's (boss.js, `arms`), and she lands into the
  //    cleave's own fall.
  leap: {
    phase: 1, range: [0, 18], arc: 1.3, aim: 0, weight: 1.6, cool: 12,
    w: (b, s) => (b.punish > 0 ? 3 : 1) * (s.dist >= 9 ? 1 : b.hugged > 2.5 ? 1.8 : 0.7),      // he will not leave her feet: she leaves him, upward
    end(b) { b.char.overlayOff(0.2); },
    parts: [
      { clip: 'jump_mutant', at: 0.05, fade: 0.35, to: 0.5, speed: 0.42, stage: 'windup', track: 2.2, travel: 0, glow: 0.8, wings: 0.8, arms: { clip: 'cast', t0: 0.3, t1: 0.7 }, up: 'near' },      // (near stone the blade goes up from an upright guard)
      { to: 1.47, speed: 0.72, track: 0, travel: 0, glow: 1, wings: 1, arms: { clip: 'cast', t0: 0.7, t1: 1.3 }, on: (b) => b.leapStart(), each: (b) => b.leapFly() },
      { clip: 'cast', at: 2.24, fade: 0.1, to: 2.47, speed: 1.05, stage: 'active', arm: CLEAVE, track: 0, travel: 0, glow: 1, wings: 0.8, on: (b) => b.leapLand(), touch: { r: 6, power: 1.3, line: true, on: (b) => b.leapRing() } },
      { to: 3.7, speed: 0.7, stage: 'recover', travel: 0, glow: 0.2 },
      { to: 4.35, speed: 1, travel: 0 },
    ],
  },

  // 6. When he hugs her feet, wherever he stands (before her, beside her, behind her): the leg goes up (a man's side
  //    kick: at her size it passes four metres over his head, and reads as the leg being raised), hangs, and the heel
  //    comes down. The water bursts round her: whoever is within a blade's reach of her body is thrown back.
  stomp: {
    phase: 1, range: [0, 3.7], arc: Math.PI, aim: -0.25, weight: 1.8, cool: 5, coolPressed: 0.7,
    w: (b, s) => (b.hugged > 1.2 ? 2 : 1),
    parts: [
      { clip: 'kick_side', at: 0.33, fade: 0.3, to: 0.58, speed: 0.5, stage: 'windup', track: 1.6, travel: 0.25, glow: 0.5, wings: 0.4, arms: GUARD, up: 1 },
      { to: 0.95, speed: 1.5, track: 0.6, travel: 0.25, glow: 0.8, wings: 0.5, arms: GUARD, up: 1 },          // the kick itself goes by quickly: what is read is the knee held high
      { hold: 0.3, speed: 0.03, track: 0, glow: 1, wings: 0.5, arms: GUARD, up: 1 },
      { to: 1.1, speed: 1, track: 0, travel: 0.25, glow: 1, arms: GUARD, up: 1 },
      { to: 1.16, speed: 1, stage: 'active', track: 0, travel: 0.25, glow: 1, arms: GUARD, up: 1 },      // 'active' is said as the heel lands (the blow is a circle round her, not the leg)
      { to: 1.73, speed: 0.6, stage: 'recover', travel: 0.25, glow: 0.2, arms: GUARD, up: 1, on: (b) => b.stompLand() },
    ],
  },

  // 7. Chorale (phase two): the pipes sound and rings of light run out along the water, one after another. Both fists
  //    hold the blade raised over her head through it (the cleave's own raise, as a layer on her arms): the roar's own
  //    arms lowered a blade that could not hurt across the ground in front of her.
  chorale: {
    phase: 2, range: [0, 40], arc: Math.PI, aim: 0, weight: 1.8, cool: 14,
    w: (b, s) => (s.dist > 9 ? 1.6 : 1),
    begin(b) { b.var.rings = b.hp < b.hpMax * 0.25 ? 4 : 3; b.var.n = 0; },
    parts: [
      { clip: 'roar', at: 0.35, fade: 0.4, to: 1.5, speed: 0.85, stage: 'windup', track: 1, glow: 0.8, wings: 1, arms: { clip: 'cast', t0: 0.3, t1: 0.68 }, on: (b) => b.sing(0.35) },
      { to: 2.05, speed: 0.5, stage: 'active', beat: true, glow: 1, wings: 1, arms: { clip: 'cast', t0: 0.68, t1: 0.76 }, on: (b) => b.choraleRing() },       // 1.1 s between rings: a roll toward one is over before the next arrives
      { to: 2.6, speed: 0.5, stage: 'active', beat: true, glow: 1, wings: 1, arms: { clip: 'cast', t0: 0.76, t1: 0.84 }, on: (b) => b.choraleRing() },
      { to: 3.15, speed: 0.5, stage: 'active', beat: true, glow: 1, wings: 1, arms: { clip: 'cast', t0: 0.84, t1: 0.92 }, on: (b) => b.choraleRing() },
      { when: (b) => b.var.rings > 3, to: 3.7, speed: 0.5, stage: 'active', beat: true, glow: 1, wings: 1, arms: { clip: 'cast', t0: 0.92, t1: 1.0 }, on: (b) => b.choraleRing() },
      { to: 4.1, speed: 0.8, stage: 'recover', glow: 0.3, arms: { clip: 'cast', t0: 0.95, t1: 0.32 } },        // she holds the last note a moment and lowers the blade the way it went up: the opening for whoever came through the rings
    ],
  },

  // 8. Hymn blades (phase two): blades of light hang in the air round her, then fly at him one after another.
  //    Last polish: the sword stands UPRIGHT in her right fist while the left hand casts (`up`: the arm is turned from
  //    the shoulder). The clip holds it out level across her front, and with the pipes open that put five metres of
  //    steel INSIDE the fan of her left wing for the whole song (the reviewer could not show air between them: the
  //    axes came within 0.23 m, tools/tests/lastpolish/hymnblade.mjs). Upright it stands in the gap between the two
  //    wings, 0.6 m clear of every pipe. Decided as HER pose, not the wing's: a wing drawn aside would break the fan
  //    in the one move in which it is shown whole.
  hymn: {
    phase: 2, range: [0, 40], arc: Math.PI, aim: 0, weight: 1.8, cool: 14,
    w: (b, s) => (s.dist > 10 ? 1.8 : 1),
    parts: [
      { clip: 'cast_sustain', at: 0.05, fade: 0.4, to: 1.05, speed: 0.75, stage: 'windup', track: 1.2, glow: 0.8, wings: 1, up: 1, on: (b) => b.hymnCast() },
      { to: 2.5, speed: 0.4, stage: 'active', track: 0.8, glow: 1, wings: 1, up: 1, on: (b) => b.hymnLoose() },
      { to: 3.3, speed: 0.9, stage: 'recover', glow: 0.3, up: 0.6 },
    ],
  },

  // 9. Descant (phase two): five hits, quick: the sweep's two cuts twice over, and out of the last one the blade goes
  //    up for the cleave.
  descant: {
    phase: 2, range: [2.6, 6.4], arc: 1.5, aim: SIDE, weight: 2.4, cool: 10,
    parts: [
      ...cutA(CUT2, 0.62, 0.9, true),
      ...cutB(CUT2, 0.7, 1.4),
      ...cutA(CUT2, 0.4, 0.9, false),
      ...cutB(CUT2, 0.7, 1.4),
      RAISE(0.9, 1.5, { aim: 0, fade: 0.3 }),
      { hold: 0.35, speed: 0.04, track: 0.7, glow: 1, wings: 0.7 },
      ...HEAVE,
      ...FALL(CLEAVE_TOUCH),
    ],
  },

  // 10. Tide (phase two): a level sweep just over the water (she leans into it until the point cuts the surface),
  //     and from where the blade's reach ends a wave of her light crosses the hall. Roll through it.
  tide: {
    phase: 2, range: [2.4, 40], arc: 1.4, aim: 1.05, weight: 1.8, cool: 12,
    w: (b, s) => (s.dist > 9 ? 1.6 : 1),
    parts: [
      { clip: 'slash_low', at: 0.22, fade: 0.4, to: 0.72, speed: 0.4, stage: 'windup', track: 1.5, glow: 1, wings: 1, travel: 0 },
      { to: 0.97, speed: 0.9, stage: 'active', arm: TIDE, track: 0, travel: 0, glow: 1, stoop: 0.14, snap: true, touch: { r: 4, power: 0.8, on: (b) => b.tideLoose() } },
      { to: 1.12, speed: 0.9, travel: 0, glow: 1, on: (b) => b.tideLoose() },      // (if the point never met the water the wave still leaves)
      { to: 1.83, speed: 0.55, stage: 'recover', travel: 0, glow: 0.3 },
    ],
  },
};

// THE GROUND EACH MOVE'S BLADE SWEEPS (docs/impact.md, Part 1: her blade does not pass through the hall's stone).
// For every 15 degrees of her own frame (index 0 = straight ahead, then round to her LEFT: 15, 30 ... 345), how far
// out from where she stood when the move began the blade comes at any moment of the move, wind-up to recovery:
// `any` at any height (a pier stands to the vault), `low` under 1.8 m (the fallen stones are low). The frame is the
// one in which the pilgrim stands at the move's `aim`. boss.js asks these before she chooses a stroke (arcBlocked) and
// while she turns in a wind-up; where stone stands inside them she does something else or steps to open ground.
// MEASURED, not drawn: on the real boss and kit, both phases, near and far, three seeds (the sweep's two and three
// cuts, the cleave's short and long hold), by tools/tests/fightpolish/gen_reach.mjs. Run it again and paste its
// output here after any change to a move's clips, speeds, stoop or arms, or to the sword's hold or length.
const REACH = {
  sweep: { any: [7.8, 8.5, 8.3, 7.5, 7.1, 6.9, 5.9, 5.6, 5.8, 5.9, 5.9, 5.8, 5.5, 5.2, 5, 5, 5, 5.1, 5.5, 6.5, 6.8, 7.5, 7.4, 6.9],
         low: [6.2, 6.7, 8.1, 7.5, 7.1, 6.9, 5.2, 5.2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6.1, 7.1, 6.9] },
  cleave: { any: [7.5, 6.2, 2.7, 1.5, 0.9, 0.8, 0.8, 0.7, 0.7, 1, 1.2, 2.2, 4.4, 5.8, 1.5, 1.2, 1.1, 1.1, 1.1, 1.3, 1.7, 2.7, 4.3, 5.2],
          low: [7.5, 3.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  spin: { any: [7, 6.3, 5.7, 5.6, 5.6, 5.5, 5.2, 5.7, 6.2, 6.2, 6, 5.8, 5.6, 5.6, 5.5, 5.4, 5.4, 5.3, 5.3, 5.3, 5.3, 5.3, 6.1, 6.8],
        low: [6.7, 6.3, 5.7, 5.6, 5.6, 5.5, 5.2, 5.2, 3.7, 5.9, 5.5, 5.5, 5.6, 5.6, 5.1, 5, 5.2, 5.2, 5.2, 5.2, 5.2, 5.1, 4.7, 4.2] },
  stomp: { any: [1.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3.4, 3.3, 2.7, 1.9, 2.3, 2.5, 2.1, 1.8],
         low: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  chorale: { any: [6.5, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5.3, 5.6, 5.5, 5.2, 5.4, 5.8, 5.8, 6, 6.3, 6.5],
           low: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  hymn: { any: [5.9, 4.5, 5.9, 7.3, 6.9, 5.3, 4.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.7, 1.4, 1.1, 2.6, 4.3, 4.4, 5.8, 5.9],
        low: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  descant: { any: [8.2, 9, 8.9, 7.6, 8.4, 6.9, 5.9, 5.5, 5.8, 5.9, 5.9, 5.8, 5.6, 5.1, 5, 5, 5.2, 6.1, 5.6, 6.5, 6.7, 7.4, 7.3, 6.6],
           low: [6.2, 6.7, 8.5, 7.6, 8.4, 6.9, 5.2, 5.2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 6.6] },
  tide: { any: [6.9, 7, 7, 6.9, 6.9, 6.8, 6.9, 7, 7, 6.9, 6.6, 6.3, 6, 5.5, 5.2, 5.6, 5.5, 5.2, 5.2, 5.3, 5.5, 5.9, 6.3, 6.6],
        low: [0, 7, 7, 6.9, 6.9, 6.8, 6.9, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};
for (const k in REACH) { const r = REACH[k]; r.anyMax = Math.max(...r.any); r.lowMax = Math.max(...r.low); }
// the lunge is a lane: from her to `line` metres beyond where he stands, `width` to either side
REACH.lunge = { line: 3.2, width: 0.7, back: 8.5, right: 4.4 };      // ... and out of it the blade is drawn back round her right side: over the last `back` metres of the lane, `right` metres wide
REACH.leap = REACH.cleave;                // the leap's blade is the cleave's, from where she comes down (boss.js, arcFree)

/** The order she weighs them in (and the order of the table in docs/modules/boss.md). */
export const ORDER = ['sweep', 'cleave', 'lunge', 'spin', 'leap', 'stomp', 'chorale', 'hymn', 'descant', 'tide'];
for (const name of ORDER) { MOVES[name].name = name; MOVES[name].reach = REACH[name] || null; }

/** Seconds from the start of a move to its first 'active' part, how many times it says 'active', and its whole length.
 *  quick: how much faster the wind-up parts run (phase two). */
export function timeline(parts, boss, quick = 1) {
  let t = 0, eta = -1, hits = 0, stage = null, clipT = 0;
  for (const p of parts) {
    if (p.stage === 'active' && (stage !== 'active' || p.beat)) { hits++; if (eta < 0) eta = t; }
    if (p.stage) stage = p.stage;
    if (p.hold !== undefined) t += typeof p.hold === 'function' ? p.hold(boss) : p.hold;
    else { if (p.clip) clipT = p.at || 0; t += Math.max(0, p.to - clipT) / ((p.speed || 1) * (stage === 'windup' ? quick : 1)); clipT = p.to; }
  }
  return { eta: Math.max(0, eta), hits, total: t };
}
