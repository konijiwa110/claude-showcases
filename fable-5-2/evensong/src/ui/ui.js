// The interface: the title and its logo, the HUD, banners, the furniture of cutscenes (bars, subtitles, the name
// card, the skip hint, the fade), pause and options, the end card. HTML and CSS in #ui, over the game's canvas.
// The contract is docs/engine.md, "Interface"; what it offers beyond that is in docs/modules/interface.md.
//
//   ui.js      this file: the surface the game calls, and everything that follows the game's clock
//   hud.js     bars, flasks, her name and bar, the lock-on mark, prompts, the controls shown when play begins
//   menus.js   title, pause, options, the end card: keyboard, mouse, gamepad and fingers (they work while the clock is stopped)
//   touch.js   the controls for thumbs on a touch screen (a stick, buttons, the lens dragged), and the upright card
//   style.js   every colour, size and shape (one stylesheet, scoped to the interface's root)
//   glyphs.js  the small drawn marks: flame, flask, lock, keys and buttons
//   logo.js    fetches assets/ui/logo.svg (the logo is that one file) and puts copies in the page
//   lab.html   the interface alone over a still picture, for looking at it without the game
//
// Two clocks. What belongs to the fight and to cutscenes (bar trails, flashes, banners, subtitles, the name card)
// is advanced in update(dt), in the game's fixed steps, so a picture run shows the same thing every time. The
// screens with choices on them cannot use update (it is not called while the game is paused): they use CSS
// transitions and read the gamepad from their own frame loop.
import { installStyle, removeStyle } from './style.js';
import { Hud } from './hud.js';
import { Menus, CONTROLS } from './menus.js';
import { Touch } from './touch.js';
import { mountLogo } from './logo.js';
import { ICON, glyphsFor, esc } from './glyphs.js';
import { HEADLESS, walk } from './devhold.js';

/** Nothing comes through the game's loader: the fonts and the logo are needed before it runs (the loading screen). */
export const ASSETS = {};

const STORE = 'evensong.settings';
// The controls, shown by themselves when control is first handed to the player (Kevin, 9 Nov: "show controls at
// beginning so people know how to play", "the player should see the controls without clicking 'controls'"). Once per
// visit, in the first fight; nothing is stopped and nobody is held. With keys or a gamepad it is a card at the left
// edge; with fingers the controls on the screen carry their own labels (touch.js). Never in a film (&capture), and in
// the picture tools only when asked (&card=1), so the films' recipes and older pictures stay as they were.
const CARD = ['move', 'look', 'attack', 'heavy', 'block', 'roll', 'jump', 'lock', 'heal', 'pause'];      // its lines, in this order (the words are the pause card's). ('jump' added 9 Nov by the jump's owner: the one word of this file that changed for it)
const CARD_TITLE = 'Controls';
const CARD_FROM = 0.5, CARD_FOR = 10;        // it comes half a second into the fight and stands until ten seconds in ...
const CARD_AFTER = 2.5, CARD_MOVED = 0.4;    // ... or, if he has not yet moved by then, until this long after he has (moved: the stick pushed for 0.4 s in all)
const CARD_IN = 0.6, CARD_OUT = 1.2;         // its fades
const DEFAULTS = { music: 0.8, sfx: 0.9, voice: 1, sensitivity: 1, invertY: false, quality: 'high', reducedMotion: false };
const QUALITIES = ['low', 'medium', 'high', 'ultra'];
const SCREENS = { title: 1, hud: 1, pause: 1, options: 1, end: 1, none: 1 };
const MENUS = { title: 1, pause: 1, options: 1, end: 1 };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

