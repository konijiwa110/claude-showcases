// The touch controls: what a player with thumbs on the glass sees and presses (docs/modules/interface.md, "Touch").
//
//   left thumb    a stick. It appears under the thumb wherever it lands in the left part of the picture (below the
//                 top bars) and follows a thumb that drags past its rim; a faint ring marks where it rests.
//   right thumb   dragging on free picture turns the lens; and the buttons, in an arc round the thumb's own reach:
//                 attack (the largest, nearest), roll (held: sprint), block (held), heavy (held: charge), jump (at
//                 the screen's edge, above attack), flask (with how many are left), lock on (lit while locked); a
//                 small pause mark in the top right corner.
//   a cutscene    the controls are away; the skip ring (bottom right) is the thing to hold.
//   upright       a quiet card asks for the phone to be turned; the fight is paused behind it.
//
// Who does what. This file draws the controls and reads the fingers: it listens on the window (capture) for pointer
// events of type touch or pen ONLY, and decides by where a finger landed what it belongs to, from the drawn buttons'
// own rectangles. Nothing here is ever the target of an event (the layer has pointer-events: none like the rest of
// the HUD), so the mouse never meets it. What the fingers do is handed to the input (src/core/input.js: touchSet,
// touchStick, touchTurn, touchClear), which gives it to the game like a key or a gamepad button.
//
// Each finger belongs to what it first touched until it lifts. A finger that slides off a button lets it go, and
// sliding back does not press it again. Everything is let go when a finger is cancelled, when the window loses
// focus, the page is hidden, the screen is turned or resized, the game is paused, a cutscene begins or he dies.
//
// Pressed looks (a lit ring, the stick under the thumb) are written at once, from the pointer events; what follows
// the game (how many flasks, the lock, the labels of the first seconds) is written in update(dt), on the game's clock.
//
//   touch.selfTest(name?)        the wiring checked with made-up pointer events: { ok, checks }; with a name, the
//                                result is also sent to the dev server (.shots/<name>)
//   touch.finger(id, phase, x, y)   dev and tests: a made-up finger. phase 'down' | 'move' | 'up' | 'cancel'; x, y in
//                                CSS pixels, negative = from the right / the bottom edge
//   touch.at(name)               dev and tests: the middle of a control in CSS pixels: { x, y, r }
//                                (attack heavy roll block jump heal lock pause stick skip)
import { ICON, TOUCH_ICON } from './glyphs.js';

/**
 * The buttons under the right thumb. x, y: the middle of the button, from the right and the bottom edge of the screen
 * (inside the notch and the home bar; the side counts as at least 12 in: --er in style.js); d: its width. All in units
 * of --tu, which is one CSS pixel on a screen 390 high (see style.js). The thumb's own arc from the corner passes through roll, block and heavy; attack lies inside it,
 * under the thumb at rest; flask and lock lie outside it, a stretch away. Every ring is at least 18 apart from the next.
 * Jump (9 Nov) is the seventh: nothing else was moved for it. It stands at the screen's edge beside heavy and above
 * attack, where the thumb points straight up the edge (where shooters on a phone have it): the one place left inside
 * the cluster's width, which her bar's width is cut to. Its ring comes within 4 of the 12 a side edge counts as.
 */
export const BUTTONS = [
  { a: 'attack', x: 92, y: 96, d: 80, label: 'Attack' },
  { a: 'roll', x: 186, y: 70, d: 64, label: 'Roll', note: 'hold to sprint' },
  { a: 'block', x: 176, y: 166, d: 64, label: 'Block', note: 'hold' },
  { a: 'heavy', x: 104, y: 204, d: 62, label: 'Heavy', note: 'hold to charge' },
  { a: 'jump', x: 32, y: 168, d: 56, label: 'Jump' },
  { a: 'heal', x: 196, y: 252, d: 58, label: 'Flask' },
  { a: 'lock', x: 88, y: 290, d: 56, label: 'Lock on' },
];
/** Every word the touch controls say. Sentence case. */
export const TEXT = {
  move: 'Move', pause: 'Pause', thumbs: 'Left thumb moves. Right thumb turns the camera.',
  turn: 'Turn the screen on its side', turnNote: 'Evensong is played in landscape.',
};
const ZONE = 0.45;                 // the stick may be put down anywhere in this share of the width, from the left ...
const ZONE_TOP = 0.2, ZONE_TOP_PX = 76;      // ... below this share of the height (and this many pixels): his bars are above
const TRAVEL = 44 / 112;           // how far the knob goes from the middle, as a share of the ring's width: a full push
const SLOP = 8, REACH = 30;        // a button answers this far outside its ring, and never to less than this radius (pixels)
const OFF = 22;                    // a finger this far outside the ring has slid off
const isFinger = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

