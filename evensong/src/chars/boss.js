// Ondine, Cantor of the Drowned Choir: the boss.
//
// This file is her mind and her body's rules: a duellist's footwork between blows, the choice of the next move, the
// playing of a move part by part (boss_moves.js is the table), poise and the stagger, the change of phase, dying.
// What she fights with that is not a body (rings, blades of light, the wave) is boss_fx.js.
//
// The surface the others use (docs/engine.md, "Fighters"): char, kit, pos, yaw, hp, hpMax, alive, state, radius,
// invulnerable, takeHit(hit), reset(spawn), applyMotion(m), puppet, phase, enterPhase(n), poise, staggered, name, ai.
// Beyond it (docs/modules/boss.md): forceMove(name), moveName, stage, fx (what is loose in the hall), lightLevel.
//
// She is 3.67 times a man and her clips are a man's: a level cut at her waist passes metres over the pilgrim's head.
// So the moves are built from the strokes that do come down to him, and each has an `aim`: where in her own frame
// the clip's own stroke lands. She turns her WHOLE BODY to put him there. The blade is never aimed by her wrist: it
// lies in both fists by the measured hold (docs/grips.md) and goes where Mixamo's great-sword clips carry it. After
// the pose (applyPosture) only this is added: a lean of the whole body and the sword arm lowered from the shoulder
// where a move asks for it (the lunge, the Tide), and the floor: a blade is a solid thing, so where a stroke would
// carry its point under the floor the point rides ON it (the wrist gives 15 degrees, both arms the rest).
//
// Solid bodies (docs/impact.md): `solid` is her body as capsules in the world, for the pilgrim's push-out; she moves
// in sub-steps, held off walls by a radius that grows with her open wings, and never comes to stand on him.
//
// Nothing here uses Math.random(): one generator, rng(game.seed + 17), reseeded in reset(), decides everything.
import * as THREE from 'three';
import { Character } from './character.js';
import * as clipdata from './clipdata.js';
import * as wardrobe from './wardrobe.js';
import { MOVES, ORDER, STOMP, DAMAGE, timeline } from './boss_moves.js';
import { rulesFor } from '../core/rules.js';
import { BossFx, COLORS } from './boss_fx.js';
import { angleDiff, clamp, damp, lerp, rng, smooth } from '../core/math.js';
import { BOSS_HEIGHT, WATER_Y } from '../core/constants.js';

export const ASSETS = Object.assign({}, wardrobe.ASSETS || {}, { cantor: 'assets/models/cantor.glb', 'cantor.clips': 'assets/models/cantor.clips.glb' });
export { MOVES, ORDER as MOVE_NAMES };

const POISE = 130;                      // enough damage in a short time and she drops to one knee
const POISE_WAIT = 2, POISE_BACK = 8;   // seconds without being struck before her poise starts to come back, and how fast (a second)
const STAGGER_TIME = 3.2;               // on one knee, taking more
const STAGGER_HURT = 1.3;
const STAGGER_REST = 12;                // after she has risen she cannot be staggered again for this long
const PRESSED = 30, PRESS_EBB = 9;       // `pressed`: the damage he has just done her from at her feet (it ebbs by 9 a second); over 30 (two cuts in quick succession) she is pressed: shorter rests, the stomp and the round stroke come back sooner
const ARMOUR = 0.3;                     // a blow that lands while she winds up or strikes takes only this share of its poise: her poise is broken by punishing her openings, not by trading blows with her
const WALK = { f: 2.9, b: 2.2, s: 2.5 };          // how fast she walks forward, backward, sideways (metres a second)
const GROUND = { walk_f: 4.08, walk_b: 3.17, walk_l: 3.7, walk_r: 4.46 };   // what her walk clips cover at speed 1 (measured; clipdata's figure is used when it has one)
const TURNS = { turn_180: -3.18, turn_l: 1.58, turn_r: -1.71 };             // what the pivot clips turn (radians, + = to her left)
// (phase two: her wind-ups run `quick` times faster; her rests are `rest` times the lengths in breathe(): numbers of difficulty, src/core/rules.js)
const RIDE = 0.06;                      // where her blade's point rides when a stroke meets the floor: on the stone, under the water's skin
const WRIST = 0.26;                     // the most her wrist gives to keep the point on the floor (15 degrees); both arms give the rest from the shoulders
const STEP = 0.3;                       // she never moves further than this without asking the hall and the pilgrim (metres): nothing is jumped
const WALL = [2.2, 3.5];                // how far her centre keeps from the walls: wings folded, wings open (they reach 4.5 m to each side; the piers stand 2 m behind the walls)
const HIS = 0.38;                       // the pilgrim's own radius
// Her blade and the hall's stone (docs/impact.md, Part 1, lines 2 and 4). A blade is a solid thing: she does not choose
// a stroke whose arc would cross a pier, a door leaf, an end wall or a fallen stone (each move carries the ground its
// blade sweeps: `reach` in boss_moves.js), she steps to open ground instead; and where the blade meets stone all the
// same (he has drawn her round, a stroke was forced) it stops there: a clash, a recoil, an opening.
const PIER_R = 1.0;                     // a pier of the arcade with its shafts, as her blade meets it (the play area's wall is 2 m inside the piers' line)
const ARC_CLEAR = 0.35;                 // how far her blade keeps from stone when she chooses where to cut (metres)
const BINS = 24, BIN = Math.PI * 2 / BINS;      // `reach` is given every 15 degrees of her own frame (0 = ahead, + = her left)
const WEST = 21.0, EAST = -20.8;        // the doors' wall and the organ's case, as planes across the nave (z)
const LEAVES = [{ x: 2.44, z: 19.9, r: 1.35 }, { x: -3.1, z: 19.9, r: 1.35 }];     // the two door leaves standing open into the nave (docs/modules/world.md)
const stoneHeight = (c) => (c.h !== undefined ? c.h : c.r >= 1.4 ? 1.6 : c.r <= 1.0 ? 0.95 : 0.7);      // as combat.js reads the fallen stones for his blade
// Last polish (R3: "the mouth of the lowest pipe passes within a helmet's width of his head, his feet on the hem's rim"):
// measured on her as she stands (tools/tests/lastpolish/hem.mjs), her cloth lies on the water out to 2.3 to 2.9 m behind
// her to either side (105 to 165 degrees off her front) and the mouths of the folded pipes hang 1.2 to 1.9 m up, 2.1 to
// 2.9 m behind her and up to 1.6 m to either side: at a man's head. Two more low capsules, one down each side of the
// train, from beside her heels to the pipes' mouths. Her flanks (90 degrees) are as they were: his cuts reach her from there.
const HEM = { lat: [1.25, 1.1], back: [1.0, 2.75], r: 0.7 };
const TRAIN = { from: 1.3, to: 2.75, r: 0.95 };      // her train lies on the water from her heels to 3.2 m behind her middle, and the lowest pipes of her folded wings end at a man's head height over it: a low capsule behind her, this far back, this wide
const BLOCKED_REST = 0.55;              // ... and when that was the move's last stroke she holds this long where the board stopped her before she stands (he has that opening)
const PRESS_ON = 0.05;                  // last polish: a falling stroke that has struck him stays on him this long (its fall slowed) while its solid blade knocks him out from under it
const BOUNCE_FALL = 0.5, FALL_REST = 0.75;      // last polish: a FALLING stroke (the cleave, the leap's blade) stopped by his shield is spent like any other: it is thrown back up over her head for this long and she holds it there for this long; it does not fall a second time on the man who stopped it, and no slam is told (nothing strikes the floor)
const BOUNCE = 0.15;                    // a light cut stopped by his shield: the blade springs back off the board for this long, and the rest of that cut is not played
const RECOIL = { back: 0.16, end: 1.05, stop: 0.1 };      // her blade met stone: it springs back for so long, she is open until `end`, the world holds for `stop`
// her body as the pilgrim meets it: [name, bone, bone, radius in her own units (a 1.8 m figure's)]. Only what can come down to a man's height.
const SOLID = [['shinL', 'LeftLeg', 'LeftFoot', 0.105], ['shinR', 'RightLeg', 'RightFoot', 0.105], ['footL', 'LeftFoot', 'LeftToeBase', 0.085], ['footR', 'RightFoot', 'RightToeBase', 0.085],
  ['thighL', 'LeftUpLeg', 'LeftLeg', 0.13], ['thighR', 'RightUpLeg', 'RightLeg', 0.13], ['body', 'Hips', 'Spine2', 0.2], ['armL', 'LeftForeArm', 'LeftHand', 0.07], ['armR', 'RightForeArm', 'RightHand', 0.07]];
const UP = new THREE.Vector3(0, 1, 0);

const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
const _ax = new THREE.Vector3(), _d = new THREE.Vector3();
const _q2 = new THREE.Quaternion(), _pw = new THREE.Quaternion(), _rot = new THREE.Quaternion();
const _a0 = new THREE.Vector3(), _b0 = new THREE.Vector3(), _sp = new THREE.Vector3(), _sn = new THREE.Vector3();

