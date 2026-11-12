// Input: what the player wants, whatever they hold in their hands (docs/engine.md, "Input"; more in
// docs/modules/player.md). Keyboard and mouse, a gamepad and the touch controls are all live all the time; `device`
// follows whichever was touched last (the interface reads it for its prompts).
//
//   input.update()                           once per fixed step, first thing
//   input.move = { x, y }                    the stick: -1..1, y = forward. Length 1 = run, below 0.55 = walk
//   input.look = { x, y }                    camera turn gathered since the last step (radians: yaw to the left, pitch up)
//   input.held(a), pressed(a), released(a)   this step
//   input.buffered(a, seconds = 0.35)        pressed within the last so-many seconds and not yet used up
//   input.consume(a)                         use the press up
//   input.when(a)                            input time of the last unused press of a (-Infinity if none): to pick the newest of several
//   input.heldFor(a)                         seconds the button has been down (0 when it is up)
//   input.time                               seconds of input time (it advances by DT per update)
//   input.device                             'keys' | 'pad' | 'touch' (it starts as 'touch' where the main pointer is a finger)
//   input.coarse                             the main pointer is a finger (a phone, a tablet), or the address says &touch=1
//   input.set(a, on), input.setMove(x, y), input.setLook(x, y)     tests and bots: press, steer, turn the camera
//                                            (radians per step). They take effect at once, in the step they are called
//                                            in. setMove(null) and setLook(null) give the stick back.
//   input.sensitivity, input.invertY         the game sets these from the options screen
//   input.wantLock                           the game sets this while the fight is on: the pointer is captured
//   input.capture()                          ask for the pointer now (call it from a click or key handler, e.g. "Resume")
//   input.settle()                           the game calls this as it un-pauses: a button still down in the next step is
//                                            held, not pressed (the A that chose "Resume" does not also jump)
//   input.rumble(strong, weak, seconds)      shake the gamepad, if the last thing touched was a gamepad that can
//   input.poll()                             read the gamepad between steps (the camera calls it every display frame, so
//                                            a tap during a hit-stop is not lost)
//   input.touchSet(a, on), touchStick(x, y), touchTurn(dx, dy), touchClear()
//                                            the touch source: src/ui/touch.js draws the controls, reads the fingers and
//                                            says here what they press (see "The touch source" below)
//
// Actions: attack heavy block roll heal lock pause confirm skip jump. (`jump` was added last, on 9 Nov, and stays last:
// the recorded sessions, the film tools and the tests keep lists of the first nine by their place.)
//
// Keyboard and mouse: W A S D move, mouse looks (arrow keys too), left button attack, Shift + left button or E heavy,
// right button or C block, Space roll (hold to sprint), F jump, R heal, Q or middle button lock, Esc pause, Enter confirm.
// Gamepad (standard layout): left stick move, right stick look, RB attack, RT heavy, LB block, B roll (hold to
// sprint), A jump (in the menus A confirms, in a cutscene it skips: both read it themselves), X heal, right stick click
// lock, Start pause.
// Touch (src/ui/touch.js): a stick under the left thumb, a drag of the right thumb turns the lens, and a button on the
// screen for attack, heavy, roll (hold to sprint), jump, block, heal, lock, pause and, in a cutscene, skip.
//
// Nothing is ever eaten: a key that goes down and up again between two steps (or during a hit-stop) still counts as
// pressed in the next step, and every press is remembered for 0.35 s (buffered) until something uses it.
export const ACTIONS = ['attack', 'heavy', 'block', 'roll', 'heal', 'lock', 'pause', 'confirm', 'skip', 'jump'];

const KEY = {
  Space: ['roll', 'skip'], KeyR: ['heal'], KeyQ: ['lock'], KeyE: ['heavy'], KeyF: ['jump'], KeyC: ['block'], Tab: ['lock'],      // F jumps (9 Nov: Elden Ring's key; until then it was a second key for block, which is C now)
  Escape: ['pause', 'skip'], Enter: ['confirm', 'skip'], NumpadEnter: ['confirm', 'skip'],
};
const MOVE_KEYS = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
const LOOK_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
const PAD = { 5: ['attack'], 7: ['heavy'], 4: ['block'], 1: ['roll', 'skip'], 2: ['heal'], 11: ['lock'], 9: ['pause', 'skip'], 0: ['jump', 'confirm', 'skip'] };      // A: jump in play (the menus read A themselves; held in a cutscene it skips)
const QUIET = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);     // keys the page must not act on itself

