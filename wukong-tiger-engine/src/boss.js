// 虎先锋 (HFM_Hu_Stone_01): AI = data/tiger.json ai (behaviour tree + combo nodes + EQS wander + CBG rules), skills
// cast as montages with root motion, poise/super-armor/stone-guard hit rules, death.
import * as THREE from "three";
import { wrapAngle, targetMoveScale } from "./character.js";
import { HitTracker, hurtCapsule, blockMove } from "./combat.js";
import { computeDamage } from "./damage.js";
import { LocoMatcher } from "./locomotion.js";

const DEG = Math.PI / 180;
const _dv = new THREE.Vector4(), _mv = new THREE.Vector3(), _to = new THREE.Vector3();
const randRange = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const cmp = (op, a, b) => op === "<=" ? a <= b : op === "<" ? a < b : op === ">=" ? a >= b : op === ">" ? a > b : op === "==" ? a === b : false;

// tiger idle + locomotion takes (TigerAssets): free-run MMF + lock/strafe MMS mocap takes
const IDLE = "AS_HFM_Hu_Stone_Bstd_01";
const LOCO_FREE = ["Hu_stone_01_MMF_shexing", "Hu_stone_01_MMF_yuan", "Hu_stone_01_MMF_yuannishizheng", "Hu_stone_01_MMF_zhefanpao", "Hu_stone_01_MMF_zhefanpaoting"];
const LOCO_LOCK = ["Hu_stone_01_MMS_lingxing", "Hu_stone_01_MMS_mizi", "Hu_stone_01_MMS_shexing", "Hu_stone_01_MMS_yuan", "Hu_stone_01_MMS_zhengfangxing"];

const BUFF_STONE = "202202";         // ImmueDamage + BounceAttack (铜头铁臂)
const STONE_STATELIB = ["2022061", "202220"];
const BUFF_INVISIBLE = "202212";     // WindWalk: hidden + pass-through
const BUFF_CANT_LOCK = "202203";