export class Boss {
  constructor(ctx) {
    this.ctx = ctx; this.name = 'Ondine, Cantor of the Drowned Choir';
    const c = this.char = new Character(ctx, { model: 'cantor', clips: 'cantor.clips', scale: BOSS_HEIGHT / 1.8, data: clipdata.cantor });
    this.root = c.root; this.pos = c.root.position; ctx.scene.add(c.root);
    const R = this.rules = rulesFor(ctx.params);                 // how hard the fight is (src/core/rules.js)
    this.radius = 1.5; this.hpMax = R.herHealth;
    if (ctx.gfx && ctx.gfx.materials && ctx.gfx.materials.character) ctx.gfx.materials.character(c.model, { who: 'boss' });
    const kit = this.kit = wardrobe.dressCantor(ctx, c);
    this.weapon = ctx.combat.addWeapon({ owner: this, base: kit.sword.base, tip: kit.sword.tip, radius: kit.sword.radius || 0.07, damage: 24, heavy: true });
    this.trail = ctx.vfx && ctx.vfx.trail ? ctx.vfx.trail(kit.sword, { look: 'cantor', who: 'boss' }) : null;      // the effects owner's own look for her blade
    this.light = ctx.gfx && ctx.gfx.lights && ctx.gfx.lights.add ? ctx.gfx.lights.add('boss') : null;      // her own gold light, asked for once
    if (this.light) { this.light.intensity = 0; if (this.light.color) this.light.color.setRGB(1, 0.8, 0.46); }
    this.lightPower = 70; this.lightLevel = null;               // lightLevel: null = by her phase; 0..1 = set by a cutscene
    this.fx = new BossFx(ctx, this);

    const B = c.bones;
    this.post = { on: false, stoop: 0, lower: 0, up: 0, spine: [B.Spine, B.Spine1, B.Spine2].filter(Boolean), hand: B.RightHand || null, armR: B.RightArm || null, armL: B.LeftArm || null, bones: [], saved: [] };
    this.post.bones = this.post.spine.concat([this.post.armR, this.post.armL, this.post.hand].filter(Boolean));
    for (let i = 0; i < this.post.bones.length; i++) this.post.saved.push(new THREE.Quaternion());
    // her body as the pilgrim meets it (docs/impact.md): capsules in the world, written every step after her pose
    this.solid = []; this.solidBones = [];
    for (const [name, a, b, r] of SOLID) if (B[a] && B[b]) { this.solid.push({ name, a: new THREE.Vector3(), b: new THREE.Vector3(), r: r * c.scale }); this.solidBones.push(B[a], B[b]); }
    this.skirt = B.Hips && B.LeftFoot && B.RightFoot ? { name: 'skirt', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.17 * c.scale } : null;      // the robes between her legs, hips to the floor
    if (this.skirt) this.solid.push(this.skirt);
    this.blade = { name: 'blade', a: new THREE.Vector3(0, 50, 0), b: new THREE.Vector3(0, 50, 0), r: 0.14 };      // her blade while it lies still or is carried slowly: he steps round it (solidUpdate)
    this.solid.push(this.blade);
    this.train = { name: 'train', a: new THREE.Vector3(), b: new THREE.Vector3(), r: TRAIN.r };      // the train of her skirt on the water behind her, and the ends of her folded pipes over it: he does not stand on it
    this.solid.push(this.train);
    this.hems = [0, 1].map((i) => ({ name: i ? 'hemR' : 'hemL', a: new THREE.Vector3(0, 50, 0), b: new THREE.Vector3(0, 50, 0), r: HEM.r }));      // last polish: the two back corners of her spread hem, and the mouths of her folded pipes over them (solidUpdate)
    this.solid.push(this.hems[0], this.hems[1]);
    this.wall = WALL[0]; this.riding = false; this.touch = null; this.armsOn = null; this.struck = new THREE.Vector3();

    const data = clipdata.cantor || {};
    this.ground = {}; for (const k in GROUND) this.ground[k] = data[k] && data[k].groundSpeed ? data[k].groundSpeed * c.scale : GROUND[k];
    this.idleClip = 'idle';
    this.blend = false;                                          // the animation owner's blended walk, when the runtime has it
    if (typeof c.locomotion === 'function' && typeof c.move === 'function') {
      try { c.locomotion({ idle: 'idle', walk: { f: 'walk_f', b: 'walk_b', l: 'walk_l', r: 'walk_r' } }); this.blend = true; } catch (e) { console.warn('cantor: no blended walk (' + e.message + ')'); }
    }
    this.eye = new THREE.Vector3(); this.looking = 0; this.flinches = 0;      // looking: 0 not, 1 head and chest, 2 head only
    this.puppet = false; this.ai = true; this.wasPuppet = false;
    this.parts = []; this.var = {}; this.cool = {}; this.s = { dist: 99, bearing: 0, face: 0 };
    this.vel = { x: 0, z: 0 }; this.tipPrev = new THREE.Vector3(); this.leapFrom = new THREE.Vector3(); this.leapTo = new THREE.Vector3();
    this.slamAt = new THREE.Vector3(); this.footAt = new THREE.Vector3();
    this.bPrev = new THREE.Vector3(); this.tPrev = new THREE.Vector3(); this.bladeV = 0; this.moveFrom = new THREE.Vector3(); this.clashAt = new THREE.Vector3(); this.clashDir = new THREE.Vector3(); this.clashN = new THREE.Vector3();
    this.stones = null;                                          // the hall's stone as her blade meets it: built on first use (the arena is older than she is, but a lab page may have none)
    this.offs = [
      c.on((e) => this.onClip(e)),
      ctx.bus.on('heal', () => { if (!(R.punish > 0)) return; this.punish = R.punish; if (this._state === 'idle' || this._state === 'walk') this.breath = Math.min(this.breath, 0.2); }),      // he drinks in front of her: she answers at once, from range if she can
      ctx.bus.on('hit', (e) => {
        if (e.attacker !== this || e.target !== ctx.player || !e.weapon) return;
        this.fx.spare();                                             // the blade struck him: what the same blow throws out spares him
        // A blow stopped by his shield never goes on through board and man (docs/impact.md, Part 2, 12): the blade stops on
        // the board for the hold and springs back off it (update, next step; also when his guard breaks under it: he is
        // beaten open, the blade does not pass through him), and from then on it is spent: solid to him, so what is left
        // of a falling stroke (the cleave) shoves him aside and comes down beside him: it glances off, it does not pass
        // through. What follows the spring back: movePost.
        if (e.blocked && this.recoil <= 0) { this.bladeSpent = true; if (this.armedWith) this.bounced = true; }
        // Last polish: a FALLING stroke that lands on him (the cleave, the leap's blade) is solid to him from the contact
        // on: for three steps after the hold the blade is still on him and knocks him out from under it (the fall is
        // slowed that long: movePre), then it comes down on the water BESIDE the man it threw. Before, it lay on the
        // water through both his shins for three frames while he was still on his feet.
        else if (!e.blocked && this.armedWith && this.armedWith.knockdown && this.recoil <= 0) { this.bladeHit = true; this.bladeOn = PRESS_ON; }
      }),
    ];
    this.reset();
  }

  get yaw() { return this.root.rotation.y; } set yaw(v) { this.root.rotation.y = v; }
  get phase() { return this._phase; } set phase(n) { this._phase = n; }      // the game may set it before the cutscene; enterPhase(2) does the work
  get state() { return this._state; }
  /** Her one source of chance: rng(game.seed + 17), reseeded in reset(). */
  get rand() { return this._rand; }

  // ------------------------------------------------------------------------------------------------ life cycle
  reset(spawn = this.ctx.arena.spawn.boss) {
    const c = this.char, kit = this.kit, game = this.ctx.game;
    this.restorePosture();
    this.pos.set(spawn.x, 0, spawn.z); this.yaw = spawn.yaw || 0; this.root.visible = true;
    this.hp = this.hpMax; this.alive = true; this.invulnerable = false; this._phase = 1; this.p2 = false; this.changing = false; this.changeT = 0;
    this.poise = POISE; this.poiseWait = 0; this.staggered = false; this.staggerRest = 0;
    this._state = 'idle'; this.stage = 'idle'; this.move = null; this.moveName = null; this.part = null; this.pi = -1; this.parts.length = 0; this.armedWith = null;
    this.holdT = -1; this.holdLen = 1; this.partFrom = 0; this.partClip = 0; this.hitN = 0; this.hits = 0; this.aim = 0;
    this.breath = 3; this.planT = 0; this.side = 1; this.still = false; this.blockedT = 0; this.hugged = 0; this.farT = 0; this.punish = 0;
    this.forced = null; this.last = null; this.last2 = null; for (const k of ORDER) this.cool[k] = 0;
    this.pivot = null; this.pivotK = 1; this.stT = 0; this.stStage = 0;
    this.glow = 0; this.flare = 0; this.shine = 0; this.sung = 0; this.tipLow = false; this.tick = 0; this.clock = 0;
    this.vel.x = this.vel.z = 0; this.post.stoop = this.post.lower = this.post.up = 0; this.riding = false; this.touch = null; this.slamDue = null; this.wall = WALL[0]; this.flying = false; this.kneeDown = false;
    this.recoil = 0; this.bounce = 0; this.bounced = false; this.bouncedArm = null; this.bladeSpent = false; this.bladeHit = false; this.bladeOn = 0; this.inStone = false; this.bladeFresh = true; this.cramped = 0; this.denied = 0; this.handle = null; this.clipPrev = 0; this.pressed = 0; this.forcedMove = false;
    this.yawPrev = this.yaw; this.xPrev = this.pos.x; this.zPrev = this.pos.z; this.guardUp = 0; this.recoilUp = 0; this.trainYaw = this.yaw;
    if (this.armsOn) { this.armsOn = null; if (c.overlayOff) c.overlayOff(0); }
    if (this.looking) { this.looking = 0; c.look(null); }
    this._rand = rng(((game && game.seed) || 1) + 17);
    this.ctx.combat.disarm(this.weapon); if (this.trail) this.trail.stop();
    this.fx.clear();
    c.speed = 1; c.play(this.idleClip, { fade: 0, force: true }); this.rest(0);
    if (kit.swordPlanted && kit.takeSword) kit.takeSword();
    if (kit.wings) { kit.wings.open = 0; kit.wings.glow = 0; } if (kit.sword) kit.sword.glow = 0; if (kit.halo) kit.halo.glow = 0; kit.fade = 0;
    if (this.light) this.light.intensity = 0;
    if (kit.teleport) kit.teleport();
  }

  /** Phase two begins (the game calls this after the cutscene; a dev start calls it cold). */
  enterPhase(n) {
    if (n !== 2) { this._phase = 1; this.p2 = false; return; }
    this._phase = 2; this.p2 = true; this.changing = false;
    if (!this.alive) return;
    this.invulnerable = false;
    if (this.move) this.abortMove();
    this.staggered = false; this.poise = POISE; this.poiseWait = 0;
    this._state = 'idle'; this.stage = 'idle'; this.char.speed = 1; this.pivot = null;
    this.breath = 1.6; if (!this.forced) this.forced = 'chorale';          // she opens the phase with her own song
  }

  /** Dev: do this move next, whatever the distance (`&do=boss.forceMove("cleave")@1`). */
  forceMove(name) {
    if (!MOVES[name]) { console.warn(`boss: no move "${name}" (${ORDER.join(', ')})`); return false; }
    this.forced = name; this.breath = 0; return true;
  }

  dispose() {
    for (const off of this.offs) off();
    this.restorePosture();
    this.ctx.combat.removeWeapon(this.weapon); if (this.trail && this.trail.dispose) this.trail.dispose();
    this.fx.dispose(); this.kit.dispose(); this.char.dispose();
    if (this.light) this.light.intensity = 0;
  }

  // ------------------------------------------------------------------------------------------------ being hit
  takeHit(hit) {
    if (!this.alive || this.invulnerable) return false;
    if (this.staggered) hit.damage *= STAGGER_HURT;
    this.hp = Math.max(0, this.hp - hit.damage);
    if (this.hp <= 0) { this.die(hit); return true; }
    if (this._phase === 1 && !this.changing && this.hp <= this.hpMax * 0.5) { this.beginChange(); return true; }
    if (!this.staggered && this.staggerRest <= 0 && !(this.part && this.part.each)) {       // not while she is in the air
      const armoured = this._state === 'attack' && (this.stage === 'windup' || this.stage === 'active') && !this.recoil;
      this.poise -= (hit.poise || (hit.heavy ? 30 : 12)) * (armoured ? ARMOUR : 1); this.poiseWait = POISE_WAIT;
      if (this.poise <= 0) { this.stagger(); return true; }
    }
    if (this.ai && (this._state === 'idle' || this._state === 'walk')) this.breath = Math.min(this.breath, 0.15 + this.rand() * 0.35);      // struck while she stands: she answers
    if (this.s.dist < 4.4) this.pressed = Math.min(90, this.pressed + hit.damage);      // struck from at her feet: it mounts up (and ebbs: update), and she rests less and stamps more (breathe, the stomp's weight)
    this.flinch(hit);
    if (hit.heavy && this.ctx.game && this.ctx.game.hitStop) this.ctx.game.hitStop(0.09);      // his heavy blow: the world holds still a moment (the camera asks for the same; the longer one counts)
    return true;
  }

