// Cutscenes: the opening, the change of phase, the ending, and the living picture behind the title screen.
// The contract is in docs/engine.md ("Cinematics"); how the pieces are made is in docs/modules/cinematics.md.
//
//   await cine.play('intro' | 'phase2' | 'ending' | 'rescue')   resolves (with true if it was skipped) when it ends
//   cine.skip()                                      ends it at once, leaving the world as its natural end would
//   cine.playing, cine.name, cine.time, cine.duration, cine.shot (the name of the shot in front)
//   cine.title(on)                                   stage and film the still scene behind the title screen
//   cine.update(dt)                                  once per fixed step (after the fighters, before the play camera)
//
// While a cutscene plays, ctx.cam.mode is 'cine', both fighters are puppets, ctx.camera and gfx.post.dof /
// letterbox / fade / exposure are driven from here, and 'cine' events go out on the bus ({ name, on, skipped }).
// The engine is in src/cine: timeline.js (shots, events, spans), rig.js (the camera), stage.js (actors, their things,
// the room), ease.js (curves); the pieces are intro.js, phase2.js, ending.js and title.js.
import { Stage } from '../cine/stage.js';
import { Rig, LENS } from '../cine/rig.js';
import { Title } from '../cine/title.js';
import { buildIntro } from '../cine/intro.js';
import { buildPhase2 } from '../cine/phase2.js';
import { buildEnding } from '../cine/ending.js';
import { buildRescue } from '../cine/rescue.js';
import { RescueProps } from '../cine/rescue_props.js';
import { clamp, smooth } from '../cine/ease.js';

// The score's cue times (the pictures are cut to them). Optional: src/cine/cues.js holds the same numbers.
export const ASSETS = {
  'cine.music': { url: 'assets/audio/music/music.json', type: 'json', optional: true },
};

const BUILD = { intro: buildIntro, phase2: buildPhase2, ending: buildEnding, rescue: buildRescue };
const SECTION = { intro: 'intro', phase2: 'turn', ending: 'ending' };      // the section of the score each is cut to (the rescue: none; the fight's music goes on under it)
const FADE_UP = 0.45;                 // after a skip the picture comes up from black over this long

/**
 * Dev only, for whoever composes a shot: try several cameras in ONE picture run.
 *   &cineprobe=k:1,2.2,-2.6,0,1.2,0,32;c:0,1,9,0,5,0,40;0.6,12,20,0,0.5,6    cameras: x,y,z, look x,y,z [, fov [, aperture 0..1]]
 *                                  k: = both points measured from the pilgrim's feet, c: from the Cantor's, none: the world
 *   &probeat=40.9                  the cutscene clock (the title: seconds since it began) at which the first is shown
 * From that moment each step shows the next camera, so a strip with `--frames N --dt 0.0167` is N views of one moment:
 *   python3 tools/shot.py "/?dev&at=intro&ct=40.8&t=0.1&ui=0&probeat=40.9&cineprobe=..." probe.png --frames 6 --dt 0.0167
 */
function readProbe(ctx) {
  if (!ctx.dev || typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search), text = q.get('cineprobe'); if (!text) return null;
  const list = [];
  for (const part of text.split(';')) {
    const m = part.trim().match(/^(?:([kc]):)?(.+)$/); if (!m) continue;
    const n = m[2].split(',').map(Number);
    if (n.length >= 6 && n.every(Number.isFinite)) list.push({ rel: m[1] || '', n }); else console.error('&cineprobe: cannot read "' + part + '"');
  }
  return list.length ? { list, at: +q.get('probeat') || 0, i: -1 } : null;
}

export class Cine {
  constructor(ctx) {
    this.ctx = ctx; this.stage = new Stage(ctx); this.rig = new Rig(ctx); this.titleScene = new Title(ctx, this.stage, this.rig);
    this.playing = false; this.name = null; this.time = 0; this.duration = 0; this.scene = null;
    this.titleOn = false; this._done = null; this.fadeUp = 0; this.prevMode = 'free'; this.playFov = 50; this.lb = -1;
    this.probe = readProbe(ctx);
    this.props = new RescueProps(ctx);                // the rescue's lamp and carton, made once (src/cine/rescue_props.js)
  }
  /** Dev (&cineprobe): the next of the cameras asked for, in place of the shot's own. */
  probeStep(clock) {
    const p = this.probe, ctx = this.ctx; if (clock < p.at - 0.004) return;
    p.i = Math.min(p.list.length - 1, p.i + 1);
    const c = p.list[p.i], n = c.n, o = c.rel === 'k' ? ctx.player.pos : c.rel === 'c' ? ctx.boss.pos : null, ox = o ? o.x : 0, oz = o ? o.z : 0, cam = ctx.camera;
    cam.position.set(n[0] + ox, n[1], n[2] + oz); cam.up.set(0, 1, 0); cam.lookAt(n[3] + ox, n[4], n[5] + oz);
    const fov = n[6] || 35; if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    const dof = ctx.gfx.post.dof, ap = n[7] || 0, d = Math.hypot(n[3] - n[0], n[4] - n[1], n[5] - n[2]);
    dof.on = ap > 0.001; dof.focus = d; dof.aperture = Math.min(LENS.max, ap * LENS.k / (d * Math.tan(fov * Math.PI / 360))); dof.maxBlur = LENS.maxBlur;
  }
  /** The name of the shot in front (for the dev tools and for looking at one shot). */
  get shot() { return this.scene && this.scene.current ? this.scene.current.name : null; }

