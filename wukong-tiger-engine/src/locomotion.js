// Motion-matching style locomotion for long mocap takes (tiger MM/free + MM/lock clips):
// the clips' rootMotion is indexed every `step` seconds by local (character-frame) velocity over a short window; the
// runtime asks for a desired local velocity and plays the best-matching clip segment, re-searching periodically.
// Character translation is driven by the AI speed; playback rate is adjusted so feet match the requested speed.
import * as THREE from "three";

export class LocoMatcher {
  constructor(ch, clipNames, { step = 0.1, window = 0.5, maxYawRate = 80 } = {}) {
    this.ch = ch;
    this.entries = [];
    this.window = window;
    const f = ch.anims.forward || [0, 0, 1];
    for (const name of clipNames) {
      const rm = ch.meta(name)?.rootMotion;
      if (!rm?.samples?.length || !ch.has(name)) continue;
      const s = rm.samples, fps = rm.fps, n = s.length, w = Math.max(1, Math.round(window * fps));
      for (let i = 0; i + w < n; i += Math.max(1, Math.round(step * fps))) {
        const a = s[i], b = s[i + w];
        // displacement in model space -> character root frame at time i (+Z forward, +X = character left)
        const v = new THREE.Vector3(b[0] - a[0], 0, b[2] - a[2]).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -a[3] + ch.modelYaw);
        const speed = v.length() / window;
        const yawRate = (b[3] - a[3]) / window * 180 / Math.PI;
        if (Math.abs(yawRate) > maxYawRate) continue; // turning segments look wrong without root yaw
        this.entries.push({ clip: name, t: i / fps, vx: v.x / window, vz: v.z / window, speed, yawRate });
      }
    }
    this.cur = null; this.timer = 0;
  }

  /** best entry for desired local velocity (vx,vz) m/s */
  match(vx, vz) {
    let best = null, bestCost = Infinity;
    for (const e of this.entries) {
      const dx = e.vx - vx, dz = e.vz - vz;
      const cost = dx * dx + dz * dz + 0.002 * e.yawRate * e.yawRate;
      if (cost < bestCost) { bestCost = cost; best = e; }
    }
    return best;
  }

  /**
   * Drives the character's clip for a desired local velocity. Returns true while it controls the animation.
   * Re-matches every 1.2 s, or immediately when the request changes a lot.
   */
  update(dt, vx, vz) {
    if (!this.entries.length) return false;
    this.timer -= dt;
    const req = Math.hypot(vx, vz);
    const changed = !this.req || Math.hypot(this.req.vx - vx, this.req.vz - vz) > Math.max(0.6, req * 0.5);
    if (!this.cur || this.timer <= 0 || changed || this.ch.clipName !== this.cur.clip) {
      const e = this.match(vx, vz);
      if (!e) return false;
      const same = this.cur && this.ch.clipName === e.clip && Math.abs(this.ch.clipTime - e.t) < 0.6;
      if (!same) this.ch.play(e.clip, { loop: true, fade: 0.35, rootMotion: false, start: e.t });
      this.cur = e; this.timer = 1.2; this.req = { vx, vz };
    }
    this.ch.setSpeed(THREE.MathUtils.clamp(req / Math.max(this.cur.speed, 0.05), 0.6, 1.5));
    return true;
  }

  reset() { this.cur = null; this.req = null; this.timer = 0; }
}
