// The pilgrim: how he moves and fights in the player's hand (docs/engine.md, "Fighters"; the numbers and the
// reasons are in docs/modules/player.md).
//
// The surface the others use: char, kit, root, pos, yaw, hp, hpMax, stamina, staminaMax, flasks, flasksMax, alive,
// state, radius, invulnerable, blocking, locked, god, puppet, vel, takeHit(hit), reset(spawn?), applyMotion(m),
// update(dt), dispose().
//
// state is one of: idle move sprint block dodge roll backstep jump attack recoil heal hit stagger down getup dead.
// Beyond the contract: bladeStopped(info) (combat tells him his live blade met stone or the floor); air (how high the
// soles of his boots are over the floor, metres: 0 unless he is in a jump or falling out of one).
//
// How it is put together: update() reads the stick (relative to the play camera), lets the state he is in decide
// what the buttons may start (every press is remembered for a third of a second, so one made during a recovery comes
// out the moment it can), advances the pose, then moves him: by his own velocity when he walks, by the clip's root
// motion (scaled) when he rolls or swings. Walls and columns stop him (arena.resolve) and so does the Cantor's body.
import * as THREE from 'three';
import { Character } from './character.js';
import * as clipdata from './clipdata.js';
import * as motiondata from './motiondata.js';
import { dressKnight } from './wardrobe.js';
import { clamp, lerp, angleDiff, approach } from '../core/math.js';
import { rulesFor } from '../core/rules.js';

export const ASSETS = { knight: 'assets/models/knight.glb', 'knight.clips': 'assets/models/knight.clips.glb', 'knight.motion': 'assets/models/knight.motion.glb' };

/** Every number of feel in one place. Speeds in m/s, times in seconds, turns in radians a second. */
export const FEEL = {
  stamina: 100,                                // (his health, his flasks and what a flask gives are numbers of difficulty: src/core/rules.js)
  walk: 1.7, run: 4.6, sprint: 6.6,            // free running; the stick below half is a walk
  strafe: 0.87, back: 0.74,                    // locked on: sideways and backwards as a share of the run
  blockWalk: 2.0, healWalk: 1.5,
  accel: 38,                                   // m/s2: full run in 0.12 s, a stop in 0.12 s
  turn: 14, turnEase: 18,                      // free: he turns toward the stick at up to 14 rad/s, easing in at the end
  turnLock: 11, turnLockEase: 14,              // locked: he turns to face her
  regen: 42, regenBlock: 14, regenDelay: 0.8, regenDelayEmpty: 1.25, sprintDrain: 11,
  buffer: 0.35,                                // how long a press is remembered (the design's number)
  queue: 0.6,                                  // ... and a press made DURING a roll or a swing is kept this long, so a double tap gives two
  tap: 0.25,                                   // the roll button held longer than this (with the stick pushed) is a sprint
  blockArc: 1.4,                               // he blocks blows that come from within this angle of the way he faces (80 degrees)
  blockCost: 0.7, blockCostHeavy: 0.9, chip: 0.12,       // a blocked blow costs damage x this in stamina; heavy blows chip 12 % through
  flinchHeavy: 26, knockdown: 46,              // damage from which a blow staggers him back / throws him down (or hit.heavy / hit.knockdown). Raised with her damage (fight polish): a ring of the Chorale (24) is a flinch, her cuts (30) reel him, only the cleave and the leap (48) throw him down
  lunge: 3.2, lungeMax: 1.3,                   // a swing at a target just out of reach carries him in, at most this far
  bodyGap: 1.0,                                // how much of the Cantor's radius is solid to him (her skirts hang about that far out)
  graceUp: 0.4,                                // seconds without harm after he is back on his feet
  mercy: 0.45,                                 // seconds without harm after a blow that hurt him (a combo cannot land twice in that time)
};

// Solid bodies (docs/impact.md, part 1). head: what of her is at a man's height and so solid to him; lie: how much room
// his body takes lying down (thrown down, dead), so that it never lies through a stone or her feet; sub: the longest
// stretch he travels between two looks at what is in his way; shove: the most her body may push him in one step.
const SOLID = { head: 1.9, lie: 0.92, sub: 0.2, shove: 0.25, floor: 0.035 };
const ROLL = { clip: 'roll_quick', at: 0.02, speed: 1.35, slow: 0.45, cost: 22, iframes: 0.35, distance: 3.3, span: 0.84, cancel: 0.92, walk: 1.0, end: 1.12, fade: 0.07 };
const BACKSTEP = { clip: 'backstep', at: 0.58, speed: 1.75, cost: 12, iframes: 0.24, scale: 1.05, cancel: 1.5, walk: 1.58, end: 1.75, fade: 0.07 };
const HEAL = { clip: 'drink', at: 3.0, speed: 1.75, from: 0.5, to: 1.2, end: 5.3, fade: 0.2 };
// The jump (9 Nov; docs/modules/player.md, "The jump"). The clip is Mixamo's jump on the spot, and the height is the
// clip's own (his hips rise half a metre and his legs tuck: the soles of his boots are 0.86 m up at the top): his place
// (`pos`) stays on the floor, so the lens, her aim and everything else that follows `pos` are as they were. The ground
// he covers is the speed he pushed off with. Times are seconds into the clip:
//   at, gather   where the clip is entered and how fast its crouch is played (prompt: his feet leave 0.12 s after the press)
//   off, land    his soles leave the floor / are on it again (measured: tools/tests/jump/clip.mjs); splash: they meet the water's skin
//   top          from here on he is coming down, and it is his soles that say when he lands: wet (m): at the water's skin, touch (m): standing
//   speed        how fast the rest is played (1: half a second in the air, as the clip was made)
//   end          the clip is left for the idle (with the stick pushed, or a button waiting, he is off at `land`)
//   stride       travelling, the walk blend is put in front from here on (strideFade: over so long), so that he lands in his stride
//   steer        how much the stick still changes his speed in the air, m/s2 (the ground gives 38: this is "a little"). He does
//                not turn in the air, except to keep facing her when locked on
//   carry        m/s kept along his nose when the jump comes out of a roll with the stick pushed (as walking out of it keeps)
const JUMP = { clip: 'jump', at: 0.02, gather: 1.5, speed: 1, off: 0.2, top: 0.45, splash: 0.73, land: 0.75, end: 0.95, wet: 0.08, touch: 0.03, stride: 0.6, strideFade: 0.2, fade: 0.08, cost: 12, steer: 3, carry: 3.6 };
// The landing's weight. Mixamo's jump comes down all but stiff-legged (his hips end one centimetre under where he
// stands): a man in plate who drops half a metre gives at the knees. The give is a stretch of the backstep's crouch
// (both feet flat, the hips going down), added on his hips and legs as his boots meet the water, and let go again:
// his hips go on down through their standing height, about 9 cm, and are back a quarter of a second later.
//   weight   how much of it on a jump on the spot; stride: when he lands in his stride (the stride has a give of its own)
const GIVE = { clip: 'backstep', at: 0.25, end: 0.62, speed: 1.4, weight: 1, stride: 0.6, fadeIn: 0.03, fadeOut: 0.18 };
// What runs along the floor passes under a man in the air: her blows that are not blades, by the `kind` they are
// struck with (boss_fx.js: the rings, the wave; boss.js: the stomp), and how high each stands, metres over the floor.
// While the soles of his boots are higher than that, it misses him (takeHit). How each was measured: player.md.
const FLOOR = { chorale: 0.3, leap: 0.3, stomp: 0.3, tide: 0.45 };
const FALL_G = 16, FALL_SKIP = 0.05, FALL_BLEND = 0.1;       // struck in the air he falls: m/s2 (the clip's own way down is about 13); under this height (m) there is no fall to show; seconds the reaction's pose takes to come in (the model follows his hips exactly through it)
// Reactions. travel: how much of the clip's own stagger is kept (it is sent along the blow, not along his nose);
// push: a shove on top of that, in m/s, dying away.
// The light flinch is chosen by where the blow lands and which way it travels: a blow to the body bows him forward
// ('hit'), one that crosses him from his right twists him to his left ('hit_small'), a high one or one from his left
// throws his head back and to the right ('hit_head').
const FLINCH = { clip: 'hit', at: 0.03, speed: 1.5, end: 0.78, travel: 1, push: 1.6, fade: 0.06 };
const FLINCH_SIDE = { clip: 'hit_small', at: 0.1, speed: 1.5, end: 0.66, travel: 1, push: 1.6, fade: 0.06 };
const FLINCH_HEAD = { clip: 'hit_head', at: 0.03, speed: 1.3, end: 0.6, travel: 1, push: 1.6, fade: 0.06 };
const RECOIL = { back: 0.1, free: 0.36, end: 0.5 };      // his blade met stone: it springs back along its path, then he gathers himself
// (hit_big's own stagger steps ease in: taken whole, he was carried back fastest a third of a second AFTER the blow and
// seemed to step back by himself. Now most of the 1.15 m is a shove that is largest on the contact frame and dies away
// (push, m/s; it dies at 7.5 a second, so 5.2 carries him 0.7 m), and the clip's steps are the rest.)
const FLINCH_BIG = { clip: 'hit_big', at: 0.02, speed: 1.35, end: 0.92, travel: 0.4, push: 5.2, fade: 0.06 };
const BREAK = { clip: 'hit_big', at: 0.02, speed: 1.0, end: 1.05, travel: 0.3, push: 3.6, fade: 0.06 };
const FALL = { clip: 'stunned', at: 0.05, speed: 1.25, end: 1.5, lie: 0.3, travel: 1.5, push: 2.2, fade: 0.08 };
// The blow that kills is the blow that fells: Mixamo's deaths begin with a long totter (death_back stands for a second,
// death_fwd for a second and a half), so each is entered where the body starts to go down (measured: the hips' height
// over the clip, tools/tests/fightpolish/deathclip.mjs): back: falling from 1.0 s, down by 1.6; fwd: on his knees from
// 1.5 s, on his face at 3.1; fly: thrown at once.
const DEATH = { travel: 1, push: 0.8, back: 0.95, fwd: 1.35, fly: 0.06 };
const TURN_TO_BLOW = 0.26;             // seconds over which a heavy blow turns him to face where it came from (he reels AWAY from it)
const GETUP = { clip: 'getup', at: 4.25, speed: 1.75, end: 5.85, fade: 0.25 };

