// The game: builds every module, runs the fixed-step clock and keeps the state machine
// (title -> intro -> fight -> phase -> fight -> won; a fall in the fight -> rescue -> fight). See docs/engine.md for the contracts.
//
// What the game loads: each module exports ASSETS = { name: 'path' } and they are merged here, so an owner adds a file
// to the game by adding a line to their own module.
import * as THREE from 'three';
import { Bus } from './core/events.js';
import { Assets } from './core/assets.js';
import { Loop } from './core/loop.js';
import { damp } from './core/math.js';
import * as inputMod from './core/input.js';
import * as gfxMod from './gfx/renderer.js';
import * as arenaMod from './world/arena.js';
import * as waterMod from './gfx/water.js';
import * as candlesMod from './world/candles.js';
import * as vfxMod from './gfx/vfx.js';
import * as audioMod from './audio/audio.js';
import * as combatMod from './chars/combat.js';
import * as playerMod from './chars/player.js';
import * as bossMod from './chars/boss.js';
import * as camMod from './cam/camera.js';
import * as cineMod from './cam/cine.js';
import * as uiMod from './ui/ui.js';

const MODULES = [inputMod, gfxMod, arenaMod, waterMod, candlesMod, vfxMod, audioMod, combatMod, playerMod, bossMod, camMod, cineMod, uiMod];
// He cannot lose (Kevin, 10 Nov: "make it so you CANT LOSE"): a fall holds for a moment in the play camera, then the
// rescue (src/cine/rescue.js) gives him his life back where he lies and the fight goes on. There is no death screen.
const RESCUE = { wait: 0.7 };                 // seconds of the fall seen in the play camera before the cutscene cuts in
const WON_FADE = 3.2;                        // seconds the hall takes to go to black under the name, once the ending is over
const _v = new THREE.Vector3();

export class Game {
  constructor({ canvas, uiRoot, params }) {
    const auto = params.has('shot') || params.has('perf') || params.has('fight') || params.has('pilot') || params.has('capture');
    this.seed = +(params.get('seed') || 1) || 1;               // every random choice in play is drawn from generators seeded with this
    this.canvas = canvas; this.params = params; this.auto = auto; this.dev = params.has('dev') || auto;
    this.state = 'boot'; this.time = 0; this.stateTime = 0; this.paused = false; this.skipHold = 0; this.slowT = 0; this.drawFrames = true; this.killWait = null;
    const ctx = this.ctx = { DT: 1 / 60, params, bus: new Bus(), assets: new Assets(), game: this, dev: this.dev };
    ctx.input = new inputMod.Input(ctx, canvas);
    ctx.ui = new uiMod.UI(ctx, uiRoot);
    this.loop = new Loop({ step: (dt) => this.step(dt), frame: (dt, a) => this.frame(dt, a), onError: (e) => this.fail(e) });
  }

  async load() {
    const ctx = this.ctx, p = this.params, manifest = {};
    for (const m of MODULES) Object.assign(manifest, m.ASSETS || {});
    await ctx.assets.load(manifest, (f) => ctx.ui.setLoading(f * 0.9));
    const size = this.auto ? [+(p.get('shotw') || 1600), +(p.get('shoth') || 900)] : null;
    // A phone or a tablet starts on a lighter picture, unless the player has already chosen one (the options screen
    // shows what it is, and it can be raised there). `&phone=1` / `&phone=0` say which this is, for looking at it.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const phone = p.has('phone') ? p.get('phone') !== '0' : coarse && Math.min(window.innerWidth, window.innerHeight) < 560;
    if (!p.get('q') && !(ctx.ui.saved && ctx.ui.saved.quality) && (coarse || phone)) ctx.ui.settings.quality = phone ? 'low' : 'medium';
    ctx.gfx = new gfxMod.Gfx(ctx, this.canvas, { quality: p.get('q') || ctx.ui.settings.quality || 'high', size, phone, preserve: this.auto });
    ctx.scene = ctx.gfx.scene; ctx.camera = ctx.gfx.camera;
    ctx.arena = new arenaMod.Arena(ctx);
    ctx.water = new waterMod.Water(ctx);
    ctx.candles = new candlesMod.Candles(ctx);
    ctx.vfx = new vfxMod.Vfx(ctx);
    ctx.audio = new audioMod.GameAudio(ctx);
    ctx.combat = new combatMod.Combat(ctx);
    ctx.player = new playerMod.Player(ctx);
    ctx.boss = new bossMod.Boss(ctx);
    ctx.cam = new camMod.PlayCamera(ctx);
    ctx.cine = new cineMod.Cine(ctx);
    ctx.ui.on((e) => this.onUi(e));
    ctx.bus.on('boss-phase', (e) => { if (e.phase === 2 && this.state === 'fight') this.pendingPhase = true; });
    if (ctx.gfx.warm) await ctx.gfx.warm();                    // compile shaders and upload textures before the first frame
    ctx.ui.setLoading(1); if (ctx.ui.loaded) ctx.ui.loaded();
  }

