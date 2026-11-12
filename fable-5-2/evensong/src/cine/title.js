// The picture behind the title screen. The Cantor stands before the organ in profile, tall and still, her sword standing
// in the water before her, her pipes folded: she sings without a sound (her arms open a little and sink again, her face
// is lifted to the vault). Candles all round; the moon in the rose window; the pilgrim not yet there. The camera stands
// on the water south-west of her, low, and drifts very slowly. (Until 8 Nov she knelt here with folded hands, as in
// the key painting: nobody kneels to pray in this game any more.)
import * as THREE from 'three';
import { camera } from './rig.js';
import { stageStanding, sing } from './intro.js';

export class Title {
  constructor(ctx, stage, rig) {
    this.ctx = ctx; this.stage = stage; this.rig = rig; this.t = 0; this.on = false; this.still = null;
    const k = ctx.arena.spawn.kneel, head = new THREE.Vector3();
    this.cam = camera({
      // On the water south-west of her, low. She stands in profile turned a little toward us, her pipes folded behind
      // her, her sword standing before her in the foreground, the rose window and the moon above it; all of that in
      // the right half of the picture. The left (the north arcade, the night, candles on the water) is calm for the
      // logo. A very slow drift: the sword slides against her, the candles against the piers.
      pos: (out, t) => out.set(k.x + 7.4 + Math.sin(t * 0.045) * 0.4, 1.05 + Math.sin(t * 0.033 + 1) * 0.07, k.z + 8.8 - Math.sin(t * 0.027 + 0.4) * 0.5),
      look: (out, t) => out.set(k.x - 3.25 + Math.sin(t * 0.03) * 0.15, 3.2, k.z + 2.85),
      fov: 57, aperture: 0.25, breathe: 0.05, sway: 0.004,
      focus: (out) => { stage.bone(ctx.boss, 'Head', head); out.copy(head); },
    });
  }
  start() {
    const ctx = this.ctx, st = this.stage;
    this.on = true; this.t = 0;
    this.still = stageStanding(ctx, st); st.wingsNow(0);
    ctx.player.puppet = true; st.play(ctx.player, 'idle', { fade: 0, loop: true }); st.hidePilgrim();
    sing(ctx, st, this.still, 0, 0);
    st.flush();
    this.rig.cut(); this.update(0);
  }
  /** Undo all of it: both fighters at their marks for the fight, ready, nobody a puppet. */
  stop() {
    if (!this.on) return;
    const ctx = this.ctx, st = this.stage, s = ctx.arena.spawn;
    this.on = false; this.still = null;
    st.take(); st.place(ctx.boss, s.boss.x, s.boss.z, s.boss.yaw || 0); st.play(ctx.boss, 'idle', { fade: 0, loop: true }); st.halo(0);
    st.place(ctx.player, s.player.x, s.player.z, s.player.yaw); st.lantern(1);
    st.flush(); st.release();
    ctx.gfx.post.dof.on = false;
  }
  update(dt) {
    if (!this.on) return;
    this.t += dt;
    sing(this.ctx, this.stage, this.still, this.t, dt);
    this.stage.update(dt);
    this.rig.apply(this.cam, this.t, dt, this.t);
  }
}