  /**
   * Every blow shows on her (docs/impact.md): she has poise, so it does not stop her, but the struck side answers, as
   * a layer added on top of whatever she is doing, scaled by the blow. Which way she gives is the blow's own line:
   * from the front she recoils (hit3, hit2), from behind her knees give and she pitches forward (hit), from her left
   * she is thrown over to her right and a blow at her head throws it back (hit_head: he reaches it only when she is
   * down). While her own blade is live the layer is under half as strong: the stroke's path is a promise.
   */
  flinch(hit) {
    const c = this.char; if (typeof c.additive !== 'function') return;
    const big = hit.weight === 'colossal' ? 1.2 : hit.heavy || hit.weight === 'heavy' ? 0.9 : 0.55;
    const k = big * (this.stage === 'active' ? 0.45 : 1);
    let f = -1, l = 0;                                             // the blow's line in her own frame: f > 0 it travels the way she faces (she is struck from behind), l > 0 toward her left
    if (hit.dir) { const y = this.yaw, sn = Math.sin(y), cs = Math.cos(y); f = hit.dir.x * sn + hit.dir.z * cs; l = hit.dir.x * cs - hit.dir.z * sn; }
    let high = false;
    if (hit.point) { this.struck.copy(hit.point); const H = c.bones.Head; if (H) { H.getWorldPosition(_v); high = _v.distanceTo(hit.point) < 0.3 * BOSS_HEIGHT; } } else this.struck.set(this.pos.x, 1, this.pos.z);
    let clip, w;
    if (hit.last) { clip = 'hit2'; w = 1.7 * k; }                   // (the killing blow: she is already doubling over in `hit`, whatever side it came from: only the jolt is laid over that, never a second fold or a head thrown back)
    else if (high) { clip = 'hit_head'; w = 0.7 * k; }
    else if (f > 0.35) { clip = 'hit'; w = 0.6 * k; }
    else if (l < -0.55) { clip = 'hit_head'; w = 0.5 * k; }
    else if (l > 0.55) { clip = 'hit'; w = 0.45 * k; }
    else { clip = big > 0.6 ? 'hit2' : 'hit3'; w = 1.7 * k; }      // (these two are small clips: at her size they need the gain to be seen)
    if (c.has && !c.has(clip)) return;
    c.additive(clip, { weight: w, speed: 1.15, fadeIn: 0.03, fadeOut: 0.25 });
    this.flinches++;
    // ... and the struck LEG gives (the animation owner's leg mask): a man's blade lands on her shin or her thigh, so
    // that knee jerks up and forward off the floor and comes down again. Only while she stands on her feet (on her
    // knees there is no leg to give), and not in the air.
    const B = c.bones;
    if (hit.point && B.LeftFoot && B.RightFoot && B.Hips && !this.flying && this._state !== 'stagger' && (!c.has || c.has('hit'))) {
      B.Hips.getWorldPosition(_v);
      if (_v.y > 2.7 && hit.point.y < _v.y) {
        B.LeftFoot.getWorldPosition(_t); B.RightFoot.getWorldPosition(_b);
        const left = Math.hypot(hit.point.x - _t.x, hit.point.z - _t.z) <= Math.hypot(hit.point.x - _b.x, hit.point.z - _b.z);
        c.additive('hit', { mask: left ? 'left-leg' : 'right-leg', weight: 0.3 * k, speed: 1.3, fadeIn: 0.03, fadeOut: 0.22 });
      }
    }
  }

  /** Her poise breaks: the hard stop, the drop to one knee. The loudest moment of the fight so far. */
  stagger() {
    const c = this.char, ctx = this.ctx;
    this.abortMove(); this.staggered = true; this._state = 'stagger'; this.stT = 0; this.stStage = 0; this.poise = POISE; this.poiseWait = 0; this.kneeDown = false;
    this.pivot = null; c.speed = 1.9; this.pos.y = 0;
    c.play('kneel_down', { fade: 0.2, at: 0.45, speed: 1, force: true });
    if (typeof c.additive === 'function' && (!c.has || c.has('hit_head'))) c.additive('hit_head', { weight: 0.5, speed: 1.3, fadeIn: 0.02, fadeOut: 0.3 });      // the blow that broke her throws her head back as she goes down
    this.sing(1);                                                  // the pipes cry out with her
    if (ctx.game && ctx.game.hitStop) ctx.game.hitStop(0.2);
    ctx.bus.emit('boss-stagger', { point: this.struck, pos: this.pos, weight: 'colossal' });      // on the contact frame: this is still inside takeHit
  }

  beginChange() {
    this.abortMove(); this.changing = true; this.changeT = 0; this.invulnerable = true; this._state = 'change'; this.pivot = null; this.pos.y = 0;
    this.char.speed = 1; this.rest(0.4);
    this.ctx.bus.emit('boss-phase', { phase: 2 });
  }

  /**
   * She is killed. The game lets the blow be seen (the world runs at 0.3 for a second and a half before the ending
   * begins, 0.55 s of her time): in those moments she is struck along the blow, at the full weight (the trunk's recoil
   * and the struck leg, as layers over the fall), her pipes cry out, and the sword stays in her fists (nothing here
   * lets it go: the ending does what it will with it afterwards).
   */
  die(hit) {
    const c = this.char;
    this.abortMove(); this.alive = false; this._state = 'dead'; this.staggered = false; this.pivot = null; this.pos.y = 0;
    this.fx.clear();
    // WHAT SHE DOES WHEN THE KILLING BLOW LANDS (seen for 1.8 s, slowed, from the play camera low at his back). She
    // DOUBLES OVER: `hit` from 0.15: her head and chest come down over the blow and her knees bend (deepest in the
    // middle of the slow motion), and she is rearing up again when the ending takes her on. Tried before, and why
    // not: `death_knees2` from 0 arched her backward for the whole slow motion (Kevin, 9 Nov: "Her death animation
    // should look more natural"); `hit_head` from 0.3 threw head and chest back at once: from that low camera her
    // head went out of sight behind her breast and it was the same backbend, sooner. A man's blade lands on her
    // legs: a body struck there folds over the blow, and her face comes down into the picture.
    c.speed = 1; this.struckAt = 0.15;
    if (c.has && c.has('hit')) c.play('hit', { fade: 0.1, at: this.struckAt, force: true });
    else { this.struckAt = 0; c.play(c.has && c.has('death_knees2') ? 'death_knees2' : 'death_knees', { fade: 0.3, force: true }); }
    if (hit) { this.stage = 'idle'; hit.weight = 'colossal'; hit.last = true; this.flinch(hit); }
    this.sing(1);
    this.ctx.bus.emit('boss-died', {});
  }

  // ------------------------------------------------------------------------------------------------ one step
  update(dt) {
    const c = this.char;
    if (this.puppet) {                                          // a cutscene or a dev tool drives her: no rules
      if (!this.wasPuppet) this.enterPuppet();
      const m = c.update(dt); if (this.puppet === 'root') this.applyMotion(m);
      this.lightStep(dt, true); this.kit.update(dt); this.solidUpdate();
      return;
    }
    if (this.wasPuppet) this.leavePuppet();
    if (this._phase === 2 && !this.p2) this.enterPhase(2);       // somebody set the phase without the call
    this.restorePosture();
    this.clock += dt; this.tick++;
    this.yawPrev = this.yaw; this.xPrev = this.pos.x; this.zPrev = this.pos.z;
    const s = this.look(), st = this._state;
    for (const k of ORDER) if (this.cool[k] > 0) this.cool[k] -= dt;
    if (this.poiseWait > 0) this.poiseWait -= dt; else if (this.poise < POISE) this.poise = Math.min(POISE, this.poise + POISE_BACK * dt);
    if (this.staggerRest > 0) this.staggerRest -= dt;
    if (this.punish > 0) this.punish -= dt;
    if (this.pressed > 0) this.pressed = Math.max(0, this.pressed - PRESS_EBB * dt);
    this.hugged = s.dist < 3.9 ? this.hugged + dt : Math.max(0, this.hugged - dt * 2);
    this.farT = s.dist > 9 ? this.farT + dt : 0;

    this.watch(st);
    // before the pose: decide
    if (st === 'attack') this.movePre(dt, s);
    else if (st === 'idle' || st === 'walk') this.foot(dt, s);
    else if (st === 'change') { this.changeT += dt; const g = this.ctx.game, cine = this.ctx.cine; if (this.changeT > 2 && g && g.state === 'fight' && !(cine && cine.playing)) this.enterPhase(2); }

    this.clipPrev = this.handle && typeof this.handle.time === 'number' ? this.handle.time : 0;
    const m = c.update(dt);

    // after the pose: travel, and what depends on where the clip has got to
    const now = this._state;
    if (now === 'attack') this.movePost(dt, s, m);
    else if (now === 'turn') this.pivotPost(m);
    else if (now === 'stagger') this.staggerPost(dt);
    else if (now === 'dead') { this.shift(m.x * 0.3, m.z * 0.3, 0); }
    this.guardUp = now !== 'dead' && now !== 'stagger' && this.guardCrossed() ? 1 : 0;      // on guard her blade points six metres ahead of her: where stone stands there she carries it upright
    this.applyPosture(dt);
    if (this.touch && (this.armedWith || this.bladeSpent)) { this.kit.sword.tip.getWorldPosition(_t); if (_t.y <= this.floorAt(_t.x, _t.z) + 0.22) this.touchDown(); }
    if (this.slamDue) { const o = this.slamDue; this.slamDue = null; this.slam(o); }
    this.bladeStone(dt);                                         // a blade is a solid thing: the hall's stone stops it
    // Her blade against him, here and now (not later in combat.update): if it struck part way through this step's travel,
    // her pose is put back to that moment, so the frame the world holds on shows the blade ON him, where the flash and
    // the sparks are (docs/impact.md, Part 2, 1: contact is where the blade is), not already past him on the floor.
    if (this.ctx.combat.sweepNow) {
      const u = this.ctx.combat.sweepNow(this.weapon, dt);
      if (u > 0 && u < 0.999 && this._state === 'attack' && this.recoil <= 0) this.poseBack(u);
    }
    this.dress(dt);
    if ((this.tick & 1) === 0) this.bladeWater(dt * 2);
    if (this.pos.z > 8 && this.kit.wings && this.kit.wings.obstacle && this.ctx.arena.piers && this.ctx.arena.piers.length) for (const d of LEAVES) this.kit.wings.obstacle(d.x, d.z, d.r);      // near the doors: the two leaves standing open into the nave (the wings know the walls and the fallen stones themselves)
    this.kit.update(dt);
    this.fx.update(dt);
    this.solidUpdate();
  }

  enterPuppet() {
    this.wasPuppet = true; this.restorePosture();
    if (this.looking) { this.looking = 0; this.char.look(null); }
    if (this.move) this.abortMove();
    this.pivot = null; this.char.speed = 1; this.fx.clear();
    this.post.stoop = this.post.lower = this.post.up = 0; this.touch = null;
    this.ctx.combat.disarm(this.weapon); if (this.trail) this.trail.stop();
  }
  leavePuppet() {
    this.wasPuppet = false; this.pos.y = 0; this.char.speed = 1; this.bladeFresh = true; this.recoil = 0;
    if (this.alive && !this.changing) { this._state = 'idle'; this.stage = 'idle'; this.breath = Math.max(this.breath, 1.2); this.vel.x = this.vel.z = 0; }
  }

  /**
   * Her masked head follows the pilgrim (the animation runtime's look-at; it eases). Between blows the chest turns
   * a little with it; in a blow only the head does, so the blade goes exactly where the move says.
   */
  watch(st) {
    const c = this.char; if (typeof c.look !== 'function') return;
    const p = this.ctx.player, want = this.alive && p.alive && st !== 'stagger' && st !== 'dead' && st !== 'turn' && st !== 'change';
    const mode = !want ? 0 : st === 'attack' ? 2 : 1;
    if (want) this.eye.set(p.pos.x, 1.5, p.pos.z);
    if (mode === this.looking) return;
    this.looking = mode;
    if (mode === 0) c.look(null);
    else if (mode === 1) c.look(this.eye, { weight: 0.9, speed: 4, head: 0.65, chest: 0.35, always: false });
    else c.look(this.eye, { weight: 0.8, speed: 5, head: 0.9, chest: 0, always: true });
  }

  /** Where the pilgrim is, seen from her. */
  look() {
    const p = this.ctx.player, s = this.s;
    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z;
    s.dist = Math.hypot(dx, dz); s.face = Math.atan2(dx, dz); s.bearing = angleDiff(s.face, this.yaw);     // + = to her left
    return s;
  }