  start(at = 'title') { this.begin(at); this.loop.start(); }
  fail(e) { console.error(e); document.title = 'error: ' + e.message; }

  set(state) { const from = this.state; if (from === state) return; this.state = state; this.stateTime = 0; this.ctx.input.wantLock = state === 'fight'; this.ctx.bus.emit('state', { from, to: state }); }

  /** Put the fight back to its beginning: both fighters at their marks, full health, phase one, candles lit. */
  resetFight() {
    const c = this.ctx;
    if (c.cine.playing) c.cine.skip();
    c.cine.title(false);
    c.player.puppet = false; c.boss.puppet = false;
    c.player.reset(); c.boss.reset();
    c.candles.relight(1, 0); c.gfx.mood.candle = 1; c.gfx.mood.gold = 0;
    c.gfx.post.fade = 0; c.gfx.post.letterbox = 0; c.gfx.post.hurt = 0; c.ui.fade(0); c.ui.letterbox(0); c.ui.banner(null); c.ui.prompt(null);
    this.pendingPhase = false; this.relit = 0; this.wonStage = 0; this.killWait = null; this.rescueWait = 0; this.rescues = 0;
    if (c.cam.mode !== 'free') { c.cam.mode = 'free'; c.player.locked = false; }
    c.cam.snapBehind();
  }

  /** Start from a named point: 'title' | 'intro' | 'fight' | 'phase2' (the cutscene, then phase two) | 'fight2' | 'ending' | 'rescue' (he falls; 'dead' is the same). */
  begin(at = 'title', o = {}) {
    const c = this.ctx;
    this.resetFight(); this.pause(false);
    if (at === 'title') { this.set('title'); c.ui.showScreen('title'); c.cine.title(true); c.audio.music('title'); }
    else if (at === 'intro') { this.set('intro'); c.ui.showScreen('none'); c.cine.play('intro'); c.audio.music('intro'); }
    else if (at === 'phase2') { c.boss.hp = c.boss.hpMax * 0.5; c.boss.phase = 2; this.toFight(false); this.toPhase(o); }
    else if (at === 'fight2') { c.boss.hp = c.boss.hpMax * 0.5; this.applyPhase(2); this.toFight(); }
    else if (at === 'ending') { c.boss.hp = 0; c.boss.alive = false; this.applyPhase(2); this.toFight(false); this.toWon(o); }
    else if (at === 'rescue' || at === 'dead') {                // a blow that fells him (&death=face: from behind, so he falls on his face)
      this.toFight(); c.player.hp = 1; if (this.params.get('death') === 'face') c.player.yaw = Math.atan2(c.player.pos.x - c.boss.pos.x, c.player.pos.z - c.boss.pos.z);
      c.combat.strike({ attacker: c.boss, target: c.player, damage: 999, heavy: true });
    }
    else this.toFight();
  }
  toFight(music = true) { const c = this.ctx; this.set('fight'); c.ui.showScreen('hud'); if (music) c.audio.music(c.boss.phase === 2 ? 'phase2' : 'phase1'); }
  toPhase(o = {}) { const c = this.ctx; this.set('phase'); c.ui.showScreen('none'); c.cine.play('phase2'); c.audio.music('turn'); }
  toWon(o = {}) { const c = this.ctx; this.set('won'); this.wonStage = 0; c.ui.showScreen('none'); c.cine.play('ending'); c.audio.music('ending'); }
  /** The lasting changes of a phase (the cutscene shows them happening; this makes sure they have happened). */
  applyPhase(n) { const c = this.ctx; if (n === 2) { c.boss.enterPhase(2); if (c.candles.lit > 0.02) c.candles.snuffAll(0); c.gfx.mood.candle = 0; c.gfx.mood.gold = 1; this.relit = 0; } }