export class Boss {
  constructor(game, ch, ctl, data) {
    this.game = game; this.ch = ch; this.ctl = ctl; this.d = data;
    this.stats = data.stats;
    this.maxHp = data.stats.hp;
    this.maxPoise = 0; // the tiger has no stagger bar; poise = montage super-armor windows
    this.isPlayer = false;
    this.skills = data.skills;
    this.effects = data.effects;
    this.hitter = new HitTracker(ch, 0.5);
    this.cap = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 };
    this.aiEnabled = true;
    this.opponent = null;
    this.locoFree = new LocoMatcher(ch, LOCO_FREE);
    this.locoLock = new LocoMatcher(ch, LOCO_LOCK);
    ch.moveScaleRate = (e) => this.moveScaleRate(e);
    // combo nodes by id, tree root
    this.tree = data.ai.behaviorTree;
  }

  get capsule() { return this.ch.anims.capsule; }
  get alive() { return this.hp > 0; }
  get hpPct() { return 100 * this.hp / this.maxHp; }
  /** current AI target: the 聚形散气 decoy while it lives (FPhantomRushServantInstance taunt), else the player */
  get foe() { return this.decoy?.alive ? this.decoy : this.opponent; }

  reset(pos, yaw) {
    this.ch.position.copy(pos);
    this.ch.setYaw(yaw);
    this.ctl.vy = 0; this.ctl.noGravity = false;
    this.hp = this.maxHp; this.poise = 0;
    this.state = "idle"; this.skill = null; this.prevSkill = null;
    this.fsm = "BATTLE_ATTACK"; this.comboBudget = 0;
    const w = this.d.ai.initialWatchTime || [0, 0];
    this.watchTime = randRange(w[0], w[1]);
    this.watchTick = 0; this.watchNext = 1;
    this.cooldowns = new Map(); this.lastCast = new Map();
    this.battleTime = 0; this.aware = false;
    this.buffs = new Map(); // persistent buffs (CBG addBuff / AddBuff effects): id -> remaining seconds (Infinity)
    this.cbgCooldown = new Map();
    this.armor = new Map(); // super-armor window index -> remaining armor
    this.task = null; this.path = null;
    this.moveVel = new THREE.Vector3();
    this.phase = null;
    this.timeScale = 1;
    this.immobilized = null; // 定身 state (spells.js): {remain, hp, dmgDefAdd, onHit(dmg, stiff, attacker) -> "break"?}
    this.decoy = null;       // 聚形散气 decoy (spells.js)
    this.locoFree.reset(); this.locoLock.reset();
    this.hitter.reset();
    this.ch.model.visible = true;
    this.ch.play(IDLE, { loop: true, fade: 0, rootMotion: false });
    this.updatePhase();
  }

  lockPoint() {
    const b = this.ch.bonePos(this.ch.anims.bones?.cameraLock || "CAMERA_LOCK");
    return b || this.ch.position.clone().setY(this.ch.position.y + (this.ch.anims.height || 2) * 0.6);
  }
  canBeLocked() { return this.alive && !this.hasBuff(BUFF_CANT_LOCK) && !this.hasBuff(BUFF_INVISIBLE); }

  // ------------------------------------------------------------------ helpers
  relation() {
    _to.subVectors(this.foe.ch.position, this.ch.position);
    const dist = Math.hypot(_to.x, _to.z);
    const yawTo = Math.atan2(_to.x, _to.z);
    const rel = wrapAngle(yawTo - this.ch.yaw); // + = towards +X = the tiger's left
    return { dist, angle: -rel / DEG, yawTo, dz: _to.y };
  }

  turnTowards(yawTo, degPerSec, dt) {
    const diff = wrapAngle(yawTo - this.ch.yaw), step = degPerSec * DEG * dt;
    this.ch.setYaw(this.ch.yaw + (Math.abs(diff) <= step ? diff : Math.sign(diff) * step));
  }

  hasBuff(id) {
    const k = String(id);
    if (this.buffs.has(k)) return true;
    return this.ch.activeEvents("buff").some((e) => String(e.buffId) === k);
  }

  addBuff(id, seconds) {
    const b = this.d.buffs[String(id)];
    const dur = seconds ?? b?.duration ?? Infinity;
    this.buffs.set(String(id), dur == null ? Infinity : dur);
  }

  onCooldown(id) { return (this.cooldowns.get(String(id)) ?? 0) > 0; }

  updatePhase() {
    const hp = this.hpPct;
    let cur = null;
    for (const p of this.d.phases) {
      if (p.hpPctAbove != null && hp > p.hpPctAbove) cur = p;
      if (p.hpPctAtMost != null && hp <= p.hpPctAtMost) cur = p;
    }
    if (cur && cur.id !== this.phase) { this.phase = cur.id; this.game.debugLog({ ev: "phase", phase: cur.id }); }
  }

  /** BANS_GSCalcAMScale for the tiger (target = player, surface distance) */
  moveScaleRate(e) {
    const t = this.foe;
    if (!t) return 1;
    const p = t.ch.position, q = this.ch.position, f = this.ch.forward();
    const surface = (p.x - q.x) * f.x + (p.z - q.z) * f.z - this.capsule.radius - t.capsule.radius;
    return targetMoveScale(this.ch, e, this.state === "skill" ? surface : null, this.skill?.data?.moveScaleClamp);
  }

  // ------------------------------------------------------------------ casting
  /** plays skill `id` (montage). section: name or null (= first section) */
  cast(id, section = null, source = "BT") {
    const s = this.skills[String(id)];
    if (!s || !this.ch.has(s.clip)) { this.game.debugLog({ ev: "castMissing", id, clip: s?.clip }); return false; }
    const meta = this.ch.meta(s.clip);
    const sec = section && meta?.sections?.some((x) => x.name === section) ? section : null;
    this.prevSkill = this.skill ? this.skill.id : this.prevSkill;
    this.skill = { id: String(id), data: s, clip: s.clip, section: sec, source };
    this.cooldowns.set(String(id), s.cooldown ?? 0);
    for (const sid of s.sharedCooldown || []) this.cooldowns.set(String(sid), this.skills[String(sid)]?.cooldown ?? 0);
    this.lastCast.set(String(id), this.battleTime);
    this.state = "skill";
    this.armor.clear();
    this.hitter.reset();
    this.locoFree.reset(); this.locoLock.reset();
    this.ch.play(s.clip, { fade: 0.15, loop: false, section: sec, onEnd: () => this.onSkillEnd(id) });
    this.game.debugLog({ ev: "bossSkill", id: String(id), clip: s.clip, section: sec, source, phase: this.phase });
    this.game.hazards?.onSkillStart(this);
    return true;
  }

  onSkillEnd(id) {
    if (this.state !== "skill" || this.skill?.id !== String(id)) return;
    this.state = "idle";
    this.prevSkill = this.skill.id;
    this.skill = null;
    this.ch.play(IDLE, { loop: true, fade: 0.3, rootMotion: false });
  }

  // ------------------------------------------------------------------ frame
  update(dt, active) {
    const ch = this.ch;
    dt *= this.timeScale;
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, v - dt);
    for (const [k, v] of this.buffs) { if (v !== Infinity) { if (v - dt <= 0) this.buffs.delete(k); else this.buffs.set(k, v - dt); } }
    if (this.immobilized) {
      // 定身 (BUS_BeImmobilizedComp): montage time, movement, BT/FSM and hit windows paused; CBG keeps polling
      this.moveVel.set(0, 0, 0);
      if (active && this.alive && this.aware && this.aiEnabled && this.opponent.alive) this.runCbg(dt);
      ch.update(0, _dv);
      this.ctl.move(ch.position, _mv.set(0, 0, 0), dt);
      return;
    }
    if (active && this.alive && this.aware) this.battleTime += dt;

    this.moveVel.set(0, 0, 0);
    if (active && this.alive && this.opponent.alive) {
      this.updatePhase();
      if (!this.aware) this.perceive();
      if (this.state === "skill") this.skillTick(dt);
      if (this.aiEnabled && this.aware) {
        this.serviceTick(dt);
        this.runCbg(dt);
        if (this.state !== "hit" && this.state !== "dead" && !this.skill?.reaction) this.btTick(dt);
      } else if (this.state === "move") this.idle();
    } else if (this.alive && this.state !== "skill" && this.state !== "hit") {
      if (ch.clipName !== IDLE) ch.play(IDLE, { loop: true, fade: 0.3, rootMotion: false });
    }

    ch.update(dt, _dv);
    _mv.set(_dv.x, 0, _dv.z); // tiger clips carry no vertical root motion (checked); gravity + ground snap own Y
    ch.setYaw(ch.yaw + _dv.w);
    _mv.addScaledVector(this.moveVel, dt);
    if (this.alive && this.opponent?.alive && !this.passThrough() && !this.opponent.windWalk) // 聚形散气 buff 118: WindWalk_Pawn
      blockMove(ch.position, _mv, this.opponent.ch.position, this.capsule.radius + this.opponent.capsule.radius);
    this.ctl.move(ch.position, _mv, dt);
    // invisibility (化石遁形 hidden phase); with stone.js loaded the montage material notifies fade the body instead
    if (!this.game.stoneFx?.ownsTigerVisibility) ch.model.visible = !this.hasBuff(BUFF_INVISIBLE);
    // trigger effects placed on the montage timeline
    if (this.state === "skill") for (const e of ch.crossed("effect")) this.triggerEffect(e.effectId);
  }

  /** FUStUnitAIDesc perception: battle starts when the player is seen (sight m within ±visionAngle°) or heard */
  perceive() {
    const P = this.stats.perception, rel = this.relation();
    if (rel.dist <= P.hear || (rel.dist <= P.sight && Math.abs(rel.angle) <= P.visionAngle)) this.becomeAware("perception");
  }

  becomeAware(why) {
    if (this.aware) return;
    this.aware = true;
    this.battleTime = 0;
    this.game.debugLog({ ev: "aware", why });
  }

  /** BANS_GSCloseHitMove / collision-profile windows / WindWalk buff: no pawn collision with the player */
  passThrough() {
    return this.ch.inEvent("noHitMove") || this.ch.inEvent("collision") || this.hasBuff(BUFF_INVISIBLE);
  }

  /** watchTimeTick service (interval ± deviation) */
  serviceTick(dt) {
    this.watchTick += dt;
    if (this.watchTick >= this.watchNext) {
      this.watchTime -= this.watchTick;
      this.watchTick = 0;
      const svc = findService(this.tree, "watchTimeTick") || { interval: 1, randomDeviation: 0 };
      this.watchNext = svc.interval + randRange(-svc.randomDeviation, svc.randomDeviation);
    }
  }

  skillTick(dt) {
    const rel = this.relation();
    // BANS_GSAttackRotation windows: turn toward the target at the window speed
    for (const e of this.ch.activeEvents("rotate")) { this.turnTowards(rel.yawTo, e.speed ?? 0, dt); break; }
    // jumpSectionIfBuff
    for (const e of this.ch.activeEvents("jumpSectionIfBuff")) {
      if (this.hasBuff(e.buffId) && this.ch.cur.sections?.[this.ch.cur.secIdx]?.name !== e.section) {
        this.ch.jumpToSection(e.section);
        this.game.debugLog({ ev: "jumpSection", section: e.section, buff: e.buffId });
        break;
      }
    }
  }

  // ------------------------------------------------------------------ behaviour tree
  decoratorPass(dec) {
    let ok;
    switch (dec.type) {
      case "fsmState": ok = this.fsm === dec.state || this.fsm.startsWith(dec.state + "_"); break;
      case "hpPctAtMost": ok = this.hpPct <= dec.value; break;
      case "distanceAtMost": ok = this.relation().dist <= dec.value; break;
      case "distanceAtLeast": ok = this.relation().dist >= dec.value; break;
      case "comboBudgetAtMost": ok = this.comboBudget <= dec.value; break;
      case "watchTimeRemaining": ok = this.watchTime > 0; break;
      default: console.warn("unknown decorator", dec.type); ok = true;
    }
    return dec.invert ? !ok : ok;
  }
  nodePass(n) { return (n.decorators || []).every((d) => this.decoratorPass(d)); }

  btTick(dt) {
    if (this.task) {
      if (this.checkAborts()) this.abortTask();
      else {
        const r = this.task.update(dt);
        if (r === "running") return;
        this.finishTask(r);
        return;
      }
    }
    const path = [];
    const r = this.exec(this.tree, path);
    if (r === "running") this.path = path;
  }

  exec(node, path) {
    if (!this.nodePass(node)) return "failure";
    switch (node.type) {
      case "selector":
      case "sequence": return this.runChildren(node, 0, path);
      case "enterAttack":
        this.comboBudget = randInt(node.comboBudget[0], node.comboBudget[1]);
        this.fsm = "BATTLE_ATTACK";
        this.game.debugLog({ ev: "enterAttack", budget: this.comboBudget });
        return "success";
      case "enterWander":
        this.watchTime = randRange(node.watchTime[0], node.watchTime[1]);
        this.fsm = "BATTLE_WANDER";
        this.game.debugLog({ ev: "enterWander", watch: +this.watchTime.toFixed(2) });
        return "success";
      case "combo": return this.startTask(new ComboTask(this, node), node, path);
      case "eqsMove": return this.startTask(new EqsMoveTask(this, node), node, path);
      default: console.warn("unknown BT node", node.type); return "failure";
    }
  }

  runChildren(node, from, path) {
    const kids = node.children || [];
    for (let i = from; i < kids.length; i++) {
      path.push({ node, i });
      const r = this.exec(kids[i], path);
      if (r === "running") return r;
      path.pop();
      if (node.type === "selector" && r === "success") return "success";
      if (node.type === "sequence" && r === "failure") return "failure";
    }
    return node.type === "selector" ? "failure" : "success";
  }

  startTask(task, node, path) {
    const r = task.start();
    if (r !== "running") return r;
    this.task = task; this.taskNode = node;
    return "running";
  }

  /** UE-style observer aborts: Self/Both on the running branch, LowerPriority/Both on higher-priority siblings */
  checkAborts() {
    const chain = [...this.path.map((p) => p.node), this.taskNode];
    for (const n of chain) {
      for (const d of n.decorators || []) if ((d.abort === "Self" || d.abort === "Both") && !this.decoratorPass(d)) return true;
    }
    for (const { node, i } of this.path) {
      if (node.type !== "selector") continue;
      for (let j = 0; j < i; j++) {
        const sib = node.children[j];
        const decs = sib.decorators || [];
        if (decs.some((d) => d.abort === "LowerPriority" || d.abort === "Both") && decs.every((d) => this.decoratorPass(d))) return true;
      }
    }
    return false;
  }

  abortTask() {
    this.game.debugLog({ ev: "btAbort", node: this.taskNode.id });
    this.task.abort();
    this.finishTask("failure", true);
  }

  /** propagate a finished latent task result up the stored path (continuing sequences/selectors) */
  finishTask(result, aborted = false) {
    this.task = null;
    const path = this.path || [];
    this.path = null;
    if (aborted) return;
    let r = result;
    while (path.length) {
      const { node, i } = path.pop();
      if ((node.type === "sequence" && r === "success") || (node.type === "selector" && r === "failure")) {
        const res = this.runChildren(node, i + 1, path); // pushes/pops its own entries above the ancestors
        if (res === "running") { this.path = path; return; }
        r = res;
      }
    }
  }

  // ------------------------------------------------------------------ locomotion used by tasks
  /** move with velocity (world) at speed; facing: "move" (turn toward travel) or "target" (keep facing player) */
  locomote(dir, speed, facing, dt) {
    const rel = this.relation();
    if (facing === "target") this.turnTowards(rel.yawTo, this.stats.turnSpeed, dt);
    else if (speed > 0) this.turnTowards(Math.atan2(dir.x, dir.z), this.stats.turnSpeed, dt);
    this.moveVel.copy(dir).setY(0).normalize().multiplyScalar(speed);
    // desired velocity in the tiger's root frame (+Z forward, +X left)
    const local = this.moveVel.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -this.ch.yaw);
    const m = facing === "target" ? this.locoLock : this.locoFree;
    if (speed <= 0.05 || !m.update(dt, local.x, local.z)) this.idle();
    this.state = speed > 0.05 ? "move" : "idle";
  }

  idle() {
    this.moveVel.set(0, 0, 0);
    if (this.ch.clipName !== IDLE) { this.ch.play(IDLE, { loop: true, fade: 0.35, rootMotion: false }); this.locoFree.reset(); this.locoLock.reset(); }
    if (this.state === "move") this.state = "idle";
  }

  runSpeed(kind) {
    const ms = this.stats.moveSpeed;
    if (kind === "RUN") return ms.fast * this.stats.aiRunSpeedRate;
    return ms[kind?.toLowerCase?.()] ?? ms.normal;
  }

  // ------------------------------------------------------------------ CBG
  runCbg(dt) {
    const cbg = this.d.ai.cbg;
    for (const [k, v] of this.cbgCooldown) this.cbgCooldown.set(k, v - dt);
    const tags = this.state === "skill" ? this.ch.crossed("behavior").map((e) => e.tag) : [];
    for (const rule of cbg.rules) {
      const t = rule.trigger;
      if (t.type === "montageTag") {
        if (tags.includes(t.tag)) { this.game.debugLog({ ev: "cbgTag", tag: t.tag, node: rule.node }); this.cbgAction(rule.action); }
      } else if (t.type === "poll") {
        if ((this.cbgCooldown.get(rule.node) ?? 0) > 0) continue;
        if (this.cbgConds(t)) { this.cbgCooldown.set(rule.node, t.cooldown ?? 0); this.cbgAction(rule.action); }
      }
    }
  }

  onKilledPlayer() {
    for (const rule of this.d.ai.cbg.rules) if (rule.trigger.type === "killedPlayer") this.cbgAction(rule.action);
  }

  cbgConds(n) {
    const conds = n.conditions || [];
    const unit = n.unit === "player" ? "player" : "self";
    const test = (c) => {
      let ok;
      switch (c.type) {
        case "hasBuff": ok = unit === "self" ? this.hasBuff(c.buff) : this.opponent.hasBuff?.(c.buff) ?? false; break;
        case "simpleState": ok = c.state === "Immobilizing" ? !!this.immobilized : c.state === "Frozen" ? !!this.frozen : false; break;
        case "castingSkill": ok = c.skills.map(String).includes(String(unit === "self" ? (this.state === "skill" ? this.skill?.id : null) : this.opponent.currentSkillId?.())); break;
        case "hpPct": ok = cmp(c.op, this.hpPct, c.value); break;
        case "distance": ok = cmp(c.op, this.relation().dist, c.value); break;
        case "skillOnCooldown": ok = this.onCooldown(c.skill); break;
        default: console.warn("unknown CBG condition", c.type); ok = false;
      }
      return c.not ? !ok : ok;
    };
    return n.match === "any" ? conds.some(test) : conds.every(test);
  }

  cbgAction(a) {
    if (!a) return;
    switch (a.do) {
      case "cast": {
        const s = this.skills[String(a.skill)];
        if (!s) { this.game.debugLog({ ev: "cbgCastMissing", skill: a.skill }); return; }
        this.cast(a.skill, a.section ?? null, "CBG");
        return;
      }
      case "if": return this.cbgAction(this.cbgConds(a) ? a.then : a.else);
      case "random": return this.cbgAction(Math.random() < a.chance ? a.then : a.else);
      case "sequence": for (const s of a.steps) this.cbgAction(s); return;
      case "addBuff": this.addBuff(a.buff); return;
      case "removeBuff": this.buffs.delete(String(a.buff)); return;
      case "triggerEffect": this.triggerEffect(a.effect); return;
      case "voiceLine": this.game.debugLog({ ev: "voiceLine", ids: a.ids }); return;
      default: console.warn("unknown CBG action", a.do);
    }
  }

  /** non-damage skill effects triggered by montage timelines / CBG */
  triggerEffect(id) {
    this.game.audio?.effect(id); // SetBgmState rows (20229990: BGM lv2) are not in tiger.json effects
    const e = this.effects[String(id)];
    if (!e) return;
    switch (e.type) {
      case "Teleport": this.teleportFront(); break;
      case "AddBuff": this.addBuff(e.int[0], e.float?.[0] != null ? e.float[0] / 1000 : undefined); break;
      case "SwitchBullet": this.game.hazards?.switchBullets(e.int[3], e.int[0]); break;
      case "SummonUnit": this.game.stoneFx?.summon(this, e); break; // 20229999: stone decoy (FUStSummonCommDesc 20220201)
      default: this.game.debugLog({ ev: "effect", id: String(id), type: e.type }); // BGM/state-lib/summon: logged only
    }
  }

  /** effect 20229890 Teleport: EQ_TeleportSkillPointBwd_Hu_Stone_Front = 24 points on a 15 m circle around the
   * player, score = dot2D(camera forward, camera->point) -> reappear in front of the camera */
  teleportFront() {
    const cam = this.game.r.camera, p = this.opponent.ch.position;
    const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      const q = new THREE.Vector3(p.x + Math.cos(a) * 15, p.y, p.z + Math.sin(a) * 15);
      const pa = this.game.world;
      if (Math.hypot(q.x - pa.playCenter.x, q.z - pa.playCenter.z) > pa.playRadius - this.capsule.radius) continue;
      const g = pa.groundAt(q.x, q.z, p.y + 8, 30);
      if (!g) continue;
      q.y = g.point.y;
      const d = new THREE.Vector3(q.x - cam.position.x, 0, q.z - cam.position.z).normalize();
      const s = fwd.dot(d);
      if (s > bestS) { bestS = s; best = q; }
    }
    if (!best) return;
    this.ch.position.copy(best);
    const v = _to.subVectors(p, best);
    this.ch.setYaw(Math.atan2(v.x, v.z));
    this.game.debugLog({ ev: "teleport", pos: best.toArray().map((x) => +x.toFixed(2)) });
  }

  // ------------------------------------------------------------------ combat
  resolveHits() {
    if (!this.alive || this.state !== "skill" || !this.opponent.alive || this.immobilized) return;
    for (const p of this.decoy?.alive ? [this.opponent, this.decoy] : [this.opponent]) {
      const hits = this.hitter.test(hurtCapsule(p.ch, p.capsule, p.cap), p.isDecoy ? "decoy" : "player");
      for (const h of hits) {
        const effs = (h.event.effectIds || h.event.effects || [h.event.id]).map((id) => [id, this.effects[String(id)]]);
        for (const [id, e] of effs) {
          if (!e) continue;
          if (e.type === "damage") { if (p.receiveHit(this, e, h.point, { effectId: id }) > 0) { this.game.vfx?.hit("tiger", h.point); this.game.audio?.hit(this, p, h); } }
          else if (e.type === "TimeScale") p.applySlowTime?.(this);
          else if (e.type === "AddBuff") this.game.debugLog({ ev: "playerBuff", buff: e.int?.[0] });
        }
      }
    }
  }

  /** current super-armor window (montage BANS_GSSetSkillSuperArmor) or null */
  armorWindow() {
    const ev = this.ch.cur?.meta?.events;
    if (!ev || this.state !== "skill") return null;
    const t = this.ch.clipTime;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === "superArmor" && t >= e.start && t < e.end) return { e, i };
    }
    return null;
  }

  stiffConfig() { return STONE_STATELIB.some((b) => this.hasBuff(b)) ? "stone" : "normal"; }

  /** player -> tiger. e = damage effect, info {kind, skill}. Returns {damage, bounced} */
  receiveHit(attacker, e, point, info = {}) {
    if (!this.alive) return null;
    this.becomeAware("hit");
    this.watchTime = this.d.ai.hitResetsWatchTime ? 0 : this.watchTime;
    const stiff = (e.hitWeight ?? 0) - (this.stats.tenacity ?? 0);
    // 铜头铁臂: ImmueDamage + BounceAttack
    if (this.hasBuff(BUFF_STONE)) {
      this.game.hud.toast("铜头铁臂", 0.7);
      this.game.debugLog({ ev: "bounce", skill: info.skill, stiff });
      this.game.vfx?.burst("hit_stone", point); // FUStBeAttackedDispInfoDesc 25: HitItemFXType Stone
      this.react(stiff, attacker, "stone");
      return { damage: 0, bounced: true };
    }
    // 定身 begin buffs (脆断 1024 / 精准定身 1027: DmgDefBase) lower the victim's damage reduction while frozen
    const im = this.immobilized;
    const victim = im?.dmgDefAdd ? { stats: { ...this.stats, dmgDef: (this.stats.dmgDef ?? 0) + im.dmgDefAdd }, maxHp: this.maxHp, isPlayer: false } : this;
    const res = computeDamage(this.game.damageModel, attacker.stats, victim, e);
    this.hp = Math.max(0, this.hp - res.damage);
    this.game.hud.damage(this.game.r.camera, point || this.lockPoint(), res.damage, res.crit ? "crit" : "");
    this.game.debugLog({ ev: "bossHit", dmg: res.damage, crit: res.crit, hp: this.hp, effect: info.effectId, clip: attacker.ch.clipName, immobilized: !!im });
    const out = { damage: res.damage, crit: res.crit };
    if (this.hp <= 0) { this.die(stiff, attacker); return out; }
    // ImmobilizedHit: no reaction while frozen; ImmobilizedBreak plays a stiff reaction (BUS_BeAttackedComp)
    if (im) { if (im.onHit(res.damage, stiff, attacker) === "break") this.breakImmobilized(stiff, attacker, im); return out; }
    // super armor window: armor -= armorBreak; reaction only once broken
    const w = this.armorWindow();
    if (w) {
      if (!this.armor.has(w.i)) this.armor.set(w.i, this.d.poise.superArmorLevels[String(w.e.level)]?.value ?? 0);
      const left = this.armor.get(w.i);
      if (left > 0) {
        const now = left - (e.armorBreak ?? 0);
        this.armor.set(w.i, now);
        if (now > 0 || !(e.armorBreak > 0)) return out;
        this.game.debugLog({ ev: "superArmorBroken", level: w.e.level });
        return out; // no break montage: the running skill continues (poise.rules[1])
      }
    }
    this.react(stiff, attacker, this.stiffConfig());
    return out;
  }

  applyDamageDirect(n, attacker) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - n);
    if (this.hp <= 0) this.die(1, attacker || this.opponent);
  }

  sectorClip(levelCfg, attacker) {
    const v = _to.subVectors(attacker.ch.position, this.ch.position);
    const rel = wrapAngle(Math.atan2(v.x, v.z) - this.ch.yaw); // + = attacker on the tiger's left
    const c = levelCfg.clips;
    let key = "F";
    if (levelCfg.sectors === "FourDir") {
      const a = Math.abs(rel);
      key = a <= Math.PI / 4 ? "F" : a >= 3 * Math.PI / 4 ? "B" : rel > 0 ? "L" : "R";
    } else if (levelCfg.sectors === "ForwardAndBackward") key = Math.abs(rel) <= Math.PI / 2 ? "F" : "B";
    if (levelCfg.rotateToAttacker) this.ch.setYaw(Math.atan2(v.x, v.z));
    return c[key] || c.F || Object.values(c)[0];
  }

  react(stiff, attacker, config) {
    const lv = this.d.poise.hitReactions[config]?.levels?.[String(stiff)];
    if (!lv) return; // only listed stiff levels play an animation
    const clip = this.sectorClip(lv, attacker);
    if (!clip || !this.ch.has(clip)) return;
    if (this.task) this.abortTask(); // interrupted combo: budget handled by ComboTask.abort
    this.state = "hit"; this.skill = null;
    this.armor.clear();
    this.hitter.reset();
    this.game.debugLog({ ev: "bossReact", clip, stiff, config });
    // hit-reaction montages can carry their own hit windows/effects (stone counter punch)
    this.skill = { id: "react", data: {}, clip, reaction: true, stiff };
    this.state = "skill";
    this.ch.play(clip, { fade: 0.08, loop: false, onEnd: () => this.onSkillEnd("react") });
  }

  /** ImmobilizedBreak (BUS_BeAttackedComp.SolveBreakImmobilized): relieve, then the hit's stiff reaction, or the lowest
   * listed stiff level when that level has none; no montage under DisableImmobilizedBreakAnim (buff 204) */
  breakImmobilized(stiff, attacker, im) {
    im.relieve("break");
    if (im.noBreakAnim) return;
    const config = this.stiffConfig(), lv = this.d.poise.hitReactions[config]?.levels || {};
    const s = lv[String(stiff)] ? stiff : Math.min(...Object.keys(lv).map(Number));
    if (Number.isFinite(s)) this.react(s, attacker, config);
  }

  die(stiff, attacker) {
    if (this.task) { this.task.abort(); this.task = null; this.path = null; }
    this.immobilized?.relieve("dead"); // OnDeadWhenInImmobilized: DeadEffects + relieve
    const D = this.d.poise.death;
    const lv = D.levels[String(stiff)] || D.levels[String(Math.min(...Object.keys(D.levels).map(Number)))];
    const clip = this.sectorClip(lv, attacker);
    this.state = "dead"; this.skill = null;
    this.ch.play(clip, { fade: 0.15, loop: false, rootMotion: true });
    this.game.debugLog({ ev: "bossDeath", clip });
    this.game.hud.toast("虎先锋　伏诛", 2.5);
    this.game.onBossDefeated();
  }

  forceSkill(id) { return this.cast(id, null, "debug"); }
}

