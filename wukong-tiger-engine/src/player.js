// 天命人: data/player.json + wukong.anims.json (extra.actions / events) driven controller.
// Free locomotion, dodge chain + perfect dodge, light combo (combo windows/whitelists), sprint light, heavy charge
// (xuli start/loop/attack by focus level), gourd, hit reactions by stiff level, super armor, death.
import * as THREE from "three";
import { wrapAngle, targetMoveScale } from "./character.js";
import { HitTracker, hurtCapsule, blockMove } from "./combat.js";
import { computeDamage } from "./damage.js";

const DEG = Math.PI / 180;
const STICK_WALK = 0.5; // touch joystick deflection below this walks (keyboard: Ctrl / Alt)
const _dv = new THREE.Vector4(), _mv = new THREE.Vector3(), _tmp = new THREE.Vector3();

export class Player {
  constructor(game, ch, ctl, data) {
    this.game = game;
    this.isPlayer = true;
    this.maxMp = data.stats.mpMax;
    this.setForm(ch, ctl, data, "wukong");
    this.cap = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 };
    this.pdCap = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 };
    this.opponent = null;
    this.god = false;
    this.mods = []; // extension modules (see use())
  }

  /**
   * Binds the controlled unit: character, capsule controller, combat data (player.json schema) and form id ("wukong",
   * or a transformation / spirit form set by transform.js / spirit.js). Derived fields follow the data; hp/stamina/focus
   * values are the caller's business.
   */
  setForm(ch, ctl, data, form) {
    this.ch = ch; this.ctl = ctl; this.d = data; this.form = form;
    this.stats = data.stats;
    this.maxHp = data.stats.hpMax;
    this.maxStamina = data.stamina.max ?? data.stats.staminaMax;
    this.act = ch.anims.actions || ch.anims.extra?.actions;
    this.pd = ch.anims.extra?.perfectDodge;
    this.gait = ch.anims.extra?.locomotion?.gaitCurves;
    const cfg = data.focus.configs[String(data.focus.activeConfig)];
    this.focusCfg = cfg;
    this.focusLevels = cfg.filter((l) => l.level > 0);
    this.focusMax = cfg[cfg.length - 1].threshold;
    this.chargeCap = (cfg.find((l) => l.normalMax) || cfg[cfg.length - 1]).threshold;
    this.hitter = new HitTracker(ch, 0.5);
    ch.moveScaleRate = (e) => this.moveScaleRate(e);
  }

  /**
   * Registers an extension module (spells, stances, transformation, spirit; factories in modules.js). Every hook is
   * optional:
   *   attach(player)                      once, right after use()
   *   reset()                             end of Player.reset (new fight)
   *   update(dt, active)                  every frame after the built-in key mapping (read input, call press(name))
   *   owns(name) -> bool                  claims an input/action name (e.g. "spell:immobilize"; kinds may share it)
   *   bufferable(name) -> bool            press() during an action: buffer it now (default: inputBuffer/comboWindow)
   *   start(name, dir, from) -> bool      run a queued owned name; from = "free" | "action" (only if canInterrupt)
   *   canInterrupt(name, action) -> bool  queued owned name may cancel the running action now
   *   onActionEnd(action) -> bool         owned action kind's montage ended; true = handled (no toFree())
   *   receiveHit(attacker, e, point, info) -> number | undefined   handle an incoming hit before the default path
   *   resolveHits()                       per frame after the player's own hit resolution
   *   onHitLanded(hit, spec, effectId, result)  each landed own hit (after damage, not bounced): hit = {event, point}
   */
  use(mod) {
    this.mods.push(mod);
    mod.attach?.(this);
    return mod;
  }

  modFor(name) { return name ? this.mods.find((m) => m.owns?.(name)) : null; }

  get capsule() { return this.ch.anims.capsule; }
  get alive() { return this.hp > 0; }
  /** skill id of the running montage (boss CBG castingSkill on the player) */
  currentSkillId() { return this.state === "action" ? this.action.skill ?? this.action.spec?.skill ?? null : null; }
  get focusPips() { let l = 0; for (const c of this.focusCfg) if (this.focus >= c.threshold) l = c.level; return l; }
  get focusFrac() {
    const lv = this.focusPips, cfg = this.focusCfg;
    if (lv >= cfg[cfg.length - 1].level) return 1;
    const a = cfg[lv].threshold, b = cfg[lv + 1].threshold;
    return (this.focus - a) / (b - a);
  }

  reset(pos, yaw) {
    this.ch.position.copy(pos);
    this.ch.setYaw(yaw);
    this.ctl.vy = 0; this.ctl.grounded = false; this.ctl.noGravity = false; this.ctl.limitArea = false;
    this.hp = this.maxHp; this.mp = this.maxMp; this.stamina = this.maxStamina;
    this.focus = 0; this.lastFocusGain = 0; this.time = 0;
    this.noRegen = 0; this.depleted = 0;
    this.gourdCharges = this.d.gourd.charges;
    this.state = "idle"; this.action = null;
    this.lockOn = false; this.vel = new THREE.Vector3(); this.locoClip = null; this.sprinting = false;
    this.queued = null; this.queuedAt = 0;
    this.pdTimer = 0; this.pdAwarded = new Set(); this.invulnUntil = 0;
    this.armor = new Map();
    this.slowUntil = 0;
    this.timeScale = 1;
    this.hitter.reset();
    this.playLoco(this.act.idle, 0);
    for (const m of this.mods) m.reset?.();
  }

  // ------------------------------------------------------------------ helpers
  playLoco(name, fade = 0.2) {
    if (!name || this.locoClip === name) return;
    this.locoClip = name;
    this.ch.play(name, { loop: true, fade, rootMotion: false });
  }

  /** starts a montage-driven action */
  playAction(kind, clip, extra = {}) {
    if (!clip || !this.ch.has(clip)) { this.game.debugLog({ ev: "missingClip", clip }); return false; }
    this.locoClip = null;
    this.state = "action";
    this.action = { kind, clip, ...extra };
    this.armor.clear();
    this.hitter.reset();
    this.ch.play(clip, { fade: extra.fade ?? 0.1, loop: false, onEnd: () => this.onActionEnd(clip) });
    return true;
  }

  onActionEnd(clip) {
    if (this.state !== "action" || this.action?.clip !== clip) return;
    if (this.action.kind === "heavyStart") return this.enterChargeLoop();
    if (this.modFor(this.action.kind)?.onActionEnd?.(this.action)) return;
    this.toFree();
  }

  toFree() {
    this.state = "idle"; this.action = null;
    this.playLoco(this.act.idle, 0.25);
  }

  inputDir() {
    const I = this.game.input;
    let x = I.stick.x, z = I.stick.y;
    if (I.held("KeyW")) z += 1; if (I.held("KeyS")) z -= 1;
    if (I.held("KeyD")) x += 1; if (I.held("KeyA")) x -= 1;
    if (!x && !z) return null;
    const { f, r } = this.game.cam.basis();
    return new THREE.Vector3().addScaledVector(f, z).addScaledVector(r, x).normalize();
  }

  faceTowards(dir, degPerSec, dt) {
    if (!dir) return;
    const want = Math.atan2(dir.x, dir.z), diff = wrapAngle(want - this.ch.yaw), step = degPerSec * DEG * dt;
    this.ch.setYaw(this.ch.yaw + (Math.abs(diff) <= step ? diff : Math.sign(diff) * step));
  }

  toBoss() { return _tmp.subVectors(this.opponent.ch.position, this.ch.position).setY(0).normalize().clone(); }
  bossDist() { const p = this.opponent.ch.position, q = this.ch.position; return Math.hypot(p.x - q.x, p.z - q.z); }

  /** attack target for rotation / root-motion scaling: lock target, or the boss when close and roughly ahead */
  attackTarget() {
    const b = this.opponent;
    if (!b?.alive || !b.canBeLocked()) return null;
    if (this.lockOn) return b;
    const d = this.bossDist();
    const ang = Math.abs(wrapAngle(Math.atan2(...(() => { const v = this.toBoss(); return [v.x, v.z]; })()) - this.ch.yaw));
    return d < 12 && ang < 75 * DEG ? b : null;
  }

  moveScaleRate(e) {
    const t = this.attackTarget();
    if (!t || this.state !== "action") return e.type === "EAMScaleType::UsePureScale" ? e.pureScale ?? 1 : 1;
    const p = t.ch.position, q = this.ch.position, f = this.ch.forward();
    const surface = (p.x - q.x) * f.x + (p.z - q.z) * f.z - this.capsule.radius - t.capsule.radius;
    return targetMoveScale(this.ch, e, surface, null);
  }

  invulnerable() {
    if (this.god || this.state === "dead") return true;
    if (this.time < this.invulnUntil) return true;
    return this.ch.inEvent("iframe");
  }

  spend(n) {
    if (!(n > 0)) return;
    this.stamina = Math.max(0, this.stamina - n);
    if (this.stamina <= 0) {
      // stamina depletion: buff 129 (no regen) + StaminaDepleted state
      const dp = this.d.stamina.depletion;
      this.noRegen = dp.noRegenSec; this.depleted = dp.staminaDepletedStateSec;
    }
  }

  gainFocus(v) {
    if (!(v > 0)) return;
    this.focus = Math.min(this.focusMax, this.focus + v);
    this.lastFocusGain = this.time;
  }

  decayFocus(dt) {
    const lvl = this.focusPips, cfg = this.focusCfg, L = cfg[lvl];
    if (!L || !(L.decayPerSec > 0) || L.protectTime < 0) return;
    if (this.time - this.lastFocusGain < L.protectTime) return;
    if (this.state === "action" && this.action.kind?.startsWith("heavy")) return; // charging holds focus
    const top = lvl === cfg[cfg.length - 1].level;
    const floor = top ? cfg[lvl - 1].threshold : L.threshold;
    this.focus = Math.max(floor, this.focus - L.decayPerSec * dt);
  }

  // ------------------------------------------------------------------ frame
  update(dt, active) {
    const I = this.game.input, ch = this.ch;
    dt *= this.timeScale;
    this.time += dt;
    this.game.worldSlow = 1;
    if (active && this.alive) {
      // MouseEvent.button: 1 = middle (Mouse1), 2 = right (Mouse2)
      if (I.wasPressed("KeyQ") || I.wasPressed("Mouse1")) this.lockOn = !this.lockOn && this.opponent.canBeLocked();
      for (const [code, a] of [["Mouse0", "light"], ["Mouse2", "heavy"], ["Space", "dodge"], ["KeyR", "gourd"]]) {
        if (I.wasPressed(code)) this.press(a);
      }
    }
    for (const m of this.mods) m.update?.(dt, active && this.alive);
    if (this.lockOn && !this.opponent.canBeLocked()) this.lockOn = false;

    // perfect-dodge detection window (BUS_PreciseDodgeComp): enemy hit/warning shape overlapping the PD capsule
    this.updatePerfectWindow(dt);

    // stamina regen: paused in every `cost` window of the current action and while sprinting/depleted
    this.noRegen = Math.max(0, this.noRegen - dt); this.depleted = Math.max(0, this.depleted - dt);
    const blocked = this.noRegen > 0 || this.sprinting || (this.d.stamina.regenBlockedDuringCostWindows && ch.inEvent("cost"));
    if (!blocked) this.stamina = Math.min(this.maxStamina, this.stamina + this.d.stamina.regenPerSec * dt);
    this.decayFocus(dt);

    const dir = active && this.alive ? this.inputDir() : null;
    if (active && this.alive) {
      if (this.state !== "action") this.freeUpdate(dir, dt);
      else this.actionUpdate(dir, dt);
    } else if (this.state !== "action" && this.state !== "dead") {
      this.vel.set(0, 0, 0); this.sprinting = false; this.state = "idle"; this.playLoco(this.act.idle);
    }

    ch.update(dt, _dv);
    if (this.state === "action" || this.state === "dead") {
      _mv.set(_dv.x, 0, _dv.z);
      ch.setYaw(ch.yaw + _dv.w);
    } else _mv.copy(this.vel).multiplyScalar(dt);
    const b = this.opponent;
    if (b?.alive && this.state !== "dead" && !b.passThrough() && !this.windWalk) blockMove(ch.position, _mv, b.ch.position, this.capsule.radius + b.capsule.radius);
    this.ctl.move(ch.position, _mv, dt);

    if (this.state === "action") this.actionEvents();
  }

  // ------------------------------------------------------------------ input buffering
  /** press handling: execute now if allowed, else buffer when inside the matching input-buffer window */
  press(a) {
    if (this.state !== "action") { this.queued = a; this.queuedAt = this.time; return; }
    const ch = this.ch, mod = this.modFor(a);
    const buf = mod ? (mod.bufferable?.(a) ?? (ch.inEvent("inputBuffer") || ch.inEvent("comboWindow")))
      : a === "dodge" ? (ch.inEvent("dodgeInputBuffer") || ch.inEvent("dodgeWindow") || ch.inEvent("hitCancel"))
        : a === "gourd" ? ch.inEvent("itemWindow") || ch.inEvent("inputBuffer")
          : ch.inEvent("inputBuffer") || ch.inEvent("comboWindow");
    if (buf) { this.queued = a; this.queuedAt = this.time; }
  }

  takeQueued(a) { if (this.queued === a) { this.queued = null; return true; } return false; }

  freeUpdate(dir, dt) {
    const I = this.game.input, M = this.d.movement;
    const q = this.queued;
    if (q && this.time - this.queuedAt > 0.4) this.queued = null;
    const qm = this.modFor(this.queued);
    if (qm) { const name = this.queued; this.queued = null; if (qm.start(name, dir, "free")) return; }
    if (this.queued === "dodge" && this.stamina > 0) { this.queued = null; return this.startDodge(dir, 0); }
    if (this.queued === "light") {
      this.queued = null;
      if (this.sprinting && this.stamina >= (this.d.sprintLight.minStaminaToStart ?? 0)) return this.startAttack("sprintLight", this.d.sprintLight, dir);
      return this.startLight(0, dir);
    }
    if (this.queued === "heavy") { this.queued = null; return this.startCharge(); }
    if (this.queued === "gourd") { this.queued = null; if (this.startGourd()) return; }

    const stick = Math.hypot(I.stick.x, I.stick.y);
    const walkKey = I.held("ControlLeft") || I.held("AltLeft") || (stick > 0 && stick < STICK_WALK);
    this.sprinting = !!dir && I.held("ShiftLeft") && this.stamina > 0 && this.depleted <= 0 && !walkKey;
    const gait = !dir ? 0 : this.sprinting ? 3 : walkKey ? 1 : 2;
    let target = gait === 3 ? M.sprint : gait === 2 ? M.run : gait === 1 ? M.walk : 0;
    if (this.lockOn && dir) {
      const rel = Math.abs(wrapAngle(Math.atan2(dir.x, dir.z) - this.ch.yaw));
      if (rel > Math.PI / 2) target *= M.backwardRate;
    }
    // ALS gait curves (ABPSetting_Wukong): acceleration / braking per gait
    const curves = this.lockOn ? this.gait?.lock : this.gait?.free;
    const accel = curveAt(curves?.accel, Math.max(gait, 1)) ?? 20, decel = curveAt(curves?.decel, gait) ?? 40;
    const wantVel = (dir || _tmp.set(0, 0, 0)).clone().multiplyScalar(target);
    const diff = wantVel.clone().sub(this.vel);
    const rate = wantVel.lengthSq() >= this.vel.lengthSq() ? accel : decel;
    const step = rate * dt;
    if (diff.length() <= step) this.vel.copy(wantVel); else this.vel.addScaledVector(diff.normalize(), step);
    if (this.sprinting) this.spend(this.d.stamina.sprintPerSec * dt);
    const speed = this.vel.length();
    const turn = M.turnSpeed;
    if (this.lockOn) this.faceTowards(this.toBoss(), M.bigTurnSpeed, dt);
    else if (dir) {
      const big = Math.abs(wrapAngle(Math.atan2(dir.x, dir.z) - this.ch.yaw)) > Math.PI / 2;
      this.faceTowards(dir, big ? M.bigTurnSpeed : turn, dt);
    }
    this.state = speed > 0.1 ? "move" : "idle";
    this.chooseLocoClip(speed, gait, dir);
  }

  chooseLocoClip(speed, gait, dir) {
    const A = this.act, M = this.d.movement, th = this.ch.anims.extra?.locomotion?.footSpeedThresholds || {};
    if (speed < 0.1) return this.playLoco(A.idle);
    let clip, base;
    if (this.lockOn && gait !== 3) {
      const rel = wrapAngle(Math.atan2(this.vel.x, this.vel.z) - this.ch.yaw); // + = towards the character's left
      const a = rel / DEG;
      const set = speed > (th.run ?? 5) * 0.6 ? A.lockRun : A.lockWalk;
      const key = Math.abs(a) <= 30 ? "F" : Math.abs(a) >= 150 ? "B" : a > 0 ? (Math.abs(a) <= 90 ? "LF" : "LB") : (Math.abs(a) <= 90 ? "RF" : "RB");
      clip = set[key] || set.F;
      base = set === A.lockRun ? M.run : M.walk;
    } else if (gait === 3) { clip = A.sprint; base = M.sprint; }
    else if (speed > (th.walk ?? 1) * 1.6) { clip = A.run; base = M.run; }
    else { clip = A.walk; base = M.walk; }
    this.playLoco(clip);
    this.ch.setSpeed(THREE.MathUtils.clamp(speed / base, 0.5, 1.3));
  }

  /** interrupts / chaining while a montage plays (windows from the clip's events) */
  actionUpdate(dir, dt) {
    const ch = this.ch, A = this.action, I = this.game.input;
    if (A.kind === "heavyStart" || A.kind === "heavyLoop") return this.chargeUpdate(dt);
    if (this.queued && this.time - this.queuedAt > 1.0) this.queued = null;
    const qm = this.modFor(this.queued);
    if (qm?.canInterrupt?.(this.queued, A)) { const name = this.queued; this.queued = null; if (qm.start(name, dir, "action")) return; }
    // dodge
    if (this.queued === "dodge" && (ch.inEvent("dodgeWindow") || ch.inEvent("hitCancel")) && this.stamina > 0) {
      this.queued = null;
      const chainIdx = A.kind === "dodge" ? (A.chain + 1) % this.d.dodge.chain.length : 0;
      return this.startDodge(dir, chainIdx);
    }
    // attacks inside combo windows (whitelist / blacklist of next skill ids)
    const cw = ch.activeEvents("comboWindow")[0];
    if (cw) {
      if (this.queued === "light") {
        const next = this.stances?.lightNext(A) ?? (A.kind === "light" ? (A.step + 1) % this.d.lightCombo.length : 0);
        const skill = this.d.lightCombo[next].skill;
        if (allowed(cw, skill)) { this.queued = null; return this.startLight(next, dir); }
      }
      if (this.queued === "heavy") {
        // stance light->heavy follow-ups (识破 / 风云转 / 退寸进尺, combo graph CCG_Player_Wukong): stances.js
        if (this.stances?.heavyFollowUp(A, cw, dir)) { this.queued = null; return; }
        const L = this.d.heavy.levels[this.focusPips];
        if (allowed(cw, L.chargeStartSkill ?? L.skill)) { this.queued = null; return this.startCharge(); }
      }
    }
    if (this.queued === "gourd" && ch.inEvent("itemWindow")) { this.queued = null; if (this.startGourd()) return; }
    // movement input cancels inside moveWindow (or, for attacks without one, after their last combo window)
    if (dir) {
      const mw = ch.inEvent("moveWindow");
      const cws = ch.events("comboWindow"), hasMW = ch.events("moveWindow").length > 0;
      const afterCombo = !hasMW && ["light", "sprintLight", "heavy", "followUp", "dodge", "perfectDodge"].includes(A.kind) &&
        cws.length && ch.clipTime >= Math.max(...cws.map((e) => e.end));
      if (mw || afterCombo) { this.toFree(); this.vel.copy(dir).multiplyScalar(this.d.movement.run * 0.5); return; }
    }
    // BANS_GSAttackRotation windows: steer toward the target / input at window speed
    const rot = ch.activeEvents("rotate")[0];
    if (rot && rot.speed) {
      const t = this.attackTarget();
      this.faceTowards(t ? this.toBoss() : dir, rot.speed, dt);
    }
    if (A.kind === "gourd") this.gourdUpdate();
  }

  /** point events on the running montage */
  actionEvents() {
    for (const e of this.ch.crossed("focus")) {
      if (e.value === -99) this.focus = 0; else this.gainFocus(e.value);
    }
    for (const e of this.ch.crossed("heal")) this.applyHeal();
    const sl = this.ch.activeEvents("slowTime")[0];
    this.game.worldSlow = sl ? sl.scale : 1;
  }

  // ------------------------------------------------------------------ actions
  startDodge(dir, chainIdx) {
    const D = this.d.dodge;
    const perfect = this.pdTimer > 0 && !this.pdAwarded.has(this.pdKey);
    const clips = perfect ? D.perfect.clips : D.chain[chainIdx].clips;
    let key = "F";
    if (this.lockOn && this.opponent.alive) {
      if (dir) {
        const rel = wrapAngle(Math.atan2(dir.x, dir.z) - this.ch.yaw), a = Math.abs(rel);
        key = a < Math.PI / 4 ? "F" : a > 3 * Math.PI / 4 ? "B" : rel > 0 ? "L" : "R";
      } else key = "B";
    } else if (dir) this.ch.setYaw(Math.atan2(dir.x, dir.z));
    if (perfect) {
      // perfect dodge: no stamina cost, invulnerability + focus award (once per window)
      this.pdAwarded.add(this.pdKey);
      this.invulnUntil = this.time + D.perfect.rewards.invulnerableSec;
      this.gainFocus(D.perfect.rewards.focusGain ?? this.d.focus.perfectDodgeGain);
      this.game.hud.toast("识破", 0.8);
      this.game.debugLog({ ev: "perfectDodge", clip: clips[key] });
      return this.playAction("perfectDodge", clips[key], { fade: 0.05 });
    }
    this.spend(D.chain[chainIdx].staminaCost);
    this.game.debugLog({ ev: "dodge", chain: chainIdx, clip: clips[key] });
    this.playAction("dodge", clips[key], { fade: 0.05, chain: chainIdx });
  }

  aimAtStart(dir) {
    const t = this.attackTarget();
    if (t) { const v = this.toBoss(); this.ch.setYaw(Math.atan2(v.x, v.z)); }
    else if (dir) this.ch.setYaw(Math.atan2(dir.x, dir.z));
  }

  startAttack(kind, spec, dir, extra = {}) {
    if (this.stamina < (spec.minStaminaToStart ?? 0) || (spec.minStaminaToStart == null && this.stamina <= 0)) return false;
    this.aimAtStart(dir);
    this.spend(spec.staminaCost);
    this.sprinting = false;
    this.game.debugLog({ ev: "attack", kind, clip: spec.clip });
    return this.playAction(kind, spec.clip, { spec, ...extra });
  }

  startLight(step, dir) { return this.startAttack("light", this.d.lightCombo[step], dir, { step }); }

  startCharge() {
    if (this.stances?.startHeavy(this.inputDir())) return; // 立棍 / 戳棍 heavies live in stances.js
    const H = this.d.heavy, lv = this.focusPips, L = H.levels[lv];
    if (this.stamina < (L.minStaminaToStart ?? 0)) return;
    this.aimAtStart(this.inputDir());
    this.spend(L.chargeStartCost);
    this.chargeTime = 0;
    this.playAction("heavyStart", L.chargeStartClip, { fade: 0.1 });
    if (!this.game.input.held("Mouse2")) this.action.released = true;
  }

  enterChargeLoop() {
    this.playAction("heavyLoop", this.d.heavy.loopClip, { fade: 0.1 });
    this.ch.cur.loop = true;
    this.loopTime = 0;
  }

  chargeUpdate(dt) {
    const H = this.d.heavy, I = this.game.input, A = this.action;
    if (!I.held("Mouse2")) A.released = true;
    this.chargeTime += dt;
    // buff 246: from focusGainStartsAfter into the start stage, focus +55/s capped at the first normalMax level
    if (this.chargeTime >= H.charge.focusGainStartsAfter && this.focus < this.chargeCap) {
      this.focus = Math.min(this.chargeCap, this.focus + H.charge.focusGainPerSec * dt);
      this.lastFocusGain = this.time;
    }
    if (A.kind === "heavyLoop") {
      this.loopTime += dt;
      if (this.loopTime >= H.loopLength) { this.loopTime -= H.loopLength; this.spend(H.loopStaminaCost); }
    }
    if (this.lockOn) this.faceTowards(this.toBoss(), this.d.movement.turnSpeed, dt);
    else this.faceTowards(this.inputDir(), this.d.movement.turnSpeed, dt);
    if (this.queued === "dodge" && this.ch.inEvent("dodgeWindow") && this.stamina > 0) { this.queued = null; return this.startDodge(this.inputDir(), 0); }
    if (A.released || this.stamina <= 0) this.releaseHeavy();
  }

  releaseHeavy() {
    const H = this.d.heavy, lv = this.focusPips, L = H.levels[lv];
    this.spend(L.staminaCost);
    this.aimAtStart(this.inputDir());
    this.game.debugLog({ ev: "heavy", level: lv, clip: L.clip });
    this.playAction("heavy", L.clip, { spec: L, level: lv, fade: 0.08 });
    if (H.charge.consumesAllFocus && !this.ch.events("focus").some((e) => e.value === -99)) this.focus = 0;
  }

  startGourd() {
    const G = this.d.gourd;
    if (this.gourdCharges <= 0) { this.game.hud.toast("葫芦已空", 0.8); return false; }
    this.healed = false;
    this.sprinting = false;
    return this.playAction("gourd", G.clip, { fade: 0.15 });
  }

  gourdUpdate() {
    const G = this.d.gourd;
    if (!this.healed && !this.ch.events("heal").length && this.ch.clipTime >= G.healTime) this.applyHeal();
  }

  applyHeal() {
    if (this.healed || this.action?.kind !== "gourd") return;
    const G = this.d.gourd;
    this.healed = true;
    this.gourdCharges--;
    const heal = this.maxHp * G.healPctOfHpMax + G.healFlat;
    this.hp = Math.min(this.maxHp, this.hp + heal);
    this.game.debugLog({ ev: "gourd", heal, hp: this.hp, left: this.gourdCharges });
  }

  // ------------------------------------------------------------------ perfect dodge window
  updatePerfectWindow(dt) {
    this.pdTimer = Math.max(0, this.pdTimer - dt);
    const b = this.opponent;
    if (!b?.alive || b.state !== "skill" || b.immobilized) return; // 定身 pauses attack warnings / sweep checks
    const c = this.pd?.capsule || { radius: 0.9, halfHeight: 1.6 };
    const cap = hurtCapsule(this.ch, c, this.pdCap);
    for (const type of ["hit", "warning"]) {
      const e = b.hitter.overlapsNow(type, cap);
      if (e) {
        this.pdTimer = this.pd?.tolerantTime ?? this.d.dodge.perfect.toleranceSec;
        // a warning window and the hit window it announces count as one award window
        const evs = b.ch.cur.meta.events;
        const hitEv = type === "hit" ? e : evs.find((x) => x.type === "hit" && x.start >= e.start) || e;
        this.pdKey = `${b.ch.cur.stamp}:${evs.indexOf(hitEv)}`;
        return;
      }
    }
  }

  // ------------------------------------------------------------------ combat
  resolveHits() {
    this.resolveOwnHits();
    for (const m of this.mods) m.resolveHits?.();
  }

  resolveOwnHits() {
    const boss = this.opponent;
    if (!boss.alive || this.state !== "action" || !this.action.spec?.damage) return;
    const hits = this.hitter.test(hurtCapsule(boss.ch, boss.capsule, boss.cap), "boss");
    const spec = this.action.spec;
    for (const h of hits) {
      const ids = h.event.effects || h.event.effectIds || [h.event.id];
      const dmgId = ids.map(String).find((id) => spec.damage[id]);
      if (!dmgId) continue;
      const res = boss.receiveHit(this, spec.damage[dmgId], h.point, { effectId: dmgId, skill: spec.skill });
      if (!res) continue;
      this.game.audio?.hit(this, boss, h, res);
      if (res.bounced) {
        const clip = this.d.reboundClips?.[String(spec.skill)];
        if (clip) { this.game.debugLog({ ev: "rebound", clip }); this.playAction("rebound", clip, { fade: 0.05 }); }
        return;
      }
      this.gainFocus(focusGainFor(spec, dmgId));
      for (const m of this.mods) m.onHitLanded?.(h, spec, dmgId, res);
      this.game.vfx?.hit("staff", h.point);
    }
  }

  /** tiger -> player. e = damage effect. Returns damage applied */
  receiveHit(attacker, e, point, info = {}) {
    if (!this.alive) return 0;
    for (const m of this.mods) { const r = m.receiveHit?.(attacker, e, point, info); if (r !== undefined) return r; }
    // CommonDamageImmue (dodge i-frames / perfect dodge) ignores hits with damageImmuneLevel < 1
    if (this.invulnerable() && (e.damageImmuneLevel ?? 0) < 1) return 0;
    let { damage, crit } = computeDamage(this.game.damageModel, attacker.stats, this, e);
    if (this.state === "action" && (this.action.kind === "heavyStart" || this.action.kind === "heavyLoop"))
      damage = Math.floor(damage * (1 - this.d.heavy.charge.damageReductionWhileCharging));
    if (this.god) damage = 0;
    this.hp = Math.max(0, this.hp - damage);
    this.game.hud.damage(this.game.r.camera, point || this.ch.position, damage, "player");
    this.game.debugLog({ ev: "playerHit", dmg: damage, crit, hp: this.hp, effect: info.effectId, clip: attacker.ch.clipName });
    const stiff = (e.hitWeight ?? 0) - (this.stats.tenacity ?? 0);
    if (this.hp <= 0) { this.die(stiff, attacker); return damage; }
    // player super armor windows: armor = window value, reduced by armorBreak; > 0 left -> no reaction
    const sa = this.superArmorWindow();
    if (sa) {
      if (!this.armor.has(sa.i)) this.armor.set(sa.i, this.saValue(sa.e));
      const left = this.armor.get(sa.i) - (e.armorBreak ?? 0);
      this.armor.set(sa.i, left);
      if (left > 0) return damage;
    }
    this.react(stiff, attacker);
    return damage;
  }

  superArmorWindow() {
    const ev = this.ch.cur?.meta?.events;
    if (!ev || this.state !== "action") return null;
    const t = this.ch.clipTime;
    for (let i = 0; i < ev.length; i++) if (ev[i].type === "superArmor" && t >= ev[i].start && t < ev[i].end) return { e: ev[i], i };
    return null;
  }

  saValue(e) { return this.game.boss.d.poise.superArmorLevels[String(e.level)]?.value ?? 0; }

  dirKey(attacker) {
    const v = _tmp.subVectors(attacker.ch.position, this.ch.position);
    const rel = wrapAngle(Math.atan2(v.x, v.z) - this.ch.yaw), a = Math.abs(rel);
    return a <= Math.PI / 4 ? "f" : a >= 3 * Math.PI / 4 ? "b" : rel > 0 ? "l" : "r";
  }

  react(stiff, attacker) {
    if (stiff <= 0) return;
    const byLv = this.act.hitByStiffLevel;
    const levels = Object.keys(byLv).map(Number).sort((x, y) => x - y);
    const lv = byLv[String(stiff)] ? stiff : levels.filter((l) => l <= stiff).pop() ?? levels[0];
    const list = byLv[String(lv)];
    const d = this.dirKey(attacker);
    const match = list.filter((c) => c.includes(`_d${d}_`));
    const pool = match.length ? match : list;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    this.sprinting = false; this.vel.set(0, 0, 0);
    this.game.debugLog({ ev: "playerReact", stiff, clip });
    this.playAction(lv >= 8 ? "knockdown" : "hit", clip, { fade: 0.05 });
  }

  applySlowTime() { this.game.debugLog({ ev: "playerSlowTime" }); }

  applyDamageDirect(n) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - n);
    if (this.hp <= 0) this.die(1, this.opponent);
  }

  die(stiff, attacker) {
    this.lockOn = false; this.sprinting = false; this.vel.set(0, 0, 0);
    const D = this.act.die;
    const clip = stiff >= 8 ? D.knockdown : stiff >= 3 ? D.heavy : this.dirKey(attacker) === "b" ? D.B : D.F;
    this.state = "dead"; this.action = null;
    this.ch.play(clip, { fade: 0.1, loop: false });
    this.game.debugLog({ ev: "playerDeath", clip });
    this.opponent.onKilledPlayer?.();
    this.game.onPlayerDefeated();
  }
}

/** comboWindow whitelist / blacklist test for the next skill id */
function allowed(cw, skill) {
  if (cw.whitelist?.length) return cw.whitelist.map(String).includes(String(skill));
  if (cw.blacklist?.length) return !cw.blacklist.map(String).includes(String(skill));
  return true;
}

/** focus gain for a landed hit window: single entry -> every window; several -> matched by the effect id's last
 * digit (q4: 1080491 (+3) <-> 1080401/1080411, 1080492 (+13) <-> 1080402) [INFERENCE, CombatData] */
function focusGainFor(spec, dmgId) {
  const g = spec.focusGain || [];
  if (!g.length) return 0;
  if (g.length === 1) return g[0].value;
  const d = String(dmgId).slice(-1);
  return g.find((x) => String(x.effect).slice(-1) === d)?.value ?? 0;
}

function curveAt(pts, x) {
  if (!pts?.length) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return pts[pts.length - 1][1];
}