  play(name, opts = {}) {
    const ctx = this.ctx, build = BUILD[name];
    if (this.playing) this.finish(true);
    if (!build) { console.warn(`cine: no cutscene called "${name}"`); return Promise.resolve(false); }
    if (this.titleOn) { this.titleOn = false; this.titleScene.stop(); }
    this.fadeUp = 0;
    this.prevMode = ctx.cam.mode === 'cine' ? 'free' : ctx.cam.mode; this.stage.playMode = this.prevMode;
    this.playFov = ctx.cam.mode === 'cine' ? this.playFov : ctx.camera.fov;
    ctx.cam.mode = 'cine';
    this.stage.puppets(true);
    this.scene = build(ctx, this.stage, this.rig);
    this.playing = true; this.name = name; this.time = 0; this.duration = this.scene.duration;
    ctx.bus.emit('cine', { name, on: true });
    this.scene.step(0, ctx.DT);                    // the first frame is the cutscene's, whatever step it was asked for in
    return new Promise((r) => { this._done = r; });
  }

  skip() { if (this.playing) this.finish(true); }

  finish(skipped = false) {
    const ctx = this.ctx, sc = this.scene, name = this.name, post = ctx.gfx.post, cam = ctx.camera;
    this.playing = false; this.scene = null;
    sc.end(skipped);                               // the piece's own end state: the one place it is written
    this.stage.release();
    // after the ending the pilgrim stays as the cutscene left him, standing at rest with his sword put up, until the game
    // begins again (game.resetFight frees him and draws his sword): given back to his own rules he would take his guard
    // (and what is left of her stays where the cutscene put it: started from the dev tools she is not in her 'dead'
    // state, and walked off, unseen, when her rules took her back)
    if (name === 'ending') { ctx.player.puppet = true; ctx.boss.puppet = true; }
    if (skipped) this.stage.hush();
    post.letterbox = 0; post.dof.on = false; post.exposure = 1; post.fade = 0;
    if (ctx.ui && ctx.ui.letterbox) ctx.ui.letterbox(0);
    if (cam.fov !== this.playFov) { cam.fov = this.playFov; cam.updateProjectionMatrix(); }
    ctx.cam.mode = this.prevMode;
    if (ctx.cam.snapBehind) ctx.cam.snapBehind();
    if (skipped) { this.fadeUp = FADE_UP; post.fade = 1; }
    ctx.bus.emit('cine', { name, on: false, skipped });
    const d = this._done; this._done = null; if (d) d(skipped);
  }

  title(on) {
    const ctx = this.ctx;
    if (on === this.titleOn) return;
    if (on) {
      if (this.playing) this.finish(true);
      this.fadeUp = 0;
      if (ctx.cam.mode !== 'cine') this.playFov = ctx.camera.fov;
      this.titleOn = true; ctx.cam.mode = 'cine';
      this.titleScene.start();
    } else {
      this.titleOn = false; this.titleScene.stop();
      if (!this.playing) {
        const cam = ctx.camera;
        if (cam.fov !== this.playFov) { cam.fov = this.playFov; cam.updateProjectionMatrix(); }
        if (ctx.cam.mode === 'cine') ctx.cam.mode = 'free';
        if (ctx.cam.snapBehind) ctx.cam.snapBehind();
      }
    }
  }

  update(dt) {
    const ctx = this.ctx;
    this.props.update(dt);
    if (this.playing) {
      let step = dt;
      // in the live game the pictures keep step with the music's own clock; picture runs use the steps alone
      const au = ctx.audio;
      if (!ctx.game.auto && SECTION[this.name] && au && au.musicTime && (au.musicSection === undefined || au.musicSection === SECTION[this.name])) {
        const mt = au.musicTime();
        if (Number.isFinite(mt) && mt > 0.1 && mt < this.duration + 0.5) { const err = mt - (this.time + dt); if (Math.abs(err) < 3) step = dt * (1 + clamp(err * 0.6, -0.08, 0.08)); }
      }
      this.time = Math.min(this.duration, this.time + step);
      this.scene.step(this.time, dt);
      if (this.probe) this.probeStep(this.time);
      if (this.time >= this.duration - 1e-6) this.finish(false);
    } else if (this.titleOn) { this.titleScene.update(dt); if (this.probe) this.probeStep(this.titleScene.t); }
    else if (this.fadeUp > 0) { this.fadeUp = Math.max(0, this.fadeUp - dt); ctx.gfx.post.fade = smooth(this.fadeUp / FADE_UP); }
  }

  dispose() { if (this.playing) this.finish(true); if (this.titleOn) this.title(false); }
}
