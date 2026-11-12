// 精魄 广谋 (SoulSkillDesc 8011, key F): MagicallyChange — the Destined One becomes 广谋 (MC_10_gycy_she_01) for skill 10111
// AM_10_gycy_she_01_atk_07, which summons two snakes (FUStSummonCommDesc 1011101, 10 s) that keep spitting poison
// (skill 103801 -> bullet 10380101) at the tiger, then he changes back (AM_wukong_trans_from_Vigor).
// Data: data/bianhua.json spirit (extract/B1Data/build_bianhua.py). Energy: VigorEnergyMax = CastEnergy, filled by the
// CostAttr(type 9) rows in the Destined One's hit effect lists, all spent by a cast (BUS_MagicallyChangeComp).
import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { Character, wrapAngle } from "./character.js";
import { CapsuleController } from "./collision.js";
import { hurtCapsule, segSegDist2 } from "./combat.js";
import { ensureCastClips, ensureVfx, swapForm, transSmoke } from "./transform.js";

export const FORM_SHE = "gycy_she";
const KEY = "KeyF";
const DEG = Math.PI / 180;
const rand = (a, b) => a + Math.random() * (b - a);
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _v4 = new THREE.Vector4();
const POISON = [0.45, 1, 0.35]; // NG_GYCY_SheBang_* (M_Hydro_Water_Particles_Inst BaseColor 8FA26B, glow) [INFERENCE: tint]

class Spirit {
  constructor(game) {
    this.game = game;
    const F = game.assets.files;
    this.S = F.bianhuaData.spirit;
    this.sheGltf = F.sheGlb; this.sheAnims = F.sheAnims;
    this.snakeGltf = F.snakeGlb; this.snakeAnims = F.snakeAnims;
    this.vigor = this.S.energy.max; this.phase = "none"; this.cantGain = false;
    this.snakes = []; this.bullets = [];
  }

  attach(p) {
    this.p = p;
    const g = this.game;
    ensureCastClips(g, p.ch);
    this.base = { id: "wukong", ch: p.ch, ctl: p.ctl, d: p.d };
    const ch = new Character(this.sheGltf, this.sheAnims, FORM_SHE);
    ch.root.visible = false;
    g.r.scene.add(ch.root);
    // MagicallyChange keeps the actor (HP, attributes, data); only mesh + capsule change (UpdateHitMoveCollision)
    this.form = { id: FORM_SHE, ch, ctl: new CapsuleController(g.world, this.S.form.capsule, { limitArea: false, areaLatch: true }), d: p.d };
    this.L = ensureVfx(g.vfx);
    g.hud.addSlot("spirit", { key: "F", label: this.S.soulSkill.name, order: 50, code: KEY });
    g.hud.addGauge("spirit", { label: "精魄", color: "#6fc27e" });
    // a hit that breaks the spirit's super armor, or death, ends the change first (the Destined One reacts / dies)
    const react = p.react, die = p.die;
    p.react = (stiff, attacker) => { if (p.form === FORM_SHE && stiff > 0) this.abort("hit"); return react.call(p, stiff, attacker); };
    p.die = (stiff, attacker) => { if (p.form === FORM_SHE) this.abort("dead"); return die.call(p, stiff, attacker); };
    g.spirit = this;
    this.installDebug();
  }

  reset() {
    if (this.p.form === FORM_SHE) {
      const pos = this.p.ch.position.clone(), yaw = this.p.ch.yaw;
      swapForm(this.p, this.base);
      this.p.ch.position.copy(pos); this.p.ch.setYaw(yaw);
    }
    this.vigor = this.S.energy.max; // resting refills VigorEnergy (BUS_PlayerRestComp)
    this.phase = "none"; this.cantGain = false;
    for (const s of this.snakes) this.removeSnake(s);
    this.snakes = []; this.bullets = [];
  }

  get busy() { return this.phase !== "none"; }

  owns(name) { return name === "spirit:cast"; }
  bufferable() { return true; }

  canInterrupt(name, A) {
    const ch = this.p.ch;
    if (A.kind === "hit" || A.kind === "knockdown" || A.kind?.startsWith("spirit:") || A.kind?.startsWith("bianhua:")) return false;
    return ch.inEvent("comboWindow") || ch.inEvent("dodgeWindow") || ch.inEvent("moveWindow");
  }