function readSaved() {
  let o = null;
  try { const t = window.localStorage.getItem(STORE); o = t ? JSON.parse(t) : null; } catch (e) { o = null; }       // no storage, or not ours: start afresh
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of ['music', 'sfx', 'voice']) if (typeof o[k] === 'number' && Number.isFinite(o[k])) out[k] = clamp(o[k], 0, 1);
  if (typeof o.sensitivity === 'number' && Number.isFinite(o.sensitivity)) out.sensitivity = clamp(o.sensitivity, 0.2, 2);
  if (typeof o.invertY === 'boolean') out.invertY = o.invertY;
  if (QUALITIES.includes(o.quality)) out.quality = o.quality;
  if (typeof o.reducedMotion === 'boolean') out.reducedMotion = o.reducedMotion;
  return out;
}

export class UI {
  constructor(ctx, root) {
    this.ctx = ctx; this.root = root; this.screen = 'none'; this.listeners = []; this.offs = [];
    // settings: what the player saved, over the defaults; reduced motion follows the system until the player chooses
    this.saved = readSaved();
    const calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.settings = Object.assign({}, DEFAULTS, { reducedMotion: calm }, this.saved);

    installStyle();
    root.classList.add('evs'); root.innerHTML = '';
    this.device = this.inputDevice(); root.dataset.input = this.device;      // 'keys' | 'pad' | 'touch': what is in the player's hands (a phone starts as 'touch')
    this.cineOn = false;
    const add = (html) => root.insertAdjacentHTML('beforeend', html);
    // the layers, from the back to the front
    add('<div class="evs-lbx t"></div><div class="evs-lbx b"></div>');
    this.hud = new Hud(this, root);
    this.touch = new Touch(this, root);
    add(`<div class="evs-fade"></div>
      <div class="evs-banner"><i class="band"></i><i class="ru"></i><span class="tx"></span><i class="ru"></i></div>
      <div class="evs-name"><span class="tx"></span><i class="ru"></i></div>
      <div class="evs-sub"></div>
      <div class="evs-skip">${ICON.ring}<span class="lb"></span></div>
      <div class="evs-load"><div class="evs-spot"><div class="logo"></div><div class="line"><i></i></div></div></div>`);
    this.menus = new Menus(this, root);
    add('<div class="evs-live" role="status" aria-live="polite"></div>');
    root.appendChild(this.touch.turn);                                 // the card for an upright phone: over everything
    const q = (s) => root.querySelector(s);
    this.n = {
      lbt: q('.evs-lbx.t'), lbb: q('.evs-lbx.b'), fade: q('.evs-fade'),
      banner: q('.evs-banner'), band: q('.evs-banner .band'), bannerText: q('.evs-banner .tx'), ru1: root.querySelectorAll('.evs-banner .ru')[0], ru2: root.querySelectorAll('.evs-banner .ru')[1],
      name: q('.evs-name'), nameText: q('.evs-name .tx'), nameRule: q('.evs-name .ru'),
      sub: q('.evs-sub'), skip: q('.evs-skip'), skipRing: q('.evs-skip .v'), skipLabel: q('.evs-skip .lb'),
      load: q('.evs-load'), line: q('.evs-load .line i'), live: q('.evs-live'),
    };
    mountLogo(q('.evs-load .logo'));

    // what follows the game's clock
    this.bn = { on: false, kind: 'death', t: 0, a: 0 };                 // the banner
    this.sb = { on: false, text: null, left: 0, a: 0 };                 // the subtitle
    this.nc = { on: false, text: null, t: 0, len: 0 };                  // the name card
    this.lb = { cur: 0, want: 0 };                                      // the bars
    this.skipK = 0; this.skipLinger = 0;
    this.card = { done: !this._cardWanted(), t: 0, a: 0, moved: 0, movedAt: Infinity };      // the controls shown when play begins
    this.w = { banner: -1, bannerTx: -1, bannerSc: -1, bannerRu: -1, sub: -1, name: -1, nameRu: -1, lb: -1, fade: -1, load: -1, skipOn: null, skipV: -1, card: -1 };
    this.isLoaded = false; this.revealed = false; this.firstT = 0;
    this.hud.setDevice(this.device); this._skipWords(); this._cardWords(); this._motion();

    // dev: &uifreeze=2.5 stops the interface's own clock at 2.5 s of game time, so one moment of it can be photographed
    const p = ctx.params;
    this.freezeAt = ctx.dev && p && p.has('uifreeze') && p.get('uifreeze') !== '' ? +p.get('uifreeze') : -1;
    // the picture tools' browser: no time passes there once the page is idle, so show every screen settled (see devhold.js)
    if (HEADLESS && !(p && p.get('motion') === '1')) root.classList.add('still');
    this._walk = walk(ctx);                                            // and its clock must not race while the game loads

    // a key pressed during a cutscene brings up the skip hint, so the player learns that holding skips
    this._onKey = (e) => { if (this.cineOn && !e.repeat) this.skipLinger = Math.max(this.skipLinger, 2.4); };
    window.addEventListener('keydown', this._onKey);
    const bus = ctx.bus;
    if (bus && bus.on) {
      this.offs.push(bus.on('cine', (e) => {
        this.cineOn = !!(e && e.on);
        if (!this.cineOn) this.skipLinger = 0;
        else if (this.device === 'touch') this.skipLinger = Math.max(this.skipLinger, 6);      // fingers have no key to try: the skip ring shows itself as a cutscene begins
        this.touch.sync();
      }));
      this.offs.push(bus.on('subtitle', (e) => { if (e) this.subtitle(e.text, e.seconds); }));
    }
    // the fonts are fetched now, so the first words that fade up are already in the right hand
    if (document.fonts && document.fonts.load) for (const f of ['400 1em "Evs Caslon"', 'italic 400 1em "Evs Caslon"', '500 1em "Evs Ysabeau"']) document.fonts.load(f).catch(() => {});
  }