// The attacks. Times are seconds into the clip at speed 1 (the animation owner's convention); hit, swing and recover
// are replaced by the measured events in clipdata.js where it has them (see timings()).
//   at      where the clip is entered (its dead wind-up skipped)      speed   how fast it is played
//   hit     [on, off] the blade is live                               swing   the whoosh
//   chain   the next attack may start      recover   anything may start (roll, block, drink)      walk   the stick takes over
//   end     the clip is left for the idle
//   x, z    how much of the clip's own travel is kept (sideways, forward)
//   yaw     he is turned this much off the line to the target, because the clip's cut does not land straight ahead
//           (atk_high spins and chops 30 degrees to his left: turned 30 degrees right, the blade comes down on the line)
const ATTACKS = {
  light1: { clip: 'atk_cross', at: 0.40, speed: 1.3, hit: [0.72, 0.90], swing: 0.68, chain: 1.03, recover: 1.15, walk: 1.25, end: 1.5, damage: 16, poise: 12, cost: 14, next: 'light2' },
  light2: { clip: 'atk_down', at: 0.20, speed: 1.25, hit: [0.53, 0.80], swing: 0.45, chain: 0.96, recover: 1.10, walk: 1.2, end: 1.38, damage: 16, poise: 12, cost: 14, next: 'light3' },
  light3: { clip: 'atk_thrust', at: 0.30, speed: 1.2, hit: [0.60, 0.90], swing: 0.53, chain: 1.02, recover: 1.06, walk: 1.1, end: 1.12, n: 0, own: true, damage: 22, poise: 18, cost: 16, next: 'light1' },
  heavy: { clip: 'atk_power', at: 0.45, speed: 1.3, hold: 0.62, hit: [1.30, 1.46], swing: 1.25, chain: 1.82, recover: 1.95, walk: 2.05, end: 2.3, damage: 34, poise: 30, cost: 28, heavy: true, charged: { damage: 52, poise: 48 }, next: 'light1' },
  runLight: { clip: 'atk_high', at: 0.0, speed: 1.2, hit: [0.48, 0.68], swing: 0.42, chain: 0.86, recover: 0.95, walk: 1.0, end: 1.2, yaw: -0.52, damage: 20, poise: 16, cost: 16, next: 'light2', fade: 0.1 },
  rollLight: { clip: 'atk_high', at: 0.0, speed: 1.25, hit: [0.48, 0.68], swing: 0.42, chain: 0.86, recover: 0.95, walk: 1.0, end: 1.2, yaw: -0.52, x: 0.55, z: 0.55, damage: 18, poise: 14, cost: 16, next: 'light2', fade: 0.1 },
  runHeavy: { clip: 'atk_jump', at: 0.30, speed: 1.35, hit: [1.02, 1.33], swing: 0.93, chain: 1.8, recover: 1.95, walk: 2.0, end: 2.2, damage: 38, poise: 34, cost: 28, heavy: true, next: 'light1', fade: 0.1 },
  // the falling cut (9 Nov): attack or heavy pressed in the air. The leaping blow's own clip, entered where it is in the
  // air (`at` is worked out from the air he has left: startCut), so that the stroke lands as he does. The heavy blow's numbers.
  jumpCut: { clip: 'atk_jump', at: 0.86, speed: 1.15, hit: [1.02, 1.33], swing: 0.93, chain: 1.8, recover: 1.95, walk: 2.0, end: 2.2, damage: 34, poise: 30, cost: 28, heavy: true, next: 'light1', fade: 0.1 },
};
// The falling cut, in the air: from, to: the stretch of the jump (its clip's seconds) in which a press cuts (before it
// he has hardly left the floor; after it too little air is left for a stroke: the press waits for the floor, and is
// an ordinary cut there); land: the clip's second at which its boots land, hips: how high its hips are then (m);
// first, last: the earliest and latest second of the clip it may be entered at; ease: over the last so many seconds
// of air the clip's own fall takes over from his.
const CUT = { from: 0.26, to: 0.56, land: 1.2, hips: 0.92, first: 0.62, last: 1.0, ease: 0.08 };
export { ATTACKS, ROLL, BACKSTEP, JUMP, FLOOR };

/** Take the measured windows from the animation owner's clip data where it has them. */
function timings(data) {
  for (const key in ATTACKS) {
    const a = ATTACKS[key], d = data && data[a.clip];
    a.x = a.x === undefined ? 1 : a.x; a.z = a.z === undefined ? 1 : a.z; a.fade = a.fade || 0.07; a.key = key;
    if (!d || !d.events) continue;
    const n = a.n || 0, at = (name) => { const e = d.events.find((v) => v.name === name && (!v.data || (v.data.n || 0) === n)); return e ? e.t : undefined; };
    const on = at('hit-on'), off = at('hit-off'), sw = at('swing');
    if (on !== undefined && off !== undefined && off > on) a.hit = [on, off];
    if (sw !== undefined) a.swing = sw;
    if (!a.own && typeof d.recover === 'number') { const shift = d.recover - a.recover; a.recover += shift; a.chain += shift; a.walk += shift; a.end = Math.max(a.end, a.walk + 0.05); }
  }
}

const _v = new THREE.Vector3(), _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _tip = new THREE.Vector3(), _hand = new THREE.Vector3(), _ax = new THREE.Vector3(), _d3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
// What of her is solid to him when boss.solid is not there: bone to bone, radius in her own units (a 1.8 m figure's).
const HER = [['LeftLeg', 'LeftFoot', 0.105], ['RightLeg', 'RightFoot', 0.105], ['LeftFoot', 'LeftToeBase', 0.085], ['RightFoot', 'RightToeBase', 0.085],
  ['LeftUpLeg', 'LeftLeg', 0.13], ['RightUpLeg', 'RightLeg', 0.13], ['Hips', 'Spine2', 0.2], ['LeftForeArm', 'LeftHand', 0.07], ['RightForeArm', 'RightHand', 0.07]];
// what a moment allows the buttons to start (shared: nothing is made per step)
const REFUSED = { refused: true };
// (a jump may start wherever a roll may: with no jump pressed these read exactly as before)
const MAY_ALL = { roll: true, attack: true, heal: true, jump: true }, MAY_CUT = { attack: true }, MAY_LEAVE = { roll: true, heal: true, jump: true }, MAY_ROLL = { roll: true, jump: true };
// the skin of his boots (clipdata's $contact: points measured on the mesh, in each bone's own frame): his soles are the lowest of them
const SOLES = ['LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase'];
const speedFor = (stick, top) => Math.min(top, stick >= 0.9 ? top : stick > 0.5 ? lerp(FEEL.walk, top, (stick - 0.5) / 0.4) : FEEL.walk * (0.5 + stick));
const turnStep = (from, to, ease, cap, dt) => { const d = angleDiff(to, from); return from + clamp(d * (1 - Math.exp(-ease * dt)), -cap * dt, cap * dt); };

export class Player {
  constructor(ctx) {
    this.ctx = ctx; this.name = 'pilgrim';
    const c = this.char = new Character(ctx, { model: 'knight', clips: 'knight.clips', data: { ...clipdata.knight, ...motiondata.knight } });
    // clips taken from a performer live in a file of their own (src/chars/motiondata.js); a test that builds its own asset list may not have it
    if (ctx.assets.has && ctx.assets.has('knight.motion')) for (const raw of ctx.assets.gltf('knight.motion').animations) c.addClip(raw);
    this.root = c.root; this.pos = c.root.position; ctx.scene.add(c.root);
    this.look = ctx.gfx && ctx.gfx.materials && ctx.gfx.materials.character ? ctx.gfx.materials.character(c.model, { who: 'player' }) : null;
    const R = this.rules = rulesFor(ctx.params);                 // how hard the fight is (src/core/rules.js)
    this.radius = 0.38; this.hpMax = R.health; this.staminaMax = FEEL.stamina; this.flasksMax = R.flasks;
    const kit = this.kit = dressKnight(ctx, c);
    this.weapon = ctx.combat.addWeapon({ owner: this, base: kit.sword.base, tip: kit.sword.tip, radius: kit.sword.radius || 0.06 });
    this.trail = ctx.vfx && ctx.vfx.trail ? ctx.vfx.trail(kit.sword) : null;
    timings(clipdata.knight);
    this.rollScale = ROLL.distance / (ROLL.span * ((clipdata.knight[ROLL.clip] && clipdata.knight[ROLL.clip].travel && clipdata.knight[ROLL.clip].travel[1]) || 5.98));
    this.vel = new THREE.Vector3(); this.push = new THREE.Vector3(); this.pushDir = new THREE.Vector3(0, 0, 1); this.aim = 0; this.speed = 0;
    this.puppet = false; this.locked = false; this.god = false; this._wasPuppet = false; this.afterPuppet = 0;
    this.wx = 0; this.wz = 0; this.wish = 0; this.wishYaw = 0;
    this._step = { who: 'player', pos: this.pos, foot: 'l', run: false };
    this._land = { who: 'player', pos: this.pos, hard: false };
    this._swing = { who: 'player', heavy: false, weapon: this.weapon };
    this._roll = { pos: this.pos, dir: new THREE.Vector3() };
    this.feet = 0; this.stride = 0; this.footSide = 0;
    this.solids = new Float32Array(5 * 24); this.solidN = 0; this.room = this.radius; this.shoveLeft = SOLID.shove;      // her body at a man's height (ax, az, bx, bz, r each); the room his own body takes
    this.handle = null; this.clipPrev = 0; this.blowFrom = 0; this.turnT = 0;
    // the jump: how high his soles are (0 on the floor), the skin of his boots to read that from, his hips' height and how fast it changes, and, struck in the air, the fall (falling, fallH, fallV: his hips' way down)
    this.air = 0; this.hipY = 0; this.hipV = 0; this.jumpTop = 0; this.jt = 0; this.pushed = false; this.landed = false; this.striding = false; this.plantWas = true; this.falling = false; this.fallH = 0; this.fallV = 0; this.fallG = FALL_G; this.fallT = 0; this.cutting = false; this.cutT = 0;
    { const pts = clipdata.knight && clipdata.knight.$contact; this.soleSkin = []; if (pts) for (const n of SOLES) if (c.bones[n] && pts[n]) this.soleSkin.push({ bone: c.bones[n], pts: pts[n] }); }
    this.gaze = new THREE.Vector3(); this.gazing = false;                  // where his head turns: her face (the animation owner's look-at)
    this.offClip = c.on((e) => this.onClip(e));
    // the animation owner's blend and layers, when they exist (docs/modules/animation.md); plain clips until then
    this.hasBlend = false; this.hasOverlay = typeof c.overlay === 'function' && typeof c.overlayOff === 'function';
    if (typeof c.locomotion === 'function' && typeof c.move === 'function') {
      try { c.locomotion({ idle: 'idle', walk: { f: 'walk_f', b: 'walk_b', l: 'walk_l', r: 'walk_r' }, run: { f: 'run_f', b: 'run_b', l: 'run_l', r: 'run_r' }, sprint: 'sprint' }); this.hasBlend = true; } catch (e) { console.warn('pilgrim: no blended walk (' + e.message + ')'); }
    }
    this.reset();
  }