  start() {
    const p = this.p, g = this.game;
    if (p.form !== "wukong" || this.busy || g.transform?.busy) return false;
    if (this.vigor < this.S.energy.max) { g.hud.toast("精魄能量未满", 0.8); return false; }
    if (!p.ctl.grounded) return false;
    p.sprinting = false;
    if (!p.playAction("spirit:enter", this.S.enter.clip, { fade: 0.1 })) return false;
    p.aimAtStart(p.inputDir());
    // successful cast: all VigorEnergy spent, CantGainVigorEnergy until the change ends
    this.vigor = 0; this.cantGain = true;
    this.phase = "enter"; this.flags = {};
    g.debugLog({ ev: "spiritCast", skill: this.S.soulSkill.id });
    return true;
  }

  onActionEnd(A) {
    if (A.kind === "spirit:enter") { if (this.phase === "enter") this.change(); return true; }
    if (A.kind === "spirit:form") { if (this.phase === "form") this.recover(); return true; }
    if (A.kind === "spirit:leave") { this.phase = "none"; return false; }
    return false;
  }

  /** BAN_GSMagicallyChange: the mesh becomes 广谋 and skill 10111 plays */
  change() {
    const p = this.p;
    swapForm(p, this.form, { loco: false });
    p.playAction("spirit:form", this.S.form.clip, { fade: 0.05 });
    this.phase = "form";
    transSmoke(this.L, p.ch.position, 0.9, [0.55, 0.7, 0.5]);
  }

  /** BAN_GSMagicallyChangeRecover: back to the Destined One, leave montage (skill 10199) */
  recover() {
    const p = this.p;
    swapForm(p, this.base, { loco: false });
    this.cantGain = false;
    this.phase = "leave";
    if (!p.playAction("spirit:leave", this.S.leave.clip, { fade: 0.05 })) { this.phase = "none"; p.toFree(); }
  }

  abort(reason) {
    const p = this.p;
    if (p.form === FORM_SHE) swapForm(p, this.base, { loco: false });
    this.cantGain = false; this.phase = "none";
    this.game.debugLog({ ev: "spiritAbort", reason });
  }

  update(dt, active) {
    const g = this.game, p = this.p;
    if (this.phase === "leave" && p.action?.kind !== "spirit:leave") this.phase = "none";
    if (active && g.input.wasPressed(KEY)) p.press("spirit:cast");
    for (let i = this.snakes.length - 1; i >= 0; i--) if (this.updateSnake(this.snakes[i], dt)) this.snakes.splice(i, 1);
    this.updateBullets(dt);
    const f = this.vigor / this.S.energy.max;
    g.hud.setSlot("spirit", { cd: 1 - f, ready: f >= 1 && p.form === "wukong" && !g.transform?.busy, active: this.busy || this.snakes.length > 0,
      text: this.snakes.length ? `${Math.ceil(Math.max(...this.snakes.map((s) => s.left)))}` : "" });
    g.hud.setGauge("spirit", f, true);
  }

  /** montage-time events of the change (after the frame's animation update) */
  resolveHits() {
    const p = this.p, A = p.action, t = p.ch.clipTime, S = this.S;
    if (A?.kind === "spirit:enter" && this.phase === "enter" && t >= S.enter.changeAt) this.change();
    else if (A?.kind === "spirit:form" && this.phase === "form") {
      const fl = this.flags;
      if (!fl.destroy && t >= S.form.destroyOldAt) { fl.destroy = true; for (const s of this.snakes) s.left = Math.min(s.left, 0); } // effect 2111100
      if (!fl.summon && t >= S.form.summonAt) { fl.summon = true; this.summon(); } // effect 1011101
      if (!fl.fade && t >= S.form.fadeOutAt) { fl.fade = true; p.ch.root.visible = false; transSmoke(this.L, p.ch.position, 0.9, [0.55, 0.7, 0.5]); }
      if (t >= S.form.recoverAt) this.recover();
    }
  }

  /** VigorEnergy from the landed hit's CostAttr(type 9) effects (e.g. ComboA_q1 1080193: +1.5) */
  onHitLanded(h) {
    if (this.cantGain || this.p.form !== "wukong") return;
    const G = this.S.energy.gainByEffect;
    let gain = 0;
    for (const id of h.event.effects || []) gain += G[String(id)] ?? 0;
    if (gain > 0) this.vigor = Math.min(this.S.energy.max, this.vigor + gain);
  }