function findService(node, type) {
  for (const s of node.services || []) if (s.type === type) return s;
  for (const c of node.children || []) { const r = findService(c, type); if (r) return r; }
  return null;
}

/** angle (deg, + = target on the tiger's right) -> angleScores sector index */
function sectorOf(a) {
  if (a >= 0) return Math.min(3, Math.floor(a / 45));
  return 4 + Math.min(3, Math.floor((a + 180) / 45));
}

/**
 * BUS_AINodeComp.ComboAction (data ai.model[2..5]).
 */
class ComboTask {
  constructor(boss, node) { this.b = boss; this.n = node; }

  start() {
    const b = this.b, n = this.n;
    this.length = Math.min(weightedLength(n.lengthWeights), n.stages.length);
    this.stage = 0; this.casted = new Set(); this.prev = null; this.done = false;
    this.attemptedWindow = null; this.ending = false; this.turned = false; this.retry = 0; this.chasing = false;
    const stage0 = n.stages[0].filter((id) => b.skills[String(id)]?.ai);
    if (b.state === "skill" || stage0.every((id) => b.onCooldown(id))) { this.exit(); return "success"; }
    b.game.debugLog({ ev: "combo", node: n.id, length: this.length });
    return "running";
  }

  exit() { if (!this.exited) { this.exited = true; this.b.comboBudget -= 1; } }
  abort() { if (this.n.interruptReducesBudget !== false) this.exit(); }