  get yaw() { return this.root.rotation.y; } set yaw(v) { this.root.rotation.y = v; }
  get blocking() { return this.state === 'block'; }
  get invulnerable() { return this.iframes > 0 || this.safe; } set invulnerable(v) { this.safe = !!v; }
  get attacking() { return this.state === 'attack'; }
  get busy() { const s = this.state; return !(s === 'idle' || s === 'move' || s === 'sprint' || s === 'block'); }

  reset(spawn = this.ctx.arena.spawn.player) {
    const c = this.char;
    this.pos.set(spawn.x, 0, spawn.z); this.yaw = spawn.yaw || 0;
    this.hp = this.hpMax; this.stamina = this.staminaMax; this.flasks = this.flasksMax; this.alive = true;
    this.iframes = 0; this.safe = false; this.regenWait = 0; this.sprintOut = false;
    this.state = 'idle'; this.t = 0; this.def = null; this.chain = 'light1'; this.chainT = 0; this.sinceSprint = 9; this.sinceRoll = 9;
    this.vel.set(0, 0, 0); this.push.set(0, 0, 0); this.charge = 0; this.healed = 0; this.dodged = false; this.decided = true; this.lit = 1;
    this.root.visible = true; c.speed = 1;
    this.ctx.combat.disarm(this.weapon); if (this.trail && this.trailOn) this.trail.stop();
    if (this.hasOverlay) c.overlayOff(0);
    if (this.kit.sheathe) this.kit.sheathe(false);
    if (this.kit.lantern) this.kit.lantern.level = 1;
    if (typeof c.look === 'function') { c.look(null); this.gazing = false; }
    this.anim = ''; this.fadeIn = 0; this.rdef = null; this.lieT = 0; this.trailOn = false; this.blockHit = 0;
    this.room = this.radius; this.solidN = 0; this.turnT = 0; this.handle = null; this.shoveLeft = 99;      // put down anywhere, he is out of her at once
    this.grounded();
    c.play('idle', { fade: 0, force: true }); if (!this.hasBlend) this.anim = 'idle';
    this.legs(0, 0, true, 0); this.fadeIn = undefined;
    const input = this.ctx.input; for (const a of ['attack', 'heavy', 'roll', 'heal', 'block', 'jump']) input.consume(a);
    this.kit.teleport();
  }

  /**
   * Back from a fall to his full life, where he lies (the rescue: src/cine/rescue.js). Only his body's state is put
   * right: where he is, which way he faces, his flasks and his sword stay as they were. He gets up as the cutscene's
   * puppet; given back to his rules he stands in his guard (and `afterPuppet` seconds of grace are his then).
   */
  revive() {
    this.hp = this.hpMax; this.stamina = this.staminaMax; this.alive = true;
    this.regenWait = 0; this.sprintOut = false; this.lieT = 0; this.rdef = null; this.def = null; this.healed = 0; this.charge = 0;
    this.vel.set(0, 0, 0); this.push.set(0, 0, 0); this.state = 'getup'; this.t = 0;
  }

  // ---------------------------------------------------------------- moving him