  // ------------------------------------------------------------------ snakes (UNIT_vigorskill_gycy_shebang)
  summon() {
    const g = this.game, p = this.p, S = this.S.summon, b = g.boss;
    // EQ_SummonVigorskill_huolingsha: 9 points on an 8 m circle around the caster, scored by facing (EnvQueryTest_Dot)
    const face = b?.alive ? Math.atan2(b.ch.position.x - p.ch.position.x, b.ch.position.z - p.ch.position.z) : p.ch.yaw;
    const pts = [];
    for (let i = 0; i < S.eqs.points; i++) {
      const a = (i * 2 * Math.PI) / S.eqs.points;
      pts.push({ a, score: Math.cos(wrapAngle(a - face)) });
    }
    pts.sort((x, y) => y.score - x.score);
    for (const pt of pts.slice(0, S.count)) {
      const x = p.ch.position.x + Math.sin(pt.a) * S.eqs.circleRadius, z = p.ch.position.z + Math.cos(pt.a) * S.eqs.circleRadius;
      const gnd = g.world.groundAt(x, z, p.ch.position.y + 3, 8);
      this.snakes.push(this.spawnSnake(new THREE.Vector3(x, gnd ? gnd.point.y : p.ch.position.y, z)));
    }
    g.debugLog({ ev: "spiritSummon", count: S.count });
  }

  spawnSnake(pos) {
    const g = this.game, S = this.S.summon;
    const ch = new Character({ scene: cloneSkinned(this.snakeGltf.scene), animations: this.snakeGltf.animations }, this.snakeAnims, "shebang");
    ch.position.copy(pos);
    // the snake mesh inherits its capsule's RelativeScale3D 10 and sits partly underground (summon.mesh)
    if (S.mesh) { ch.model.scale.setScalar(S.mesh.scale); ch.model.position.y = S.mesh.offsetY; }
    ch.root.visible = false;
    g.r.scene.add(ch.root);
    g.audio?.track?.(ch);
    // FUStAttrCopyConfigDesc 103809: AtkRatio 2000 of the summoner's attack, other attributes copied
    const stats = { ...this.base.d.stats, attack: this.base.d.stats.attack * S.atkRatio };
    const s = { ch, stats, state: "wait", t: S.bornDelay, left: S.aliveTime, fired: false };
    this.faceBoss(s, 1e9);
    return s;
  }

  faceBoss(s, degPerSec, dt = 1) {
    const b = this.game.boss;
    if (!b?.alive) return;
    const want = Math.atan2(b.ch.position.x - s.ch.position.x, b.ch.position.z - s.ch.position.z);
    const d = wrapAngle(want - s.ch.yaw), step = degPerSec * DEG * dt;
    s.ch.setYaw(s.ch.yaw + (Math.abs(d) <= step ? d : Math.sign(d) * step));
  }

  /** returns true when the snake is gone */
  updateSnake(s, dt) {
    const S = this.S.summon, ch = s.ch;
    const dts = dt;
    s.left -= dts;
    if (s.state === "wait") {
      s.t -= dts;
      if (s.t <= 0) {
        ch.root.visible = true; s.state = "born";
        ch.play(S.bornClip, { loop: false, rootMotion: false, fade: 0 });
        this.burst(ch.position, 1);
      }
      return false;
    }
    if (s.left <= 0 && s.state !== "die" && s.state !== "gone") {
      // SummonAliveTime over (or destroyed by the next cast): disappear montage
      s.state = "die"; ch.play(S.dieClip, { loop: false, rootMotion: false, fade: 0.1 });
    }
    ch.update(dts, _v4);
    const cur = ch.cur;
    if (s.state === "die") {
      if (!cur || cur.ended) { this.burst(ch.position, 0.7); this.removeSnake(s); return true; }
      return false;
    }
    if (s.state === "born" && cur?.ended) { s.state = "idle"; s.t = rand(...S.attack.gap); ch.play(S.idleClip, { loop: true, rootMotion: false, fade: 0.15 }); }
    else if (s.state === "idle") {
      this.faceBoss(s, S.attack.rotateSpeed, dts);
      s.t -= dts;
      if (s.t <= 0 && this.game.boss.alive) { s.state = "atk"; s.fired = false; ch.play(S.attack.clip, { loop: false, rootMotion: false, fade: 0.1 }); }
    } else if (s.state === "atk") {
      if (ch.inEvent("rotate")) this.faceBoss(s, S.attack.rotateSpeed, dts);
      if (!s.fired && ch.clipTime >= this.S.bullet.at) { s.fired = true; this.fire(s); }
      if (cur?.ended) { s.state = "idle"; s.t = rand(...S.attack.gap); ch.play(S.idleClip, { loop: true, rootMotion: false, fade: 0.15 }); }
    }
    return false;
  }

  removeSnake(s) {
    s.state = "gone";
    this.game.audio?.untrack?.(s.ch);
    this.game.r.scene.remove(s.ch.root);
  }