const MOUSE_RAD = 0.0018;          // radians per pixel of pointer travel at sensitivity 1 (a full turn in about 3500 px)
const KEY_LOOK = 2.2;              // radians a second for the arrow keys
const PAD_YAW = 3.3, PAD_PITCH = 2.0;   // radians a second at full stick
const DEAD = 0.2, FULL = 0.94;     // the stick's dead zone and where it counts as fully pushed
const GESTURE_MS = 1200;           // how long after a click or key press the pointer may still be asked for
// touch: the right thumb dragged across a third of the screen's width turns the lens a quarter turn (at sensitivity 1);
// up and down is gentler, the lens has little room there
const TOUCH_TURN = Math.PI / 2, TOUCH_SWEEP = 1 / 3, TOUCH_PITCH = 0.6;
const isFinger = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

export class Input {
  constructor(ctx, canvas) {
    this.ctx = ctx; this.canvas = canvas; this.enabled = true; this.device = 'keys'; this.time = 0;
    this.move = { x: 0, y: 0 }; this.look = { x: 0, y: 0 };
    this.sensitivity = 1; this.invertY = false; this.wantLock = false;
    this.keys = new Set(); this.buttons = new Set(); this.tapped = new Set();        // tapped: went down since the last step (even if up again)
    this.scripted = new Set(); this.scriptMove = null; this.scriptLook = null;
    this.now = {}; this.was = {}; this.at = {}; this.since = {}; this.pulse = {}; this.padDown = {}; this.padEdge = {};
    for (const a of ACTIONS) { this.now[a] = this.was[a] = false; this.at[a] = -Infinity; this.since[a] = 0; this.pulse[a] = false; this.padDown[a] = false; this.padEdge[a] = false; }
    this._mx = 0; this._my = 0; this._padMove = { x: 0, y: 0 }; this._padLook = { x: 0, y: 0, hold: 0 }; this._padActive = false;
    this._gesture = -1e9; this._asked = -1e9; this._swallow = false; this._settings = false; this._hadLock = false; this._leftHeavy = false;
    // the touch source: what the fingers hold down, what they tapped since the last step, the stick, the lens's drag (pixels)
    this.touchDown = {}; this.touchEdge = {}; for (const a of ACTIONS) { this.touchDown[a] = false; this.touchEdge[a] = false; }
    this._touchMove = { x: 0, y: 0 }; this._tx = 0; this._ty = 0;
    const forced = ctx && ctx.params && ctx.params.get ? ctx.params.get('touch') : null;      // &touch=1: as on a phone (to look at it on a desk); &touch=0: never
    let finger = false; try { finger = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (e) { finger = false; }
    this.coarse = forced === '1' || (forced !== '0' && finger);
    if (this.coarse) this.device = 'touch';
    this._listen();
  }

  _paused() { const g = this.ctx.game; return !!(g && g.paused); }
  _locked() { return typeof document !== 'undefined' && document.pointerLockElement === this.canvas; }

  _listen() {
    const c = this.canvas, offs = this._offs = [];
    const on = (t, n, f, o) => { t.addEventListener(n, f, o); offs.push(() => t.removeEventListener(n, f, o)); };
    on(window, 'keydown', (e) => {
      if (QUIET.has(e.code) && !this._typing(e)) e.preventDefault();
      if (e.repeat) return;
      this._gesture = performance.now(); this.device = 'keys';
      this.keys.add(e.code); if (!this._paused()) this.tapped.add(e.code);
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => { this.keys.clear(); this.buttons.clear(); this.tapped.clear(); });
    on(window, 'mousedown', () => { this._gesture = performance.now(); }, true);
    on(c, 'mousedown', (e) => {
      this.device = 'keys';
      if (this.wantOrPlaying() && this.enabled && !this._locked() && !this._paused()) { this.capture(); this._swallow = true; return; }   // the click that takes the pointer does not also swing the sword
      if (e.button === 0) this._leftHeavy = !!e.shiftKey || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');      // a click that began as a heavy stays one until it is let go, Shift or no Shift
      this.buttons.add(e.button); if (!this._paused()) this.tapped.add('M' + e.button);
      if (e.button === 1) e.preventDefault();
    });
    on(window, 'mouseup', (e) => { this.buttons.delete(e.button); this._swallow = false; });
    on(c, 'contextmenu', (e) => e.preventDefault());
    on(c, 'auxclick', (e) => e.preventDefault());
    on(window, 'mousemove', (e) => { if (this._locked()) { this._mx += e.movementX || 0; this._my += e.movementY || 0; } });
    on(document, 'pointerlockchange', () => {
      // the browser takes the pointer back on Esc (often without sending the key): that is a press of 'pause'
      if (!this._locked() && this.wantLock && this.enabled && !this._paused() && this._hadLock) this.pulse.pause = true;
      this._hadLock = this._locked();
      if (!this._hadLock) { this.buttons.clear(); this._mx = this._my = 0; }
    });
    on(document, 'pointerlockerror', () => {});
    // ---- fingers. The controls themselves are src/ui/touch.js; here only what must hold whoever draws them:
    // a finger on the glass makes the device 'touch'; a finger on the picture never becomes a mouse click as well (the
    // browser would send one after every tap, and that click would ask for the pointer and swing the sword); and
    // nothing a finger held stays held when the page loses it.
    on(window, 'pointerdown', (e) => { if (isFinger(e)) this.device = 'touch'; }, true);
    on(c, 'touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    on(c, 'touchend', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    on(window, 'blur', () => this.touchClear());
    on(document, 'visibilitychange', () => this.touchClear());
    if (this.coarse) on(document, 'gesturestart', (e) => { if (e.cancelable) e.preventDefault(); });      // an iPhone's own pinch: the page is not to be zoomed
  }
  _typing(e) { const t = e.target; return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)); }

  /** Ask for the pointer (hidden, endless mouse travel). Must be called while a click or key press is being handled.
   *  (The plain request, on purpose: the system's own pointer feel, which is what a trackpad on a laptop needs.) */
  capture() {
    const c = this.canvas;
    if (!c.requestPointerLock || this._locked()) return;
    this._asked = performance.now();
    try { const p = c.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* refused: play without it */ }
  }

  // ------------------------------------------------------------------ the touch source
  // src/ui/touch.js owns the fingers (which finger is on what) and tells the input what they do. Like the gamepad's,
  // a button's press is kept as an edge until the next step, so a tap shorter than a step still counts.

  /** A finger went down on the button of an action (on = true), or came off it. */
  touchSet(a, on) {
    if (!(a in this.touchDown)) return;
    if (on) { this.device = 'touch'; if (!this.touchDown[a]) { this.touchDown[a] = true; if (!this._paused()) this.touchEdge[a] = true; } }
    else this.touchDown[a] = false;
  }
  /** The stick under the left thumb: how far it is pushed, -1..1 each way, y = forward. It has the gamepad stick's
   *  dead zone and its rescaling, so the same push gives the same walk or run. (0, 0) = let go. */
  touchStick(x, y) {
    const out = this._touchMove, l = Math.hypot(x, y);
    if (!(l >= DEAD)) { out.x = out.y = 0; return; }
    const m = Math.min(1, (l - DEAD) / (FULL - DEAD)); out.x = (x / l) * m; out.y = (y / l) * m; this.device = 'touch';
  }
  /** The right thumb dragged this many pixels over the picture (to the right, down). */
  touchTurn(dx, dy) { this._tx += dx; this._ty += dy; this.device = 'touch'; }
  /** Every finger off: nothing held, the stick at rest. */
  touchClear() {
    for (const a of ACTIONS) { this.touchDown[a] = false; this.touchEdge[a] = false; }
    this._touchMove.x = this._touchMove.y = 0; this._tx = this._ty = 0;
  }

  /** Read the gamepad. Called from update(), and by the camera every display frame so that taps between steps count. */
  poll() {
    if (!this.enabled || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let pads; try { pads = navigator.getGamepads(); } catch (e) { return; }
    let pad = null;
    for (const p of pads) if (p && p.connected && p.buttons && p.buttons.length >= 10) { pad = p; break; }
    this._pad = pad;
    const down = this._padNow || (this._padNow = {}); for (const a of ACTIONS) down[a] = false;
    if (!pad) { this._padMove.x = this._padMove.y = 0; this._padLook.x = this._padLook.y = 0; for (const a of ACTIONS) this.padDown[a] = false; return; }
    let any = false;
    for (let i = 0; i < pad.buttons.length; i++) {
      const b = pad.buttons[i], on = b.pressed || b.value > 0.4;
      if (!on) continue; any = true;
      const l = PAD[i]; if (l) for (const a of l) down[a] = true;
    }
    for (const a of ACTIONS) { if (down[a] && !this.padDown[a] && !this._paused()) this.padEdge[a] = true; this.padDown[a] = down[a]; }
    // sticks: a round dead zone, then rescaled so that the edge of the dead zone is zero
    const stick = (x, y, out) => {
      const l = Math.hypot(x, y); if (l < DEAD) { out.x = out.y = 0; return 0; }
      const m = Math.min(1, (l - DEAD) / (FULL - DEAD)); out.x = (x / l) * m; out.y = (y / l) * m; return m;
    };
    const ax = pad.axes;
    if (stick(ax[0] || 0, ax[1] || 0, this._padMove) > 0) any = true;
    this._padMove.y = -this._padMove.y;
    if (stick(ax[2] || 0, ax[3] || 0, this._padLook) > 0) any = true;
    if (any) { this.device = 'pad'; this._padActive = true; }
  }

  /** Once per fixed step, first thing. */
  update() {
    const DT = this.ctx.DT, A = ACTIONS;
    this.time += DT;
    if (!this._settings && this.ctx.ui && this.ctx.ui.settings) {             // the options as they were saved
      this._settings = true; const s = this.ctx.ui.settings;
      if (typeof s.sensitivity === 'number') this.sensitivity = s.sensitivity; if (typeof s.invertY === 'boolean') this.invertY = s.invertY;
    }
    const h = this._h || (this._h = {}), edge = this._e || (this._e = {});
    for (const a of A) { h[a] = this.scripted.has(a); edge[a] = false; }
    let mx = 0, my = 0, lx = 0, ly = 0;
    if (this.enabled) {
      const K = this.keys, T = this.tapped, shift = !!this._leftHeavy;
      for (const code of K) { const l = KEY[code]; if (l) for (const a of l) h[a] = true; }
      for (const code of T) { const l = KEY[code]; if (l) for (const a of l) edge[a] = true; }
      if (!this._swallow) {
        if (this.buttons.has(0)) h[shift ? 'heavy' : 'attack'] = true;
        if (this.buttons.has(2)) h.block = true;
        if (this.buttons.has(1)) h.lock = true;
      }
      if (T.has('M0')) edge[shift ? 'heavy' : 'attack'] = true;
      if (T.has('M2')) edge.block = true;
      if (T.has('M1')) edge.lock = true;
      for (const code in MOVE_KEYS) if (K.has(code)) { mx += MOVE_KEYS[code][0]; my += MOVE_KEYS[code][1]; }
      const inv = this.invertY ? -1 : 1, s = this.sensitivity;
      lx = -this._mx * MOUSE_RAD * s; ly = -this._my * MOUSE_RAD * s * inv;
      for (const code in LOOK_KEYS) if (K.has(code)) { lx += LOOK_KEYS[code][0] * KEY_LOOK * DT * s; ly += LOOK_KEYS[code][1] * KEY_LOOK * DT * s * inv; }
      this.poll();
      if (this._pad) {
        for (const a of A) { if (this.padDown[a]) h[a] = true; if (this.padEdge[a]) edge[a] = true; }
        const pm = this._padMove; if (pm.x || pm.y) { mx = pm.x; my = pm.y; }
        // the right stick: gentle near the middle, and a little faster once it has been held hard over for a moment
        const pl = this._padLook, m = Math.hypot(pl.x, pl.y);
        if (m > 0) {
          pl.hold = m > 0.9 ? Math.min(1, pl.hold + DT / 0.5) : 0;
          const k = m * (0.45 + 0.55 * m) * (1 + 0.35 * pl.hold) / m;
          lx += -pl.x * k * PAD_YAW * DT * s; ly += -pl.y * k * PAD_PITCH * DT * s * inv;
        } else pl.hold = 0;
      }
      // the touch controls: buttons, the stick, the lens dragged by the right thumb
      const TD = this.touchDown, TE = this.touchEdge, tm = this._touchMove;
      for (const a of A) { if (TD[a]) h[a] = true; if (TE[a]) edge[a] = true; }
      if (tm.x || tm.y) { mx = tm.x; my = tm.y; }
      if (this._tx || this._ty) {
        const w = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 844, k = TOUCH_TURN / Math.max(200, w * TOUCH_SWEEP);
        lx += -this._tx * k * s; ly += -this._ty * k * TOUCH_PITCH * s * inv;
      }
      // take the pointer back after "Begin" or "Resume" (a click or key press on the interface counts as the gesture)
      if (this.wantOrPlaying() && !this._locked() && this.device === 'keys' && !this._paused()) {
        const t = performance.now();
        if (t - this._gesture < GESTURE_MS && this._asked < this._gesture) this.capture();
      }
      const cur = this.wantLock && !this._paused() ? 'none' : '';
      if (this._cursor !== cur) { this._cursor = cur; this.canvas.style.cursor = cur; }
    }
    for (const a of A) { if (this.pulse[a]) { edge[a] = true; this.pulse[a] = false; } this.padEdge[a] = false; this.touchEdge[a] = false; }
    this.tapped.clear(); this._mx = this._my = 0; this._tx = this._ty = 0;
    if (this.scriptMove) { mx = this.scriptMove.x; my = this.scriptMove.y; }
    if (this.scriptLook) { lx += this.scriptLook.x; ly += this.scriptLook.y; }
    const len = Math.hypot(mx, my); if (len > 1) { mx /= len; my /= len; }
    this.move.x = mx; this.move.y = my; this.look.x = lx; this.look.y = ly;
    const settle = this._settle; this._settle = false;
    for (const a of A) {
      this.was[a] = this.now[a];
      const down = !!h[a], hit = edge[a] && !this.was[a];                      // a tap that came and went between two steps
      this.now[a] = down || hit;
      if (settle && this.now[a] && !this.was[a] && !this.scripted.has(a)) { this.was[a] = true; this.since[a] = 0; }      // back from a menu with a button still down: held, never pressed (settle())
      else if (this.now[a] && !this.was[a]) { this.at[a] = this.time; this.since[a] = 0; }
      else if (this.now[a]) this.since[a] += DT;
    }
  }
  /** Control comes back from a menu (the game calls this as it un-pauses). A button that is still down in the next step
   *  is the one that made the choice ("Resume" with a gamepad's A, which is also the jump): it counts as held, so a
   *  shield kept up stays up, but it is not a press and starts nothing. Buttons pressed by tests and bots are left alone. */
  settle() { this._settle = true; }
  /** The pointer is wanted from the opening onward, so the fight starts with the mouse already in hand. */
  wantOrPlaying() { if (this.wantLock) return true; const g = this.ctx.game, s = g && g.state; return s === 'intro' || s === 'phase' || s === 'rescue'; }

  held(a) { return this.now[a]; }
  pressed(a) { return this.now[a] && !this.was[a]; }
  released(a) { return !this.now[a] && this.was[a]; }
  /** Pressed within the last `seconds` and not yet used up. */
  buffered(a, seconds = 0.35) { return this.time - this.at[a] <= seconds + 1e-6; }
  consume(a) { this.at[a] = -Infinity; }
  when(a) { return this.at[a]; }
  heldFor(a) { return this.now[a] ? this.since[a] + this.ctx.DT : 0; }

  /** Tests and bots: hold or let go of a button. It counts from the step it is called in. */
  set(a, on) {
    if (on) {
      if (this.scripted.has(a)) return; this.scripted.add(a);
      if (!this.now[a]) { this.now[a] = true; this.at[a] = this.time; this.since[a] = 0; }
    } else if (this.scripted.has(a)) { this.scripted.delete(a); this.now[a] = false; }
  }
  /** Tests and bots: steer. setMove(null) gives the stick back. */
  setMove(x, y) {
    if (x === null || x === undefined) { this.scriptMove = null; return; }
    const m = this.scriptMove || (this.scriptMove = { x: 0, y: 0 }); const l = Math.hypot(x, y);
    m.x = l > 1 ? x / l : x; m.y = l > 1 ? y / l : y; this.move.x = m.x; this.move.y = m.y;
  }
  /** Tests: turn the camera by so many radians every step. setLook(null) stops. */
  setLook(x, y) { if (x === null || x === undefined) { this.scriptLook = null; return; } const l = this.scriptLook || (this.scriptLook = { x: 0, y: 0 }); l.x = x; l.y = y || 0; }

  /** Shake the gamepad (a blow lands). Nothing happens on keyboard and mouse, or when the pad cannot. */
  rumble(strong = 0.5, weak = 0.5, seconds = 0.15) {
    const p = this._pad; if (!p || this.device !== 'pad' || !this.enabled) return;
    const s = this.ctx.ui && this.ctx.ui.settings; if (s && s.reducedMotion) { strong *= 0.4; weak *= 0.4; }
    try { const v = p.vibrationActuator; if (v && v.playEffect) { const q = v.playEffect('dual-rumble', { duration: seconds * 1000, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }); if (q && q.catch) q.catch(() => {}); } } catch (e) { /* no rumble */ }
  }

  /** Check the wiring without hands: it sends itself key, mouse and gamepad events and reads back what update() makes
   *  of them, then does the same with the touch source. Returns { ok, checks: [...] }. (The feel probe calls it: see
   *  src/bot.js.) It leaves no button down. The fingers' own test, with pointer events, is ctx.ui.touch.selfTest(). */
  selfTest() {
    const out = { ok: true, checks: [] }, c = this.canvas, A = ACTIONS;
    const check = (name, ok) => { out.checks.push((ok ? 'ok    ' : 'FAIL  ') + name); if (!ok) out.ok = false; };
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const mouse = (type, button, target) => (target || c).dispatchEvent(new MouseEvent(type, { button, bubbles: true }));
    const keep = { enabled: this.enabled, wantLock: this.wantLock, scripted: new Set(this.scripted), move: this.scriptMove, look: this.scriptLook, device: this.device };
    this.enabled = true; this.wantLock = false; this.scripted.clear(); this.scriptMove = null; this.scriptLook = null;
    const wipe = () => { this.keys.clear(); this.buttons.clear(); this.tapped.clear(); this._swallow = false; for (const a of A) { this.pulse[a] = false; this.padEdge[a] = false; } this.update(); this.update(); for (const a of A) this.consume(a); };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    try {
      wipe();
      key('keydown', 'KeyW'); this.update(); check('W: the stick is forward', near(this.move.y, 1) && near(this.move.x, 0) && this.device === 'keys');
      key('keydown', 'KeyD'); this.update(); check('W + D: a diagonal of length 1, to the right', near(Math.hypot(this.move.x, this.move.y), 1) && this.move.x > 0.7);
      key('keyup', 'KeyW'); key('keyup', 'KeyD'); this.update(); check('keys up: the stick is at rest', near(this.move.x, 0) && near(this.move.y, 0));
      key('keydown', 'Space'); key('keyup', 'Space'); this.update();
      check('Space down and up between two steps is still a press of roll', this.pressed('roll') && this.buffered('roll'));
      this.update(); check('... and a release in the step after', this.released('roll') && !this.held('roll'));
      for (let i = 0; i < 18; i++) this.update(); check('a press is remembered for a third of a second', this.buffered('roll', 0.35));
      for (let i = 0; i < 3; i++) this.update(); check('... and no longer', !this.buffered('roll', 0.35));
      key('keydown', 'Space'); this.update(); this.consume('roll'); check('a press that was used up is gone', !this.buffered('roll') && this.held('roll'));
      for (let i = 0; i < 29; i++) this.update(); check('heldFor counts the hold (0.5 s)', near(this.heldFor('roll'), 0.5)); key('keyup', 'Space'); this.update();
      mouse('mousedown', 0); this.update(); check('left button: attack', this.pressed('attack') && !this.held('heavy'));
      mouse('mouseup', 0, window); this.update(); check('left button up: released', this.released('attack'));
      key('keydown', 'ShiftLeft'); mouse('mousedown', 0); this.update(); check('Shift + left button: heavy, not attack', this.pressed('heavy') && !this.held('attack'));
      mouse('mouseup', 0, window); key('keyup', 'ShiftLeft'); this.update();
      mouse('mousedown', 2); this.update(); check('right button: block, held', this.held('block')); mouse('mouseup', 2, window); this.update(); check('right button up: guard down', !this.held('block'));
      mouse('mousedown', 1); this.update(); check('middle button: lock', this.pressed('lock')); mouse('mouseup', 1, window); this.update();
      const keys = { KeyE: 'heavy', KeyR: 'heal', KeyQ: 'lock', KeyF: 'jump', KeyC: 'block', Escape: 'pause', Enter: 'confirm' };
      for (const code in keys) { key('keydown', code); this.update(); const ok = this.pressed(keys[code]); key('keyup', code); this.update(); check(code + ': ' + keys[code], ok && !this.held(keys[code])); }
      key('keydown', 'KeyF'); this.update(); check('F is the jump alone: it no longer raises the shield', this.pressed('jump') && !this.held('block')); key('keyup', 'KeyF'); this.update(); this.consume('jump');
      key('keydown', 'KeyF'); key('keyup', 'KeyF'); this.update(); const jt = this.pressed('jump') && this.buffered('jump'); for (let i = 0; i < 18; i++) this.update();
      check('F down and up between two steps is a press of jump, remembered for a third of a second like the others', jt && this.buffered('jump', 0.35) && !this.held('jump')); for (let i = 0; i < 3; i++) this.update(); this.consume('jump');
      this.settle(); key('keydown', 'KeyF'); this.update(); const sh = this.held('jump') && !this.pressed('jump') && !this.buffered('jump'); this.update(); const sh2 = this.held('jump') && !this.pressed('jump'); key('keyup', 'KeyF'); this.update();
      key('keydown', 'KeyF'); this.update(); check('settle(): a button down as control comes back from a menu is held, not pressed; let go and pressed again it counts', sh && sh2 && this.pressed('jump') && this.buffered('jump')); key('keyup', 'KeyF'); this.update(); this.consume('jump');
      this.settle(); this.set('attack', true); this.update(); check('settle() leaves a button pressed by set() alone', this.held('attack') && this.buffered('attack')); this.set('attack', false); this.update(); this.consume('attack');
      key('keydown', 'ArrowLeft'); this.update(); check('left arrow turns the camera to the left', this.look.x > 0); key('keyup', 'ArrowLeft'); this.update();
      this.set('attack', true); check('set() counts in the step it is called in', this.pressed('attack') && this.buffered('attack'));
      this.update(); check('... and is a hold in the next', this.held('attack') && !this.pressed('attack')); this.set('attack', false); check('... and so does letting go', this.released('attack'));
      this.setMove(0.3, 0.4); check('setMove() steers at once', near(this.move.x, 0.3) && near(this.move.y, 0.4)); this.setMove(null); this.update();
      // a gamepad (the browser's own cannot be pressed from here: a stand-in with the standard layout)
      const real = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
      const pad = { connected: true, axes: [0, -1, 1, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
      let patched = false;
      try { Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] }); patched = navigator.getGamepads()[0] === pad; } catch (e) { patched = false; }
      if (patched) {
        this.update(); check('pad: left stick up is forward, right stick right turns right', near(this.move.y, 1) && this.look.x < 0 && this.device === 'pad');
        pad.axes = [0.1, 0.1, 0, 0]; this.update(); check('pad: a stick inside its dead zone is at rest', near(this.move.x, 0) && near(this.move.y, 0) && near(this.look.x, 0));
        pad.axes = [0.5, 0, 0, 0]; this.update(); check('pad: half a push is a walk (well under 1)', this.move.x > 0.25 && this.move.x < 0.55);
        const map = { 5: 'attack', 4: 'block', 1: 'roll', 2: 'heal', 11: 'lock', 9: 'pause', 0: 'confirm' };
        pad.buttons[0].pressed = true; this.update(); const aj = this.pressed('jump') && this.pressed('confirm') && this.held('skip'); pad.buttons[0].pressed = false; this.update(); check('pad button 0 (A): jump, and still confirm and skip', aj && this.released('jump')); this.consume('jump');
        for (const i in map) { pad.buttons[i].pressed = true; this.update(); const ok = this.pressed(map[i]); pad.buttons[i].pressed = false; this.update(); check('pad button ' + i + ': ' + map[i], ok && this.released(map[i])); }
        pad.buttons[7].value = 0.8; this.update(); check('pad: right trigger pulled is heavy', this.pressed('heavy')); pad.buttons[7].value = 0; this.update();
        pad.buttons[1].pressed = true; this.poll(); pad.buttons[1].pressed = false; this.poll(); this.update(); check('pad: a tap between two steps, seen by poll(), is a press', this.pressed('roll'));
        this.update();
        if (real) Object.defineProperty(navigator, 'getGamepads', real); else delete navigator.getGamepads;
      } else out.checks.push('skip  gamepad (cannot stand in for navigator.getGamepads here)');
      // the touch source (the fingers themselves are read in src/ui/touch.js, which has its own self-test with pointer events)
      wipe(); this.device = 'keys';
      this.touchSet('block', true); this.update(); check('touch: a button held is a press, and the device is touch', this.pressed('block') && this.held('block') && this.device === 'touch');
      this.update(); check('touch: ... and stays held', this.held('block') && !this.pressed('block')); this.touchSet('block', false); this.update(); check('touch: ... until the finger lifts', this.released('block'));
      this.touchSet('roll', true); this.touchSet('roll', false); this.update(); check('touch: a tap between two steps is still a press', this.pressed('roll') && this.buffered('roll')); this.update(); this.consume('roll');
      this.touchSet('jump', true); this.touchSet('jump', false); this.update(); check('touch: the jump button tapped is a press of jump', this.pressed('jump') && this.buffered('jump') && !this.held('roll')); this.update(); this.consume('jump');
      this.touchStick(0.1, 0.1); this.update(); check('touch: the stick inside its dead zone is at rest', near(this.move.x, 0) && near(this.move.y, 0));
      this.touchStick(0, 0.5); this.update(); check('touch: half a push is a walk, as on a gamepad', near(this.move.x, 0) && near(this.move.y, (0.5 - DEAD) / (FULL - DEAD)) && this.move.y < 0.55);
      this.touchStick(0.8, 0.8); this.update(); check('touch: a full push is a run (length 1), on the diagonal too', near(Math.hypot(this.move.x, this.move.y), 1) && this.move.x > 0.7);
      this.touchStick(0, 0); this.update(); check('touch: the thumb lifted, the stick is at rest', near(this.move.x, 0) && near(this.move.y, 0));
      this.touchTurn(60, -20); this.update(); const lx1 = this.look.x, ly1 = this.look.y; this.update();
      check('touch: a drag to the right turns the lens right, a drag up looks up, and only while it moves', lx1 < 0 && (this.invertY ? ly1 < 0 : ly1 > 0) && near(this.look.x, 0) && near(this.look.y, 0));
      this.touchSet('attack', true); this.touchStick(0, 1); this.touchClear(); this.update(); check('touch: touchClear() lets everything go', !this.held('attack') && near(this.move.y, 0));
      const was = this.enabled; this.enabled = false; this.touchSet('heavy', true); this.touchStick(1, 0); this.update();
      check('touch: nothing of it is read while the input is switched off (a replay)', !this.held('heavy') && near(this.move.x, 0)); this.touchClear(); this.enabled = was;
    } catch (e) { check('the self-test itself: ' + (e && e.message), false); }
    this.touchClear(); wipe(); this._pad = null; this._padMove.x = this._padMove.y = 0; this._padLook.x = this._padLook.y = 0;
    this.enabled = keep.enabled; this.wantLock = keep.wantLock; this.scriptMove = keep.move; this.scriptLook = keep.look; this.device = keep.device;
    for (const a of keep.scripted) this.scripted.add(a);
    return out;
  }

  dispose() { for (const off of this._offs) off(); this._offs.length = 0; }
}