  /** Apply a step of root motion (in his own frame: +z forward, +x to his left) to his place in the world. */
  applyMotion(m, sx = 1, sz = 1) {
    const y = this.yaw, c = Math.cos(y), s = Math.sin(y), x = m.x * sx, z = m.z * sz;
    this.yaw = y + m.yaw;
    return this.moveBy(x * c + z * s, -x * s + z * c);
  }
  /** Travel by (dx, dz) in the world, looking at what is in the way every SOLID.sub metres, so that nothing fast (a roll,
   *  the leaping blow, a hard shove) can carry him through a stone, a pier or her. Returns true if he touched something. */
  moveBy(dx, dz) {
    const l = Math.hypot(dx, dz), p = this.pos;
    if (l < 1e-7) return false;
    const n = Math.max(1, Math.ceil(l / SOLID.sub)); let hit = false;
    for (let i = 0; i < n; i++) { p.x += dx / n; p.z += dz / n; if (this.collide()) hit = true; }
    return hit;
  }
  /** Her body as he meets it this step: capsules in the world, only what of her is at a man's height (her shins, her
   *  feet, the low end of her thighs; her knees, hips and hands when she crouches or kneels). boss.solid is used when
   *  she offers it ([{ a, b, r }], world metres); until then it is read off her bones. */
  readSolids() {
    const b = this.ctx.boss; let n = 0;
    if (!b || !b.alive || !b.char || b === this) { this.solidN = 0; return; }
    const src = Array.isArray(b.solid) ? b.solid : null;
    if (src) { for (let i = 0; i < src.length; i++) { const c = src[i]; if (!c || !c.a || !c.b) continue; const A = c.a.isObject3D ? c.a.getWorldPosition(_sa) : c.a, B = c.b.isObject3D ? c.b.getWorldPosition(_sb) : c.b; n = this.addSolid(n, A, B, c.r || 0.3); } }
    else {
      const B = b.char.bones, s = b.char.scale;
      for (let i = 0; i < HER.length; i++) { const h = HER[i], ba = B[h[0]], bb = B[h[1]]; if (!ba || !bb) continue; n = this.addSolid(n, ba.getWorldPosition(_sa), bb.getWorldPosition(_sb), h[2] * s); }
    }
    this.solidN = n;
  }
  addSolid(n, A, B, r) {
    if (n >= 24) return n;
    const top = SOLID.head + r * 0.6;                                      // above this a part of her passes over his head
    let ax = A.x, ay = A.y, az = A.z, bx = B.x, by = B.y, bz = B.z;
    if (ay > top && by > top) return n;
    if (ay > top) { const k = (top - by) / (ay - by); ax = bx + (ax - bx) * k; az = bz + (az - bz) * k; }
    else if (by > top) { const k = (top - ay) / (by - ay); bx = ax + (bx - ax) * k; bz = az + (bz - az) * k; }
    const S = this.solids, o = n * 5; S[o] = ax; S[o + 1] = az; S[o + 2] = bx; S[o + 3] = bz; S[o + 4] = r;
    return n + 1;
  }
  /** Keep him out of walls, columns and the Cantor (her body's circle, and her legs wherever they stand). Returns true
   *  if he touched something. */
  collide() {
    const b = this.ctx.boss, a = this.ctx.arena, p = this.pos, R = this.room, S = this.solids; let hit = false;
    for (let i = 0; i < 3; i++) {
      let again = false;
      if (b && b.alive && b !== this && !b.flying) {                        // six metres up in her leap she is over his head: nothing of her is in his way
        const dx = p.x - b.pos.x, dz = p.z - b.pos.z, d = Math.hypot(dx, dz), min = b.radius * FEEL.bodyGap + R;
        if (d < min && this.shoveLeft > 0) {                               // her body (her skirts): out of it, at most SOLID.shove a step (shoved, not teleported)
          const out = Math.min(min - d, this.shoveLeft); this.shoveLeft -= out;
          if (d > 1e-4) { p.x += dx / d * out; p.z += dz / d * out; } else { p.x -= Math.sin(this.yaw) * out; p.z -= Math.cos(this.yaw) * out; }
          hit = again = true;
        }
        for (let k = 0; k < this.solidN; k++) {                            // her legs and whatever else of her is down at his height
          const o = k * 5, ax = S[o], az = S[o + 1], sx = S[o + 2] - ax, sz = S[o + 3] - az, min2 = S[o + 4] + R, l2 = sx * sx + sz * sz;
          let t = l2 > 1e-8 ? ((p.x - ax) * sx + (p.z - az) * sz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + sx * t, qz = az + sz * t; let ex = p.x - qx, ez = p.z - qz, e = Math.hypot(ex, ez);
          if (e >= min2) continue;
          if (e < 0.02 && l2 > 0.25) { ex = -sz; ez = sx; e = Math.hypot(ex, ez); }      // on the very axis of something long (her blade lying on the water, her train): out to its side, not along it
          else if (e < 1e-4) { ex = p.x - b.pos.x; ez = p.z - b.pos.z; e = Math.hypot(ex, ez); if (e < 1e-4) { ex = -Math.sin(this.yaw); ez = -Math.cos(this.yaw); e = 1; } }
          if (this.shoveLeft <= 0) continue;
          const out = Math.min(min2 - Math.hypot(p.x - qx, p.z - qz), this.shoveLeft); this.shoveLeft -= out;      // shoved, not teleported: the rest comes in the next steps
          p.x += ex / e * out; p.z += ez / e * out; hit = again = true;
        }
      }
      if (a.resolve(p, R)) hit = true; else if (!again || i) break;
    }
    return hit;
  }
  /** How far his body is from hers (0 = touching), and the way to her. */
  gapTo(b) { return Math.hypot(b.pos.x - this.pos.x, b.pos.z - this.pos.z) - b.radius * FEEL.bodyGap - this.radius; }
  yawTo(b) { return Math.atan2(b.pos.x - this.pos.x, b.pos.z - this.pos.z); }

  /** Where the stick points, in the world: it is read against the play camera, so "up" is away from the lens. */
  readStick() {
    const ctx = this.ctx, mv = ctx.input.move, cam = ctx.cam;
    let yaw;
    if (cam && cam.mode !== 'cine' && typeof cam.yaw === 'number') yaw = cam.yaw;
    else { ctx.camera.getWorldDirection(_v); yaw = Math.atan2(_v.x, _v.z); }
    const s = Math.sin(yaw), c = Math.cos(yaw), m = Math.min(1, Math.hypot(mv.x, mv.y));
    if (m > 0.12) { const wx = s * mv.y - c * mv.x, wz = c * mv.y + s * mv.x, l = Math.hypot(wx, wz); this.wx = wx / l; this.wz = wz / l; this.wish = m; this.wishYaw = Math.atan2(this.wx, this.wz); }
    else { this.wish = 0; this.wx = 0; this.wz = 0; }
  }

  /** Walk, run or sprint by the stick. top: the speed at full stick. face: 'stick' | 'boss' | 'keep'. */
  locomote(dt, top, face) {
    const v = this.vel, p = this.pos, boss = this.ctx.boss;
    let tx = 0, tz = 0;
    if (this.wish > 0) {
      let sp = speedFor(this.wish, top);
      if (face === 'boss') {                                               // sideways and backwards are slower than toward her
        const f = Math.sin(this.yaw) * this.wx + Math.cos(this.yaw) * this.wz;
        sp *= f >= 0 ? lerp(FEEL.strafe, 1, f) : lerp(FEEL.strafe, FEEL.back, -f);
      }
      tx = this.wx * sp; tz = this.wz * sp;
    }
    const dx = tx - v.x, dz = tz - v.z, dl = Math.hypot(dx, dz), step = FEEL.accel * dt;
    if (dl <= step) { v.x = tx; v.z = tz; } else { v.x += dx / dl * step; v.z += dz / dl * step; }
    if (face === 'boss' && boss) this.yaw = turnStep(this.yaw, this.yawTo(boss), FEEL.turnLockEase, FEEL.turnLock, dt);
    else if (face === 'stick' && this.wish > 0) this.yaw = turnStep(this.yaw, this.wishYaw, FEEL.turnEase, FEEL.turn, dt);
    const px = p.x, pz = p.z, was = Math.hypot(v.x, v.z);
    if (this.moveBy(v.x * dt, v.z * dt) || this.collide()) {               // a wall takes the speed that ran into it; her shove is not his own speed
      const ax = (p.x - px) / dt, az = (p.z - pz) / dt, al = Math.hypot(ax, az), k = al > was ? was / (al || 1) : 1;
      v.x = ax * k; v.z = az * k;
    }
    this.legs((p.x - px) / dt, (p.z - pz) / dt, face !== 'boss', dt);
  }

  /** Make the legs fit what he actually covered this step (world velocity). */
  legs(ax, az, forwardOnly, dt) {
    const c = this.char, y = this.yaw, sy = Math.sin(y), cy = Math.cos(y);
    const vz = ax * sy + az * cy, vx = ax * cy - az * sy, sp = Math.hypot(vx, vz);         // his own frame: +z forward, +x left
    this.speed = sp;
    if (this.hasBlend) {
      if (this.anim !== '@move') { this.anim = '@move'; c.play('@move', { fade: this.fadeIn !== undefined ? this.fadeIn : 0.18 }); this.fadeIn = undefined; }
      // not locked on he turns his body and always goes forward in his own frame (the animation owner's advice: a quick
      // turn must not flip the gait between its forward and strafe groups); locked on he steps in any direction
      if (forwardOnly) c.move(0, sp); else c.move(vx, vz);
    } else {
      // plain clips: the nearest of idle / walk / run in four directions, played at the rate that matches the ground
      let name = 'idle', ground = 0;
      if (sp > 0.25) {
        const run = sp > 2.7, ang = forwardOnly ? 0 : Math.atan2(vx, vz), a = Math.abs(ang);
        const d = a < 0.9 ? 'f' : a > 2.25 ? 'b' : ang > 0 ? 'l' : 'r';
        name = (run ? 'run_' : 'walk_') + d; ground = (clipdata.knight[name] && clipdata.knight[name].groundSpeed) || (run ? 4.2 : 1.5);
      }
      const e = c.clips && c.clips.get(name), base = (e && e.speed) || 1;
      if (this.anim !== name) { this.anim = name; c.play(name, { fade: this.fadeIn !== undefined ? this.fadeIn : name === 'idle' ? 0.22 : 0.16, speed: ground ? clamp(sp / ground, 0.5, 1.7) / base : 1 }); this.fadeIn = undefined; }
      else if (ground) c.play(name, { speed: clamp(sp / ground, 0.5, 1.7) / base });
    }
    // steps: from the clips' foot events where they come; counted from the ground covered where they do not
    this.stride += sp * dt;
    if (this.feet > 0) this.feet -= dt;
    else if (sp > 0.6 && this.stride > (sp > 2.7 ? 1.25 : 0.72)) { this.stride = 0; this.footSide ^= 1; this.emitStep(this.footSide ? 'l' : 'r', true); }
  }
  emitStep(foot, counted) {
    const s = this._step; s.foot = foot; s.run = this.speed > 2.7 || this.state === 'roll' || this.state === 'attack';
    if (!counted) { this.feet = 1.5; this.stride = 0; }
    this.ctx.bus.emit('step', s);
  }
  onClip(e) {
    if (this.state === 'jump' && !this.puppet) return;                     // in a jump the push-off and the landing are told from the jump itself (jumping()): a foot of the stride he lands in is not yet on the floor
    if (e.name === 'foot-l' || e.name === 'foot-r') {
      if (!this.puppet && (this.state === 'idle' || this.state === 'down' || this.state === 'dead')) return;      // an idle shifting its weight is not a step
      this.emitStep(e.name === 'foot-l' ? 'l' : 'r', false);
    } else if (e.name === 'land') { const l = this._land; l.hard = this.state === 'attack' || this.state === 'down'; this.ctx.bus.emit('land', l); }
  }

  // ---------------------------------------------------------------- clips

  play(name, at, speed, fade) {
    const c = this.char, e = c.clips && c.clips.get(name), base = (e && e.speed) || 1;
    this.anim = name;
    return (this.handle = c.play(name, { at, speed: speed / base, fade, force: true, loop: false }));
  }
  enter(state) {
    const c = this.char;
    if (this.striding) this.unstride();
    if (this.cutting) { this.cutting = false; if (!(this.air > FALL_SKIP && (state === 'hit' || state === 'down' || state === 'dead'))) { c.model.position.y = 0; this.air = 0; } }      // (struck in the falling cut while still up, he falls from where he is: react(), then drop())
    if (this.state === 'attack') this.ctx.combat.disarm(this.weapon);
    if ((this.state === 'block' || this.state === 'heal') && this.hasOverlay && state !== this.state) c.overlayOff(0.15);
    if (this.trailOn && this.trail) { this.trail.stop(); this.trailOn = false; }
    this.state = state; this.t = 0; c.speed = 1; this.armed = false; this.swung = false; this.whooshed = false; this.lieT = 0;
  }
  spend(cost) {
    this.stamina = Math.max(0, this.stamina - cost);
    this.regenWait = Math.max(this.regenWait, this.stamina <= 0 ? FEEL.regenDelayEmpty : FEEL.regenDelay);
    if (this.stamina <= 0) this.ctx.bus.emit('stamina-out', {});
  }

  // ---------------------------------------------------------------- what the buttons start

  /** Start whatever was asked for most recently among what this moment allows. Returns true if something started. */
  act(allow, B = FEEL.buffer) {
    const input = this.ctx.input, st = this.stamina > 0;
    let best = null, when = -Infinity, w;
    if (!st && (input.pressed('roll') || input.pressed('attack') || input.pressed('heavy') || input.pressed('jump'))) this.ctx.bus.emit('stamina-out', REFUSED);     // the interface may flash the bar
    if (allow.roll && st && input.buffered('roll', B) && (w = input.when('roll')) > when) { best = 'roll'; when = w; }
    if (allow.attack && st && input.buffered('attack', B) && (w = input.when('attack')) > when) { best = 'attack'; when = w; }
    if (allow.attack && st && input.buffered('heavy', B) && (w = input.when('heavy')) > when) { best = 'heavy'; when = w; }
    if (allow.heal && this.flasks > 0 && this.hp < this.hpMax && input.buffered('heal', B) && (w = input.when('heal')) > when) { best = 'heal'; when = w; }
    if (allow.jump && st && input.buffered('jump', Math.min(B, FEEL.buffer)) && (w = input.when('jump')) > when) { best = 'jump'; when = w; }      // (a jump is never kept longer than the design's third of a second: a double tap is one jump, not two)
    if (!best) return false;
    if (best === 'jump') return this.startJump();
    if (best === 'roll') return this.startDodge();
    if (best === 'heal') { input.consume('heal'); this.startHeal(); return true; }
    input.consume('attack'); input.consume('heavy');
    this.startAttack(this.pickAttack(best === 'heavy'));
    return true;
  }

  pickAttack(heavy) {
    const fast = this.state === 'sprint' || this.sinceSprint < 0.25;
    if (fast) return heavy ? ATTACKS.runHeavy : ATTACKS.runLight;
    if (heavy) return ATTACKS.heavy;
    if (this.state === 'roll' || this.sinceRoll < 0.12) return ATTACKS.rollLight;
    return ATTACKS[this.chainT > 0 ? this.chain : 'light1'];
  }

  startAttack(def, at = def.at) {
    const boss = this.ctx.boss;
    this.enter('attack'); this.def = def; this.spend(def.cost); this.vel.set(0, 0, 0);
    this.chain = def.next; this.chainT = 0.45;                                 // the chain is kept for 0.45 s after the attack ends
    this.charge = 0; this.charging = !!def.hold; this.lunged = 0;
    // where the swing is aimed: at her when locked on; where the stick points otherwise, pulled onto her when she is near that line
    let aim = this.yaw, onHer = false;
    if (boss && boss.alive) {
      const to = this.yawTo(boss), near = this.gapTo(boss) < 4.5;
      if (this.locked) { aim = to; onHer = true; }
      else { if (this.wish > 0) aim = this.wishYaw; if (near && Math.abs(angleDiff(to, aim)) < 0.75) { aim = to; onHer = true; } }
    } else if (this.wish > 0) aim = this.wishYaw;
    this.aim = aim; this.onHer = onHer; this.aimOff = def.yaw || 0;
    this.play(def.clip, at, def.speed, def.fade);
  }

  /** The roll button. With the stick pushed the dodge starts at once, harmless at once; whether it is a roll (a tap)
   *  or the start of a sprint (still held after FEEL.tap) is settled in dodge(). Without the stick: a backstep. */
  startDodge() {
    const input = this.ctx.input, held = input.held('roll'), heldFor = input.heldFor('roll');
    if (held && heldFor >= FEEL.tap) {                                     // an old hold, not a tap: it means "sprint", and sprinting needs no start
      input.consume('roll'); return false;
    }
    input.consume('roll');
    this.vel.set(0, 0, 0); this.dodged = false;
    if (this.wish <= 0) {                                                  // no direction: hop back
      this.enter('backstep'); this.spend(BACKSTEP.cost); this.iframes = BACKSTEP.iframes;
      this.play(BACKSTEP.clip, BACKSTEP.at, BACKSTEP.speed, BACKSTEP.fade);
      const r = this._roll; r.dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); this.ctx.bus.emit('roll', r);
      return true;
    }
    this.yaw = this.wishYaw;                                               // a roll goes where the stick points, now
    this.enter('dodge'); this.iframes = ROLL.iframes; this.pressT = heldFor;
    this.decided = !held;
    this.play(ROLL.clip, ROLL.at, ROLL.speed, ROLL.fade);
    if (this.decided) this.commitRoll(); else this.char.speed = ROLL.slow;
    return true;
  }
  commitRoll() {
    this.state = 'roll'; this.decided = true; this.char.speed = 1; this.spend(ROLL.cost);
    const r = this._roll; r.dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.ctx.bus.emit('roll', r);
  }