  burst(p, s) {
    const L = this.L;
    // NG_GYCY_SheBang_Enter / ChuXian: dust ring + green glow
    for (let i = 0; i < 12 * s; i++) {
      const a = Math.random() * 6.283, v = rand(1, 2.5);
      L.bhSmoke.spawn(p.x + Math.cos(a) * 0.3, p.y + 0.3, p.z + Math.sin(a) * 0.3, Math.cos(a) * v, rand(0.3, 1), Math.sin(a) * v,
        { size: [0.8 * s, 2.2 * s], life: rand(0.7, 1.1), color: [0.55, 0.6, 0.45], alpha: 0.35, drag: 2, frames: 64 });
    }
    L.bhGlow.spawn(p.x, p.y + 0.8, p.z, 0, 0, 0, { size: [0.6, 3.5 * s], life: 0.35, color: POISON, alpha: 0.9 });
  }

  // ------------------------------------------------------------------ poison bullets (10380101)
  fire(s) {
    const B = this.S.bullet, b = this.game.boss;
    const from = s.ch.bonePos(B.socket, new THREE.Vector3()) || s.ch.position.clone().setY(s.ch.position.y + 1.2);
    const to = (b.ch.bonePos(B.target, _t) || _t.copy(b.ch.position).setY(b.ch.position.y + 1.5));
    const dir = to.clone().sub(from).normalize(); // ProjectileBornDirType LookAtTargetPos, StraightMode
    this.bullets.push({ pos: from, prev: from.clone(), dir, age: 0, owner: s });
  }

  updateBullets(dt) {
    const B = this.S.bullet, boss = this.game.boss, L = this.L;
    const cap = boss.alive ? hurtCapsule(boss.ch, boss.capsule, { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 }) : null;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const u = this.bullets[i];
      u.age += dt;
      // BulletFlySpd 4000 -> 5000 cm/s over AccelerationTime 0.2 s
      const sp = B.speed[0] + (B.speed[1] - B.speed[0]) * Math.min(1, u.age / Math.max(B.accelTime, 1e-3));
      u.prev.copy(u.pos); u.pos.addScaledVector(u.dir, sp * dt);
      // visuals: NG_GYCY_SheBang_Bullet (glow core + green trail)
      L.bhDot.spawn(u.pos.x, u.pos.y, u.pos.z, 0, 0, 0, { size: [0.7, 0.4], life: 0.12, color: POISON, alpha: 1 });
      for (let k = 0; k < 2; k++) {
        _p.copy(u.prev).lerp(u.pos, Math.random());
        L.bhDot.spawn(_p.x, _p.y, _p.z, rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.3, 0.3), { size: [0.35, 0.1], life: 0.25, color: [0.3, 0.75, 0.25], alpha: 0.8 });
      }
      let hit = false;
      if (cap) {
        const r = B.radius + cap.r;
        if (segSegDist2(u.prev, u.pos, cap.a, cap.b) <= r * r) {
          hit = true;
          const res = boss.receiveHit({ stats: u.owner.stats, ch: u.owner.ch }, B.damage, u.pos.clone(), { effectId: B.id });
          this.game.debugLog({ ev: "spiritBulletHit", dmg: res?.damage ?? 0, bounced: !!res?.bounced });
          for (let k = 0; k < 14; k++) {
            const a = Math.random() * 6.283, v = rand(2, 5);
            L.bhDot.spawn(u.pos.x, u.pos.y, u.pos.z, Math.cos(a) * v, rand(0, 3), Math.sin(a) * v, { size: [0.4, 0.15], life: 0.4, color: POISON, alpha: 1, gravity: 6 });
          }
          L.bhGlow.spawn(u.pos.x, u.pos.y, u.pos.z, 0, 0, 0, { size: [0.5, 2.5], life: 0.25, color: POISON, alpha: 1 }); // NG_GYCY_SheBang_Bullet_BaoFa
        }
      }
      if (hit || u.age >= B.life || u.pos.distanceTo(boss.ch.position) > 80) this.bullets.splice(i, 1);
    }
  }

  installDebug() {
    const dbg = window.__WK_DEBUG__;
    if (!dbg) return;
    dbg.spirit = {
      state: () => ({ phase: this.phase, vigor: +this.vigor.toFixed(2), max: this.S.energy.max, form: this.p.form, snakes: this.snakes.map((s) => ({ state: s.state, left: +s.left.toFixed(2), pos: s.ch.position.toArray().map((v) => +v.toFixed(2)) })), bullets: this.bullets.length }),
      setVigor: (v) => { this.vigor = Math.max(0, Math.min(this.S.energy.max, v)); },
      cast: () => this.p.press("spirit:cast"),
    };
  }
}

export const makeSpirit = (game) => new Spirit(game);