  pause(on) {
    if (this.paused === on) return; this.paused = on; this.loop.scale = on ? 0 : 1;
    if (on) { this.ctx.ui.showScreen('pause'); if (document.exitPointerLock) document.exitPointerLock(); } else if (this.state === 'fight') this.ctx.ui.showScreen('hud');
    if (!on && this.ctx.input.settle) this.ctx.input.settle();      // the button that chose "Resume" is still under the thumb: not a press in the fight (a gamepad's A is also the jump)
    if (this.ctx.audio.pause) this.ctx.audio.pause(on);
  }
  /** Hold the world still for a moment (a heavy blow lands). */
  hitStop(seconds) { this.loop.freeze = Math.max(this.loop.freeze, seconds); }
  /** Run the world slowly for a while (real seconds). */
  slow(scale, seconds) { this.loop.scale = scale; this.slowT = seconds; }

  onUi(e) {
    const c = this.ctx;
    if (e.type === 'play') { c.audio.unlock(); if (this.state === 'title') this.begin(e.skipIntro ? 'fight' : 'intro'); }
    else if (e.type === 'resume') this.pause(false);
    else if (e.type === 'restart') this.begin('fight');
    else if (e.type === 'title') this.begin('title');
    else if (e.type === 'skip') c.cine.skip();
    else if (e.type === 'setting') {
      if (e.key === 'quality') c.gfx.setQuality(e.value);
      else if (e.key === 'sensitivity') c.input.sensitivity = e.value; else if (e.key === 'invertY') c.input.invertY = e.value;
      else if (e.key === 'music' || e.key === 'sfx' || e.key === 'voice') c.audio.setVolumes(c.ui.settings);
      c.bus.emit('setting', { key: e.key, value: e.value });
    }
  }

  /** Cutscenes are skipped by holding the button for a little while, never by a stray tap. */
  skipping(dt) {
    const c = this.ctx;
    if (!c.cine.playing) { if (this.skipHold) { this.skipHold = 0; if (c.ui.skip) c.ui.skip(0); } return; }
    if (c.input.held('skip')) { this.skipHold += dt; if (this.skipHold > 0.7) { this.skipHold = 0; c.cine.skip(); } } else this.skipHold = Math.max(0, this.skipHold - dt * 2);
    if (c.ui.skip) c.ui.skip(Math.min(1, this.skipHold / 0.7));
  }