  startHeal() {
    this.enter('heal'); this.flasks--; this.healed = 0; this.vel.multiplyScalar(0.4);
    const c = this.char, e = c.clips && c.clips.get(HEAL.clip), base = (e && e.speed) || 1;
    if (this.hasOverlay) c.overlay(HEAL.clip, { mask: 'upper', fade: HEAL.fade, loop: false, speed: HEAL.speed / base, at: HEAL.at });
    else this.play(HEAL.clip, HEAL.at, HEAL.speed, HEAL.fade);
    this.healLen = (HEAL.end - HEAL.at) / HEAL.speed;
    this.ctx.bus.emit('heal', { flasks: this.flasks });
  }

  // ---------------------------------------------------------------- the jump

  /** The jump button, from wherever a roll may start. He keeps the speed and the heading he has (a running jump covers
   *  ground, a standing one goes straight up); out of a roll with the stick pushed, what walking out of it would keep. */
  startJump() {
    const was = this.state, v = this.vel;
    this.ctx.input.consume('jump');
    if (was === 'roll' && this.wish > 0) v.set(Math.sin(this.yaw) * JUMP.carry, 0, Math.cos(this.yaw) * JUMP.carry);
    if (this.falling) this.grounded();
    this.enter('jump'); this.def = null; this.spend(JUMP.cost);
    this.jumpTop = Math.max(Math.hypot(v.x, v.z), FEEL.walk); this.jt = JUMP.at; this.pushed = false; this.landed = false; this.striding = false;
    this.play(JUMP.clip, JUMP.at, JUMP.gather, JUMP.fade);
    this.jumping(this.ctx.DT);                                             // he goes on over the ground in the step of the press too: a running jump must not hitch
    return true;
  }
  /** One step of a jump: the gather, the air, the first moment on the floor again. (this.jt is the jump clip's own clock,
   *  kept here: the clip is not always the one in front, see `stride`.) */
  jumping(dt) {
    const ctx = this.ctx, c = this.char, J = JUMP, h = this.handle, t = this.jt, v = this.vel, boss = ctx.boss, lock = this.locked && boss && boss.alive;
    // on the way down, his soles as they were posed in the last step say when he is at the water and when he stands (the clip's own times are the fallback)
    const coming = t > J.top, down = t >= J.land || (coming && this.air <= J.touch);
    if (!this.landed && (down || t >= J.splash || (coming && this.air <= J.wet))) {      // his boots meet the water: the game's own `land` (splash, ring, sound), and his knees give
      this.landed = true; const l = this._land; l.hard = false; ctx.bus.emit('land', l);
      if (typeof c.additive === 'function') c.additive(GIVE.clip, { at: GIVE.at, end: GIVE.end, speed: GIVE.speed, weight: this.striding ? GIVE.stride : GIVE.weight, mask: 'lower', fadeIn: GIVE.fadeIn, fadeOut: GIVE.fadeOut });
    }
    if (down) {                                                            // down again: whatever was asked for in the air goes straight off, the stick runs him out of it
      if (this.act(MAY_ALL, FEEL.queue)) return;
      // the speed he lands with is still his: he runs on, or stops as a runner stops. Only a jump on the spot plays the clip's own landing out
      if (t >= J.end || this.striding || this.wish > 0 || ctx.input.held('block')) { const striding = this.striding; this.enter('idle'); if (!striding) { this.anim = ''; this.fadeIn = 0.18; } this.free(dt); return; }
    }
    if (!this.pushed && t >= J.off) {                                      // his feet leave the floor: the water answers the push-off like a running step
      this.pushed = true; if (h) h.timeScale = J.speed;
      const s = this._step; s.foot = this.footSide ? 'l' : 'r'; s.run = true; this.feet = 1.5; this.stride = 0; ctx.bus.emit('step', s);
    }
    // attack or heavy asked for while he is well in the air: the falling cut (with too little air left the press waits for the floor)
    if (this.pushed && !down && t >= CUT.from && t <= CUT.to && this.stamina > 0 && (ctx.input.buffered('attack', FEEL.buffer) || ctx.input.buffered('heavy', FEEL.buffer))) { this.startCut((J.land - t) / J.speed); return; }
    // the ground he covers: the speed he pushed off with; the stick changes it a little (and stops him once he stands again)
    const rate = (down ? FEEL.accel : J.steer) * dt;
    let tx = v.x, tz = v.z;
    if (down) { tx = 0; tz = 0; } else if (this.wish > 0) { const sp = speedFor(this.wish, this.jumpTop); tx = this.wx * sp; tz = this.wz * sp; }
    const dx = tx - v.x, dz = tz - v.z, dl = Math.hypot(dx, dz);
    if (dl <= rate) { v.x = tx; v.z = tz; } else { v.x += dx / dl * rate; v.z += dz / dl * rate; }
    if (lock) this.yaw = turnStep(this.yaw, this.yawTo(boss), FEEL.turnLockEase, FEEL.turnLock, dt);
    const p = this.pos, px = p.x, pz = p.z, was = Math.hypot(v.x, v.z);
    if (was > 1e-6 && this.moveBy(v.x * dt, v.z * dt)) {                   // a wall, a stone or her body takes the speed that ran into it
      const ax = (p.x - px) / dt, az = (p.z - pz) / dt, al = Math.hypot(ax, az), k = al > was ? was / (al || 1) : 1;
      v.x = ax * k; v.z = az * k;
    }
    // Travelling, his legs come out of the tuck into his own stride before he lands. The clip lands standing on the
    // spot: carried over the floor at a run, those two planted feet slid half a metre (tools/tests/jump/feet.mjs). So
    // the walk blend is put in front while he is still coming down, and he lands in his stride. Until his feet are on
    // the floor the blend must not hold one of them still in the world (that is for feet that stand): its foot-plant
    // is off for those few steps, and enter() puts it back as he lands (or is struck).
    if (!this.striding && !down && t >= J.stride && v.x * v.x + v.z * v.z > 0.25) {
      this.striding = true; this.plantWas = c.footPlant; c.footPlant = false;
      // (the clip comes down left foot first: the stride's clock is set so that its left footfall falls where he lands)
      if (this.hasBlend) { const mv = c.play('@move', { fade: J.strideFade }); this.anim = '@move'; if (mv) mv.time = mv.duration - (J.land - t) / J.speed; } else { this.anim = ''; this.fadeIn = J.strideFade; }
    }
    if (this.striding) { this.feet = 1.5; this.legs((p.x - px) / dt, (p.z - pz) / dt, !lock, dt); }
    this.jt = t + dt * (this.pushed ? J.speed : J.gather);
  }
  /** Attack or heavy pressed in the air, `rem` seconds of it left: the falling cut. He keeps the speed he has until he
   *  lands; his hips go on along their own way down (a body's: one fall from where they are to where the clip lands),
   *  and the leaping blow's clip is held under that (cutStep) from the moment in it that leaves as much air as he has. */
  startCut(rem) {
    const d = ATTACKS.jumpCut, c = this.char, v = this.vel, vx = v.x, vz = v.z, input = this.ctx.input;
    input.consume('attack'); input.consume('heavy');
    c.bones.Hips.getWorldPosition(_v); const H = _v.y;
    const at = clamp(CUT.land - rem * d.speed, CUT.first, CUT.last), T = (CUT.land - at) / d.speed;
    this.startAttack(d, at); v.set(vx, 0, vz);                             // (an attack on the floor stands still: this one is in the air)
    // one fall from H to the clip's landing in T seconds, starting with the speed his hips have: its gravity follows (kept between a float and a drop)
    const g = clamp(2 * (H + this.hipV * T - CUT.hips) / (T * T), 6, 40);
    this.cutting = true; this.cutT = T; this.fallH = H; this.fallG = g; this.fallV = (CUT.hips - H + 0.5 * g * T * T) / T;
  }
  /** One step of the falling cut, after the pose: the model is set so that his hips are where their fall has them (the
   *  clip's own are higher: it leaps from a run), his boots never under the floor; as he lands the clip's own fall takes over. */
  cutStep(dt) {
    const c = this.char, m = c.model;
    if (this.state !== 'attack') { this.cutting = false; this.falling = true; this.fallT = 0; this.fallStep(dt); return; }      // the stroke was broken off in the air (his blade met stone): he falls out of it
    this.cutT -= dt; this.fallV -= this.fallG * dt; this.fallH += this.fallV * dt;
    if (this.cutT <= 0) { m.position.y = 0; this.cutting = false; this.air = 0; this.hipV = 0; this.vel.set(0, 0, 0); return; }      // down: from here the clip's own landing carries him
    c.bones.Hips.getWorldPosition(_v);
    m.position.y = (this.fallH - (_v.y - m.position.y)) * Math.min(1, this.cutT / CUT.ease);
    const low = this.soles(); if (low < 0) m.position.y -= low;
  }
  /** His stride has the floor again (or the jump ended some other way): the walk blend may hold his feet as before. */
  unstride() { if (this.striding) { this.striding = false; this.char.footPlant = this.plantWas; } }
  /** How high the soles of his boots are over the floor now: the lowest point of their skin, as he is posed. */
  soles() {
    let low = Infinity; const S = this.soleSkin;
    for (let i = 0; i < S.length; i++) {
      const b = S[i].bone, pts = S[i].pts; b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements, e1 = e[1], e5 = e[5], e9 = e[9], e13 = e[13];
      for (let k = 0; k < pts.length; k += 3) { const y = e1 * pts[k] + e5 * pts[k + 1] + e9 * pts[k + 2] + e13; if (y < low) low = y; }
    }
    if (low === Infinity) return 0;
    const a = this.ctx.arena;
    return low - (a && a.ground ? a.ground(this.pos.x, this.pos.z) : 0);
  }
  /** On the floor, and nothing of a jump is left (a reset, a cutscene takes him). */
  grounded() { this.air = 0; this.hipV = 0; this.unstride(); if (this.falling || this.cutting) { this.falling = false; this.cutting = false; this.char.model.position.y = 0; } }
  /** Struck in the air. The clips of being struck are a man's on the floor: so his body (the drawn model; his place
   *  stays where it is, and with it the lens and her aim) is held up where it was, and comes down as a body falls
   *  while he flinches, reels or is thrown: his hips go on from where they were, on the way down. */
  drop() {
    this.char.bones.Hips.getWorldPosition(_v);
    this.falling = true; this.cutting = false; this.fallT = 0; this.fallH = _v.y; this.fallV = Math.min(0, this.hipV);
  }
  /** One step of that fall, after the pose: the model is set so that his hips are where their fall has them (above the
   *  reaction's pose, which stands on the floor; out of a falling cut, whose clip stands higher than he was, it is
   *  under it for the few steps the two poses take to change places). Over when the pose stands by itself. */
  fallStep(dt) {
    const c = this.char, m = c.model;
    this.fallT += dt; this.fallV -= FALL_G * dt; this.fallH += this.fallV * dt;
    c.bones.Hips.getWorldPosition(_v);
    const lift = this.fallH - (_v.y - m.position.y);                       // (what the pose alone gives his hips, against the height they have fallen to)
    if (lift > 0 || this.fallT < FALL_BLEND) { m.position.y = lift; const low = this.soles(); if (low < 0) m.position.y -= low; return; }      // (his boots never under the floor)
    if (m.position.y < -1e-3) { m.position.y = Math.min(0, m.position.y + 2.5 * dt); if (m.position.y < 0) return; }      // (a pose that still stands higher than he fell, a death's own throw: what is left is let go gently, never at once)
    m.position.y = 0; this.falling = false; this.air = 0; this.hipV = 0;
    if (this.state === 'hit') { const l = this._land; l.hard = false; this.ctx.bus.emit('land', l); }      // on his feet again (thrown down or dead, the body's own fall goes on and the water answers it)
  }