export class Touch {
  constructor(ui, parent) {
    this.ui = ui; this.ctx = ui.ctx; this.live = false; this.force = false; this.dirty = true; this.upright = false;
    this.fingers = new Map();                                    // pointerId -> { kind: 'stick' | 'look' | 'btn' | 'skip' | 'none', b, x, y }
    this.stick = { id: null, ox: 0, oy: 0, hx: 0, hy: 0, r: 44, ring: 56 };
    this.lookId = null; this.skipId = null; this.fingerAt = -1e9; this.testing = false;
    this.wide = window.innerWidth >= window.innerHeight;
    this.w = { fl: -1, lock: null, labels: null };

    const el = this.el = document.createElement('div'); el.className = 'evs-touch'; el.setAttribute('aria-hidden', 'true');
    let html = `<div class="evs-ts"><i class="tk"></i><i class="tk"></i><i class="tk"></i><i class="tk"></i><div class="kn"><i></i></div><span class="lb">${TEXT.move}</span></div>`;
    for (const b of BUTTONS) {
      html += `<div class="evs-tb ${b.a}" data-a="${b.a}" style="--x:${b.x};--y:${b.y};--d:${b.d}">${b.a === 'heal' ? ICON.flask + '<b class="ct"></b>' : TOUCH_ICON[b.a]}` +
        `<span class="lb">${b.label}${b.note ? `<em>${b.note}</em>` : ''}</span></div>`;
    }
    html += `<div class="evs-tb pause" data-a="pause">${TOUCH_ICON.pause}<span class="lb">${TEXT.pause}</span></div><p class="evs-tcap">${TEXT.thumbs}</p>`;
    el.innerHTML = html;
    parent.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.n = { ring: q('.evs-ts'), knob: q('.evs-ts .kn'), count: q('.evs-tb.heal .ct'), heal: q('.evs-tb.heal'), lock: q('.evs-tb.lock') };
    this.btns = Array.from(el.querySelectorAll('.evs-tb')).map((node) => ({ a: node.dataset.a, el: node, id: null, cx: 0, cy: 0, r: 0 }));

    // the card for an upright phone: above everything (the interface puts it last in its root)
    const turn = this.turn = document.createElement('div'); turn.className = 'evs-turn'; turn.setAttribute('role', 'status');
    turn.innerHTML = `<div class="in">${ICON.turn}<p class="a">${TEXT.turn}</p><p class="b">${TEXT.turnNote}</p></div>`;

    // dev: &safe=47,0,47,21 pretends the screen has a notch and a home bar (left, top, right, bottom, in pixels), for pictures
    const p = this.ctx.params, safe = p && p.get ? p.get('safe') : null;
    if (safe) { const v = safe.split(',').map(Number), root = ui.root; ['--sl', '--st', '--sr', '--sb'].forEach((k, i) => { if (Number.isFinite(v[i])) root.style.setProperty(k, v[i] + 'px'); }); }

    this.offs = [];
    const on = (t, name, f, o) => { t.addEventListener(name, f, o); this.offs.push(() => t.removeEventListener(name, f, o)); };
    on(window, 'pointerdown', (e) => this._down(e), true);
    on(window, 'pointermove', (e) => this._move(e), true);
    on(window, 'pointerup', (e) => this._up(e), true);
    on(window, 'pointercancel', (e) => this._up(e), true);
    // a net under the pointer events: when the browser says no finger is left on the glass, nothing is held
    const none = (e) => { if (e.touches && e.touches.length === 0 && this.fingers.size) this.release(); };
    on(window, 'touchend', none, true); on(window, 'touchcancel', none, true);
    on(window, 'blur', () => this.release());
    on(document, 'visibilitychange', () => { this.release(); if (document.visibilityState !== 'hidden') this._away(); });
    on(window, 'pagehide', () => this.release());
    on(window, 'resize', () => this._resized(false));
    on(window, 'orientationchange', () => this._resized(true));
    // sound starts from the first tap: a finger's press is not yet a gesture to the browser, its lifting is
    const wake = (e) => {
      if (e.type === 'click') { if (performance.now() - this.fingerAt > 1000) return; }      // (a mouse's click is none of this file's business)
      else if (e.type === 'pointerup' && !isFinger(e)) return;
      else this.fingerAt = performance.now();
      const a = this.ctx.audio; if (!a || typeof a.unlock !== 'function') return;
      try { a.unlock(); } catch (err) { /* no sound, then */ }
    };
    on(window, 'touchend', wake, true); on(window, 'pointerup', wake, true); on(window, 'click', wake, true);
    const bus = this.ctx.bus;
    if (bus && bus.on) this.offs.push(bus.on('lock', (e) => { this._lock(!!(e && e.on)); }));
    this._upright();
  }

