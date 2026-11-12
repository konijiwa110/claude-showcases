// The HUD: the pilgrim's light, health and stamina (top left), his flasks (bottom left), the Cantor's name and her
// long bar (bottom centre), the lock-on mark and quiet prompts.
//
// The game hands over plain numbers every display frame (setPlayer, setBoss, setLock). Everything that moves is
// worked out in update(dt), in the game's fixed steps, and written to the page only when it has changed. Nothing
// here causes layout while playing: bars are scaled, marks are moved with transforms, words are written once.
import { ICON, expand, glyphsFor } from './glyphs.js';

const HP_UNITS = 3.3, ST_UNITS = 2.7;        // length of the bars, in interface units for one point of health or stamina
const LOW = 0.3;                             // below this share of health the lamp gutters
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Hud {
  constructor(ui, parent) {
    this.ui = ui;
    const el = this.el = document.createElement('div'); el.className = 'evs-hud'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="evs-vit">
        <div class="lamp">${ICON.lamp}</div>
        <div class="bars">
          <div class="evs-bar hp"><i class="tr"></i><i class="fi"></i><i class="fx"></i><b class="cap"></b></div>
          <div class="evs-bar st"><i class="tr"></i><i class="fi"></i><i class="fx"></i><b class="cap"></b></div>
        </div>
      </div>
      <div class="evs-flasks"><span class="row"></span><span class="key"></span></div>
      <div class="evs-boss">
        <div class="head"><span class="nm"></span><span class="dmg"></span></div>
        <div class="evs-bar bb"><i class="tr"></i><i class="fi"></i><i class="fx"></i>${ICON.lozenge}${ICON.lozenge}</div>
      </div>
      <div class="evs-lock"><span>${ICON.lock}</span></div>
      <div class="evs-prompt"></div>
      <div class="evs-ctl"></div>`;
    parent.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.n = {
      vit: q('.evs-vit'), lamp: q('.lamp'), flame: q('.lamp .f'),
      hp: q('.hp'), hpFill: q('.hp .fi'), hpTrail: q('.hp .tr'), hpFlash: q('.hp .fx'),
      st: q('.st'), stFill: q('.st .fi'), stTrail: q('.st .tr'), stFlash: q('.st .fx'),
      flasks: q('.evs-flasks'), flaskRow: q('.evs-flasks .row'), flaskKey: q('.evs-flasks .key'),
      boss: q('.evs-boss'), bossName: q('.evs-boss .nm'), dmg: q('.evs-boss .dmg'),
      bFill: q('.bb .fi'), bTrail: q('.bb .tr'), bFlash: q('.bb .fx'),
      lock: q('.evs-lock'), prompt: q('.evs-prompt'), ctl: q('.evs-ctl'),      // ctl: the controls shown when play begins (ui.js fills and fades it)
    };
    // what the game last told us
    this.p = { hp: 100, hpMax: 100, st: 100, stMax: 100, fl: 0, flMax: 0 };
    this.b = { name: '', hp: 1, hpMax: 1, visible: false };
    // what is shown (shares of the whole bar, and timers in seconds)
    this.s = { hp: 1, hpTrail: 1, hpHold: 0, hpFlash: 0, st: 1, stTrail: 1, stHold: 0, stFlash: 0, jolt: 0,
      bhp: 1, bTrail: 1, bHold: 0, bFlash: 0, dmg: 0, dmgT: 0 };
    // what is on the page (so that nothing is written twice)
    this.w = { hp: -1, hpTrail: -1, hpFlash: -1, st: -1, stTrail: -1, stFlash: -1, jolt: -1, bhp: -1, bTrail: -1, bFlash: -1, dmg: -1, dmgOp: -1,
      hpMax: -1, stMax: -1, fl: -1, flMax: -1, dull: null, low: null, bossOn: null, name: null, lockOn: null, lx: NaN, ly: NaN };
    this.snapP = true; this.snapB = true; this.dull = false; this.promptText = null; this.hintText = null; this.shownText = null; this.device = 'keys';
    this.lockX = 0; this.lockY = 0; this.lockOn = false;
    this.flaskEls = [];
    this.setDevice('keys');
  }

  /** The HUD has just been shown again (a new fight, a respawn): take the next values as they are, without trails. */
  snap() { this.snapP = true; this.snapB = true; }

  setPlayer(p) { const t = this.p; t.hp = p.hp; t.hpMax = p.hpMax; t.st = p.stamina; t.stMax = p.staminaMax; t.fl = p.flasks; t.flMax = p.flasksMax; }
  setBoss(b) { const t = this.b; t.name = b.name; t.hp = b.hp; t.hpMax = b.hpMax; t.visible = !!b.visible; }

  /** Where the lock-on mark sits, in page pixels. Called every display frame, so it moves with the picture. */
  setLock(x, y, visible) {
    const w = this.w, l = this.n.lock;
    if (visible !== w.lockOn) { w.lockOn = visible; l.classList.toggle('on', !!visible); }
    if (!visible) return;
    const rx = Math.round(x * 2) / 2, ry = Math.round(y * 2) / 2;
    if (rx !== w.lx || ry !== w.ly) { w.lx = rx; w.ly = ry; l.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)'; }
  }

  /** A quiet line near the foot of the picture. "{lock} Lock on" shows the right key or button for the device in use. */
  prompt(text) { this.promptText = text || null; this._line(); }
  /** The interface's own hint (how to lock on, the first time): it gives way to whatever the game asks to be shown. */
  hint(text) { this.hintText = text || null; this._line(); }
  _line() {
    const n = this.n.prompt, text = this.promptText || this.hintText;
    if (text === this.shownText) return;
    this.shownText = text;
    if (text) { n.innerHTML = expand(text, this.device); n.classList.add('on'); } else n.classList.remove('on');
  }

  /** Keys, pad or touch: redraw whatever names a button. (With fingers the flasks' own button carries their count:
   *  the row at the bottom left, where the stick lives, is hidden by the styles.) */
  setDevice(device) {
    this.device = device;
    this.n.flaskKey.innerHTML = glyphsFor('heal', device);
    if (this.shownText) this.n.prompt.innerHTML = expand(this.shownText, device);
  }

  _flasks(count, max) {
    const w = this.w, row = this.n.flaskRow;
    if (max !== w.flMax) {
      w.flMax = max; w.fl = -1;
      row.innerHTML = new Array(Math.max(0, Math.min(12, max | 0)) + 1).join(`<span class="fl">${ICON.flask}</span>`);
      this.flaskEls = Array.from(row.children);
      this.n.flasks.classList.toggle('none', !(max > 0));
    }
    if (count !== w.fl) {
      const fresh = w.fl < 0; w.fl = count;
      for (let i = 0; i < this.flaskEls.length; i++) {
        const e = this.flaskEls[i], full = i < count;
        e.classList.toggle('used', !full); e.classList.toggle('still', fresh);
      }
    }
  }

  update(dt) {
    const p = this.p, b = this.b, s = this.s, w = this.w, n = this.n;

    // ---- the pilgrim's health: the bar drops at once, a pale trail follows after a beat, the frame flashes
    const hv = p.hpMax > 0 ? clamp01(p.hp / p.hpMax) : 0;
    if (this.snapP) { s.hp = s.hpTrail = hv; s.hpHold = 0; s.hpFlash = 0; s.jolt = 0; }
    else {
      if (hv < s.hp - 0.0005) { const lost = s.hp - hv; s.hp = hv; s.hpHold = 0.55; s.hpFlash = Math.min(1, 0.5 + lost * 2.2); s.jolt = 1; }
      else if (hv > s.hp) s.hp = Math.min(hv, s.hp + dt * 0.9);                    // a drink rises smoothly
      if (s.hpTrail < s.hp) s.hpTrail = s.hp;
      else if (s.hpTrail > s.hp) { if (s.hpHold > 0) s.hpHold -= dt; else s.hpTrail = Math.max(s.hp, s.hpTrail - dt * (0.22 + (s.hpTrail - s.hp) * 2.4)); }
      if (s.hpFlash > 0) s.hpFlash = Math.max(0, s.hpFlash - dt / 0.38);
      if (s.jolt > 0) s.jolt = Math.max(0, s.jolt - dt / 0.5);
    }
    // ---- stamina: follows at once; what was just spent lingers a moment; dull while he is spent
    const sv = p.stMax > 0 ? clamp01(p.st / p.stMax) : 0;
    if (this.snapP) { s.st = s.stTrail = sv; s.stHold = 0; s.stFlash = 0; this.dull = sv <= 0.004; }
    else {
      if (sv < s.st - 0.02) s.stHold = 0.22;
      s.st = sv;
      if (s.stTrail < sv) s.stTrail = sv;
      else if (s.stTrail > sv) { if (s.stHold > 0) s.stHold -= dt; else s.stTrail = Math.max(sv, s.stTrail - dt * 1.6); }
      if (!this.dull && sv <= 0.004) { this.dull = true; s.stFlash = 1; }
      else if (this.dull && sv >= 0.3) this.dull = false;
      if (s.stFlash > 0) s.stFlash = Math.max(0, s.stFlash - dt / 0.5);
    }
    this.snapP = false;
    if (p.hpMax !== w.hpMax) { w.hpMax = p.hpMax; n.hp.style.width = 'calc(var(--u) * ' + Math.round(Math.min(900, p.hpMax * HP_UNITS)) + ')'; }
    if (p.stMax !== w.stMax) { w.stMax = p.stMax; n.st.style.width = 'calc(var(--u) * ' + Math.round(Math.min(900, p.stMax * ST_UNITS)) + ')'; }
    this._sx('hp', n.hpFill, s.hp); this._sx('hpTrail', n.hpTrail, s.hpTrail); this._op('hpFlash', n.hpFlash, s.hpFlash * 0.72);
    this._sx('st', n.stFill, s.st); this._sx('stTrail', n.stTrail, s.stTrail); this._op('stFlash', n.stFlash, s.stFlash * 0.5);
    if (this.dull !== w.dull) { w.dull = this.dull; n.st.classList.toggle('dull', this.dull); }
    const low = hv > 0 && hv < LOW, out = hv <= 0, lamp = out ? 'out' : low ? 'low' : '';
    if (lamp !== w.low) { w.low = lamp; n.lamp.classList.toggle('low', low); n.lamp.classList.toggle('out', out); n.hp.classList.toggle('low', low); }
    const j = Math.round(s.jolt * 40) / 40;
    if (j !== w.jolt) { w.jolt = j; n.flame.style.transform = j > 0 ? 'scale(' + (1 - 0.42 * j * j).toFixed(3) + ')' : ''; }
    this._flasks(p.fl, p.flMax);

    // ---- the Cantor: her name, a long bar with a trail, and what the last blows took
    if (b.visible !== w.bossOn) { w.bossOn = b.visible; n.boss.classList.toggle('on', b.visible); if (b.visible) this.snapB = true; }
    if (b.name !== w.name) { w.name = b.name; n.bossName.textContent = b.name || ''; }
    const bv = b.hpMax > 0 ? clamp01(b.hp / b.hpMax) : 0;
    if (this.snapB || bv > s.bhp + 0.0005) { s.bhp = s.bTrail = bv; s.bHold = 0; s.bFlash = 0; s.dmg = 0; s.dmgT = 0; this.snapB = false; }
    else {
      if (bv < s.bhp - 0.00005) {
        s.dmg += (s.bhp - bv) * b.hpMax; s.dmgT = 2.6;
        s.bFlash = Math.min(1, 0.45 + (s.bhp - bv) * 6); s.bhp = bv; s.bHold = 0.8;
      }
      if (s.bTrail > s.bhp) { if (s.bHold > 0) s.bHold -= dt; else s.bTrail = Math.max(s.bhp, s.bTrail - dt * (0.07 + (s.bTrail - s.bhp) * 1.6)); }
      else s.bTrail = s.bhp;
      if (s.bFlash > 0) s.bFlash = Math.max(0, s.bFlash - dt / 0.3);
      if (s.dmgT > 0) { s.dmgT -= dt; if (s.dmgT <= 0) { s.dmgT = 0; s.dmg = 0; } }
    }
    this._sx('bhp', n.bFill, s.bhp); this._sx('bTrail', n.bTrail, s.bTrail); this._op('bFlash', n.bFlash, s.bFlash * 0.34);     // her bar is long: a quiet flash
    const shown = Math.round(s.dmg);
    if (shown !== w.dmg && shown > 0) { w.dmg = shown; n.dmg.textContent = String(shown); }
    this._op('dmgOp', n.dmg, shown > 0 ? clamp01(s.dmgT / 0.5) : 0);
    if (shown === 0) w.dmg = 0;
  }

  _sx(k, node, v) { const q = Math.round(v * 2000) / 2000; if (this.w[k] !== q) { this.w[k] = q; node.style.transform = 'scaleX(' + q + ')'; } }
  _op(k, node, v) { const q = Math.round(v * 50) / 50; if (this.w[k] !== q) { this.w[k] = q; node.style.opacity = q; } }

  dispose() { this.el.remove(); }
}