  // ---------------------------------------------------------------- being hit

  /** A blow is offered (docs/engine.md, "Combat"). Returns false to refuse it. hit.knockdown throws him down;
   *  hit.unblockable goes through the shield. */
  takeHit(hit) {
    if (!this.alive || this.god || this.puppet) return false;
    if (this.invulnerable) { if (this.state === 'dodge') this.dodged = true; return false; }
    if (this.air > 0 && hit.kind && FLOOR[hit.kind] !== undefined && this.air > FLOOR[hit.kind]) return false;      // in the air, over it: her light and her water run along the floor (a blade is a volume, and is tried against his body wherever it is)
    const src = hit.attacker && hit.attacker.pos, bus = this.ctx.bus, up = this.air > FALL_SKIP;      // up: struck in the air (he comes down as the blow leaves him)
    // where the blow comes from: the attacker for a blade, against its own travel for a wave or a ring
    let from = this.yaw + Math.PI;
    if (hit.weapon && src) from = Math.atan2(src.x - this.pos.x, src.z - this.pos.z);
    else if (hit.dir && (hit.dir.x || hit.dir.z)) from = Math.atan2(-hit.dir.x, -hit.dir.z);
    else if (src) from = Math.atan2(src.x - this.pos.x, src.z - this.pos.z);
    const front = Math.abs(angleDiff(from, this.yaw)) < FEEL.blockArc;
    // the push: along the blow, and away from her
    const push = this.push; push.set(0, 0, 0);
    if (hit.dir) push.set(hit.dir.x, 0, hit.dir.z);
    if (src) { _v.set(this.pos.x - src.x, 0, this.pos.z - src.z); if (_v.lengthSq() > 1e-6) push.addScaledVector(_v.normalize(), push.lengthSq() > 0.01 ? 0.8 : 1); }
    if (push.lengthSq() < 1e-6) push.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); push.normalize(); this.pushDir.copy(push);