  candidates(stage) {
    const b = this.b, rel = b.relation();
    const ids = [...new Set(this.n.stages[stage] || [])].map(String);
    const first = stage === 0 || !this.prev;
    const prevAi = this.prev ? b.skills[this.prev]?.ai : null;
    const out = [];
    for (const id of ids) {
      const s = b.skills[id];
      const ai = s?.ai;
      if (!ai || !b.ch.has(s.clip)) continue;
      if (b.onCooldown(id)) continue;
      if (b.battleTime < (s.preCooldown ?? 0)) continue;
      if (rel.dist < ai.rangeMin || rel.dist > ai.rangeMax) continue;
      if (Math.abs(rel.dz) > ai.heightMax) continue;
      const sec = sectorOf(rel.angle);
      if (!ai.angleScores[sec]) continue;
      if (this.casted.has(id)) continue;
      // score (ai.model[3])
      const sc = b.d.ai.scoreConfig;
      let score = ai.angleScores[sec];
      const last = b.lastCast.get(id);
      score += last == null ? ai.cooldownScoreMax : Math.min((b.battleTime - last) * ai.cooldownScorePerSec, ai.cooldownScoreMax);
      if (!ai.next?.length) score += stage === this.length - 1 ? sc.endSkillAddition : sc.endSkillSubtraction;
      if (first) score += sc.firstSkillRealComboAddition * (this.length - sc.firstSkillRealComboSkillReduceNum);
      else if (prevAi?.next?.map(String).includes(id)) score += sc.realComboAddition * stage;
      else if (Object.values(b.skills).some((o) => o.ai?.next?.map(String).includes(id))) score += sc.otherComboSkillSubtraction * stage;
      if (rel.dist >= ai.optimalMin && rel.dist <= ai.optimalMax) score += ai.optimalScore;
      out.push({ id, score });
    }
    return out;
  }