  get input() { const i = this.ctx.input; return i && typeof i.touchSet === 'function' ? i : null; }
  /** Is this a device held in the hands (its main pointer a finger)? The upright card and the pause on coming back are for those only. */
  get handheld() { const i = this.ctx.input; return !!(i && i.coarse); }

  // ------------------------------------------------------------------ shown or not

  /** Are the controls up, and do fingers count? Only while he can be steered: the fight, not paused, no cutscene, the device in hand a touch screen. */
  sync() {
    const ui = this.ui, g = this.ctx.game;
    const live = ui.device === 'touch' && !this.upright && (this.force || (ui.screen === 'hud' && !ui.cineOn && (!g || (g.state === 'fight' && !g.paused))));
    if (live === this.live) return;
    this.live = live; this.el.classList.toggle('on', live);
    this.release();                                              // whatever was held belonged to the other state
    if (live) this.dirty = true;
  }

  /** The labels of the first seconds (the controls card, for fingers): every control says what it is. */
  labels(on) { on = !!on; if (on !== this.w.labels) { this.w.labels = on; this.el.classList.toggle('lbl', on); } }

  /** On the game's clock: what the controls show of the game. */
  update() {
    this.sync();
    if (this.ui.device !== 'touch') return;
    const fl = this.ui.hud.p.fl;
    if (fl !== this.w.fl) { this.w.fl = fl; this.n.count.textContent = fl > 0 ? String(fl) : ''; this.n.heal.classList.toggle('used', !(fl > 0)); }
  }
  _lock(on) { if (on !== this.w.lock) { this.w.lock = on; this.n.lock.classList.toggle('lit', on); } }

  // ------------------------------------------------------------------ where things are