  /** Move by a step of root motion (her own frame), stopped by walls and columns. */
  applyMotion(m) { this.shift(m.x, m.z, m.yaw); }
  /**
   * Move her (her own frame, metres). She goes in sub-steps no longer than STEP, so nothing is jumped (a lunge covers
   * a third of a metre a step and more), and after each she is put back out of the fallen stones and the walls and
   * off the pilgrim. Returns true if she touched the hall.
   */
  shift(x, z, yaw) {
    const y = this.yaw, c = Math.cos(y), s = Math.sin(y), dx = x * c + z * s, dz = -x * s + z * c;
    if (yaw) this.yaw = y + yaw;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STEP)); let hit = false;
    for (let i = 0; i < n; i++) { this.pos.x += dx / n; this.pos.z += dz / n; if (this.collide(false)) hit = true; }
    return hit;
  }
  /**
   * Solid to the hall and to him. Fallen stones and walls by her body's radius; the walls again by `wall`, which grows
   * with her open wings (gently: at most a few centimetres a step, unless `hard`); and her centre never nearer to the
   * pilgrim than her radius and his (his own push-out does the fine work against her legs: `solid`). A puppet is
   * only kept in the hall: a cutscene knows where it wants her.
   */
  collide(hard) {
    const a = this.ctx.arena, p = this.pos, pl = this.ctx.player;
    if (this.flying) return false;                               // six metres up: the leap's own path keeps her in the hall and brings her down beside him
    let hit = a.resolve(p, this.radius);
    if (this.puppet) return hit;
    if (pl && pl.alive && pl !== this) {
      const dx = p.x - pl.pos.x, dz = p.z - pl.pos.z, d = Math.hypot(dx, dz), min = this.radius + HIS;
      if (d < min && d > 1e-4) { p.x = pl.pos.x + dx / d * min; p.z = pl.pos.z + dz / d * min; if (a.resolve(p, this.radius)) hit = true; }
    }
    if (this.keepIn(p, this.wall, hard ? 99 : 0.1)) hit = true;      // 0.1 m a sub-step: more than any walk of hers, so she cannot walk into the room her wings need; when they open she is eased inward, not snatched
    return hit;
  }
  /** Bring a point inside the play area shrunk by `radius` (a rounded rectangle), moving it at most `most` metres. */
  keepIn(p, radius, most) {
    const b = this.ctx.arena.bounds; if (!b) return false;
    const ix = b.hx - b.r, iz = b.hz - b.r, lim = Math.max(0, b.r - radius);
    const cx = clamp(p.x, -ix, ix), cz = clamp(p.z, -iz, iz), dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
    if (d <= lim + 1e-4) return false;
    const k = Math.min(d - lim, most) / d; p.x -= dx * k; p.z -= dz * k;
    return true;
  }

  // ------------------------------------------------------------------------------------------------ footwork
  foot(dt, s) {
    const c = this.char, p = this.ctx.player;
    if (!p.alive) { this.walk(0, 0, dt); return; }
    if (!this.ai) { if (this.forced) this.startMove(this.take()); else this.walk(0, 0, dt); return; }
    const ab = Math.abs(s.bearing);
    this.breath -= dt; this.planT -= dt; if (this.blockedT > 0) this.blockedT -= dt;

    // her next blow
    if (this.breath <= 0) {
      const name = this.choose(s);
      if (name) { this.startMove(name); return; }
    }
    // he is behind her: she comes round on her heel
    if (ab > 2.0) { this.startPivot(s.bearing); return; }
    const rate = Math.min(1.5 + (this._phase === 2 ? 0.25 : 0), ab * 3 + 0.15) * dt;
    this.yaw += clamp(s.bearing, -rate, rate);

    // a duellist's distance: come on when he is far, give ground when he crowds her, otherwise circle or stand
    if (this.planT <= 0) { this.planT = 1.4 + this.rand() * 1.8; this.side = this.rand() < 0.5 ? 1 : -1; this.still = this.rand() < 0.3; }
    const keepFar = this._phase === 2 ? 9 : 8, keepNear = 4.2;
    let vx = 0, vz = 0;
    if (ab > 1.2) { /* turning to find him: feet still */ }
    else if (s.dist > keepFar) vz = WALK.f;
    else if (s.dist < keepNear && this.breath > 0.3 && this.blockedT <= 0) vz = -WALK.b;
    else if (!this.still) { vx = this.side * WALK.s; vz = clamp((s.dist - 6.2) * 0.7, -1, 1.2); }
    if (this.cramped > 0 && ab <= 1.2) {                         // a pier, a wall or a fallen stone stands in her blade's arc: she steps toward the open middle of the hall, still facing him
      this.cramped -= dt;
      const tx = -this.pos.x, tz = clamp(this.pos.z, -7, 9) - this.pos.z, l = Math.hypot(tx, tz);
      if (l > 0.6) { const y = this.yaw, sn = Math.sin(y), cs = Math.cos(y), f = (tx * sn + tz * cs) / l, sd = (tx * cs - tz * sn) / l; vx = sd * WALK.s; vz = f * (f > 0 ? WALK.f : WALK.b); }
    }
    const touched = this.walk(vx, vz, dt);
    if (touched) { if (vz < 0) this.blockedT = 1.5; if (vx) this.side = -this.side; }
  }
  /** Seconds from now until the move under way is over (its remaining parts at their own speeds). */
  openFor() {
    let t = 0, clipT = this.char.time;
    for (let i = this.pi; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (p.hold !== undefined) { t += i === this.pi ? Math.max(0, this.holdT) : typeof p.hold === 'function' ? p.hold(this) : p.hold; continue; }
      if (p.clip && i !== this.pi) clipT = p.at || 0;
      t += Math.max(0, p.to - clipT) / (p.speed || 1); clipT = p.to;
    }
    return t;
  }

  /** Stand at rest: the walk blend at no speed (it carries her idle), or the idle clip. */
  rest(fade) { const c = this.char; if (this.blend) { c.play('@move', { fade }); c.move(0, 0); } else c.play(this.idleClip, { fade }); }

  /** Walk at (vx, vz) metres a second in her own frame (+x is her left), with a little weight; 0, 0 stands. */
  walk(vx, vz, dt) {
    const c = this.char, v = this.vel;
    v.x = damp(v.x, vx, 5, dt); v.z = damp(v.z, vz, 5, dt);
    const sp = Math.hypot(v.x, v.z), moving = sp >= 0.25;
    c.speed = 1;
    if (this.blend) {                                            // one blend covers standing and every heading; it keeps her feet on the floor
      if (c.clipName !== '@move') c.play('@move', { fade: 0.45 });
      this._state = moving ? 'walk' : 'idle';
      if (!moving) {
        c.move(0, 0);
        this.keepIn(this.pos, this.wall, 0.02);                    // standing: only the room her wings need (they may just have opened)
        return false;
      }
      // She moves first; then her legs are told what she really covered (own frame: + left, + forward). Where a wall, a
      // fallen stone or the pilgrim has stopped her, her feet stop too: move(0, 0) lets her stand and settle instead of
      // walking on the spot (the animation owner's planted feet need the root's true velocity).
      const px = this.pos.x, pz = this.pos.z, touched = this.shift(v.x * dt, v.z * dt, 0);
      const ax = (this.pos.x - px) / dt, az = (this.pos.z - pz) / dt, y = this.yaw, sn = Math.sin(y), cs = Math.cos(y);
      let rl = ax * cs - az * sn, rf = ax * sn + az * cs;
      if (Math.hypot(rl, rf) < 0.3) { rl = rf = 0; if (touched) { v.x *= 0.6; v.z *= 0.6; } }      // held: she does not lean on the stone
      c.move(rl, rf);
      return touched;
    }
    if (!moving) {
      if (this._state !== 'idle' || c.clipName !== this.idleClip) { this._state = 'idle'; c.play(this.idleClip, { fade: 0.5 }); }
      return false;
    }
    this._state = 'walk';
    const clip = Math.abs(v.z) >= Math.abs(v.x) ? (v.z > 0 ? 'walk_f' : 'walk_b') : (v.x > 0 ? 'walk_l' : 'walk_r');
    const a = c.play(clip, { fade: 0.4, speed: 1 }); if (a) a.timeScale = clamp(sp / this.ground[clip], 0.35, 1.1);
    return this.shift(v.x * dt, v.z * dt, 0);
  }

  startPivot(bearing) {
    const c = this.char, clip = Math.abs(bearing) > 2.5 ? 'turn_180' : bearing > 0 ? 'turn_l' : 'turn_r';
    let want = bearing; if (clip === 'turn_180' && bearing > 0) want = bearing - Math.PI * 2;       // that clip turns to her right
    this.pivot = clip; this.pivotK = want / TURNS[clip]; this._state = 'turn'; this.vel.x = this.vel.z = 0;
    const a = c.play(clip, { fade: 0.25, speed: 1, force: true }); if (a) a.timeScale = 1;
    c.speed = 0.6;
  }
  pivotPost(m) {
    const c = this.char;
    this.shift(m.x * 0.4, m.z * 0.4, m.yaw * this.pivotK);
    if (c.done || c.time >= c.duration - 0.04) { this.pivot = null; c.speed = 1; this._state = 'idle'; this.rest(0.35); this.breath = Math.min(this.breath, 0.35); }
  }

  // ------------------------------------------------------------------------------------------------ choosing
  take() { const n = this.forced; this.forced = null; this.forcedMove = true; return n; }      // (a forced move is played whatever stands in its arc)
  choose(s) {
    if (this.forced) return this.take();
    let total = 0, pick = null; this.denied = 0;
    for (const name of ORDER) total += this.weigh(MOVES[name], s);
    if (this.denied) this.cramped = total <= 0 ? 1.4 : Math.max(this.cramped, 0.5);      // stone stands in the way of what she would do here: she makes for open ground (foot)
    if (total <= 0) { if (this.denied) this.breath = 0.3; return null; }
    let r = this.rand() * total;
    for (const name of ORDER) { const w = this.weigh(MOVES[name], s); if (w <= 0) continue; pick = name; r -= w; if (r <= 0) break; }
    return pick;
  }
  weigh(mv, s) {
    if (mv.phase > this._phase || this.cool[mv.name] > 0) return 0;
    if (s.dist < mv.range[0] || s.dist > mv.range[1]) return 0;
    if (Math.abs(angleDiff(s.bearing, mv.aim || 0)) > mv.arc) return 0;
    if (mv.fits && !mv.fits(this, s)) return 0;                  // the stroke would not reach him where he stands
    if (!this.arcFree(mv, s)) { this.denied++; return 0; }       // its arc would cross stone: not from here
    let w = mv.weight;
    if (this._phase === 2 && mv.phase === 1) w *= 0.75;          // in phase two her new moves come first
    if (mv.name === this.last) w *= 0.12; else if (mv.name === this.last2) w *= 0.5;
    if (mv.w) w *= mv.w(this, s);
    return w;
  }
  /** How long she waits before the next blow. */
  breathe() {
    const close = this.s.dist < 4.8, r = this.rand();            // he is at her feet: she does not stand and take it
    let t = this._phase === 2 ? (close ? lerp(0.25, 0.7, r) : lerp(0.6, 1.2, r)) : (close ? lerp(0.35, 0.9, r) : lerp(0.9, 1.7, r));
    if (this.hp < this.hpMax * 0.2) t *= 0.8;
    if (close && this.pressed > PRESSED) return t * 0.4;         // he stands at her feet and keeps striking: she does not rest, she answers (and no number of difficulty lengthens that)
    return t * this.rules.rest;
  }

  // ------------------------------------------------------------------------------------------------ playing a move
  startMove(name) {
    const mv = MOVES[name]; if (!mv) return;
    for (const k in this.var) delete this.var[k];
    this.move = mv; this.moveName = name; this._state = 'attack'; this.stage = null; this.said = false; this.pi = -1; this.hitN = 0; this.aim = mv.aim || 0; this.pivot = null;
    this.moveFrom.copy(this.pos); this.recoil = 0; this.cramped = 0;
    this.vel.x = this.vel.z = 0;
    if (mv.begin) mv.begin(this);
    this.parts.length = 0; for (const p of mv.parts) if (!p.when || p.when(this)) this.parts.push(p);
    const tl = timeline(this.parts, this, this._phase === 2 ? this.rules.quick : 1); this.hits = tl.hits; this.eta = tl.eta;
    this.cool[name] = (mv.cool || 0) * (mv.coolPressed !== undefined && this.pressed > PRESSED ? mv.coolPressed : 1); this.last2 = this.last; this.last = name;
    this.nextPart();
  }

  nextPart() {
    const c = this.char, ctx = this.ctx;
    this.pi++;
    if (this.pi >= this.parts.length) { this.endMove(); return; }
    const p = this.part = this.parts[this.pi];
    if (this.pi > 0 && p.stage === 'windup' && this.stage !== 'windup' && !ctx.player.alive) { this.endMove(); return; }      // he is dead: she does not begin another stroke on him
    if (p.clip) { const a = c.play(p.clip, { at: p.at || 0, fade: p.fade === undefined ? 0.2 : p.fade, speed: 1, force: true, loop: false }); if (a) a.timeScale = 1; this.handle = a || null; }
    this.partFrom = c.time; this.partClip = c.time;
    if (p.aim !== undefined) this.aim = p.aim;
    this.holdT = p.hold !== undefined ? Math.max(0.02, typeof p.hold === 'function' ? p.hold(this) : p.hold) : -1; this.holdLen = Math.max(0.02, this.holdT);
    c.speed = this.partSpeed(p);
    // both arms from another clip (the leap: a mutant's body, the cleave's arms): the layer's time is ours to set
    if (p.arms && typeof c.overlay === 'function') {
      if (!this.armsOn || this.armsOn.clip !== p.arms.clip) { const h = c.overlay(p.arms.clip, { mask: 'arms', fade: p.fade === undefined ? 0.25 : p.fade, at: p.arms.t0, hold: true, loop: false, force: true }); if (h) { h.paused = true; this.armsOn = { clip: p.arms.clip, handle: h }; } }
    } else if (this.armsOn) { this.armsOn = null; if (c.overlayOff) c.overlayOff(p.fade === undefined ? 0.15 : p.fade); }
    if (p.arm) {
      if (this.armedWith !== p.arm) {
        this.bladeSpent = false; this.bladeHit = false; this.bladeOn = 0;                                   // a new stroke
        this.armedWith = p.arm; ctx.combat.arm(this.weapon, { damage: p.arm.damage, poise: p.arm.poise, heavy: p.arm.heavy, knockdown: !!p.arm.knockdown, weight: p.arm.weight, sweep: true });
        ctx.bus.emit('swing', { who: 'boss', heavy: p.arm.heavy, weapon: this.weapon });
        if (this.trail) this.trail.start();
        this.touch = null;
      }
      if (p.touch) this.touch = p.touch;                           // this window's first touch of the floor is its slam
    } else if (this.armedWith) this.disarm();
    if (p.stage && (p.stage !== this.stage || p.beat)) {
      this.stage = p.stage;
      if (p.stage === 'windup') { if (!this.said) { this.said = true; ctx.bus.emit('boss-move', { name: this.moveName, stage: 'windup', eta: this.eta, hits: this.hits }); } }
      else if (p.stage === 'active') { ctx.bus.emit('boss-move', { name: this.moveName, stage: 'active', n: this.hitN, of: this.hits }); this.hitN++; }
      else ctx.bus.emit('boss-move', { name: this.moveName, stage: p.stage, open: p.stage === 'recover' ? this.openFor() : undefined });      // open: seconds until this move is over (the test player, like a player who knows her, reckons with it)
    }
    if (p.slam) this.slamDue = p.slam;                           // told at the end of this step, once the blade has its true place (after the posture)
    if (p.on) p.on(this);
  }
  disarm() { this.armedWith = null; this.touch = null; this.ctx.combat.disarm(this.weapon); if (this.trail) this.trail.stop(); }

  movePre(dt, s) {
    const p = this.part, c = this.char; if (!p) return;
    if (this.recoil > 0) { c.speed = Math.max(0.6, this.partSpeed(p)); return; }      // her blade met stone: it springs back (the clip runs backward: bladeStone)
    if (this.bounced) {                                          // a blow was stopped by his raised shield (docs/impact.md, Part 2, 12): this window is over, the blade springs back off the board, then she goes on to what follows
      this.bounced = false;
      if (this.armedWith) { const arm = this.armedWith; this.disarm(); this.bouncedArm = arm; this.touch = null; this.slamDue = null; this.bounce = 1e-4; if (this.handle) this.handle.timeScale = arm.knockdown ? -1.35 : -0.7; }      // (last polish: no splash stays due, not for a falling stroke either: a blow that was stopped strikes no floor)
    }
    if (this.bounce > 0) { c.speed = Math.max(0.8, this.partSpeed(p)); return; }
    if (p.track) {                                               // she turns her whole body to put him where the stroke will land, no faster than this
      const k = p.track * dt * (this._phase === 2 ? 1.15 : 1);
      // ... but not into stone: if he has gone where the stroke's arc would cross a pier or a fallen stone, she keeps her line
      if (this.forcedMove || !this.move.reach || this.move.reach.line || this.move.name === 'leap' || !this.arcBlocked(this.move, this.moveFrom.x, this.moveFrom.z, s.face - (this.move.aim || 0)))
        this.yaw += clamp(angleDiff(s.face - this.aim, this.yaw), -k, k);
    }
    c.speed = this.partSpeed(p);
    if (this.bladeOn > 0) { this.bladeOn -= dt; c.speed *= 0.18; }      // the falling blade has just struck him: it stays on him while he is knocked out from under it
    if (this.armsOn && p.arms) {                                 // the borrowed arms run from t0 to t1 across the part
      const u = this.holdT >= 0 ? 1 : clamp((c.time - this.partFrom) / Math.max(1e-4, p.to - this.partFrom));
      this.armsOn.handle.time = lerp(p.arms.t0, p.arms.t1, u);
    }
  }
  partSpeed(p) {
    if (this.holdT >= 0) return p.speed || 0.03;
    return (p.speed || 1) * (this._phase === 2 && this.stage === 'windup' ? this.rules.quick : 1);      // phase two: the wind-ups are a little shorter
  }

  movePost(dt, s, m) {
    const c = this.char;
    if (this.recoil > 0) {                                       // the blade sprang back off stone: held, then she gathers herself
      this.recoil += dt; const h = this.handle;
      if (h && this.recoil >= RECOIL.back && h.timeScale < 0) h.timeScale = 0;
      if (this.recoil >= RECOIL.end) { if (h) h.timeScale = 1; this.recoil = 0; this.endMove(); }
      return;
    }
    if (this.bounce > 0) {                                       // the blade springs back off his shield for a moment; the rest of that stroke is not played (it would carry the blade through him)
      this.bounce += dt;
      const fall = !!(this.bouncedArm && this.bouncedArm.knockdown);
      if (fall && this.handle) { const u = 1 - Math.min(1, this.bounce / BOUNCE_FALL); this.handle.timeScale = -1.35 * u * Math.sqrt(u); }      // thrown back fast, then slower: a rebound, not a film run backward (about 0.27 s of the clip in all: the blade ends level over her head)
      if (this.bounce >= (fall ? BOUNCE_FALL : BOUNCE)) {
        const arm = this.bouncedArm, h = this.handle; this.bounce = 0; this.bouncedArm = null;
        let j = this.pi + 1; while (j < this.parts.length && this.parts[j].arm === arm) j++;      // the same stroke's later parts (the round stroke's way back, the thrust's follow-through) are not played
        if (!fall && j < this.parts.length && this.parts[j].clip) { if (h) h.timeScale = 1; this.pi = j - 1; this.nextPart(); }      // the next stroke of the combo
        else {                                                    // nothing more to come but that stroke's own end: she holds a moment where the board stopped her, then stands
          // (last polish: the cleave and the leap's blade too. They used to fall on "beside him": the reviewer saw five
          // metres of steel come down through the hips of the man who had just blocked it, with a slam at his feet and
          // no hit. Now the blade is thrown back up over her head and stays there until she stands.)
          const rest = fall ? FALL_REST : BLOCKED_REST;
          if (h) h.timeScale = 0; this.recoil = RECOIL.end - rest;
          if (this.stage !== 'recover') { this.stage = 'recover'; this.ctx.bus.emit('boss-move', { name: this.moveName, stage: 'recover', open: rest }); }
        }
      }
      return;
    }
    for (let guard = 0; guard < 4 && this._state === 'attack'; guard++) {
      const p = this.part;
      if (guard === 0) {
        const tr = p.travel === undefined ? 1 : typeof p.travel === 'function' ? p.travel(this) : p.travel, bk = p.back === undefined ? tr : p.back;
        let mz = m.z * (m.z >= 0 ? tr : bk);
        if (mz > 0 && s.dist < this.radius + 2.1 && Math.abs(s.bearing) < 1.1) mz = 0;         // she does not walk through him: she keeps him at her blade's distance
        let turn = m.yaw;
        if (p.spin && this.holdT < 0) { const span = p.to - this.partFrom; if (span > 1e-4) turn += p.spin * clamp(c.time - this.partClip, 0, span) / span; this.partClip = c.time; }
        this.shift(m.x * (p.side === undefined ? Math.min(tr, 1) : p.side), mz, turn);      // a boosted step is boosted forward, not sideways
        if (p.each) p.each(this, dt);
      }
      if (this.holdT >= 0) { this.holdT -= dt; if (this.holdT > 0) return; this.holdT = -1; this.nextPart(); continue; }
      if (c.time >= p.to - 1e-4 || c.done) { this.nextPart(); continue; }
      return;
    }
  }

  /** The move is over (or cut short): stand, and breathe before the next. */
  endMove() {
    const c = this.char, name = this.moveName;
    if (this.armedWith) this.disarm();
    if (name && this.stage !== 'recover') this.ctx.bus.emit('boss-move', { name, stage: 'recover', open: 0 });
    if (this.move && this.move.end) this.move.end(this);
    if (this.armsOn) { this.armsOn = null; if (c.overlayOff) c.overlayOff(0.25); }
    this.move = null; this.moveName = null; this.part = null; this.parts.length = 0; this.stage = 'idle'; this.holdT = -1; this.touch = null; this.flying = false; this.forcedMove = false;
    if (this.recoil > 0 || this.bounce > 0) { this.recoil = this.bounce = 0; if (this.handle) this.handle.timeScale = 1; }
    this.bounced = false; this.bladeSpent = false; this.bladeHit = false; this.bladeOn = 0;
    this.pos.y = 0; c.speed = 1; this._state = 'idle'; this.rest(0.45);
    this.breath = this.breathe(); this.planT = 0;
  }
  /** Cut a move short without ceremony (stagger, death, the change, a cutscene). */
  abortMove() {
    if (this.armedWith) this.disarm(); else { this.ctx.combat.disarm(this.weapon); if (this.trail) this.trail.stop(); }
    if (this.armsOn) { this.armsOn = null; if (this.char.overlayOff) this.char.overlayOff(0.2); }
    this.move = null; this.moveName = null; this.part = null; this.parts.length = 0; this.stage = 'idle'; this.holdT = -1; this.char.speed = 1; this.pos.y = 0; this.touch = null; this.slamDue = null; this.flying = false; this.forcedMove = false;
    if (this.recoil > 0 || this.bounce > 0) { this.recoil = this.bounce = 0; if (this.handle) this.handle.timeScale = 1; }
    this.bounced = false; this.bladeSpent = false; this.bladeHit = false; this.bladeOn = 0;
  }

  /** Blade or body strikes the floor as a part begins (a part's `slam`). o: { r, power, at: 'tip' | 'feet' | 'blade' }.
   *  Always called after applyPosture (update keeps it until then), so the blade is read where it is drawn this step:
   *  the place told, the water struck and the sprays are on the blade, not where the bare clip would have had it. */
  slam(o) {
    const ctx = this.ctx, sw = this.kit.sword, at = this.slamAt;
    sw.tip.getWorldPosition(_t); sw.base.getWorldPosition(_b);
    if (o.at === 'feet') at.set(this.pos.x, WATER_Y, this.pos.z);
    else if (o.at === 'blade') { this.fx.burst(lerp(_b.x, _t.x, 0.25), lerp(_b.z, _t.z, 0.25), _t.x, _t.z, o.power); at.set(lerp(_b.x, _t.x, 0.6), WATER_Y, lerp(_b.z, _t.z, 0.6)); }
    else at.set(_t.x, WATER_Y, _t.z);
    if (o.at !== 'blade' && ctx.water) ctx.water.ripple(at.x, at.z, 3 * o.power, 0.9);
    ctx.bus.emit('boss-slam', { pos: at, radius: o.r, power: o.power });
  }

  // ------------------------------------------------------------------------------------------------ her blade and the hall's stone
  /** The hall's stone as her blade meets it: [{ x, z, r, h }] (piers and door leaves stand to the vault; the fallen stones are low). */
  stoneList() {
    if (this.stones) return this.stones;
    const a = this.ctx.arena, L = this.stones = [];
    if (!a) return L;
    for (const c of a.piers || []) L.push({ x: c.x, z: c.z, r: PIER_R, h: 99 });
    if (a.piers && a.piers.length) for (const c of LEAVES) L.push({ x: c.x, z: c.z, r: c.r, h: 99 });      // (only in the real hall: a lab's bare floor has no doors)
    for (const c of a.colliders || []) L.push({ x: c.x, z: c.z, r: Math.max(0.2, c.r - 0.05), h: stoneHeight(c) });
    return L;
  }
  /**
   * Would the blade meet the hall's stone in this move, if she stood at (x, z) and its frame were turned to `yaw` (the
   * way she faces when the pilgrim stands where the move aims: face - aim)? mv.reach = { any, low }: how far out the
   * blade comes in each 15 degrees of that frame over the whole move, wind-up to recovery, at any height (piers stand
   * to the vault) and under 1.8 m (the fallen stones are low). A thrust is a line: reach.line (how far beyond him the
   * point goes) and `len` (how far away he is).
   */
  arcBlocked(mv, x, z, yaw, len = 0) {
    const R = mv.reach, L = this.stoneList(); if (!R || !L.length) return false;
    if (R.line) {                                                // the lunge: a lane from her to beyond him
      const h = yaw + (mv.aim || 0), fx = Math.sin(h), fz = Math.cos(h), far = len + R.line, ez = z + fz * far;
      if (ez > WEST || ez < EAST) return true;
      for (let i = 0; i < L.length; i++) {
        const c = L[i], along = (c.x - x) * fx + (c.z - z) * fz, t = clamp(along, 0, far), d = Math.hypot(c.x - x - fx * t, c.z - z - fz * t);
        if (d < c.r + R.width + ARC_CLEAR) return true;
        // out of the thrust the blade is drawn back round her RIGHT side, low: from where she ends, some metres wide
        const side = (c.x - x) * fz - (c.z - z) * fx;              // + = her left
        if (along > far - R.back && along < far + c.r && side < 0 && -side < R.right + c.r + ARC_CLEAR) return true;
      }
      return false;
    }
    for (let i = 0; i < L.length; i++) {
      const c = L[i], tab = c.h > 5 ? R.any : R.low, most = c.h > 5 ? R.anyMax : R.lowMax;
      const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz), need = d - c.r - ARC_CLEAR;
      if (need > most) continue;
      if (need <= 0) return true;
      const mid = angleDiff(Math.atan2(dx, dz), yaw), half = Math.asin(Math.min(1, (c.r + ARC_CLEAR) / d));
      for (let k = Math.round((mid - half) / BIN), k1 = Math.round((mid + half) / BIN); k <= k1; k++) if (tab[((k % BINS) + BINS) % BINS] > need) return true;
    }
    for (let k = 0; k < BINS; k++) {                             // the end walls
      const r = R.any[k]; if (r <= 0) continue;
      const zz = z + Math.cos(yaw + k * BIN) * (r + ARC_CLEAR); if (zz > WEST || zz < EAST) return true;
    }
    return false;
  }
  /** On guard (standing, walking, turning) her blade points forward and up: its point is six metres ahead of her, six
   *  metres up. Does a pier, a door leaf or an end wall stand in that line? Then she carries it upright (`up`). */
  guardCrossed() {
    const L = this.stoneList(); if (!L.length) return false;
    const y = this.yaw, fx = Math.sin(y), fz = Math.cos(y), x = this.pos.x, z = this.pos.z, far = 6.6, ez = z + fz * far;
    if (ez > WEST || ez < EAST) return true;
    for (let i = 0; i < L.length; i++) {
      const c = L[i]; if (c.h < 5) continue;
      const t = clamp((c.x - x) * fx + (c.z - z) * fz, 0, far), d = Math.hypot(c.x - x - fx * t, c.z - z - fz * t);
      if (d < c.r + 1.5) return true;                            // (walking and turning swing the point up to a metre and a half aside)
    }
    return false;
  }
  /** Where the leap would bring her down: short of him by the blade's reach, on open floor. Result in `out`. */
  leapSpot(out) {
    const p = this.ctx.player, REACH = 4.8;                       // her feet come down this far short of the spot, so the blade (it lies 2.3 to 7.5 m ahead of her) falls on it
    let dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    const go = Math.max(-4, d - REACH);                            // he is at her feet: she goes up and BACK, and the blade still falls on him
    out.set(this.pos.x + dx * go, 0, this.pos.z + dz * go); this.ctx.arena.resolve(out, this.radius); this.keepIn(out, this.wall, 99);
    return out;
  }
  /** Is this move's arc clear of stone from where she stands, with him where he is? */
  arcFree(mv, s) {
    if (!mv.reach) return true;
    if (mv.name === 'leap') {                                    // the blade goes up where she stands, hangs behind her back in the air and falls where she comes down, along the line to him
      const to = this.leapSpot(_v), p = this.ctx.player, x = to.x, z = to.z;
      if (Math.abs(this.pos.x) > 6.4 || Math.abs(x) > 6.4) return false;      // six metres up, her blade is among the walls over the arcades (x = +-12.2): she leaps only from, and to, the middle of the nave
      return !this.arcBlocked(mv, this.pos.x, this.pos.z, s.face - (mv.aim || 0)) && !this.arcBlocked(mv, x, z, Math.atan2(p.pos.x - x, p.pos.z - z) - (mv.aim || 0));
    }
    return !this.arcBlocked(mv, this.pos.x, this.pos.z, s.face - (mv.aim || 0), s.dist);
  }
  /** Put her pose back to a moment part way through this step (u: 0 = where she stood a step ago, 1 = where she stands):
   *  the clip's clock, her turn and her step of this step, then the pose and the posture again. */
  poseBack(u) {
    const c = this.char, h = this.handle;
    this.yaw = this.yawPrev + angleDiff(this.yaw, this.yawPrev) * u; this.pos.x = lerp(this.xPrev, this.pos.x, u); this.pos.z = lerp(this.zPrev, this.pos.z, u);
    if (h && typeof h.time === 'number') h.time = this.clipPrev + (h.time - this.clipPrev) * u;
    c.update(0); this.post.on = false; this.applyPosture(0);
    if (this.ctx.combat.resync) this.ctx.combat.resync(this.weapon);
  }
  /** Does the blade (a = by the hand, b = the point) lie in stone? If so the place where it enters is left in _sp (on the
   *  stone's face, at the blade's height there) and the way out of the stone in _sn. */
  stoneAt(a, b) {
    const L = this.stoneList(), dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    for (let i = 0; i < L.length; i++) {
      const c = L[i], fx = a.x - c.x, fz = a.z - c.z, cq = fx * fx + fz * fz - c.r * c.r;
      let t0 = 0, t1 = 1;
      if (l2 > 1e-9) {
        const bq = fx * dx + fz * dz, disc = bq * bq - l2 * cq; if (disc <= 0) continue;
        const q = Math.sqrt(disc); t0 = (-bq - q) / l2; t1 = (-bq + q) / l2;
        if (t1 <= 0 || t0 >= 1) continue; if (t0 < 0) t0 = 0; if (t1 > 1) t1 = 1;
      } else if (cq >= 0) continue;
      const y0 = a.y + dy * t0, y1 = a.y + dy * t1;
      if (y0 > c.h && y1 > c.h) continue;
      const t = y0 <= c.h ? t0 : t0 + (t1 - t0) * (y0 - c.h) / (y0 - y1);
      _sp.set(a.x + dx * t, a.y + dy * t, a.z + dz * t);
      _sn.set(_sp.x - c.x, 0, _sp.z - c.z); if (_sn.lengthSq() < 1e-8) _sn.set(a.x - c.x, 0, a.z - c.z); if (_sn.lengthSq() < 1e-8) _sn.set(0, 0, 1); _sn.normalize();
      return true;
    }
    if (b.z > WEST + 0.3 || b.z < EAST - 0.3) { const w = b.z > 0 ? WEST + 0.3 : EAST - 0.3, t = Math.abs(dz) > 1e-6 ? clamp((w - a.z) / dz) : 1; _sp.set(a.x + dx * t, a.y + dy * t, w); _sn.set(0, 0, b.z > 0 ? -1 : 1); return true; }
    return false;
  }
  /**
   * After the pose and the posture, before what she wears is placed: has the blade come into stone in this step? It
   * is swept from where it stood to where it stands, in slices; if it enters stone, the clip is put back to the moment
   * before (so no picture has the blade in the stone), the stroke is over, the blade springs back along its own path
   * and she needs a second before she can do anything: `clash { point, stone, dir, normal, weight, who: 'boss' }`,
   * a hit-stop, and `boss-move { stage: 'recover', open }` (the opening is his).
   */
  bladeStone(dt) {
    const sw = this.kit.sword, c = this.char, ctx = this.ctx;
    sw.base.getWorldPosition(_b); sw.tip.getWorldPosition(_t);
    if (this.bladeFresh) { this.bladeFresh = false; this.bPrev.copy(_b); this.tPrev.copy(_t); this.inStone = this.stoneAt(_b, _t); return; }
    const travel = Math.max(_t.distanceTo(this.tPrev), _b.distanceTo(this.bPrev)), n = Math.min(10, Math.max(1, Math.ceil(travel / 0.25)));
    let hit = 0;
    for (let k = 1; k <= n; k++) { const u = k / n; _a0.lerpVectors(this.bPrev, _b, u); _b0.lerpVectors(this.tPrev, _t, u); if (this.stoneAt(_a0, _b0)) { hit = k; break; } }
    if (!hit) { this.inStone = false; this.bPrev.copy(_b); this.tPrev.copy(_t); return; }
    if (this.inStone || this._state !== 'attack' || !this.move || this.recoil > 0 || this.flying) { this.bPrev.copy(_b); this.tPrev.copy(_t); return; }      // it stood in stone before this stroke moved it (one clash is enough), or she is not striking
    const live = !!this.armedWith, heavy = live && (this.armedWith.heavy || this.armedWith.weight === 'colossal'), name = this.moveName, h = this.handle;
    this.clashAt.copy(_sp); this.clashN.copy(_sn); this.clashDir.subVectors(_t, this.tPrev); if (this.clashDir.lengthSq() < 1e-8) this.clashDir.copy(_sn).negate(); this.clashDir.normalize();
    // back to where the blade was still free, and that pose is the one shown in this very step
    this.poseBack((hit - 1) / n);                                 // (the clip's clock, and the turn or the step that may have carried it in)
    this.recoilUp = this.post.up;
    for (let i = 0; i < 3; i++) {                                 // still in it (a fade, her posture or the guard coming down carried it in, not the clip's clock): the blade is thrown up off the stone until it is free
      sw.base.getWorldPosition(_b); sw.tip.getWorldPosition(_t); if (!this.stoneAt(_b, _t)) break;
      this.recoilUp = this.post.up = Math.min(1, this.post.up + 0.36);
      this.restorePosture(); this.applyPosture(0);
    }
    if (this.armedWith) this.disarm(); else { ctx.combat.disarm(this.weapon); if (this.trail) this.trail.stop(); }
    this.touch = null; this.slamDue = null; this.recoil = 1e-4; this.inStone = false;
    if (h) h.timeScale = -0.5;                                    // it springs back along its own path
    this.stage = 'recover';
    ctx.bus.emit('boss-move', { name, stage: 'recover', open: RECOIL.end, recoil: true });
    ctx.bus.emit('clash', { point: this.clashAt, stone: true, dir: this.clashDir, normal: this.clashN, weight: heavy ? 'colossal' : 'heavy', heavy: true, who: 'boss' });
    if (ctx.game && ctx.game.hitStop) ctx.game.hitStop(RECOIL.stop);
    sw.base.getWorldPosition(this.bPrev); sw.tip.getWorldPosition(this.tPrev);
  }

  // ---- the little code of single moves (called from boss_moves.js)
  /** Lunge: the line is fixed now (she no longer turns); how much of the clip's step does she need for the point to pass through him? */
  lungeAim() {
    this.var.reach = clamp((this.s.dist - 4.7) / 1.35, 0.4, 6.5);     // leaning, her point lies 6.7 m out and the clip's own step is 1.35 m: it goes two metres past where he stood, a step back does not save him
  }

  /** Leap: she leaves the floor. The blade will fall where he stands now. */
  leapStart() {
    const p = this.ctx.player, ctx = this.ctx;
    this.leapFrom.copy(this.pos); this.leapSpot(this.leapTo);
    this.var.yaw = Math.atan2(p.pos.x - this.leapTo.x, p.pos.z - this.leapTo.z) - this.aim;
    this.flying = true;
    if (ctx.water) ctx.water.ripple(this.pos.x, this.pos.z, 2.5, 1.2);
  }
  leapFly() {
    const pl = this.ctx.player, to = this.leapTo, t = this.char.time, u = smooth((t - 0.56) / 0.9);
    if (pl.alive) {                                               // he may run in under her: she comes down beside him, never on him
      const dx = to.x - pl.pos.x, dz = to.z - pl.pos.z, d = Math.hypot(dx, dz), min = this.radius + HIS + 0.6;
      if (d < min) {
        if (d > 1e-3) { const k = Math.min(min - d, 0.2) / d; to.x += dx * k; to.z += dz * k; } else { to.x -= Math.sin(this.yaw) * 0.2; to.z -= Math.cos(this.yaw) * 0.2; }
        this.ctx.arena.resolve(to, this.radius);
      }
    }
    this.pos.x = lerp(this.leapFrom.x, to.x, u); this.pos.z = lerp(this.leapFrom.z, to.z, u);
    this.yaw += angleDiff(this.var.yaw, this.yaw) * Math.min(1, u * 1.5 + 0.02);
  }
  leapLand() {
    const ctx = this.ctx;
    this.pos.x = this.leapTo.x; this.pos.z = this.leapTo.z; this.flying = false; this.collide(true);
    if (ctx.water) ctx.water.ripple(this.pos.x, this.pos.z, 4, 1.6);
    ctx.bus.emit('land', { who: 'boss', pos: this.pos, hard: true });
  }
  /** The ring of water runs out from where the blade struck (touchDown has just put that in slamAt). */
  leapRing() {
    const p = this.ctx.player, x = this.slamAt.x, z = this.slamAt.z;
    const g = this.fx.ring(x, z, { speed: 12, max: 11, damage: DAMAGE.leapRing, r0: 0.3, band: 0.4, quiet: 0.1, color: COLORS.PALE, power: 0.8, name: 'leap' });
    // whoever rolled through the blade itself, on the spot, has earned the ring too (one roll cannot cover both)
    if (g && p.invulnerable && Math.hypot(p.pos.x - x, p.pos.z - z) < 3.2) g.done = true;
  }

  /** Stomp: the heel is down. Whoever stands by it is thrown. */
  stompLand() {
    const ctx = this.ctx, p = ctx.player, B = this.char.bones, foot = B.LeftToeBase || B.LeftFoot, at = this.footAt;
    if (foot) foot.getWorldPosition(at); else at.copy(this.pos);
    at.y = WATER_Y;
    if (ctx.water) ctx.water.ripple(at.x, at.z, 3.5, 1.2);
    ctx.bus.emit('boss-slam', { pos: at, radius: STOMP.radius, power: 0.8 });
    if (p.alive && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < STOMP.radius) {      // the water bursts round HER: the man behind her feet is thrown as well as the man before them
      _d.set(p.pos.x - this.pos.x, 0, p.pos.z - this.pos.z); if (_d.lengthSq() < 1e-6) _d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); _d.normalize();
      ctx.combat.strike({ attacker: this, target: p, point: new THREE.Vector3(p.pos.x, 0.5, p.pos.z), dir: _d.clone(), damage: STOMP.damage, poise: STOMP.poise, heavy: STOMP.heavy, unblockable: true, kind: 'stomp' });
    }
  }

  /** The pipes sound. */
  sing(strength) { const w = this.kit.wings; if (w && w.pulse) w.pulse(strength); this.sung = Math.max(this.sung, strength); }
  choraleRing() {
    this.sing(1);
    this.fx.ring(this.pos.x, this.pos.z, { speed: 8, max: 22, damage: DAMAGE.chorale, r0: 1.6, band: 0.4, color: COLORS.GOLD, power: 1, name: 'chorale' });
  }
  hymnCast() { this.sing(0.6); this.fx.hymn(this.hp < this.hpMax * 0.25 ? 8 : 7, DAMAGE.hymn); }
  hymnLoose() { this.fx.hymnLoose(0.46, 0.3); }
  /** The Tide's wave leaves, once, the way she has put him (her `aim`), from where the blade's reach ends (6.2 m out):
   *  nearer than that the blade is the danger, beyond it the wave. Called when the point cuts the water (touchDown). */
  tideLoose() {
    if (this.var.tided) return; this.var.tided = true;
    const a = this.yaw + this.aim, fx = Math.sin(a), fz = Math.cos(a); this.sing(0.8);
    this.fx.tide(this.pos.x + fx * 6.2, this.pos.z + fz * 6.2, fx, fz, { speed: 11, width: 46, max: 40, damage: DAMAGE.wave });
  }

  // ------------------------------------------------------------------------------------------------ the stagger
  staggerPost(dt) {
    const c = this.char;
    this.stT += dt;
    if (!this.kneeDown && this.stStage === 0 && c.time >= 1.5) {                            // her knee meets the floor (the knee itself is watched, not the clip's clock): the water answers, there and then
      const KL = c.bones.LeftLeg, KR = c.bones.RightLeg; let low = 0;
      if (KL && KR) { KL.getWorldPosition(_v); KR.getWorldPosition(_t); low = Math.min(_v.y, _t.y); if (_t.y < _v.y) _v.copy(_t); } else _v.copy(this.pos);
      if (low <= 0.3 || c.time >= 2.2) {                           // (the joint's middle rests 15 cm over the floor)
        this.kneeDown = true; this.footAt.copy(_v); this.footAt.y = WATER_Y;
        if (this.ctx.water) this.ctx.water.ripple(this.footAt.x, this.footAt.z, 3.5, 1.3);
        this.ctx.bus.emit('boss-slam', { pos: this.footAt, radius: 3.2, power: 0.9 });
      }
    }
    if (this.stStage === 0 && (c.done || c.time >= c.duration - 0.05)) { this.stStage = 1; c.speed = 1; c.play('kneel_idle', { fade: 0.25, loop: true }); }
    if (this.stStage < 2 && this.stT >= STAGGER_TIME) { this.stStage = 2; this.staggered = false; this.staggerRest = STAGGER_REST; c.speed = 1.5; const a = c.play('kneel_up', { fade: 0.25, speed: 1, force: true }); if (a) a.timeScale = 1; }
    else if (this.stStage === 2 && (c.done || c.time >= c.duration - 0.35)) { c.speed = 1; this._state = 'idle'; this.rest(0.4); this.breath = 0.4; }
  }

  // ------------------------------------------------------------------------------------------------ posture
  /** Put back what applyPosture changed (the animation runtime writes every bone every step; this is for the step in which she becomes a puppet). */
  restorePosture() { const P = this.post; if (!P.on) return; for (let i = 0; i < P.bones.length; i++) P.bones[i].quaternion.copy(P.saved[i]); P.on = false; }

  /**
   * After the pose. Nothing here aims the blade by the wrist: the clips carry it, in both fists.
   *  - stoop: her whole body bows the way the blade points (three spine bones share it);
   *  - lower: the sword arm comes down from the shoulder, in the blade's own upright plane (the one-handed lunge);
   *  - up: both arms turned from the shoulders until the blade stands upright (the stomp: her trunk leans far over);
   *  - the floor: a blade is a solid thing. Where the stroke would carry its point under the floor, it rides on it.
   */
  applyPosture(dt) {
    const P = this.post, p = this.part, sw = this.kit.sword;
    const rate = p && p.snap ? 26 : 8;
    P.stoop = damp(P.stoop, p && p.stoop ? p.stoop : 0, rate, dt); P.lower = damp(P.lower, p && p.lower ? p.lower : 0, rate, dt); P.up = damp(P.up, this._state === 'dead' ? 1 : this.recoil > 0 ? Math.max(this.recoilUp, this.guardUp) : p ? (p.up === 'near' ? this.guardUp : p.up || 0) : this.guardUp, this._state === 'dead' ? 9 : 6, dt);      // (struck dead she keeps the blade up in her fist: her fall's flailing arm swept it, harmless, through the man who felled her)
    this.riding = false;
    const blade = !!P.hand && !!sw && !!sw.tip && !!sw.base && !this.kit.swordPlanted;
    if (!blade) return;
    const lean = P.stoop >= 0.004 || P.lower >= 0.004, up = P.up >= 0.004 && !!P.armR;
    if (!lean && !up && !this.tipUnder()) return;
    for (let i = 0; i < P.bones.length; i++) P.saved[i].copy(P.bones[i].quaternion);
    P.on = true;
    if (up) {                                                     // the blade is kept upright whatever her trunk does (the stomp leans her far over): both arms from the shoulders, the fists as they are
      sw.base.getWorldPosition(_b); sw.tip.getWorldPosition(_t); _d.subVectors(_t, _b);
      if (_d.lengthSq() > 1e-6) {
        _d.normalize(); const ang = Math.acos(clamp(_d.y, -1, 1)) * P.up;
        if (ang > 1e-3) { _ax.crossVectors(_d, UP); if (_ax.lengthSq() > 1e-8) { _rot.setFromAxisAngle(_ax.normalize(), Math.min(ang, 1.2)); this.turnBone(P.armR, _rot); if (P.armL && this.kit.leftOn > 0.5) this.turnBone(P.armL, _rot); } }
      }
    }
    if (lean) {
      sw.base.getWorldPosition(_b); sw.tip.getWorldPosition(_t); _d.subVectors(_t, _b); _d.y = 0;
      if (_d.lengthSq() > 1e-6) {
        _ax.crossVectors(UP, _d).normalize();                     // the level axis square to the blade: a turn about it tips the point down
        if (P.stoop >= 0.004 && P.spine.length) { _rot.setFromAxisAngle(_ax, P.stoop / P.spine.length); for (const bone of P.spine) this.turnBone(bone, _rot); }
        if (P.lower >= 0.004 && P.armR) { _rot.setFromAxisAngle(_ax, P.lower); this.turnBone(P.armR, _rot); }
      }
    }
    this.rideFloor();
  }
  /** Where the point rides at (x, z): on the stone (the nave's floor, or the dais's steps east of the play area), under the water's skin. */
  floorAt(x, z) { const a = this.ctx.arena; return (a && a.ground ? a.ground(x, z) : 0) + RIDE; }
  /** Is the blade's point under the floor? */
  tipUnder() { this.kit.sword.tip.getWorldPosition(_t); return _t.y < this.floorAt(_t.x, _t.z); }
  /**
   * The point rides on the floor. The blade is turned about the level axis square to it, just far enough: first in
   * the wrist (at most WRIST: a wrist gives that, and her left fist follows the grip: the wardrobe draws it on), then
   * by both arms together from the shoulders, so both fists stay where they are on the grip.
   */
  rideFloor() {
    const P = this.post, sw = this.kit.sword; let wrist = 0;
    for (let i = 0; i < 4; i++) {
      sw.tip.getWorldPosition(_t); const fy = this.floorAt(_t.x, _t.z); if (_t.y >= fy - 0.003) break;
      const arms = wrist >= WRIST - 1e-3, pivot = arms ? P.armR : P.hand; if (!pivot) break;
      pivot.getWorldPosition(_v); _d.subVectors(_t, _v);
      const len = _d.length(), flat = Math.hypot(_d.x, _d.z);
      if (len < 1e-3 || flat < 0.2 * len) break;                  // it stands on its point: there is no side to swing it out to
      let ang = Math.asin(clamp((fy - _v.y) / len, -1, 1)) - Math.atan2(_d.y, flat);        // + raises the point
      if (ang < 1e-4) break;
      _ax.set(_d.x, 0, _d.z).normalize(); _ax.crossVectors(_ax, UP).normalize();
      if (arms) { ang = Math.min(ang, 0.7); _rot.setFromAxisAngle(_ax, ang); this.turnBone(P.armR, _rot); if (P.armL && this.kit.leftOn > 0.5) this.turnBone(P.armL, _rot); }
      else { ang = Math.min(ang, WRIST - wrist); wrist += ang; _rot.setFromAxisAngle(_ax, ang); this.turnBone(P.hand, _rot); }
      this.riding = true;
    }
    return this.riding;
  }
  /** Turn a bone by a rotation given in the world. */
  turnBone(bone, worldRot) {
    bone.parent.getWorldQuaternion(_pw);
    _q2.copy(_pw).invert().multiply(worldRot).multiply(_pw).multiply(bone.quaternion);
    bone.quaternion.copy(_q2);
  }

  /** The first touch of a live stroke on the floor is the slam: told at the very place, the water struck there. */
  touchDown() {
    const o = this.touch, ctx = this.ctx, sw = this.kit.sword, at = this.slamAt; this.touch = null;
    sw.tip.getWorldPosition(_t); sw.base.getWorldPosition(_b);
    if (o.line) {                                                 // the blade lies along the water: it bursts along the whole length, and the blow's middle is the place
      this.fx.burst(lerp(_b.x, _t.x, 0.25), lerp(_b.z, _t.z, 0.25), _t.x, _t.z, o.power);
      at.set(lerp(_b.x, _t.x, 0.6), WATER_Y, lerp(_b.z, _t.z, 0.6));
    } else { at.set(_t.x, WATER_Y, _t.z); if (ctx.water) ctx.water.ripple(at.x, at.z, 3 * o.power, 0.9); if (ctx.vfx && ctx.vfx.spray) ctx.vfx.spray(at, UP, 10, 0.5 + o.power); }
    ctx.bus.emit('boss-slam', { pos: at, radius: o.r, power: o.power });
    if (o.on) o.on(this);
  }

  // ------------------------------------------------------------------------------------------------ light, wings, water
  /** What she wears answers what she does: the blade lights before it can hurt, the pipes flare, and in phase two she shines. */
  dress(dt) {
    const kit = this.kit, p = this.part, two = this._phase === 2 && this.alive;
    this.glow = damp(this.glow, this.alive && p && p.glow !== undefined ? p.glow : 0, 7, dt);
    this.flare = damp(this.flare, this.alive && p && p.wings !== undefined ? p.wings : 0, 5, dt);
    this.shine = damp(this.shine, two ? 1 : 0, two ? 1.5 : 0.7, dt);
    this.sung = Math.max(0, this.sung - dt * 1.6);
    if (kit.sword) kit.sword.glow = Math.max(this.shine * 0.45, this.glow);
    const open = this.alive ? (two ? 1 : 0.1 + 0.5 * this.flare) : 0;
    if (kit.wings) { kit.wings.open = open; kit.wings.glow = Math.max(this.shine * (0.6 + 0.4 * this.glow), 0.3 * this.flare); }
    this.wall = damp(this.wall, lerp(WALL[0], WALL[1], open), 1.2, dt);      // open wings need room: she keeps further from the walls (it eases: she is never snatched inward)
    if (kit.halo) kit.halo.glow = 0.15 + 0.85 * this.shine;
    this.lightStep(dt, false);
  }
  lightStep(dt, puppet) {
    const L = this.light; if (!L) return;
    const B = this.char.bones, kit = this.kit;
    let level = this.lightLevel !== null && this.lightLevel !== undefined ? this.lightLevel : puppet ? Math.max(this.shine, (kit.wings && kit.wings.glow) || 0) : this.shine;
    if (kit.fade) level *= 1 - kit.fade;
    L.intensity = this.lightPower * level * (1 + 0.7 * this.sung + 0.35 * this.glow);
    if (B.Spine2) { B.Spine2.getWorldPosition(_v); const y = this.yaw; L.position.set(_v.x - Math.sin(y) * 1.7, _v.y + 2.2, _v.z - Math.cos(y) * 1.7); }      // behind and above her shoulders, where the pipes are: it rims her and lights the hall, it does not bleach her face
  }
  /** Where the blade's point is in the water it cuts a wake, and where it runs fast along the floor it throws spray
   *  (every second step: `dt` is the time since the last call). */
  bladeWater(dt) {
    const ctx = this.ctx, sw = this.kit.sword; if (!sw || !sw.tip) return;
    sw.tip.getWorldPosition(_t);
    const low = _t.y < WATER_Y + 0.15, pv = this.tipPrev;
    if (low && this.tipLow) {
      const d = Math.hypot(_t.x - pv.x, _t.z - pv.z);
      if (d > 0.12 && d < 6) {
        if (ctx.water) ctx.water.wake(pv.x, pv.z, _t.x, _t.z, clamp(d * 1.2, 0.4, 2.5));
        const v = d / dt;
        if (v > 9 && ctx.vfx && ctx.vfx.spray) {                   // thrown up and on, the way the point is going
          _v.set(_t.x, WATER_Y, _t.z); _d.set((_t.x - pv.x) / d * 0.6, 1, (_t.z - pv.z) / d * 0.6).normalize();
          ctx.vfx.spray(_v, _d, 7, clamp(v / 45, 0.35, 1));
        }
      }
    }
    pv.copy(_t); this.tipLow = low;
  }

  /** Her body as the pilgrim meets it: `solid`, capsules in the world (metres), written after the pose. */
  solidUpdate() {
    const S = this.solid, Bn = this.solidBones;
    for (let i = 0, k = 0; k < Bn.length; i++, k += 2) { Bn[k].getWorldPosition(S[i].a); Bn[k + 1].getWorldPosition(S[i].b); }
    const sk = this.skirt;
    if (sk) { const B = this.char.bones; B.Hips.getWorldPosition(sk.a); B.LeftFoot.getWorldPosition(_v); B.RightFoot.getWorldPosition(sk.b); sk.b.add(_v).multiplyScalar(0.5); sk.b.y = Math.min(sk.b.y, 0.3); }
    // Her train: behind her heels, along the way she faces away from (it follows her turns a little late: the cloth does).
    { const tr = this.train, y = this.yaw, bx = -Math.sin(y), bz = -Math.cos(y), h0 = this.flying ? 50 : 0.3; this.trainYaw = this.trainYaw === undefined ? y : this.trainYaw + angleDiff(y, this.trainYaw) * 0.12; const ty = this.trainYaw, tx = -Math.sin(ty), tz = -Math.cos(ty);
      tr.a.set(this.pos.x + bx * TRAIN.from, h0, this.pos.z + bz * TRAIN.from); tr.b.set(this.pos.x + tx * TRAIN.to, h0, this.pos.z + tz * TRAIN.to); }
    { const y = this.yaw, fx = Math.sin(y), fz = Math.cos(y), lx = Math.cos(y), lz = -Math.sin(y), h0 = this.flying ? 50 : 0.3;      // the hem's back corners and the pipes' mouths: they turn with her
      for (let i = 0; i < 2; i++) { const sg = i ? -1 : 1, c = this.hems[i];
        c.a.set(this.pos.x + lx * HEM.lat[0] * sg - fx * HEM.back[0], h0, this.pos.z + lz * HEM.lat[0] * sg - fz * HEM.back[0]);
        c.b.set(this.pos.x + lx * HEM.lat[1] * sg - fx * HEM.back[1], h0, this.pos.z + lz * HEM.lat[1] * sg - fz * HEM.back[1]); } }
    // Her blade: a solid thing to him whenever it cannot hurt and is not in flight (lying on the water after the cleave,
    // hanging beside her on one knee, dragged slowly back to guard): he is pushed out of it, it never passes through him
    // for nothing. Live, or moving fast, it is combat's business (parked over his head here).
    const bl = this.blade, sw = this.kit.sword;
    if (sw && sw.tip && sw.base && !this.kit.swordPlanted && this.alive) {
      sw.tip.getWorldPosition(_t); sw.base.getWorldPosition(_b);
      this.bladeV = _t.distanceTo(bl.tipWas || (bl.tipWas = _t.clone())) / (this.ctx.DT || 1 / 60); bl.tipWas.copy(_t);
      const spent = this._state !== 'attack' || this.stage === 'recover' || this.bladeSpent;      // a stroke is over (or was stopped by his shield), or she is going down on one knee: the blade shoves him aside even as it falls; in a wind-up only a slow blade does
      // (last polish: a falling blade that has struck him, `bladeHit`, is solid at once and along its whole line on the ground:
      // that is where it is coming down. Only while it falls: lifted away again it passes over his head as it is.)
      if ((!this.armedWith || this.bladeHit) && this.bladeV < (this.bladeSpent || this.bladeHit ? 99 : spent ? 14 : 2.5)) {
        bl.a.copy(_b); bl.b.copy(_t);
        if (this.bladeHit && this.armedWith) { bl.a.y = Math.min(bl.a.y, 1); bl.b.y = Math.min(bl.b.y, 1); }
      } else { bl.a.set(0, 50, 0); bl.b.set(0, 50, 0); }      // (he meets only what of it is at a man's height)
    } else { bl.a.set(0, 50, 0); bl.b.set(0, 50, 0); }
  }

  /** Clip events: her feet. */
  onClip(e) {
    if (e.name !== 'foot-l' && e.name !== 'foot-r') return;
    const B = this.char.bones, foot = e.name === 'foot-l' ? B.LeftFoot : B.RightFoot; if (!foot) return;
    foot.getWorldPosition(this.footAt); this.footAt.y = 0;
    this.ctx.bus.emit('step', { who: 'boss', pos: this.footAt, foot: e.name === 'foot-l' ? 'l' : 'r', run: false });
  }
}