  pick(stage) {
    const c = this.candidates(stage);
    if (!c.length) return null;
    c.sort((x, y) => y.score - x.score);
    const top = Math.max(1, Math.floor(c.length * this.n.topRandomPercent / 100));
    const p = c[Math.floor(Math.random() * top)].id;
    if (stage > 0 && this.prev) {
      const nx = this.b.skills[this.prev]?.ai?.next?.map(String) || [];
      if (!nx.includes(p)) return null; // follow-up only along prev.ai.next
    }
    return p;
  }

  castStage(id, section) {
    this.b.cast(id, section, this.n.id);
    this.casted.add(String(id)); this.prev = String(id); this.stage++;
    this.attemptedWindow = null; this.chasing = false;
  }

  update(dt) {
    const b = this.b;
    if (b.state === "hit" || b.state === "dead") { this.exit(); return "success"; }
    if (b.state === "skill") {
      // a CBG force-cast replaced the montage: it becomes the previous skill for the combo relation
      if (b.skill && b.skill.id !== this.prev && b.skill.id !== "react") { this.prev = b.skill.id; this.casted.add(b.skill.id); }
      if (this.ending || this.stage >= this.length) return "running";
      const cw = b.ch.activeEvents("comboWindow")[0];
      if (cw && this.attemptedWindow !== cw) {
        this.attemptedWindow = cw; // one attempt per window
        const p = this.pick(this.stage);
        if (p) this.castStage(p, "ing");
        else if (this.n.forceComboRelation && b.skills[this.prev]?.ai?.next?.length) this.ending = true;
      }
      return "running";
    }
    // montage over
    if (this.ending || (this.stage > 0 && this.stage >= this.length)) { this.exit(); return "success"; }
    const p = this.pick(this.stage);
    if (p) { this.castStage(p, null); return "running"; }
    if (this.stage > 0) { this.exit(); return "success"; }
    // first stage, nothing castable: turn skill, then run toward the player
    const rel = b.relation();
    if (!this.turned && this.n.useTurnSkills && Math.abs(rel.angle) > this.n.beginRotateAngle) {
      const ts = b.d.ai.turnSkills;
      const small = Math.abs(rel.angle) <= ts.smallMaxAngle;
      const id = rel.angle < 0 ? (small ? ts.leftSmall : ts.leftBig) : (small ? ts.rightSmall : ts.rightBig);
      this.turned = true;
      if (!b.onCooldown(id) && b.cast(id, null, this.n.id + ":turn")) return "running";
    }
    // chase to r = largest skill rangeMax below the current distance; retry every 2 s and on arrival
    const ranges = this.n.stages[0].map((id) => b.skills[String(id)]?.ai?.rangeMax).filter((r) => r != null && r < rel.dist);
    const r = ranges.length ? Math.max(...ranges) : 0;
    this.retry -= dt;
    const arrived = rel.dist <= r + 0.05 || r === 0;
    if (arrived && this.chasing) { this.chasing = false; this.retry = 0; }
    if (!arrived) {
      this.chasing = true;
      const dir = new THREE.Vector3(Math.sin(rel.yawTo), 0, Math.cos(rel.yawTo));
      b.locomote(dir, b.runSpeed(this.n.moveSpeed), "move", dt);
    } else { b.idle(); b.turnTowards(rel.yawTo, b.stats.turnSpeed, dt); }
    if (this.retry <= 0) { this.retry = 2; this.turned = false; }
    return "running";
  }
}