    if (this.blocking && this.stamina > 0 && front && !hit.unblockable) {
      hit.blocked = true;
      const cost = hit.damage * (hit.heavy ? FEEL.blockCostHeavy : FEEL.blockCost);
      hit.damage = hit.heavy ? Math.max(0, Math.min(this.hp - 1, hit.damage * FEEL.chip)) : 0;          // a little chips through a heavy blow; it never kills
      this.hp -= hit.damage;
      this.stamina = Math.max(0, this.stamina - cost); this.regenWait = Math.max(this.regenWait, FEEL.regenDelay + 0.2);
      if (this.stamina <= 0) {                                             // the guard breaks
        this.react(BREAK, 'stagger'); this.regenWait = FEEL.regenDelayEmpty; bus.emit('stamina-out', {}); hit.guardBreak = true;
        if (typeof this.char.additive === 'function') this.char.additive('block_hit', { weight: 0.8, speed: 1.2 });      // the shield is beaten aside first
        this.blowFrom = from; this.turnT = TURN_TO_BLOW;
      } else {
        push.multiplyScalar(hit.heavy ? 2.6 : 1.3); this.blockHit = 0.3;
        const c = this.char;
        if (typeof c.additive === 'function') c.additive('block_hit', { weight: 1, speed: 1.3 });
        else if (!this.hasOverlay) { this.play('block_hit', 0.02, 1.3, 0.05); this.anim = 'block_hit'; }
      }
      return true;
    }
    this.hp = Math.max(0, this.hp - hit.damage);
    const behind = Math.abs(angleDiff(from, this.yaw)) > 2.2;             // struck from behind: he goes down on his face, he is not spun round
    if (this.hp <= 0) {
      // he falls the way he was struck: thrown back by a blow he faced (flung, if it was one of her great ones), onto his face by one from behind
      this.alive = false; this.enter('dead'); this.vel.set(0, 0, 0); push.multiplyScalar(DEATH.push); this.rdef = DEATH;
      if (this.hasOverlay) this.char.overlayOff(0.1);
      const flung = hit.knockdown || hit.weight === 'colossal' || hit.damage >= FEEL.knockdown;
      if (behind) this.play('death_fwd', DEATH.fwd, 1.3, 0.12);
      else { this.blowFrom = from; this.turnT = TURN_TO_BLOW; this.play(flung ? 'death_fly' : 'death_back', flung ? DEATH.fly : DEATH.back, 1, 0.1); }
      if (up) this.drop();
      return true;
    }
    if (hit.knockdown || hit.damage >= FEEL.knockdown) { this.react(FALL, 'down'); this.safe = true; this.blowFrom = from; this.turnT = TURN_TO_BLOW; }
    else if (hit.heavy || hit.damage >= FEEL.flinchHeavy) { this.react(FLINCH_BIG, 'hit'); if (!behind) { this.blowFrom = from; this.turnT = TURN_TO_BLOW; } }
    else {
      // a light blow: which flinch, by where it landed and which way it was travelling (his own frame: +left)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), d = hit.dir, side = d ? d.x * cy - d.z * sy : 0, along = d ? d.x * sy + d.z * cy : -1;
      const high = (hit.point && hit.point.y - this.pos.y > 1.3) || (d && d.y < -0.6);
      this.react(high ? FLINCH_HEAD : Math.abs(side) > Math.abs(along) * 0.7 ? (side > 0 ? FLINCH_SIDE : FLINCH_HEAD) : FLINCH, 'hit');
    }
    this.iframes = Math.max(this.iframes, FEEL.mercy);
    if (up) this.drop();
    return true;
  }
  /** For looking at his reactions: a blow out of nowhere. &do=player.testHit(30,true)@1 ; (45,true,true) throws him down.
   *  fromDeg: where it comes from, in degrees off his nose (0 = in front, 90 = his left, 180 = behind; left out: from her);
   *  height: how high on him it lands (metres). &do=player.testHit(12,false,false,-90,1.0)@1 */
  testHit(damage = 30, heavy = true, knockdown = false, fromDeg, height = 1.1) {
    const boss = this.ctx.boss;
    if (typeof fromDeg !== 'number') return this.ctx.combat.strike({ attacker: boss, target: this, damage, heavy, knockdown });
    const a = this.yaw + fromDeg * Math.PI / 180, sx = Math.sin(a), sz = Math.cos(a);
    return this.ctx.combat.strike({ attacker: { pos: new THREE.Vector3(this.pos.x + sx * 3, 0, this.pos.z + sz * 3), char: boss.char }, target: this, damage, heavy, knockdown, weapon: {},
      dir: new THREE.Vector3(-sx, 0, -sz), point: new THREE.Vector3(this.pos.x + sx * 0.25, this.pos.y + height, this.pos.z + sz * 0.25) });
  }
  react(r, state) {
    this.enter(state); this.def = null; this.rdef = r; this.vel.set(0, 0, 0); this.push.multiplyScalar(r.push);
    if (this.hasOverlay) this.char.overlayOff(0.08);
    this.play(r.clip, r.at, r.speed, r.fade);
  }

  /** Combat says: his live blade has met stone (a pier, a fallen block) or the floor. Stone throws it back: the swing
   *  is taken back to the moment before it entered, runs backward for a tenth of a second, and he needs a moment
   *  before he can act. The floor only stops the point (keepBladeUp): the heavy blows are meant to end there. */
  bladeStopped(info) {
    const ctx = this.ctx, c = this.char;
    if (info.floor) {
      if (ctx.vfx && ctx.vfx.spray) ctx.vfx.spray(info.point, UP, this.def && this.def.heavy ? 16 : 8, this.def && this.def.heavy ? 0.9 : 0.5);
      if (ctx.water && ctx.water.ripple) ctx.water.ripple(info.point.x, info.point.z, this.def && this.def.heavy ? 1.2 : 0.6, 0.4);
      return;
    }
    if (this.state !== 'attack' || !this.handle) return;
    if (this.cutting) {                                                    // in the falling cut, still in the air: the blade rings off the stone and he comes down out of his stroke (no springing back along a path he is falling out of)
      ctx.combat.disarm(this.weapon); this.armed = false;
      this.push.set(info.normal.x, 0, info.normal.z); this.pushDir.copy(this.push); this.react(FLINCH, 'hit'); this.drop();
      if (ctx.game && ctx.game.hitStop) ctx.game.hitStop(0.06); if (ctx.input.rumble) ctx.input.rumble(0.5, 0.7, 0.12);
      return;
    }
    const h = this.handle, d = this.def;
    ctx.combat.disarm(this.weapon); this.armed = false;
    if (this.trailOn && this.trail) { this.trail.stop(); this.trailOn = false; }
    // back to where the blade was still free, and show that pose in this very step (the picture never has it in the stone)
    h.time = this.clipPrev + (h.time - this.clipPrev) * Math.max(0, Math.min(1, info.u)); h.timeScale = -Math.abs(h.timeScale) * 0.55;
    c.update(0);
    this.state = 'recoil'; this.t = 0; this.charging = false; this.charge = 0; this.vel.set(0, 0, 0);
    this.push.set(info.normal.x, 0, info.normal.z).multiplyScalar(1.1);    // and it sets him back a little
    if (typeof c.additive === 'function') c.additive('block_hit', { weight: d && d.heavy ? 0.8 : 0.55, speed: 1.3 });
    if (ctx.game && ctx.game.hitStop) ctx.game.hitStop(d && d.heavy ? 0.08 : 0.05);
    if (ctx.input.rumble) ctx.input.rumble(0.5, 0.7, 0.12);
  }
  /** After the pose, before what he carries is placed: the wrist keeps the point of the blade out of the floor
   *  (the heavy blow ends 13 cm under it in the clip; thrown down or dead, the clips stand the blade 0.6 m deep in the
   *  stone). The blade rides on the floor instead: turned the short way to where it just touches, heading as it was
   *  heading over the ground, or, if it stood on its point, away from his body. */
  keepBladeUp() {
    const sw = this.kit.sword, hand = this.char.bones.RightHand; if (!sw || !hand || this.kit.sheathed) return;
    sw.tip.getWorldPosition(_tip);
    const a = this.ctx.arena, floor = (a && a.ground ? a.ground(_tip.x, _tip.z) : 0) + SOLID.floor, st = this.state;
    hand.getWorldPosition(_hand);
    // lying (thrown down, dead, the first of getting up) the fist is slack: the blade lies on the floor beside him
    // (the clips leave it standing straight up out of his hand, or through his chest)
    const slack = st === 'down' || st === 'dead' || st === 'getup' ? clamp((0.5 - (_hand.y - floor)) / 0.25) : 0;
    if (_tip.y >= floor && slack <= 0) return;
    _d3.subVectors(_tip, _hand); const len = _d3.length(); if (len < 1e-4) return; _d3.divideScalar(len);
    const flat = Math.hypot(_d3.x, _d3.z), w = clamp((flat - 0.1) / 0.25) * (1 - slack);      // how far its own heading over the ground counts
    let hx = flat > 1e-4 ? _d3.x / flat : 0, hz = flat > 1e-4 ? _d3.z / flat : 0;
    if (w < 1) {                                                           // (nearly) on its point, or slack: lay it down away from him
      let fx = _hand.x - this.pos.x, fz = _hand.z - this.pos.z; const fl = Math.hypot(fx, fz);
      if (fl > 0.05) { fx /= fl; fz /= fl; } else { fx = Math.sin(this.yaw); fz = Math.cos(this.yaw); }
      hx = hx * w + fx * (1 - w); hz = hz * w + fz * (1 - w);
    }
    const hl = Math.hypot(hx, hz); if (hl < 1e-4) return;
    const e = Math.asin(clamp((floor - _hand.y) / len, -1, 1)), ce = Math.cos(e);
    _ax.set(hx / hl * ce, Math.sin(e), hz / hl * ce);                      // where the blade has to point to lie on the floor
    _q1.setFromUnitVectors(_d3, _ax);
    if (_tip.y >= floor && slack < 1) _q1.slerp(_q3.identity(), 1 - slack);      // not under the floor: only as far as the fist is slack
    hand.parent.getWorldQuaternion(_q2); _q3.copy(_q2).invert().multiply(_q1).multiply(_q2).multiply(hand.quaternion); hand.quaternion.copy(_q3);
    hand.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- one step

  update(dt) {
    const ctx = this.ctx, c = this.char, input = ctx.input, boss = ctx.boss;
    if (this.puppet) {
      if (!this._wasPuppet) {                                              // a cutscene takes him: whatever he was doing ends cleanly
        this._wasPuppet = true; c.speed = 1; ctx.combat.disarm(this.weapon); if (this.trailOn && this.trail) { this.trail.stop(); this.trailOn = false; }
        if (this.hasOverlay) c.overlayOff(0.1); if (this.gazing) { c.look(null); this.gazing = false; }
        this.grounded();
      }
      const m = c.update(dt); if (this.puppet === 'root') this.applyMotion(m); this.kit.update(dt); return;
    }
    if (this._wasPuppet) {                                                 // a cutscene had him: take him back as he stands
      this._wasPuppet = false; c.speed = 1; ctx.combat.disarm(this.weapon); this.vel.set(0, 0, 0); this.push.set(0, 0, 0); this.iframes = this.afterPuppet || 0; this.afterPuppet = 0; this.safe = false;
      if (this.alive) { this.state = 'idle'; this.anim = ''; this.fadeIn = 0.3; for (const a of ['attack', 'heavy', 'roll', 'heal', 'jump']) input.consume(a); }
    }
    this.t += dt; if (this.iframes > 0) this.iframes = Math.max(0, this.iframes - dt);
    this.readSolids(); this.shoveLeft = SOLID.shove;
    // lying down (thrown down, dead) his body takes more room, so it never lies through a stone or her feet
    { const lying = this.state === 'dead' || this.state === 'down' ? clamp((this.t - 0.25) / 0.5) : this.state === 'getup' ? 1 - clamp(this.t / 0.5) : 0, want = lerp(this.radius, SOLID.lie, lying); this.room += clamp(want - this.room, -1.6 * dt, 1.6 * dt); }
    if (this.turnT > 0) { this.turnT -= dt; this.yaw = turnStep(this.yaw, this.blowFrom, 16, 12, dt); }      // a heavy blow turns him to face it: he reels away from it
    if (this.state !== 'attack') this.chainT -= dt; this.sinceSprint += dt; this.sinceRoll += dt; if (this.blockHit > 0) this.blockHit -= dt;
    this.readStick();
    const st = this.state, px = this.pos.x, pz = this.pos.z;

    // ---- what the state he is in lets the buttons and the stick do
    if (st === 'idle' || st === 'move' || st === 'sprint' || st === 'block') this.free(dt);
    else if (st === 'dodge') {
      this.pressT += dt;
      if (!input.held('roll') || this.dodged) this.commitRoll();           // let go in time (or a blow went through him): it is a roll
      else if (this.pressT >= FEEL.tap) {                                  // still held: it was the start of a sprint all along
        if (this.wish > 0 && this.stamina > 0) {
          this.iframes = 0; this.enter('sprint'); this.fadeIn = 0.16; this.anim = '';
          this.vel.set(Math.sin(this.yaw) * FEEL.run, 0, Math.cos(this.yaw) * FEEL.run); this.free(dt);
        } else this.commitRoll();
      }
    } else if (st === 'roll') {
      if (c.time >= ROLL.cancel && this.act(MAY_ALL, FEEL.queue)) this.sinceRoll = 0;
      else if (c.time >= ROLL.end || (c.time >= ROLL.walk && this.wish > 0)) { this.sinceRoll = 0; this.exitTo(dt, 3.6); }
    } else if (st === 'backstep') {
      if (c.time >= BACKSTEP.cancel && this.act(MAY_ALL, FEEL.queue)) { /* started */ }
      else if (c.time >= BACKSTEP.end || (c.time >= BACKSTEP.walk && this.wish > 0)) this.exitTo(dt, 0);
    } else if (st === 'jump') {
      this.jumping(dt);
    } else if (st === 'attack') {
      const d = this.def, t = c.time;
      if (t >= d.chain && this.act(MAY_CUT, FEEL.queue)) { /* the next cut of the chain */ }
      else if (t >= d.recover && this.act(MAY_LEAVE, FEEL.queue)) { /* rolled or drank out of the recovery */ }
      else if (t >= d.recover && input.held('block')) this.exitTo(dt, 0);
      else if (t >= d.end || (t >= d.walk && this.wish > 0)) this.exitTo(dt, 0);
      else {
        if (this.cutting) {                                               // the falling cut, still in the air: the speed he jumped with carries him (a wall, a stone or her body takes it)
          const v = this.vel, p = this.pos, qx = p.x, qz = p.z, was = Math.hypot(v.x, v.z);
          if (was > 1e-6 && this.moveBy(v.x * dt, v.z * dt)) { const ax = (p.x - qx) / dt, az = (p.z - qz) / dt, al = Math.hypot(ax, az), k = al > was ? was / (al || 1) : 1; v.x = ax * k; v.z = az * k; }
        }
        this.swing(dt, d, t);
      }
    } else if (st === 'recoil') {
      const h = this.handle;
      if (h && this.t >= RECOIL.back && h.timeScale < 0) h.timeScale = 0;  // sprung back: held
      if (this.t >= RECOIL.free && this.act(MAY_LEAVE, FEEL.queue)) { /* rolled or drank out of it */ }
      else if (this.t >= RECOIL.end || (this.t >= RECOIL.free && (this.wish > 0 || input.held('block')))) this.exitTo(dt, 0);
    } else if (st === 'heal') {
      // the flask works over about a second; a blow before it is done loses the rest
      const due = this.rules.heal * clamp((this.t - HEAL.from) / (HEAL.to - HEAL.from));
      if (due > this.healed) { this.hp = Math.min(this.hpMax, this.hp + (due - this.healed)); this.healed = due; }
      if (this.t >= this.healLen) this.exitTo(dt, FEEL.healWalk);
      else if (this.hasOverlay) this.locomote(dt, FEEL.healWalk, this.locked && boss && boss.alive ? 'boss' : 'stick');
    } else if (st === 'hit' || st === 'stagger') {
      if (c.time >= this.rdef.end && !this.act(MAY_ALL)) this.exitTo(dt, 0);
    } else if (st === 'down') {
      if (c.time >= FALL.end) { this.lieT += dt; if (this.lieT >= FALL.lie) { this.enter('getup'); this.safe = true; this.play(GETUP.clip, GETUP.at, GETUP.speed, GETUP.fade); } }
    } else if (st === 'getup') {
      if (c.time >= GETUP.end) { this.safe = false; this.iframes = FEEL.graceUp; if (!this.act(MAY_ROLL)) this.exitTo(dt, 0); }
    }

    // ---- the pose, then the travel the clip carries (scaled by what the state he is in NOW says)
    this.clipPrev = this.handle ? this.handle.time : 0;
    const m = c.update(dt), s2 = this.state;
    if (this.cutting) this.cutStep(dt);                                    // the falling cut: his hips go their own way down, the clip under them
    else if (this.falling) this.fallStep(dt);                              // struck in the air: his body comes down under the pose
    if (s2 === 'jump' || this.falling || this.cutting) {                                   // in the air: how high his soles are, and how fast his hips rise or fall (the floor's attacks ask the first, a blow in the air the second)
      this.air = Math.max(0, this.soles()); c.bones.Hips.getWorldPosition(_v); this.hipV = this.hipY > 0 ? (_v.y - this.hipY) / dt : 0; this.hipY = _v.y;
    } else if (this.air !== 0 || this.hipY !== 0) { this.air = 0; this.hipY = 0; this.hipV = 0; }
    this.keepBladeUp();
    if (s2 === 'dodge' || s2 === 'roll') this.applyMotion(m, 0, this.rollScale);
    else if (s2 === 'backstep') this.applyMotion(m, 0, BACKSTEP.scale);
    else if (this.cutting) { /* in the air the cut's own leap is not taken: he has his speed */ }
    else if (s2 === 'attack' || s2 === 'recoil') this.applyMotion(m, this.def ? this.def.x : 1, this.def ? this.def.z : 1);
    else if (s2 === 'getup') this.applyMotion(m);
    else if (s2 === 'hit' || s2 === 'stagger' || s2 === 'down' || s2 === 'dead') {
      // a stagger's own steps carry him along the blow, whichever way he was facing
      const d = Math.hypot(m.x, m.z) * (this.rdef ? this.rdef.travel : 1);
      if (d > 0) this.moveBy(this.pushDir.x * d, this.pushDir.z * d);
    }
    const pu = this.push;                                                  // the shove of a blow, dying away
    if (pu.x * pu.x + pu.z * pu.z > 1e-4) {
      const qx = this.pos.x, qz = this.pos.z, was = Math.hypot(pu.x, pu.z);
      if (this.moveBy(pu.x * dt, pu.z * dt)) {                             // a wall, a stone or her leg stops it: it does not push on
        const ax = (this.pos.x - qx) / dt, az = (this.pos.z - qz) / dt, al = Math.hypot(ax, az), k = al > was ? was / (al || 1) : 1;
        pu.x = ax * k; pu.z = az * k;
      }
      const k = Math.exp(-7.5 * dt); pu.x *= k; pu.z *= k;
    }
    this.collide();                                                        // she may have walked into him as he stood, lay or swung
    this.speed = Math.hypot(this.pos.x - px, this.pos.z - pz) / dt;         // what he actually covered, whatever carried him
    this.kit.update(dt);
    this.keepBladeUp();                                                    // once more: the kit turns the blade in his fist to keep it out of his own body, and may have put it back in the floor (getting up)

    // ---- stamina
    const sprinting = this.state === 'sprint';
    if (sprinting) { this.stamina = Math.max(0, this.stamina - FEEL.sprintDrain * dt); this.regenWait = Math.max(this.regenWait, 0.35); if (this.stamina <= 0) { this.sprintOut = true; ctx.bus.emit('stamina-out', {}); } this.sinceSprint = 0; }
    if (this.regenWait > 0) this.regenWait -= dt;
    else if (this.alive && this.stamina < this.staminaMax && this.state !== 'attack' && this.state !== 'roll' && this.state !== 'dodge' && this.state !== 'backstep' && this.state !== 'jump')
      this.stamina = approach(this.stamina, this.staminaMax, (this.state === 'block' ? FEEL.regenBlock : FEEL.regen) * dt);
    // his head follows her (the look-at keeps the vector and reads it every step)
    if (typeof c.look === 'function') {
      const on = !!(boss && boss.alive && this.alive);
      if (on) { const hb = boss.char && boss.char.bones && boss.char.bones.Head; if (hb) hb.getWorldPosition(this.gaze); else this.gaze.set(boss.pos.x, 5.8, boss.pos.z); }
      if (on !== this.gazing) { this.gazing = on; c.look(on ? this.gaze : null, { weight: 0.8, speed: 5 }); }
    }
    // his lantern gathers with a held blow
    if (this.kit.lantern) { const want = this.state === 'attack' && this.charge > 0 ? 1 + 0.9 * clamp(this.charge / 0.9) : 1; this.lit += (want - this.lit) * Math.min(1, dt * 10); this.kit.lantern.level = this.lit; }
  }

  /** On his feet and free: walk, run, sprint, raise the shield; start what the buttons ask for. */
  free(dt) {
    const ctx = this.ctx, input = ctx.input, boss = ctx.boss, lock = this.locked && boss && boss.alive;
    if (this.act(MAY_ALL)) return;
    if (!input.held('roll')) this.sprintOut = false;
    const sprint = input.held('roll') && input.heldFor('roll') >= FEEL.tap && this.wish > 0.5 && this.stamina > 0 && !this.sprintOut;
    const block = input.held('block') && !sprint;
    const c = this.char;
    if (block) {
      if (this.state !== 'block') {
        this.state = 'block'; this.t = 0;
        if (this.hasOverlay) c.overlay('block_idle', { mask: 'upper', fade: 0.1, loop: true }); else { this.anim = 'block_idle'; c.play('block_idle', { fade: 0.1 }); }
      }
      if (this.hasOverlay) this.locomote(dt, FEEL.blockWalk, lock ? 'boss' : 'stick');
      else {                                                               // no layers yet: he stands behind the shield and turns
        this.vel.set(0, 0, 0); this.speed = 0;
        if (lock) this.yaw = turnStep(this.yaw, this.yawTo(boss), FEEL.turnLockEase, FEEL.turnLock, dt);
        else if (this.wish > 0) this.yaw = turnStep(this.yaw, this.wishYaw, FEEL.turnEase, FEEL.turn * 0.6, dt);
        if (this.anim !== 'block_idle' && !(this.blockHit > 0)) { this.anim = 'block_idle'; c.play('block_idle', { fade: 0.15 }); }
      }
      return;
    }
    if (this.state === 'block') { this.state = 'idle'; if (this.hasOverlay) c.overlayOff(0.15); else { this.anim = ''; this.fadeIn = 0.15; } }
    if (sprint) { this.state = 'sprint'; this.locomote(dt, FEEL.sprint, 'stick'); return; }
    this.locomote(dt, FEEL.run, lock ? 'boss' : 'stick');
    this.state = this.wish > 0 || this.speed > 0.3 ? 'move' : 'idle';
  }

  /** Leave an action for the ground: straight into a walk if the stick is pushed, with some of the speed kept. */
  exitTo(dt, carry) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.enter('idle'); this.def = null; this.safe = false; this.anim = ''; this.fadeIn = 0.2;
    if (carry > 0 && this.wish > 0) this.vel.set(sy * carry, 0, cy * carry); else this.vel.set(0, 0, 0);
    this.free(dt);
  }

  /** An attack under way: the turn-in, the held blow, the blade's window. */
  swing(dt, d, t) {
    const ctx = this.ctx, c = this.char, boss = ctx.boss, input = ctx.input;
    // turn toward the aim at the start; with her as the aim, keep following her (more slowly) until just before the cut
    if (this.onHer && boss && boss.alive) this.aim = this.yawTo(boss);
    const early = this.t < 0.2, before = t < d.hit[0] - 0.06;
    if (early) this.yaw = turnStep(this.yaw, this.aim + this.aimOff, 22, 12, dt);
    else if (before && this.onHer) this.yaw = turnStep(this.yaw, this.aim + this.aimOff, 10, 3.5, dt);
    // a held heavy: wait at the drawn-back pose while the button is down (up to 0.9 s), the blow growing
    if (d.hold && this.charging) {
      if (t >= d.hold) {
        if (input.held('heavy') && this.charge < 0.9) { c.speed = 0.05; this.charge += dt; if (this.charge >= 0.9) ctx.bus.emit('charge', { full: true }); }
        else { c.speed = 1; this.charging = false; }
      }
    }
    // carried in when she is just out of reach
    if (this.onHer && boss && boss.alive && before && !(d.hold && c.speed < 1)) {
      const gap = this.gapTo(boss);
      if (gap > 0.12 && gap < FEEL.lungeMax + 0.12 && this.lunged < FEEL.lungeMax && Math.abs(angleDiff(this.aim + this.aimOff, this.yaw)) < 0.5) {
        const stepIn = Math.min(gap - 0.1, FEEL.lunge * dt, FEEL.lungeMax - this.lunged);
        this.moveBy(Math.sin(this.aim) * stepIn, Math.cos(this.aim) * stepIn); this.lunged += stepIn;
      }
    }
    // The air before the blade: told a moment before the stroke goes live (0.11 s, a heavy one 0.16), so that the sound of
    // it can swell and be at its height as the blade arrives. Until 9 Nov the whoosh began WITH the stroke and was
    // loudest 0.16 s later: after the blade had already struck her (the blow lands 0.02 to 0.2 s into the stroke).
    // Only the sound listens to this; it changes nothing else.
    if (!this.whooshed && t >= d.swing - (d.heavy ? 0.16 : 0.11) * (d.speed || 1)) { this.whooshed = true; const s = this._swing; s.heavy = !!d.heavy; ctx.bus.emit('whoosh', s); }
    if (!this.swung && t >= d.swing) {
      this.swung = true; const s = this._swing; s.heavy = !!d.heavy; ctx.bus.emit('swing', s); if (this.trail) { this.trail.start(); this.trailOn = true; }
    }
    if (!this.armed && t >= d.hit[0] && t < d.hit[1]) {
      this.armed = true;
      const k = d.charged ? clamp(this.charge / 0.9) : 0;
      ctx.combat.arm(this.weapon, { damage: d.charged ? lerp(d.damage, d.charged.damage, k) : d.damage, poise: d.charged ? lerp(d.poise, d.charged.poise, k) : d.poise, heavy: !!d.heavy });
    } else if (this.armed && t >= d.hit[1]) { this.armed = false; ctx.combat.disarm(this.weapon); }
    if (this.trailOn && t >= d.hit[1] + 0.06) { this.trail.stop(); this.trailOn = false; }
  }

  dispose() {
    if (this.offClip) this.offClip();
    this.ctx.combat.removeWeapon(this.weapon); this.kit.dispose(); this.char.dispose();
  }
}
