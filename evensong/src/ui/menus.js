// The screens with choices on them: the title, the pause (with its controls card), the options, a question before
// anything that throws the fight away, and the end card.
//
// While one of them is open the game does not read ctx.input (the world's clock may be stopped), so they listen to
// the keyboard, the mouse and the gamepad themselves, and nothing here depends on ui.update(dt): the screens move
// with CSS transitions, and the gamepad is read from a requestAnimationFrame loop that runs only while a screen is
// open. Arrows, W S or the pad choose; left and right adjust; Enter, Space or A confirm; Escape, Backspace or B go
// back; Start begins on the title and resumes from the pause.
//
// Fingers: a tap is a click (every line is a target a finger's width high while the device in hand is a touch
// screen: style.js), a slider is dragged, a tap anywhere on a line of choices takes the next one, and nothing depends
// on hover. There is no small print about keys then. "Begin" and "Resume" chosen by a finger also ask for the whole
// screen (touch.js: gesture()).
//
// Presses do not leak into the game: a choice that hands control back (Begin, Resume, Start again) is announced to
// the game only once the key or button that made it has been let go (or after 0.4 s).
import { glyphsFor, esc } from './glyphs.js';
import { mountLogo } from './logo.js';

/** Every word on these screens. Sentence case. */
export const TEXT = {
  begin: 'Begin', options: 'Options', resume: 'Resume', restart: 'Start the fight again', toTitle: 'Return to the title',
  paused: 'Paused', back: 'Back', thanks: 'Thank you for playing.',
  askRestart: 'Start the fight again?', askRestartYes: 'Start again', askTitle: 'Return to the title?', askTitleYes: 'Return to the title',
  askNote: 'This fight will be lost.', askNo: 'Keep fighting',
  keys: 'Keyboard and mouse', pad: 'Gamepad', or: 'or', touch: 'On the screen',
  choose: 'Choose', adjust: 'Adjust', select: 'Select', goBack: 'Back',
};

/** The rows of the options screen. `key` is the name in ui.settings. */
export const OPTIONS = [
  { key: 'music', label: 'Music', kind: 'slider', min: 0, max: 1, step: 0.05, show: (v) => String(Math.round(v * 100)) },
  { key: 'sfx', label: 'Effects', kind: 'slider', min: 0, max: 1, step: 0.05, show: (v) => String(Math.round(v * 100)) },
  { key: 'voice', label: 'Voice', kind: 'slider', min: 0, max: 1, step: 0.05, show: (v) => String(Math.round(v * 100)) },
  { key: 'sensitivity', label: 'Camera sensitivity', kind: 'slider', min: 0.2, max: 2, step: 0.1, show: (v) => v.toFixed(1) },
  { key: 'invertY', label: 'Invert camera up and down', kind: 'choice', values: [false, true], names: ['Off', 'On'] },
  { key: 'quality', label: 'Picture quality', kind: 'choice', values: ['low', 'medium', 'high', 'ultra'], names: ['Low', 'Medium', 'High', 'Ultra'] },
  { key: 'reducedMotion', label: 'Reduced motion', kind: 'choice', values: [false, true], names: ['Off', 'On'] },
];

/** The controls card: what the design's table says, in the player's words. [label, action]. */
export const CONTROLS = [
  ['Move', 'move'], ['Turn the camera', 'look'], ['Lock on, and off', 'lock'], ['Light attack', 'attack'],
  ['Heavy attack; hold to charge', 'heavy'], ['Block; hold', 'block'], ['Roll; hold to sprint', 'roll'],
  ['Jump', 'jump'], ['Drink from a flask', 'heal'], ['Pause', 'pause'],
];
/** On a touch screen two of them are not buttons: what the card says beside their marks. */
const TOUCH_HOW = { move: 'left thumb', look: 'right thumb' };
/** The line of small print under the title's menu. */
const LEGEND = [['move', 'Move'], ['look', 'Look'], ['attack', 'Attack'], ['block', 'Block'], ['roll', 'Roll'], ['jump', 'Jump'], ['lock', 'Lock on'], ['heal', 'Flask']];