  logic(dt) {
    const c = this.ctx, st = this.state; this.stateTime += dt; const t = this.stateTime;
    this.skipping(dt);
    if (st === 'intro') { if (!c.cine.playing) this.toFight(); }
    else if (st === 'fight') {
      if (!c.player.alive) { this.set('rescue'); this.rescueWait = RESCUE.wait; c.bus.emit('player-died', {}); }
      else if (!c.boss.alive) {
        // the killing blow is allowed to be seen: a breath of slow motion while she is struck and begins to fall, then the ending
        if (this.killWait === null) { this.killWait = 0.55; this.slow(0.3, 1.5); }
        else if ((this.killWait -= dt) <= 0) { this.killWait = null; this.toWon(); }
      }
      else if (this.pendingPhase) { this.pendingPhase = false; this.toPhase(); }
      else if (c.input.pressed('pause')) this.pause(true);
      else if (c.boss.phase === 2) {                           // her light fails: the candles come back a few at a time
        const want = Math.floor((1 - c.boss.hp / (c.boss.hpMax * 0.5)) * 6) / 10;
        if (want > this.relit) { this.relit = want; c.candles.relight(want, 2.5); }
      }
    } else if (st === 'phase') { if (!c.cine.playing) { this.applyPhase(2); this.toFight(true); } }
    else if (st === 'rescue') {
      if (this.rescueWait > 0) { this.rescueWait -= dt; if (this.rescueWait <= 0) { c.ui.showScreen('none'); c.cine.play('rescue'); } }
      else if (!c.cine.playing) { this.toFight(false); c.bus.emit('player-rescued', {}); }
    } else if (st === 'won') {
      // When the ending is over the hall goes to black and the game's name stands on it; the way back to the title comes
      // a moment later (the interface's end card does both: src/ui/style.js). No banner: Kevin, 9 Nov: "Don't need
      // 'cantor silenced', so fade to evensong".
      if (this.wonStage === 0 && !c.cine.playing) { this.wonStage = 1; this.stateTime = 0; c.candles.relight(1, 4); c.ui.showScreen('end'); }
      else if (this.wonStage === 1) { const f = Math.min(1, t / WON_FADE), k = f * f * (3 - 2 * f); c.gfx.post.fade = k; c.ui.fade(k); if (f >= 1) this.wonStage = 2; }
    }
    if (this.fadeIn > 0) { this.fadeIn = Math.max(0, this.fadeIn - dt / 1.2); c.gfx.post.fade = this.fadeIn; c.ui.fade(this.fadeIn); }
    if (!c.cine.playing && (st === 'fight' || st === 'rescue')) {       // the light follows the candles and her phase
      const m = c.gfx.mood; m.candle = damp(m.candle, c.candles.lit, 2, dt); m.gold = damp(m.gold, c.boss.phase === 2 && c.boss.alive ? 1 : 0, 1.5, dt);
    }
  }

  step(dt) {
    const c = this.ctx;
    c.input.update();
    if (this.beforeStep) this.beforeStep(dt);
    this.time += dt;
    this.logic(dt);
    c.player.update(dt); c.boss.update(dt); c.combat.update(dt);
    c.arena.update(dt); c.water.update(dt); c.candles.update(dt); c.vfx.update(dt);
    c.cine.update(dt); c.cam.update(dt);
    c.ui.update(dt); c.audio.update(dt);
    if (this.afterStep) this.afterStep(dt);
  }

  frame(dt, alpha) {
    const c = this.ctx;
    if (this.slowT > 0) { this.slowT -= dt; if (this.slowT <= 0 && !this.paused) this.loop.scale = 1; }
    if (!this.drawFrames) return;
    if (c.cam.frame) c.cam.frame(dt, alpha);
    if (this.cameraHook) this.cameraHook(c.camera);
    c.audio.setListener(c.camera);
    const p = c.player, b = c.boss, hud = this.state === 'fight' || this.state === 'rescue';
    c.ui.setPlayer({ hp: p.hp, hpMax: p.hpMax, stamina: p.stamina, staminaMax: p.staminaMax, flasks: p.flasks, flasksMax: p.flasksMax });
    c.ui.setBoss({ name: b.name, hp: b.hp, hpMax: b.hpMax, visible: hud && b.alive });
    if (c.cam.mode === 'lock' && b.alive) {
      if (c.cam.lockPoint) _v.copy(c.cam.lockPoint); else _v.set(b.pos.x, 0.55 * 6.6, b.pos.z);
      _v.project(c.camera); const r = this.canvas.getBoundingClientRect();
      c.ui.setLock((_v.x * 0.5 + 0.5) * r.width, (-_v.y * 0.5 + 0.5) * r.height, _v.z < 1);
    } else c.ui.setLock(0, 0, false);
    if (c.water.frame) c.water.frame(dt, alpha); if (c.vfx.frame) c.vfx.frame(dt, alpha);
    c.gfx.render(dt);
  }
}