  // ------------------------------------------------------------------ events out

  /**
   * fn({ type: 'play' | 'resume' | 'restart' | 'title' }) and fn({ type: 'setting', key, value }).
   * ('skip' is never sent from here: the game counts the held button itself and tells the interface with skip(k).)
   */
  on(fn) { this.listeners.push(fn); }
  emit(e) {
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](e); } catch (err) { console.error('a listener of the interface failed on "' + (e && e.type) + '"', err); }   // one listener's fault must not stop the menu, or the others
    }
  }

  // ------------------------------------------------------------------ loading

  setLoading(f) {
    f = Math.round(clamp(+f || 0, 0, 1) * 500) / 500;
    if (f !== this.w.load) { this.w.load = f; this.n.line.style.transform = 'scaleX(' + f + ')'; }
  }
  /** Every asset is in. The dark lifts when the first screen is shown (slowly, if that screen is the title). */
  loaded() {
    if (this.isLoaded) return;
    this.isLoaded = true; this.setLoading(1);
    if (this._walk) { this._walk(); this._walk = null; }
    // hand the saved settings to the game (the quality it has already read, to build the renderer)
    for (const key of ['music', 'sfx', 'voice', 'sensitivity', 'invertY', 'reducedMotion']) this.emit({ type: 'setting', key, value: this.settings[key] });
  }
  _reveal() {
    if (!this.isLoaded || this.revealed) return;
    this.revealed = true;
    const slow = this.screen === 'title';
    this.n.load.classList.add(slow ? 'slow' : 'quick');
    this.n.load.classList.add('gone');
    this.root.classList.toggle('first', slow); this.firstT = slow ? 7 : 0;
  }

  // ------------------------------------------------------------------ screens

  /** 'title' | 'hud' | 'pause' | 'options' | 'end' | 'none' */
  showScreen(name) {
    if (!SCREENS[name]) name = 'none';
    const was = this.screen; this.screen = name;
    this.root.dataset.screen = name;
    if (name === 'hud' && was !== 'hud' && was !== 'pause' && was !== 'options') this.hud.snap();
    if (name !== 'title') this.root.classList.remove('first');
    this.menus.open(MENUS[name] ? name : null);
    this._reveal();
    this.touch.sync();
    if (name !== was && name === 'pause') this._say('Paused');
  }

  // ------------------------------------------------------------------ the HUD (see hud.js)

  setPlayer(p) { this.hud.setPlayer(p); }
  setBoss(b) { this.hud.setBoss(b); }
  setLock(x, y, visible) { this.hud.setLock(x, y, visible); }
  /** A quiet line. "{lock} Lock on" shows the key or the button of the device in use; null clears it. */
  prompt(text) { this.hud.prompt(text); }

  // ------------------------------------------------------------------ banners, cutscenes

  /** banner('death', 'You died'), banner(null). (Both kinds are still drawn if asked for; the game asks for neither now: a fall is a rescue, src/cine/rescue.js, and the end fades to the logo.) */
  banner(kind, text) {
    const b = this.bn;
    if (!kind || !text) { b.on = false; return; }
    b.on = true; b.t = 0; b.kind = kind === 'victory' ? 'victory' : 'death';
    this.n.banner.className = 'evs-banner live ' + b.kind;
    if (this.n.bannerText.textContent !== text) this.n.bannerText.textContent = text;
    this._say(text);
  }

  /** A spoken line, shown for `seconds`; null or '' clears it. */
  subtitle(text, seconds = 3) {
    const s = this.sb;
    if (!text) { s.left = 0; return; }
    if (text !== s.text) { s.text = text; this.n.sub.textContent = text; }
    s.left = Math.max(0.4, +seconds || 3); s.on = true;
  }

  /** Her name, set quietly in the lower part of the picture: it comes and goes by itself over `seconds`. null clears it at once. */
  nameCard(text, seconds = 5) {
    const c = this.nc;
    if (!text) { c.on = false; c.text = null; this._op('name', this.n.name, 0); return; }
    if (text !== c.text) { c.text = text; this.n.nameText.textContent = text; }
    c.t = 0; c.len = Math.max(1.2, +seconds || 5); c.on = true;
  }

  /** The bars of a cutscene, 0..1. A jump (0 to 1 at once) is eased; a value that is already moving is followed. */
  letterbox(k) { this.lb.want = clamp(+k || 0, 0, 1); }

  /** Black over the picture, 0..1. Banners, subtitles and menus stay above it. */
  fade(k) { k = Math.round(clamp(+k || 0, 0, 1) * 200) / 200; if (k !== this.w.fade) { this.w.fade = k; this.n.fade.style.opacity = k; } }

  /** How far the skip button has been held, 0..1. The hint lingers a moment after the button is let go. */
  skip(k) { this.skipK = clamp(+k || 0, 0, 1); if (this.skipK > 0) this.skipLinger = Math.max(this.skipLinger, 1.6); }

  // ------------------------------------------------------------------ the game's clock

  update(dt) {
    if (this.freezeAt >= 0 && this.ctx.game && this.ctx.game.time >= this.freezeAt) return;
    const n = this.n, w = this.w;
    this._reveal();
    if (this.firstT > 0) { this.firstT -= dt; if (this.firstT <= 0) this.root.classList.remove('first'); }
    this.syncDevice();
    this.hud.update(dt);
    this.touch.update(dt);

    // the controls, shown by themselves when control is first handed to the player: once, in the first fight
    const k = this.card;
    if (!k.done) {
      const g = this.ctx.game, fighting = this.screen === 'hud' && !this.cineOn && (!g || g.state === 'fight');
      if (fighting) {
        k.t += dt;
        const mv = this.ctx.input && this.ctx.input.move;
        if (k.movedAt === Infinity && mv && Math.hypot(mv.x, mv.y) > 0.2) { k.moved += dt; if (k.moved >= CARD_MOVED) k.movedAt = k.t; }
        const end = Math.max(CARD_FOR, k.movedAt + CARD_AFTER), want = k.t >= CARD_FROM && k.t < end;
        k.a = want ? Math.min(1, k.a + dt / CARD_IN) : Math.max(0, k.a - dt / CARD_OUT);
        if (k.t >= end && k.a === 0) k.done = true;
        const touch = this.device === 'touch';
        this._op('card', this.hud.n.ctl, touch ? 0 : smooth(k.a)); this.touch.labels(touch && want);
      } else if (k.t > 0) { k.done = true; k.a = 0; }                 // the fight was left (a cutscene, his death, the title): it has had its time
      if (k.done) { this._op('card', this.hud.n.ctl, 0); this.touch.labels(false); }
    }

    // the banner: a dark band, then the words, which grow very slowly while they stand
    const b = this.bn;
    if (b.on || b.a > 0) {
      if (b.on) { b.t += dt; b.a = Math.min(1, b.a + dt / (b.kind === 'death' ? 1.5 : 2.1)); }
      else { b.a = Math.max(0, b.a - dt / 0.8); if (b.a === 0) n.banner.classList.remove('live'); }
      const e = smooth(b.a);
      this._op('banner', n.band, e);
      this._op('bannerTx', n.bannerText, smooth((b.a - 0.18) / 0.82));
      const sc = this.settings.reducedMotion ? 1 : Math.round((1 + 0.05 * (1 - Math.exp(-b.t / 3.2))) * 2000) / 2000;
      if (sc !== w.bannerSc) { w.bannerSc = sc; n.bannerText.style.transform = 'scale(' + sc + ')'; }
      const ru = Math.round((0.5 + 0.5 * e) * 200) / 200;
      if (ru !== w.bannerRu) { w.bannerRu = ru; const t = 'scaleX(' + ru + ')'; n.ru1.style.transform = t; n.ru2.style.transform = t; n.ru1.style.opacity = n.ru2.style.opacity = (e * 0.55).toFixed(2); }
    }

    // a spoken line
    const s = this.sb;
    if (s.on) {
      s.left -= dt;
      s.a = s.left > 0 ? Math.min(1, s.a + dt / 0.22) : Math.max(0, s.a - dt / 0.4);
      this._op('sub', n.sub, s.a);
      if (s.left <= 0 && s.a === 0) { s.on = false; s.text = null; }
    }

    // her name at the end of the opening
    const c = this.nc;
    if (c.on) {
      c.t += dt;
      const fin = Math.min(1.5, c.len * 0.3), fout = Math.min(1.6, c.len * 0.3);
      const a = c.t >= c.len ? 0 : c.t < fin ? smooth(c.t / fin) : c.t > c.len - fout ? smooth((c.len - c.t) / fout) : 1;
      this._op('name', n.name, a);
      const ru = Math.round((0.25 + 0.75 * smooth(c.t / (fin * 1.6))) * 200) / 200;
      if (ru !== w.nameRu) { w.nameRu = ru; n.nameRule.style.transform = 'scaleX(' + ru + ')'; }
      if (c.t >= c.len) { c.on = false; c.text = null; }
    }

    // the bars
    const l = this.lb;
    if (l.cur !== l.want) {
      const d = l.want - l.cur;
      l.cur = Math.abs(d) < 0.05 ? l.want : l.cur + d * Math.min(1, dt * 7);
      const pc = Math.round((1 - l.cur) * 1010) / 10;
      if (pc !== w.lb) { w.lb = pc; n.lbt.style.transform = 'translateY(' + -pc + '%)'; n.lbb.style.transform = 'translateY(' + pc + '%)'; }
    }

    // the skip hint
    if (this.skipK <= 0 && this.skipLinger > 0) this.skipLinger -= dt;
    const on = this.skipK > 0 || this.skipLinger > 0;
    if (on !== w.skipOn) { w.skipOn = on; n.skip.classList.toggle('on', on); }
    const v = Math.round(this.skipK * 200) / 2;
    if (v !== w.skipV) { w.skipV = v; n.skipRing.style.strokeDashoffset = String(100 - v); }
  }

  _op(k, node, v) { const q = Math.round(v * 100) / 100; if (this.w[k] !== q) { this.w[k] = q; node.style.opacity = q; } }

  // ------------------------------------------------------------------ inside

  /** 'keys' | 'pad' | 'touch': what the player last touched, as the input module sees it. */
  inputDevice() { const i = this.ctx.input, d = i && i.device; return d === 'pad' || d === 'touch' ? d : 'keys'; }
  /** Follow the device in hand: every glyph, the touch controls, the menus' sizes. Called on the game's clock, from the
   *  menus' own frames (the clock may be stopped) and at once when a finger lands. */
  syncDevice() {
    const dev = this.inputDevice(); if (dev === this.device) return;
    this.device = dev; this.root.dataset.input = dev;
    this.hud.setDevice(dev); this._skipWords(); this._cardWords(); this.touch.sync();
    if (this.menus.panel) this.menus._device(dev);
  }
  /** For fingers the ring itself is the thing to hold; keys and pads are told which button. */
  _skipWords() { this.n.skipLabel.innerHTML = this.device === 'touch' ? 'Hold to skip' : 'Hold ' + glyphsFor('skip', this.device) + ' to skip'; }
  /** The lines of the controls card, for the keyboard and mouse or for a gamepad. */
  _cardWords() {
    const d = this.device === 'pad' ? 'pad' : 'keys', label = (a) => { const row = CONTROLS.find((r) => r[1] === a); return row ? row[0] : a; };
    this.hud.n.ctl.innerHTML = `<h3>${CARD_TITLE}</h3>` + CARD.map((a) => `<div class="r"><span class="k">${glyphsFor(a, d)}</span><span>${esc(label(a))}</span></div>`).join('');
  }
  /** Is the card to be shown at all on this page? Never in a film; in the picture tools only when the address asks. */
  _cardWanted() {
    const p = this.ctx.params, get = (name) => (p && p.get ? p.get(name) : null), g = this.ctx.game;
    if (p && p.has && p.has('capture')) return false;
    if (get('card') === '1') return true;
    if (get('card') === '0') return false;
    return !(HEADLESS || (g && g.auto));
  }
  _motion() { this.root.classList.toggle('rm', !!this.settings.reducedMotion); }
  _say(text) { this.n.live.textContent = text || ''; }

  /** A setting changed on the options screen: keep it, save it, tell the game. */
  _setting(key, value) {
    this.settings[key] = value; this.saved[key] = value;
    try { window.localStorage.setItem(STORE, JSON.stringify(this.saved)); } catch (e) { /* no storage: the setting lasts until the page is closed */ }
    if (key === 'reducedMotion') this._motion();
    this.emit({ type: 'setting', key, value });
  }

  /** The small sounds of the menus. Choices that go to the game ('play', 'resume' ...) and settings are sounded by the audio module from the events. */
  _sound(kind) {
    const a = this.ctx.audio, name = kind === 'move' ? 'ui_move' : kind === 'back' ? 'ui_back' : kind === 'confirm' ? 'ui_select' : null;
    if (name && a && typeof a.play === 'function') { try { a.play(name); } catch (e) { /* a sound must never stop a menu */ } }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    for (const off of this.offs) if (typeof off === 'function') off();
    if (this._walk) { this._walk(); this._walk = null; }
    this.menus.dispose(); this.touch.dispose(); this.hud.dispose();
    this.root.innerHTML = ''; this.root.classList.remove('evs', 'rm', 'first', 'still', 'upright');
    delete this.root.dataset.screen; delete this.root.dataset.input;
    for (const v of ['--sl', '--st', '--sr', '--sb']) this.root.style.removeProperty(v);
    this.listeners.length = 0;
    removeStyle();
  }
}