  /** Read where the buttons and the stick's resting place are (after a resize, or when they have just been shown). */
  _measure() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const b of this.btns) { const r = b.el.getBoundingClientRect(); b.cx = r.left + r.width / 2; b.cy = r.top + r.height / 2; b.r = r.width / 2; }
    const r = this.n.ring.getBoundingClientRect(), s = this.stick;
    s.hx = r.left + r.width / 2; s.hy = r.top + r.height / 2; s.ring = r.width / 2; s.r = Math.max(20, r.width * TRAVEL);
  }
  _hit(x, y) {
    let best = null, bd = Infinity;
    for (const b of this.btns) { const d = Math.hypot(x - b.cx, y - b.cy); if (d <= Math.max(b.r + SLOP, REACH) && d < bd) { best = b; bd = d; } }
    return best;
  }
  _skipBox() { const n = this.ui.n && this.ui.n.skip; return n ? n.getBoundingClientRect() : null; }
  _onSkip(x, y, pad) { const r = this._skipBox(); return !!r && r.width > 0 && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad; }

  // ------------------------------------------------------------------ fingers

  _down(e) {
    if (!isFinger(e)) return;
    this.fingerAt = performance.now();
    const ui = this.ui; if (ui.syncDevice) ui.syncDevice();
    this.sync();
    if (this.upright || this.fingers.has(e.pointerId)) return;
    const x = e.clientX, y = e.clientY, input = this.input, f = { kind: 'none', b: null, x, y };
    if (ui.cineOn) {
      // a cutscene: any touch brings up the skip ring; a finger on it holds it
      ui.skipLinger = Math.max(ui.skipLinger, 4);
      if (this.skipId === null && this._onSkip(x, y, 18)) { this.skipId = e.pointerId; f.kind = 'skip'; if (input) input.touchSet('skip', true); ui.n.skip.classList.add('dn'); }
      this.fingers.set(e.pointerId, f); return;
    }
    if (!this.live) return;
    this._measure();
    const W = window.innerWidth, H = window.innerHeight, b = this._hit(x, y), s = this.stick;
    if (b) { if (b.id === null) { b.id = e.pointerId; f.kind = 'btn'; f.b = b; this._press(b, true); } }
    else if (x < W * ZONE) {
      if (s.id === null && y > Math.max(H * ZONE_TOP, ZONE_TOP_PX)) {
        // the stick comes to the thumb, its middle exactly under it: nothing moves until the thumb does
        // (near an edge part of the ring is off the screen; holding it on would start him walking)
        s.id = e.pointerId; f.kind = 'stick'; s.ox = x; s.oy = y;
        this.n.ring.classList.add('dn'); this._stick(x, y);
      }
    } else if (this.lookId === null) { this.lookId = e.pointerId; f.kind = 'look'; }
    this.fingers.set(e.pointerId, f);
  }

  _move(e) {
    const f = this.fingers.get(e.pointerId); if (!f) return;
    const x = e.clientX, y = e.clientY;
    if (f.kind === 'stick') this._stick(x, y);
    else if (f.kind === 'look') { const input = this.input; if (input && (x !== f.x || y !== f.y)) input.touchTurn(x - f.x, y - f.y); }
    else if (f.kind === 'btn') { const b = f.b; if (Math.hypot(x - b.cx, y - b.cy) > Math.max(b.r + SLOP, REACH) + OFF) { this._press(b, false); b.id = null; f.kind = 'none'; f.b = null; } }
    else if (f.kind === 'skip') { if (!this._onSkip(x, y, 18 + OFF)) { this._skip(false); f.kind = 'none'; } }
    f.x = x; f.y = y;
  }

  _up(e) {
    const f = this.fingers.get(e.pointerId); if (!f) return;
    this.fingers.delete(e.pointerId);
    if (isFinger(e)) this.fingerAt = performance.now();
    this._drop(f);
  }
  _drop(f) {
    if (f.kind === 'stick') this._rest();
    else if (f.kind === 'look') this.lookId = null;
    else if (f.kind === 'btn') { this._press(f.b, false); f.b.id = null; }
    else if (f.kind === 'skip') this._skip(false);
    f.kind = 'none';
  }

  _press(b, on) { b.el.classList.toggle('dn', on); const input = this.input; if (input) input.touchSet(b.a, on); }
  _skip(on) { this.skipId = null; const input = this.input; if (input) input.touchSet('skip', on); const n = this.ui.n && this.ui.n.skip; if (n) n.classList.toggle('dn', on); }

  /** The thumb is at (x, y): the knob goes there, the ring follows a thumb that has gone past its rim. */
  _stick(x, y) {
    const s = this.stick; let dx = x - s.ox, dy = y - s.oy; const d = Math.hypot(dx, dy);
    if (d > s.r) { const k = (d - s.r) / d; s.ox += dx * k; s.oy += dy * k; dx = x - s.ox; dy = y - s.oy; }
    this.n.ring.style.transform = 'translate3d(' + (s.ox - s.hx).toFixed(1) + 'px,' + (s.oy - s.hy).toFixed(1) + 'px,0)';
    this.n.knob.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
    const input = this.input; if (input) input.touchStick(dx / s.r, -dy / s.r);
  }
  _rest() {
    const s = this.stick; s.id = null;
    this.n.ring.classList.remove('dn'); this.n.ring.style.transform = ''; this.n.knob.style.transform = '';
    const input = this.input; if (input) input.touchStick(0, 0);
  }

  /** Let everything go: no finger holds anything, the stick is at rest, the input's touch source is empty. */
  release() {
    for (const f of this.fingers.values()) this._drop(f);
    this.fingers.clear();
    for (const b of this.btns) { if (b.id !== null) { b.id = null; b.el.classList.remove('dn'); } }
    if (this.stick.id !== null) this._rest();
    this.lookId = null; if (this.skipId !== null) this._skip(false);
    const input = this.input; if (input) input.touchClear();
  }

  // ------------------------------------------------------------------ the phone itself

  /** The window changed. Turned on its side or upright, everything is let go; a mere change of size (a browser bar
   *  coming or going) only means the buttons must be measured again. */
  _resized(turned) {
    this.dirty = true;
    const wide = window.innerWidth >= window.innerHeight;
    if (turned || wide !== this.wide) this.release();
    this.wide = wide; this._upright();
  }
  /** Held upright? Then the card is up (the styles show it) and the fight is paused behind it. */
  _upright() {
    const up = this.handheld && window.innerHeight > window.innerWidth;
    if (up === this.upright) return;
    this.upright = up; this.ui.root.classList.toggle('upright', up);
    this.sync();                                                 // (first: it lets everything go, and that would take the pause below with it)
    if (up) this._away();
  }
  /** The player's hands are off it (the phone was turned upright, or the page was away): the fight waits, paused. */
  _away() {
    const g = this.ctx.game, input = this.input;
    if (this.testing || !this.handheld || !input || !g || g.state !== 'fight' || g.paused) return;
    input.touchSet('pause', true); input.touchSet('pause', false);
  }

  /** "Begin" or "Resume" chosen by a finger: take the whole screen, on its side, where the browser allows it. */
  gesture() {
    try {
      if (!this.handheld) return;                                                      // (a desk's touch screen keeps its window)
      const d = document.documentElement, ask = d.requestFullscreen || d.webkitRequestFullscreen;
      if (document.fullscreenElement || document.webkitFullscreenElement || !ask) return;      // (an iPhone has no full screen for a page: play on in the browser's own frame)
      const lock = () => { try { const o = window.screen && window.screen.orientation; if (o && o.lock) { const q = o.lock('landscape'); if (q && q.catch) q.catch(() => {}); } } catch (e) { /* refused */ } };
      const p = ask.call(d, { navigationUI: 'hide' });
      if (p && p.then) p.then(lock, () => {}); else lock();
    } catch (e) { /* refused: nothing changes */ }
  }

  // ------------------------------------------------------------------ dev and tests

  /** The middle of a control, in CSS pixels. */
  at(name) {
    this.dirty = true; this._measure();
    if (name === 'stick') return { x: this.stick.hx, y: this.stick.hy, r: this.stick.r };
    if (name === 'skip') { const r = this._skipBox(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.height / 2 } : null; }
    const b = this.btns.find((k) => k.a === name); return b ? { x: b.cx, y: b.cy, r: b.r } : null;
  }

  /** A made-up finger, sent as the browser would send a real one. */
  finger(id, phase, x, y) {
    const type = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' }[phase]; if (!type) return;
    if (x < 0) x += window.innerWidth; if (y < 0) y += window.innerHeight;
    const target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(new PointerEvent(type, { pointerId: 100 + id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
  }

  /**
   * The wiring, checked without hands: made-up pointer events of type touch go in at the window, and what the input
   * makes of them is read back (and what the controls show). Returns { ok, checks: [...] }; with a name the result is
   * also sent to the dev server. It needs the controls on the page; it leaves nothing held.
   */
  selfTest(name) {
    const out = { ok: true, checks: [], size: window.innerWidth + 'x' + window.innerHeight }, ui = this.ui, input = this.input;
    const check = (what, ok, got) => { out.checks.push((ok ? 'ok    ' : 'FAIL  ') + what + (ok || got === undefined ? '' : '   [' + got + ']')); if (!ok) out.ok = false; };
    const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
    if (!input) { check('there is an input with a touch source', false); return out; }
    // first the input's own self-test (keys, mouse, a gamepad, and the touch source by itself): it must pass as it always did
    try { const own = input.selfTest(); out.input = { ok: own.ok, checks: own.checks.length, failed: own.checks.filter((c) => !/^(ok|skip)/.test(c)) }; check('input.selfTest() passes (' + own.checks.length + ' checks)', own.ok, out.input.failed.join(' | ')); }
    catch (e) { check('input.selfTest() ran', false, e && e.message); }
    const keep = { device: input.device, uiDevice: ui.device, enabled: input.enabled, wantLock: input.wantLock, scripted: new Set(input.scripted), move: input.scriptMove, look: input.scriptLook, cine: ui.cineOn, force: this.force, linger: ui.skipLinger, sens: input.sensitivity, inv: input.invertY };
    const A = ['attack', 'heavy', 'block', 'roll', 'heal', 'lock', 'pause', 'confirm', 'skip', 'jump'];
    const step = () => input.update();
    const wipe = () => { this.release(); input.keys.clear(); input.buttons.clear(); input.tapped.clear(); step(); step(); for (const a of A) input.consume(a); };
    const fg = (id, phase, x, y) => this.finger(id, phase, x, y);
    this.testing = true;
    try {
      input.enabled = true; input.wantLock = false; input.scripted.clear(); input.scriptMove = null; input.scriptLook = null; input.sensitivity = 1; input.invertY = false;
      ui.cineOn = false;
      // a finger on the glass makes the device 'touch', and the interface follows at once
      input.device = 'keys'; ui.syncDevice(); this.force = true; this.sync();
      check('with keys in hand the controls are away', !this.live && !this.el.classList.contains('on'));
      const W = window.innerWidth, H = window.innerHeight;
      fg(9, 'down', W * 0.7, H * 0.3); fg(9, 'up', W * 0.7, H * 0.3);
      check('a finger makes the device touch, the interface follows and the controls come up', input.device === 'touch' && ui.device === 'touch' && ui.root.dataset.input === 'touch' && this.live && this.el.classList.contains('on'), input.device + ' ' + ui.device + ' ' + this.live);
      wipe();
      const S = this.at('stick'), R = S.r;

      // ---- the stick
      const sx = Math.round(W * 0.2), sy = Math.round(H * 0.55);
      fg(1, 'down', sx, sy); step();
      check('stick: it comes to the thumb where it lands, at rest', near(input.move.x, 0) && near(input.move.y, 0) && this.n.ring.classList.contains('dn') && near(this.stick.ox, sx) && near(this.stick.oy, sy), `${this.stick.ox},${this.stick.oy}`);
      fg(1, 'move', sx, sy - R * 0.12); step(); check('stick: a push inside the dead zone is nothing', near(input.move.x, 0) && near(input.move.y, 0), input.move.y);
      fg(1, 'move', sx, sy - R * 0.5); step(); check('stick: half a push is a walk forward (under 0.55)', near(input.move.x, 0) && input.move.y > 0.3 && input.move.y < 0.55, input.move.y);
      fg(1, 'move', sx, sy - R); step(); check('stick: a full push is a run (length 1)', near(input.move.y, 1) && near(input.move.x, 0), input.move.y);
      fg(1, 'move', sx, sy - R * 2.5); step(); check('stick: a thumb past the rim still runs, and the ring has followed it', near(input.move.y, 1) && near(this.stick.oy, sy - R * 1.5, 0.01) && /translate3d/.test(this.n.ring.style.transform), `${input.move.y} ${this.stick.oy}`);
      fg(1, 'move', sx + R, sy - R * 1.5); step(); check('stick: to the right is to the right', near(input.move.x, 1) && near(input.move.y, 0), `${input.move.x},${input.move.y}`);
      fg(1, 'move', sx - R * 0.7, sy - R * 1.5 + R * 0.7); step(); check('stick: back and to the left, a diagonal of length 1', input.move.x < -0.6 && input.move.y < -0.6 && near(Math.hypot(input.move.x, input.move.y), 1), `${input.move.x},${input.move.y}`);
      fg(1, 'up', sx, sy); step(); check('stick: the thumb lifted, it is at rest and back in its place', near(input.move.x, 0) && near(input.move.y, 0) && !this.n.ring.classList.contains('dn') && this.n.ring.style.transform === '' && this.stick.id === null);
      fg(1, 'down', W * 0.2, Math.min(30, H * 0.05)); fg(1, 'move', W * 0.2, 60); step(); check('stick: a finger on the top bars is not the stick', near(input.move.y, 0) && this.stick.id === null); fg(1, 'up', W * 0.2, 60);

      // ---- the lens
      const lx = Math.round(W * 0.62), ly = Math.round(H * 0.3), third = W / 3;
      fg(2, 'down', lx, ly); step(); check('lens: a finger down on free picture turns nothing yet', near(input.look.x, 0) && near(input.look.y, 0));
      fg(2, 'move', lx + third, ly); step(); check('lens: a drag across a third of the screen is a quarter turn to the right', near(input.look.x, -Math.PI / 2, 1e-3) && near(input.look.y, 0), input.look.x);
      step(); check('lens: ... and it turns only while the thumb moves', near(input.look.x, 0));
      fg(2, 'move', lx + third, ly - 40); step(); check('lens: a drag up looks up', input.look.y > 0 && near(input.look.x, 0), input.look.y);
      input.invertY = true; fg(2, 'move', lx + third, ly - 80); step(); check('lens: ... down, with "invert" on', input.look.y < 0, input.look.y); input.invertY = false;
      input.sensitivity = 2; fg(2, 'move', lx, ly - 80); step(); check('lens: the options\' sensitivity applies', near(input.look.x, Math.PI, 2e-3), input.look.x); input.sensitivity = 1;
      fg(2, 'up', lx, ly); step(); check('lens: lifted, nothing turns', near(input.look.x, 0) && this.lookId === null);

      // ---- every button: a tap between two steps, a hold, sliding off
      for (const b of this.btns) {
        const a = b.a, P = this.at(a);
        fg(3, 'down', P.x, P.y); fg(3, 'up', P.x, P.y); step();
        const tap = input.pressed(a) && input.buffered(a); step(); const gone = input.released(a) && !input.held(a);
        check(a + ': a tap that came and went between two steps is a press, then a release', tap && gone, `${tap} ${gone}`);
        input.consume(a);
        fg(3, 'down', P.x + P.r * 0.6, P.y - P.r * 0.6); step(); const lit = b.el.classList.contains('dn');
        for (let i = 0; i < 29; i++) step();
        check(a + ': held, it stays down and is lit (0.5 s)', input.held(a) && near(input.heldFor(a), 0.5) && lit, `${input.held(a)} ${input.heldFor(a)} ${lit}`);
        fg(3, 'move', P.x + P.r + SLOP + OFF - 2, P.y); step(); const still = input.held(a);
        fg(3, 'move', P.x + Math.max(P.r + SLOP, REACH) + OFF + 3, P.y); step();
        check(a + ': a finger at its edge still holds it; slid off, it is let go', still && !input.held(a) && !b.el.classList.contains('dn'), `${still} ${input.held(a)}`);
        fg(3, 'move', P.x, P.y); step(); check(a + ': sliding back on does not press it again', !input.held(a));
        fg(3, 'up', P.x, P.y); step(); input.consume(a);
      }
      const names = this.btns.map((b) => b.a);
      check('there is a button for attack, heavy, roll, block, jump, flask, lock and pause', ['attack', 'heavy', 'roll', 'block', 'jump', 'heal', 'lock', 'pause'].every((a) => names.includes(a)), names.join(' '));
      { const J = this.at('jump'), jb = this.btns.find((b) => b.a === 'jump'); let lone = false;
        if (J) { fg(3, 'down', J.x, J.y); step(); lone = input.pressed('jump') && !['attack', 'heavy', 'block', 'roll', 'heal', 'lock', 'pause'].some((a) => input.held(a)); fg(3, 'up', J.x, J.y); step(); input.consume('jump'); }
        check('jump: a finger on it presses jump and nothing else, and its ring is whole on the screen', lone && !!jb && jb.cx + jb.r <= W && jb.cx - jb.r >= W * ZONE, J ? `${lone} ${Math.round(jb.cx + jb.r)} of ${W}` : 'no button'); }
      let small = '', close = '';
      for (const b of this.btns) { if (Math.max(b.r + SLOP, REACH) * 2 < 56) small += b.a + ' '; for (const c of this.btns) if (c !== b && Math.hypot(b.cx - c.cx, b.cy - c.cy) - b.r - c.r < 12) close += b.a + '/' + c.a + ' '; }
      check('every button answers over at least 56 pixels, and the rings are at least 12 apart', !small && !close, small + '| ' + close);
      wipe();

      // ---- several fingers
      const At = this.at('attack'), Bl = this.at('block'), Ro = this.at('roll');
      fg(1, 'down', sx, sy); fg(1, 'move', sx, sy - R); fg(4, 'down', Bl.x, Bl.y); step();
      check('two fingers: the stick runs while block is held', near(input.move.y, 1) && input.held('block'));
      fg(2, 'down', lx, ly); fg(2, 'move', lx - 50, ly); step();
      check('three fingers: the stick, block and the lens together', near(input.move.y, 1) && input.held('block') && input.look.x > 0, `${input.move.y} ${input.held('block')} ${input.look.x}`);
      fg(5, 'down', At.x, At.y); step(); check('four: attack pressed as well', input.pressed('attack') && input.held('block') && near(input.move.y, 1));
      fg(6, 'down', W * 0.3, H * 0.7); fg(6, 'move', W * 0.3, H * 0.9); step(); check('a second finger on the left does not take the stick', near(input.move.y, 1) && near(input.move.x, 0)); fg(6, 'up', W * 0.3, H * 0.9);
      fg(7, 'down', Bl.x, Bl.y); fg(7, 'up', Bl.x, Bl.y); step(); check('a second finger on a held button changes nothing, nor does its lifting', input.held('block') && !input.pressed('block'));
      fg(5, 'up', At.x, At.y); step(); check('lifting one finger lets go only what it held', input.released('attack') && input.held('block') && near(input.move.y, 1));
      // ---- cancelled, blurred, hidden, turned
      fg(4, 'cancel', Bl.x, Bl.y); fg(1, 'cancel', sx, sy); step();
      check('cancelled fingers let go: block up, the stick at rest', !input.held('block') && near(input.move.y, 0) && this.stick.id === null);
      fg(2, 'up', lx, ly); wipe();
      const hold3 = () => { fg(1, 'down', sx, sy); fg(1, 'move', sx, sy - R); fg(4, 'down', Ro.x, Ro.y); fg(5, 'down', Bl.x, Bl.y); step(); return input.held('roll') && input.held('block') && near(input.move.y, 1); };
      const free = () => { step(); return !A.some((a) => input.held(a)) && near(input.move.x, 0) && near(input.move.y, 0) && this.fingers.size === 0 && !this.el.querySelector('.dn') && this.stick.id === null; };
      let ok = hold3(); window.dispatchEvent(new Event('blur')); check('the window loses focus: everything is let go', ok && free());
      ok = hold3(); document.dispatchEvent(new Event('visibilitychange')); check('the page is hidden: everything is let go', ok && free());
      ok = hold3(); window.dispatchEvent(new Event('orientationchange')); check('the screen is turned: everything is let go', ok && free());
      fg(1, 'move', sx, sy - R); fg(4, 'move', Ro.x, Ro.y); fg(1, 'up', sx, sy); fg(4, 'up', Ro.x, Ro.y); fg(5, 'up', Bl.x, Bl.y); check('fingers that were dropped, then move and lift, change nothing', free());
      ok = hold3(); window.dispatchEvent(new Event('resize')); step(); check('a mere change of size (a browser bar) drops nothing', ok && input.held('roll') && input.held('block') && near(input.move.y, 1));
      fg(1, 'up', sx, sy); fg(4, 'up', Ro.x, Ro.y); fg(5, 'up', Bl.x, Bl.y); check('... and the fingers lift as usual', free());
      // ---- a cutscene: the controls are away, the skip ring is the thing to hold
      ui.cineOn = true; this.force = false; this.sync();
      check('a cutscene: the controls are away', !this.live && !this.el.classList.contains('on'));
      fg(5, 'down', Bl.x, Bl.y); step(); check('... a finger where a button was does nothing, but brings up the skip ring', !input.held('block') && ui.skipLinger >= 4, ui.skipLinger); fg(5, 'up', Bl.x, Bl.y);
      const K = this.at('skip');
      if (K) {
        fg(5, 'down', K.x, K.y); step(); const down = input.held('skip'); for (let i = 0; i < 12; i++) step();
        check('... a finger on the skip ring holds skip', down && input.held('skip') && input.heldFor('skip') > 0.2 && ui.n.skip.classList.contains('dn'), `${down} ${input.heldFor('skip')}`);
        fg(5, 'move', K.x, K.y - 120); step(); check('... slid off, it is let go', !input.held('skip') && !ui.n.skip.classList.contains('dn'));
        fg(5, 'up', K.x, K.y - 120);
        fg(5, 'down', K.x, K.y); step(); ui.cineOn = false; this.force = true; this.sync(); step();
        check('... and when the cutscene ends under the finger, nothing is held', !input.held('skip') && !A.some((a) => input.held(a)) && this.live);
        fg(5, 'up', K.x, K.y);
      } else check('the skip ring is on the page', false);
      ui.cineOn = false;
      // ---- a mouse is not a finger; switched off, nothing is read
      this.force = true; this.sync(); wipe();
      const tgt = document.elementFromPoint(At.x, At.y) || document.body;
      tgt.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: At.x, clientY: At.y, bubbles: true })); step();
      check('a mouse pointer on a button is not a finger', !input.held('attack') && this.fingers.size === 0);
      tgt.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: At.x, clientY: At.y, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })); step(); ui.syncDevice(); this.sync();
      check('a key pressed: the device is keys again and the controls go away', input.device === 'keys' && ui.device === 'keys' && !this.live && near(input.move.y, 1), input.device + ' ' + ui.device);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })); step();
      fg(5, 'down', At.x, At.y); step(); check('... and a finger brings them back (that first touch presses what it lands on)', input.device === 'touch' && this.live && input.held('attack')); fg(5, 'up', At.x, At.y); wipe();
      check('at the end nothing is held and no finger is remembered', free());
    } catch (e) { check('the self-test itself: ' + (e && e.stack ? e.stack : e), false); }
    wipe(); this.testing = false;
    input.enabled = keep.enabled; input.wantLock = keep.wantLock; input.scriptMove = keep.move; input.scriptLook = keep.look; input.sensitivity = keep.sens; input.invertY = keep.inv;
    for (const a of keep.scripted) input.scripted.add(a);
    ui.cineOn = keep.cine; ui.skipLinger = keep.linger; this.force = keep.force; input.device = keep.device; ui.syncDevice(); this.sync();
    if (name) { fetch('/__shot/' + name, { method: 'POST', body: JSON.stringify(out, null, 1) }).then(() => { document.title = 'touch test done'; }).catch(() => {}); }
    return out;
  }

  dispose() { this.release(); for (const off of this.offs) if (typeof off === 'function') off(); this.offs.length = 0; this.el.remove(); this.turn.remove(); this.ui.root.classList.remove('upright'); }
}
