// Touch controls (phones / tablets): floating joystick on the left, drag-to-look anywhere else, buttons on the right
// (light / heavy / dodge / gourd / lock + the HUD skill slots, whose data-code comes from hud.addSlot). Everything is
// fed into Input as codes, look deltas and the analog stick, so gameplay code reads a single input model.

/** touch UI on a coarse primary pointer (phones, tablets); `?touch=1` / `?touch=0` overrides the check */
export const TOUCH = (() => {
  const q = new URLSearchParams(location.search).get("touch");
  return q != null ? q !== "0" : matchMedia("(pointer: coarse)").matches;
})();

const STICK_ZONE = 0.42; // left share of the screen where a new touch grabs the joystick
const STICK_R = 52;      // px * u: knob travel
const DEAD = 0.12;       // joystick deadzone, share of the travel
const LOOK = 3;          // touch px -> mouse movement units (OrbitCam.sens per unit)
const SPRINT = "ShiftLeft";
const SPRINT_HOLD = 250; // ms on the dodge button that latches sprint (gamepad scheme: hold dodge to sprint)
const HIT_PAD = 10;      // px of forgiveness around every button
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.el = document.querySelector("#touch");
    this.stick = this.el.querySelector("#t-stick");
    this.knob = this.stick.querySelector(".knob");
    this.ptrs = new Map(); // pointerId -> { kind: "stick" | "look" | "btn", ... }
    this.stickId = null;
    this.out = 0;          // joystick output length after the deadzone, 0..1
    this.base = { x: 0, y: 0 }; this.idle = { x: 0, y: 0 };
    this.u = 1;            // control scale from the short screen side
    this.dodgeHeld = false; this.sprint = false;
    // safe-area rectangle (notch, home indicator) for the layout
    this.safe = document.body.appendChild(document.createElement("div"));
    this.safe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;" +
      "inset:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    this.portraitQuery = matchMedia("(orientation: portrait)");
    document.body.classList.add("touch");
    if (!document.fullscreenEnabled) this.el.querySelector("[data-action=fullscreen]")?.remove(); // iPhone Safari

    // touches are implicitly captured by their target inside #touch, so move / up bubble to window
    this.el.addEventListener("pointerdown", (e) => this.down(e));
    addEventListener("pointermove", (e) => this.move(e));
    addEventListener("pointerup", (e) => this.up(e.pointerId, true));
    addEventListener("pointercancel", (e) => this.up(e.pointerId, false));
    // iOS: no loupe, callout or double-tap zoom on the controls
    for (const t of ["touchstart", "touchmove"]) this.el.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("resize", () => this.layout());
    addEventListener("blur", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.releaseAll(); });
    this.portraitQuery.addEventListener("change", () => this.releaseAll());
    this.layout();
  }

  /** the rotate overlay covers the game (style.css); main.js holds the simulation meanwhile */
  get portrait() { return this.portraitQuery.matches; }

  down(e) {
    e.preventDefault();
    const id = e.pointerId, x = e.clientX, y = e.clientY;
    if (this.ptrs.has(id)) return;
    const btn = this.hit(x, y);
    let p;
    if (btn) p = this.press(btn);
    else if (this.stickId == null && x < innerWidth * STICK_ZONE) {
      p = { kind: "stick" };
      this.stickId = id;
      this.stickStart(x, y);
    } else p = { kind: "look", x, y };
    this.ptrs.set(id, p);
  }

  move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    if (p.kind === "stick") this.stickMove(e.clientX, e.clientY);
    else if (p.kind === "look") {
      this.input.look((e.clientX - p.x) * LOOK, (e.clientY - p.y) * LOOK);
      p.x = e.clientX; p.y = e.clientY;
    }
  }

  /** released = a real pointerup (user activation for fullscreen); false on cancel / blur */
  up(id, released) {
    const p = this.ptrs.get(id);
    if (!p) return;
    this.ptrs.delete(id);
    if (p.kind === "stick") { this.stickId = null; this.stickEnd(); return; }
    if (p.kind !== "btn") return;
    p.el.classList.remove("pressed");
    for (const c of p.codes) this.input.up(c);
    if (p.dodge) { clearTimeout(p.timer); this.dodgeHeld = false; this.syncSprint(); }
    if (released && p.el.dataset.action === "fullscreen") this.toggleFullscreen();
  }

  releaseAll() {
    for (const id of [...this.ptrs.keys()]) this.up(id, false);
    this.setSprint(false);
  }

  /** nearest visible control around (x, y) */
  hit(x, y) {
    let best = null, bestD = Infinity;
    for (const el of document.querySelectorAll("#hud [data-code], #hud [data-action]")) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue; // display: none
      if (x < r.left - HIT_PAD || x > r.right + HIT_PAD || y < r.top - HIT_PAD || y > r.bottom + HIT_PAD) continue;
      const d = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2);
      if (d < bestD) { best = el; bestD = d; }
    }
    return best;
  }

  press(el) {
    el.classList.add("pressed");
    const p = { kind: "btn", el, codes: (el.dataset.code || "").split(" ").filter(Boolean), dodge: "sprint" in el.dataset, timer: 0 };
    for (const c of p.codes) this.input.down(c);
    if (p.dodge) {
      this.dodgeHeld = true;
      p.timer = setTimeout(() => this.setSprint(true), SPRINT_HOLD);
    }
    return p;
  }

  /** a latched sprint lasts while the dodge button is held or the joystick is pushed */
  syncSprint() { if (this.sprint && !this.dodgeHeld && !this.out) this.setSprint(false); }
  setSprint(on) {
    if (on === this.sprint) return;
    this.sprint = on;
    if (on) this.input.down(SPRINT); else this.input.up(SPRINT);
    this.stick.classList.toggle("sprint", on);
  }

  // ------------------------------------------------------------------ joystick
  stickStart(x, y) {
    const R = STICK_R * this.u, s = this.safeRect();
    // floating base: where the thumb lands, kept off the screen edges
    this.base.x = clamp(x, s.left + R, innerWidth * STICK_ZONE);
    this.base.y = clamp(y, s.top + R, s.bottom - R);
    this.stick.classList.add("active");
    this.stickMove(x, y);
  }

  stickMove(x, y) {
    const R = STICK_R * this.u;
    let dx = x - this.base.x, dy = y - this.base.y, d = Math.hypot(dx, dy);
    if (d > R) { // the base follows the thumb, so reversing direction is immediate
      this.base.x += dx * (1 - R / d); this.base.y += dy * (1 - R / d);
      dx *= R / d; dy *= R / d; d = R;
    }
    const m = d / R;
    this.out = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD);
    if (this.out) this.input.setStick(dx / d * this.out, -dy / d * this.out);
    else { this.input.setStick(0, 0); this.syncSprint(); }
    this.draw(dx, dy);
  }

  stickEnd() {
    this.out = 0;
    this.input.setStick(0, 0);
    this.base.x = this.idle.x; this.base.y = this.idle.y;
    this.stick.classList.remove("active");
    this.draw(0, 0);
    this.syncSprint();
  }

  draw(dx, dy) {
    this.stick.style.left = `${this.base.x}px`; this.stick.style.top = `${this.base.y}px`;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  // ------------------------------------------------------------------ layout
  safeRect() {
    const r = this.safe.getBoundingClientRect();
    return { left: Math.max(r.left, 12), top: Math.max(r.top, 10), right: Math.min(r.right, innerWidth - 12), bottom: Math.min(r.bottom, innerHeight - 10) };
  }

  /** right-thumb arc around the light attack: inner ring heavy / gourd / dodge, outer ring the HUD skill slots */
  layout() {
    const u = this.u = clamp(Math.min(innerWidth, innerHeight) / 400, 0.8, 1.5);
    document.documentElement.style.setProperty("--u", u.toFixed(3));
    const s = this.safeRect();
    const cx = s.right - 58 * u, cy = s.bottom - 58 * u;
    const put = (el, deg, r) => {
      if (!el) return;
      const a = deg * Math.PI / 180;
      el.style.left = `${cx + Math.cos(a) * r * u}px`;
      el.style.top = `${cy - Math.sin(a) * r * u}px`;
    };
    const $ = (q) => document.querySelector(q);
    put($("#t-light"), 0, 0);
    put($("#t-heavy"), 180, 100);
    put($("#gourd"), 135, 100);
    put($("#t-dodge"), 90, 100);
    const slots = document.querySelectorAll("#skills .slot");
    slots.forEach((el, i) => put(el, 180 - 90 * i / Math.max(1, slots.length - 1), 176));
    put($("#t-lock"), 90, 246);
    this.idle.x = s.left + 96 * u; this.idle.y = s.bottom - 96 * u;
    if (this.stickId == null) { this.base.x = this.idle.x; this.base.y = this.idle.y; this.draw(0, 0); }
  }

  // ------------------------------------------------------------------ fullscreen
  /** Android: fullscreen + landscape lock (needs a user activation: the start tap, a button release). iOS Safari has
   * neither; the rotate overlay asks for landscape and a home-screen launch drops the browser bars. */
  async enterFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      await screen.orientation?.lock?.("landscape");
    } catch { /* not allowed or unsupported */ }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.enterFullscreen();
  }
}