const PANELS = ['title', 'pause', 'ask', 'options', 'end'];
const GUARD_MS = 280;          // a screen that has just opened ignores confirm and back for this long
const LEAVE_MS = 400;          // the longest a choice waits for its key to be let go
const RETURN_MS = 700;         // if the game does not take the screen away after a choice, it comes back
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Menus {
  constructor(ui, parent) {
    this.ui = ui; this.panel = null; this.from = 'title'; this.device = 'keys';
    this.sel = 0; this.pauseSel = 0; this.items = []; this.closing = null; this.closeAt = 0; this.openedAt = 0; this.returnAt = 0;
    this.down = new Set(); this.pa = this.pb = this.ps = false; this.pdir = ''; this.prep = 0;
    this.raf = 0; this.drag = null; this._pad = { x: 0, y: 0, a: false, b: false, s: false, any: false };

    const el = this.el = document.createElement('div'); el.className = 'evs-menus';
    el.innerHTML = `
      <div class="evs-veil vt"></div><div class="evs-veil vp"></div><div class="evs-veil ve"></div>
      <section class="evs-panel evs-title" data-p="title">
        <div class="evs-spot"><div class="logo"></div></div>
        <nav class="evs-list" role="menu"></nav>
        <p class="evs-legend"></p>
      </section>
      <section class="evs-panel evs-pause" data-p="pause">
        <div class="col"><h2>${TEXT.paused}</h2><nav class="evs-list" role="menu"></nav></div>
        <div class="evs-card"></div>
        <p class="evs-keys"></p>
      </section>
      <section class="evs-panel evs-ask" data-p="ask">
        <div class="col"><h2></h2><p class="note"></p><nav class="evs-list" role="menu"></nav></div>
        <p class="evs-keys"></p>
      </section>
      <section class="evs-panel evs-options" data-p="options">
        <div class="col"><h2>${TEXT.options}</h2><div class="evs-rows" role="menu"></div></div>
        <p class="evs-keys"></p>
      </section>
      <section class="evs-panel evs-end" data-p="end">
        <div class="logo"></div><p class="thanks">${TEXT.thanks}</p><nav class="evs-list" role="menu"></nav>
      </section>`;
    parent.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.n = { title: q('.evs-title'), pause: q('.evs-pause'), ask: q('.evs-ask'), options: q('.evs-options'), end: q('.evs-end'),
      legend: q('.evs-legend'), card: q('.evs-card'), askQ: q('.evs-ask h2'), askNote: q('.evs-ask .note') };
    mountLogo(q('.evs-title .logo')); mountLogo(q('.evs-end .logo'));

    // ---- what each screen offers. `go` asks the interface for another screen; `leave` hands control back to the game.
    // (`quiet` marks a choice the audio module sounds for itself, from the event that follows.)
    const quiet = (fn) => { fn.quiet = true; return fn; };
    const go = (name) => () => this.ui.showScreen(name);
    const leave = (type) => quiet(() => this.leave({ type }));
    this.spec = {
      title: { list: [[TEXT.begin, leave('play')], [TEXT.options, go('options')]], start: leave('play') },
      pause: { list: [[TEXT.resume, leave('resume')], [TEXT.restart, () => this.ask('restart')], [TEXT.options, go('options')], [TEXT.toTitle, () => this.ask('title')]],
        back: leave('resume'), start: leave('resume') },
      ask: { list: [], back: () => this.open('pause') },
      options: { rows: OPTIONS, list: [[TEXT.back, quiet(() => this.back())]], back: () => this.ui.showScreen(this.from) },
      end: { list: [[TEXT.toTitle, leave('title')]], start: leave('title') },
    };
    this.built = {};
    for (const name of ['title', 'pause', 'options', 'end']) this._build(name);
    this._card(); this._legends();

    // ---- listening
    this._onKey = (e) => this._key(e);
    this._onKeyUp = (e) => this.down.delete(e.code);
    this._onBlur = () => { this.down.clear(); this.drag = null; };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    const itemAt = (e) => { const it = e.target.closest ? e.target.closest('.it') : null; return it && it.parentNode === this._host() ? it : null; };
    el.addEventListener('mousemove', (e) => {
      if (!this.panel || this.closing || this.returnAt || (!e.movementX && !e.movementY)) return;
      const it = itemAt(e); if (it) this._select(+it.dataset.i);
      this._device('keys');
    });
    el.addEventListener('click', (e) => {
      if (!this.panel || this.closing || this.returnAt || this._guarded()) return;
      const it = itemAt(e); if (!it) return;
      this._select(+it.dataset.i);
      const item = this.items[this.sel], word = e.target.closest('.ch b');
      if (item.row) {                                                   // sliders answer to pointerdown
        if (word) this._set(item.row, item.row.values[+word.dataset.v]);
        else if (item.row.kind === 'choice' && this._byFinger()) this._step(item.row, 1, true);      // a finger need not find the word: the line takes its next choice
        return;
      }
      this._confirm();
    });
    el.addEventListener('pointerdown', (e) => {
      const tr = e.target.closest ? e.target.closest('.sl') : null; if (!tr || this.panel !== 'options' || this.closing) return;
      const it = tr.closest('.it'); this._select(+it.dataset.i);
      this.drag = { tr, row: this.items[this.sel].row };
      if (tr.setPointerCapture) { try { tr.setPointerCapture(e.pointerId); } catch (err) { /* no capture: the drag still follows the pointer over the panel */ } }
      this._dragTo(e.clientX); e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (this.drag) this._dragTo(e.clientX); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());        // a right click on a menu is not a request for the browser's own
    const drop = () => { this.drag = null; };
    el.addEventListener('pointerup', drop); el.addEventListener('pointercancel', drop);
    this._loop = () => this._frame();
  }

  // ------------------------------------------------------------------ building

  _build(name) {
    const sp = this.spec[name], panel = this.n[name], items = [];
    const host = panel.querySelector(sp.rows ? '.evs-rows' : '.evs-list');
    let html = '';
    if (sp.rows) {
      for (const row of sp.rows) {
        const i = items.length; items.push({ row });
        const ctl = row.kind === 'slider'
          ? `<span class="sl"><i class="fl"></i><i class="kw"><i class="kn"></i></i></span><span class="val"></span>`
          : `<span class="ch">${row.names.map((nm, v) => `<b data-v="${v}">${esc(nm)}</b>`).join('')}</span>`;
        html += `<div class="it ${row.kind}" role="menuitem" data-i="${i}"><span class="lb">${esc(row.label)}</span>${ctl}</div>`;
      }
    }
    for (const [label, act] of sp.list) {
      const i = items.length; items.push({ act });
      html += `<div class="it${sp.rows ? ' act' : ''}" role="menuitem" data-i="${i}"><span class="lb">${esc(label)}</span></div>`;
    }
    host.innerHTML = html;
    for (let i = 0; i < items.length; i++) items[i].el = host.children[i];
    this.built[name] = { items, host };
    if (sp.rows) for (const it of items) if (it.row) this._paint(it);
  }

  /** The controls card on the pause screen: every action, for the keyboard and mouse and for a gamepad; with fingers
   *  as the device in hand, one column instead: the controls as they are on the screen (the styles show one or the other). */
  _card() {
    let rows = '';
    for (const [label, action] of CONTROLS) {
      const alt = glyphsFor(action, 'keys', 'alt'), how = TOUCH_HOW[action];
      rows += `<tr><td>${esc(label)}</td><td class="k">${glyphsFor(action, 'keys')}${alt ? `<em>${TEXT.or}</em>${alt}` : ''}</td><td class="p">${glyphsFor(action, 'pad')}</td>` +
        `<td class="t">${glyphsFor(action, 'touch')}${how ? `<span>${esc(how)}</span>` : ''}</td></tr>`;
    }
    this.n.card.innerHTML = `<table><thead><tr><th></th><th class="k">${TEXT.keys}</th><th class="p">${TEXT.pad}</th><th class="t">${TEXT.touch}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /** The small print that names keys or buttons: redrawn when the player changes from one device to the other.
   *  (Fingers need none for choosing: they tap the line itself.) */
  _legends() {
    const d = this.device, e = (action, label) => `<span class="e">${glyphsFor(action, d)}${esc(label)}</span>`;
    this.n.legend.innerHTML = LEGEND.map(([a, l]) => e(a, l)).join('');
    const line = (adjust) => (d === 'touch' ? '' : e('choose', TEXT.choose) + (adjust ? e('adjust', TEXT.adjust) : '') + e('confirm', TEXT.select) + e('back', TEXT.goBack));
    this.n.pause.querySelector('.evs-keys').innerHTML = line(false);
    this.n.ask.querySelector('.evs-keys').innerHTML = line(false);
    this.n.options.querySelector('.evs-keys').innerHTML = line(true);
    this.el.dataset.device = d;
  }
  _device(d) { if (d !== this.device) { this.device = d; this._legends(); } }

  // ------------------------------------------------------------------ opening and closing

  /** Show one of 'title' | 'pause' | 'options' | 'end' (and 'ask', through ask()); null closes whatever is open. */
  open(name) {
    name = name || null;
    const was = this.panel;
    if (name === was && !this.closing && !this.returnAt) return;
    if (name === 'options' && was !== 'options') this.from = was === 'pause' || was === 'ask' ? 'pause' : 'title';
    if (was === 'pause') this.pauseSel = this.sel;
    this.closing = null; this.returnAt = 0; this.drag = null; this.el.classList.remove('leaving');
    this.panel = name;
    for (const k of PANELS) this.n[k].classList.toggle('cur', k === name);
    this.el.classList.toggle('open', !!name);
    if (name) this.el.dataset.panel = name; else delete this.el.dataset.panel;
    if (!name) { this.items = []; return; }
    this.items = this.built[name].items;
    // coming back from a sub-screen, the line that led there stays chosen; a fresh screen starts at its first line
    let sel = 0;
    if (name === 'ask') sel = 1;
    else if (name === 'pause' && (was === 'options' || was === 'ask')) sel = this.pauseSel;
    else if (name === 'title' && was === 'options') sel = 1;
    if (name === 'options') this.refresh();
    this._select(sel, true);
    this.openedAt = performance.now(); this._prime(); this._run();
    this._device(this.ui.inputDevice());
  }

  /** Ask before throwing the fight away ('restart' | 'title'). The answer first chosen is "Keep fighting". */
  ask(what) {
    const go = (type) => { const fn = () => this.leave({ type }); fn.quiet = true; return fn; };
    const yes = what === 'restart' ? [TEXT.askRestartYes, go('restart')] : [TEXT.askTitleYes, go('title')];
    this.n.askQ.textContent = what === 'restart' ? TEXT.askRestart : TEXT.askTitle;
    this.n.askNote.textContent = TEXT.askNote;
    this.spec.ask.list = [yes, [TEXT.askNo, () => this.open('pause')]];
    this._build('ask');
    this.open('ask');
  }

  /** A choice that hands control back to the game: fade, wait until the key that made it is let go, then say so. */
  leave(evt) {
    if (this.closing) return;
    if (this._byFinger() && evt && (evt.type === 'play' || evt.type === 'resume' || evt.type === 'restart')) this.ui.touch.gesture();      // still inside the tap: the browser grants the whole screen only there
    this.closing = evt; this.closeAt = performance.now() + LEAVE_MS; this.el.classList.add('leaving'); this._run();
  }

  back() { const sp = this.spec[this.panel]; if (sp && sp.back) { if (!sp.back.quiet) this.ui._sound('back'); sp.back(); } }

  /** Was the choice being made just now made by a finger? (a touch within the last second, on a touch screen in hand) */
  _byFinger() { const t = this.ui.touch; return !!t && this.device === 'touch' && performance.now() - t.fingerAt < 1000; }
  _host() { const b = this.built[this.panel]; return b ? b.host : null; }
  _guarded() { return performance.now() - this.openedAt < GUARD_MS; }

  // ------------------------------------------------------------------ choosing

  _select(i, quiet) {
    const n = this.items.length; if (!n) return;
    i = ((i % n) + n) % n;
    if (i === this.sel && !quiet) return;
    for (let k = 0; k < n; k++) {
      const on = k === i, e = this.items[k].el;
      e.classList.toggle('on', on);
      if (on) e.setAttribute('aria-current', 'true'); else e.removeAttribute('aria-current');
    }
    this.sel = i;
    if (!quiet) this.ui._sound('move');
  }
  _move(d) { this._select(this.sel + d); }
  _confirm() {
    const it = this.items[this.sel]; if (!it) return;
    if (it.row) { if (it.row.kind === 'choice') this._step(it.row, 1, true); return; }
    if (!it.act.quiet) this.ui._sound('confirm');
    it.act();
  }
  _adjust(d) { const it = this.items[this.sel]; if (it && it.row) this._step(it.row, d, false); }

  _step(row, d, wrap) {
    const cur = this.ui.settings[row.key];
    if (row.kind === 'slider') {
      const n = Math.round((cur - row.min) / row.step) + d, max = Math.round((row.max - row.min) / row.step);
      this._set(row, row.min + Math.max(0, Math.min(max, n)) * row.step);
    } else {
      let i = row.values.indexOf(cur) + d; const n = row.values.length;
      i = wrap ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
      this._set(row, row.values[i]);
    }
  }
  _set(row, value) {
    if (row.kind === 'slider') value = +value.toFixed(3);
    if (this.ui.settings[row.key] === value) return;
    this.ui._setting(row.key, value);
    this.refresh();
    this.ui._sound('adjust');
  }
  _dragTo(x) {
    const d = this.drag, r = d.tr.getBoundingClientRect(), row = d.row;
    const f = clamp01((x - r.left) / Math.max(1, r.width)), steps = Math.round((row.max - row.min) / row.step);
    this._set(row, row.min + Math.round(f * steps) * row.step);
  }
  /** Draw a row of the options from ui.settings. */
  _paint(it) {
    const row = it.row, v = this.ui.settings[row.key], e = it.el;
    if (row.kind === 'slider') {
      e.querySelector('.sl').style.setProperty('--v', clamp01((v - row.min) / (row.max - row.min)).toFixed(4));
      e.querySelector('.val').textContent = row.show(v);
    } else {
      const words = e.querySelectorAll('.ch b'), cur = row.values.indexOf(v);
      for (let i = 0; i < words.length; i++) words[i].classList.toggle('cur', i === cur);
    }
  }
  /** The options screen follows ui.settings (also when a setting was changed from elsewhere). */
  refresh() { for (const it of this.built.options.items) if (it.row) this._paint(it); }

  // ------------------------------------------------------------------ keyboard and gamepad

  _key(e) {
    this.down.add(e.code);
    if (!this.panel || this.closing || this.returnAt || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = e.code; let used = true;
    if (c === 'ArrowUp' || c === 'KeyW') this._move(-1);
    else if (c === 'ArrowDown' || c === 'KeyS') this._move(1);
    else if (c === 'Tab') this._move(e.shiftKey ? -1 : 1);
    else if (c === 'ArrowLeft' || c === 'KeyA') this._adjust(-1);
    else if (c === 'ArrowRight' || c === 'KeyD') this._adjust(1);
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') { if (!e.repeat && !this._guarded()) this._confirm(); }
    else if (c === 'Escape' || c === 'Backspace') { if (!e.repeat && !this._guarded()) this.back(); }
    else used = false;
    if (used) { e.preventDefault(); this._device('keys'); }
  }

  _readPad() {
    const out = this._pad; out.x = out.y = 0; out.a = out.b = out.s = out.any = false;
    let pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }       // (not allowed in this page: no gamepad, then)
    if (!pads) return out;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i]; if (!p || !p.connected) continue;
      const bt = p.buttons, ax = p.axes, on = (k) => !!(bt[k] && bt[k].pressed), sx = ax[0] || 0, sy = ax[1] || 0;
      if (on(12) || sy < -0.55) out.y = -1; else if (on(13) || sy > 0.55) out.y = 1;
      if (on(14) || sx < -0.55) out.x = -1; else if (on(15) || sx > 0.55) out.x = 1;
      out.a = on(0); out.b = on(1); out.s = on(9);
      out.any = out.a || out.b || out.s || !!out.x || !!out.y;
      break;
    }
    return out;
  }
  /** A button that is already down when a screen opens must be let go before it counts. */
  _prime() { const p = this._readPad(); this.pa = p.a; this.pb = p.b; this.ps = p.s; this.pdir = p.y ? (p.y < 0 ? 'u' : 'd') : p.x ? (p.x < 0 ? 'l' : 'r') : ''; this.prep = Infinity; }

  _run() { if (!this.raf) this.raf = requestAnimationFrame(this._loop); }
  _frame() {
    this.raf = 0;
    if (this.ui.syncDevice) this.ui.syncDevice();                     // the game's clock may be stopped: follow the device in hand from here
    const now = performance.now(), p = this._readPad();
    if (this.closing) {
      if (now >= this.closeAt || (!this.down.size && !p.a && !p.b && !p.s)) {
        const evt = this.closing;
        this.closing = null; this.returnAt = now + RETURN_MS;         // (open() clears this when the game answers)
        this.ui.emit(evt);
      }
    } else if (this.returnAt) {
      if (now >= this.returnAt) { this.returnAt = 0; this.el.classList.remove('leaving'); this.openedAt = now; this._prime(); }
    } else if (this.panel) {
      if (p.any) this._device('pad');
      const ok = !this._guarded();
      if (p.a && !this.pa && ok) this._confirm();
      else if (p.b && !this.pb && ok) this.back();
      else if (p.s && !this.ps && ok) { const sp = this.spec[this.panel]; if (sp && sp.start) sp.start(); }
      const dir = p.y ? (p.y < 0 ? 'u' : 'd') : p.x ? (p.x < 0 ? 'l' : 'r') : '';
      if (dir !== this.pdir) { this.pdir = dir; this.prep = now + 380; if (dir) this._padDir(dir); }
      else if (dir && now >= this.prep) { this.prep = now + (dir === 'l' || dir === 'r' ? 70 : 130); this._padDir(dir); }
      this.pa = p.a; this.pb = p.b; this.ps = p.s;
    }
    if (this.panel || this.closing) this._run();
  }
  _padDir(d) { if (d === 'u') this._move(-1); else if (d === 'd') this._move(1); else this._adjust(d === 'l' ? -1 : 1); }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0;
    window.removeEventListener('keydown', this._onKey); window.removeEventListener('keyup', this._onKeyUp); window.removeEventListener('blur', this._onBlur);
    this.el.remove();
  }
}
