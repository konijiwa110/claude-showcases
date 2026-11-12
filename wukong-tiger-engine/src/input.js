// Keyboard / mouse / pointer-lock input with a scriptable injection path for the debug hook and the touch controls.
// Codes are KeyboardEvent.code / Mouse0-2; touch-only actions inject their own codes (StanceCycle, stances.js).
export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();      // KeyboardEvent.code currently held
    this.pressed = new Set();   // codes pressed since last frame (consumed by endFrame)
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0 };
    this.stick = { x: 0, y: 0 }; // analog move (touch joystick): x right, y forward, length 0..1
    this.locked = false;
    this.enabled = true;
    const norm = (e) => e.code;
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (["Space", "Tab"].includes(e.code)) e.preventDefault();
      this.down(norm(e));
    });
    addEventListener("keyup", (e) => this.up(norm(e)));
    addEventListener("blur", () => { for (const k of [...this.keys]) this.up(k); });
    dom.addEventListener("mousedown", (e) => {
      if (!this.locked && this.enabled && dom.requestPointerLock) { dom.requestPointerLock(); }
      this.down(["Mouse0", "Mouse1", "Mouse2"][e.button] || `Mouse${e.button}`);
      if (e.button === 1) e.preventDefault();
    });
    addEventListener("mouseup", (e) => this.up(["Mouse0", "Mouse1", "Mouse2"][e.button] || `Mouse${e.button}`));
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
    });
    document.addEventListener("pointerlockchange", () => { this.locked = document.pointerLockElement === dom; });
  }
  down(code) { if (!this.keys.has(code)) { this.keys.add(code); this.pressed.add(code); } }
  up(code) { if (this.keys.has(code)) { this.keys.delete(code); this.released.add(code); } }
  look(dx, dy) { this.mouse.dx += dx; this.mouse.dy += dy; }
  setStick(x, y) { this.stick.x = x; this.stick.y = y; }
  held(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
  wasReleased(code) { return this.released.has(code); }
  takeMouse() { const m = { ...this.mouse }; this.mouse.dx = 0; this.mouse.dy = 0; return m; }
  endFrame() { this.pressed.clear(); this.released.clear(); }
}