function weightedLength(lw) {
  const total = lw.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of lw) { r -= x.weight; if (r <= 0) return x.length; }
  return lw[lw.length - 1].length;
}

/** eqsMove: EQ_Hu_Stone donut around the tiger, strafe to the best point keeping the player in view */
class EqsMoveTask {
  constructor(boss, node) { this.b = boss; this.n = node; }
  start() {
    const b = this.b, q = b.d.ai.eqs, g = q.generator;
    const P = b.ch.position, T = b.foe.ch.position, fwd = b.ch.forward();
    const pts = [];
    for (let ring = 0; ring < g.rings; ring++) {
      const rad = g.rings > 1 ? g.innerRadius + (g.outerRadius - g.innerRadius) * ring / (g.rings - 1) : g.innerRadius;
      for (let i = 0; i < g.pointsPerRing; i++) {
        const a = i / g.pointsPerRing * Math.PI * 2;
        const p = new THREE.Vector3(P.x + Math.cos(a) * rad, P.y, P.z + Math.sin(a) * rad);
        const w = b.game.world;
        if (Math.hypot(p.x - w.playCenter.x, p.z - w.playCenter.z) > w.playRadius - b.capsule.radius * 2) continue;
        const gr = w.groundAt(p.x, p.z, P.y + 6, 20);
        if (!gr) continue;
        p.y = gr.point.y;
        pts.push({ p, dq: Math.hypot(p.x - P.x, p.z - P.z), dp: Math.hypot(p.x - T.x, p.z - T.z),
          dot: fwd.dot(new THREE.Vector3(p.x - P.x, 0, p.z - P.z).normalize()) });
      }
    }
    if (!pts.length) return "failure";
    const norm = (k) => { const v = pts.map((x) => x[k]); const lo = Math.min(...v), hi = Math.max(...v); return (x) => hi > lo ? (x[k] - lo) / (hi - lo) : 1; };
    const nq = norm("dq"), np = norm("dp"), nd = norm("dot");
    let best = null, bs = -Infinity;
    for (const x of pts) {
      const s = (1 - nq(x)) + np(x) + 2 * nd(x); // InverseLinear(dist to tiger) + Linear(dist to player) + 2*dot
      if (s > bs) { bs = s; best = x.p; }
    }
    this.goal = best;
    this.accept = this.n.acceptRadius + 2 * b.capsule.radius;
    this.time = 0;
    b.game.debugLog({ ev: "eqsMove", goal: best.toArray().map((v) => +v.toFixed(1)) });
    return "running";
  }
  update(dt) {
    const b = this.b, P = b.ch.position;
    const d = new THREE.Vector3(this.goal.x - P.x, 0, this.goal.z - P.z);
    if (d.length() <= this.accept || b.state === "skill") { b.idle(); return "success"; }
    this.time += dt;
    if (this.time > 15) { b.idle(); return "failure"; } // unreachable point (blocked by geometry)
    b.locomote(d.normalize(), b.runSpeed("RUN"), "target", dt);
    return "running";
  }
  abort() { this.b.idle(); }
}
