// 定身法 (Immobilize, Digit1) and 聚形散气 (Cloud Step / PhantomRush, Digit2) for the Destined One.
// Data: assets/data/spells.json (extract/B1Data/build_spells.py, sources per field); clips: assets/player/spells.glb
// (animation-only bundle, merged on attach). Logic follows the decompiled GameDll: BUS_CastImmobilizeComp /
// BUS_BeImmobilizedComp / BUS_BeAttackedComp (freeze, duration formula, immobilize HP, break), BUS_SkillMappingComp
// (perfect-dodge 瞬机 mapping), BUS_PhantomRushComp / FPhantomRushServantInstance (decoy, taunt, exit rules).
// Shared hooks: boss.immobilized / boss.decoy / boss.foe (boss.js), player.windWalk (pawn collision off).
import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { wrapAngle } from "./character.js";
import { hurtCapsule } from "./combat.js";
import { computeDamage } from "./damage.js";

const DEG = Math.PI / 180;
const rand = (a, b) => a + Math.random() * (b - a);
const GOLD = [1.0, 0.74, 0.3];          // DBC_Dingshen_Loop material context colour is not parsed [INFERENCE]
const QI = [0.86, 0.89, 0.94];          // 化气 white smoke (M_SubUV_Fire_01_Inst2 Color = white)
const KIND = { immobilize: "spell:immobilize", cloud: "spell:cloud", strike: "spell:strike" };
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

function curveAt(pts, x) {
  if (!pts?.length) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return pts[pts.length - 1][1];
}

/** buff rows -> summed AddAttr value for an attribute name */
function attrSum(buffs, ids, attr) {
  let s = 0;
  for (const id of ids) for (const e of buffs[String(id)]?.effects || []) if (e.type === "AddAttr" && e.attr === attr) s += e.value;
  return s;
}

export function createSpells(game) { return new Spells(game); }

class Spells {
  constructor(game) {
    this.game = game;
    const F = game.assets.files;
    this.d = F.spellsData; this.I = this.d.immobilize; this.C = this.d.cloud;
    this.bundle = { gltf: F.spellsGlb, doc: F.spellsAnims };
    this.talent = (id) => this.d.talents[String(id)] ?? 0;
  }

  // ------------------------------------------------------------------ player module hooks
  attach(p) {
    this.p = p;
    this.game.spells = this;
    p.ch.addAnimations(this.bundle.gltf, this.bundle.doc);
    const hud = this.game.hud;
    hud.addSlot(KIND.immobilize, { key: "1", label: "定身", order: 10, code: "Digit1" });
    hud.addSlot(KIND.cloud, { key: "2", label: "聚形", order: 11, code: "Digit2" });
    this.setupVfx();
    this.warmUp();
    this.reset();
  }

  reset() {
    if (this.im) this.relieve(this.im, "reset", true);
    if (this.rush) this.exitRush("reset", true);
    this.cd = { immobilize: 0, cloud: 0 }; this.cdMax = { immobilize: 1, cloud: 1 };
    this.im = null; this.rush = null; this.decoy = null; this.hitstop = null;
    this.fxAcc = 0;
  }

  /** compiles the shader variants used by the gold look (emissiveMap) and 化气 (transparent + emissiveMap) once at
   * load, so the first cast does not stall on program compiles: flip the real materials, compile, flip back */
  warmUp() {
    const r = this.game.r;
    if (!r?.renderer?.compile) return;
    // one record per material: shared materials must not record their already-flipped state (that left them
    // transparent/depthWrite-off with an emissive map after the restore)
    const seen = new Set();
    const flip = (model, fn) => {
      const recs = [];
      model.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of [].concat(o.material)) {
          if (!m || seen.has(m)) continue;
          seen.add(m);
          recs.push([m, m.transparent, m.depthWrite, m.emissiveMap]); fn(m); m.needsUpdate = true;
        }
      });
      return recs;
    };
    const withMap = (m) => { if (m.emissive && m.map && !m.emissiveMap) m.emissiveMap = m.map; };
    const a = flip(this.p.ch.model, (m) => { m.transparent = true; m.depthWrite = false; withMap(m); });
    const b = flip(this.game.boss.ch.model, withMap);
    try {
      r.renderer.compile(this.p.ch.root, r.camera, r.scene);
      r.renderer.compile(this.game.boss.ch.root, r.camera, r.scene);
    } catch (err) { console.warn("spells warmUp", err); }
    for (const [m, t, dw, em] of [...a, ...b]) { m.transparent = t; m.depthWrite = dw; m.emissiveMap = em; m.needsUpdate = true; }
  }

  get wukong() { return !this.p.form || this.p.form === "wukong"; }
  mine(kind) { return kind === KIND.immobilize || kind === KIND.cloud || kind === KIND.strike; }

  owns(name) {
    if (!name) return false;
    if (this.mine(name)) return true;
    return name === "light" && !!this.rush && this.wukong; // 化气: light attack = 破隐一击
  }

  bufferable(name) {
    const ch = this.p.ch;
    if (name === "light") return ch.inEvent("inputBuffer") || ch.inEvent("comboWindow") || ch.inEvent("dodgeWindow") || this.afterAttackState();
    return ch.inEvent("magicBuffer") || ch.inEvent("magicWindow") || ch.inEvent("dodgeInputBuffer") || ch.inEvent("dodgeWindow");
  }

  /** spells cancel montages inside BANS_GSMagicWindow; base-moveset clips carry no magic windows in this export, there
   * the dodge window (which the game's magic windows coincide with on every spell clip) is used [INFERENCE] */
  canInterrupt(name, action) {
    const ch = this.p.ch;
    if (action.kind === "heavyStart" || action.kind === "heavyLoop") return false;
    if (name === "light") return ch.inEvent("comboWindow") || ch.inEvent("dodgeWindow") || this.afterAttackState();
    if (ch.events("magicWindow").length) return ch.inEvent("magicWindow");
    return ch.inEvent("dodgeWindow");
  }

  start(name, dir) {
    if (!this.wukong) return false;
    if (name === KIND.immobilize) return this.castImmobilize(dir);
    if (name === KIND.cloud) return this.castCloud(dir);
    if (name === "light" && this.rush) return this.castStrike(dir);
    return false;
  }

  onActionEnd() { return false; }

  /** incoming tiger hits: buff 218 windows of the spell montages (ImmueDamage) and 化气 buff 118 (ImmueStiff, DmgDef +2000) */
  receiveHit(attacker, e, point, info) {
    const p = this.p;
    if (p.state === "action" && this.mine(p.action.kind) && p.ch.activeEvents("buff").some((b) => b.buffId === 218)) {
      this.game.debugLog({ ev: "spellImmune", buff: 218, clip: p.ch.clipName });
      return 0;
    }
    if (!this.rush) return undefined;
    if (p.invulnerable() && (e.damageImmuneLevel ?? 0) < 1) return 0;
    const add = attrSum(this.C.buffs, this.C.config.beginBuffs, "DmgDefBase");
    const V = { stats: { ...p.stats, dmgDef: (p.stats.dmgDef ?? 0) + add }, maxHp: p.maxHp, isPlayer: true };
    let { damage, crit } = computeDamage(this.game.damageModel, attacker.stats, V, e);
    if (p.god) damage = 0;
    p.hp = Math.max(0, p.hp - damage);
    this.game.hud.damage(this.game.r.camera, point || p.ch.position, damage, "player");
    this.game.debugLog({ ev: "playerHit", dmg: damage, crit, hp: p.hp, effect: info.effectId, clip: attacker.ch.clipName, phantomRush: true });
    if (p.hp <= 0) p.die((e.hitWeight ?? 0) - (p.stats.tenacity ?? 0), attacker);
    return damage;
  }

  // ------------------------------------------------------------------ frame
  update(dt, active) {
    const p = this.p, I = this.game.input;
    for (const k of ["immobilize", "cloud"]) this.cd[k] = Math.max(0, this.cd[k] - dt);
    this.updateHitstop();
    if (this.im) this.tickImmobilize(dt);
    if (this.rush) this.tickRush(dt, active);
    if (this.decoy) this.tickDecoy(dt);
    if (active && this.wukong) {
      if (I.wasPressed("Digit1")) p.press(KIND.immobilize);
      if (I.wasPressed("Digit2")) p.press(KIND.cloud);
      // BANS_GSAttackState over: movement input leaves the spell montage (clips have no BANS_GSMoveWindow) [INFERENCE]
      if (p.state === "action" && this.mine(p.action.kind) && this.afterAttackState()) {
        const dir = p.inputDir();
        if (dir && !p.queued) { p.toFree(); p.vel.copy(dir).multiplyScalar(p.d.movement.run * 0.5); }
      }
    }
    this.updateHud();
  }

  afterAttackState() {
    const ch = this.p.ch, st = ch.events("attackState");
    return st.length > 0 && ch.clipTime >= Math.max(...st.map((e) => e.end));
  }

  /** montage events of the running spell action (after the player's animation step) + 破隐一击 hits */
  resolveHits() {
    const p = this.p;
    if (p.state !== "action" || !this.mine(p.action.kind)) return;
    const A = p.action, ch = p.ch;
    for (const e of ch.crossed("cost")) {
      const row = A.kind === KIND.cloud ? this.C.mpCostEffect : this.I.mpCostEffect;
      if (row?.attr === "Mp") { p.mp = Math.max(0, p.mp - row.value); this.game.debugLog({ ev: "spellCost", effect: e.effect, mp: p.mp }); }
    }
    for (const e of ch.crossed("buff")) {
      // buff 1028 精准定身降低定身CD: ModifyCooldown 10518/10519 -30 s
      for (const x of this.I.buffs[String(e.buffId)]?.effects || []) {
        if (x.type === "ModifyCooldown" && x.seconds && this.I.skills[String(x.skill)] && String(x.skill) === "10518") {
          this.cd.immobilize = Math.max(0, this.cd.immobilize + x.seconds);
          this.game.debugLog({ ev: "spellCooldown", buff: e.buffId, cd: +this.cd.immobilize.toFixed(2) });
        }
      }
    }
    if (A.kind === KIND.immobilize) for (const e of ch.crossed("castDingShen")) this.applyImmobilize(e.config || 0);
    if (A.kind === KIND.cloud && ch.clipTime < 0.6) this.qiTrail(); // dash out of the decoy: afterimage smoke trail
    if (A.kind === KIND.strike) this.strikeHits();
  }

  // ------------------------------------------------------------------ 定身法
  immoTargetOk() {
    const b = this.game.boss, T = this.I.targeting;
    if (!b.alive || !b.canBeLocked()) return false;
    const p = this.p.ch.position, q = b.ch.position;
    return Math.hypot(q.x - p.x, q.z - p.z) <= T.range && Math.abs(q.y - p.y) <= T.zLimit;
  }

  castImmobilize(dir) {
    const p = this.p, S = this.I.skills["10518"];
    if (this.cd.immobilize > 0) { this.game.hud.toast("定身法　回转中", 0.8); return false; }
    if (p.mp < S.mpRequired) { this.game.hud.toast("法力不足", 0.8); return false; }
    // FUStPlayerSkillCtrlDesc 10518: CanEmptyCast No -> needs the lock target in range
    if (!this.immoTargetOk()) { this.game.hud.toast("无可定之敌", 0.8); return false; }
    // BUS_SkillMappingComp: InAttackWarning (perfect-dodge window) -> 10519 -> 瞬机 (Talent level 1) -> 10517 -> 10519 montage
    const precise = p.pdTimer > 0 && this.talent(100902) >= 1;
    const skill = precise ? 10519 : 10518, clip = this.I.skills[String(skill)].clip;
    this.cd.immobilize = this.cdMax.immobilize = S.cooldown; // CooldownType TryToCast; CooldownSkills share it
    const b = this.game.boss, v = _v.subVectors(b.ch.position, p.ch.position);
    p.ch.setYaw(Math.atan2(v.x, v.z)); // SkillRotateType MeleeRotate toward the lock target
    p.sprinting = false;
    this.game.debugLog({ ev: "spell", name: "immobilize", skill, clip, precise, mp: p.mp, cooldown: S.cooldown });
    return p.playAction(KIND.immobilize, clip, { skill, spec: { skill }, precise, fade: 0.08 });
  }

  tigerBuffs() {
    const b = this.game.boss;
    return Object.entries(b.d.buffs || {}).filter(([id]) => b.hasBuff(id)).map(([id, x]) => ({ id, ...x }));
  }

  /** BUS_CastImmobilizeComp.OnCastImmobilize + BUS_BeImmobilizedComp.OnTriggerImmobilize */
  applyImmobilize(configId) {
    const b = this.game.boss, cfg = this.I.configs[String(configId || 10)] || this.I.configs["10"];
    if (!this.immoTargetOk()) { this.game.debugLog({ ev: "immobilizeNoTarget", config: cfg.id }); return; }
    const buffs = this.tigerBuffs();
    const states = buffs.flatMap((x) => x.simpleStates || []);
    if (states.includes("ImmueImmobilizing")) {
      this.burst("spellsDingEnd", b.lockPoint(), 0.8); // FailedFXs = DBC_Dingshen_End
      this.game.debugLog({ ev: "immobilizeFailed", reason: "ImmueImmobilizing", buffs: buffs.map((x) => x.id) });
      return;
    }
    const V = this.I.victim, bic = V.beImmobilized;
    let add = 0;
    for (const x of buffs) for (const e of x.effects || []) if (e.type === "AddAttr" && e.params?.[0] === 122) add += e.params[1];
    const stiff = b.state === "skill" && b.skill?.reaction ? b.skill.stiff ?? 0 : 0;
    const factor = stiff > 0 ? bic.factorForBeAttacked[String(stiff)] ?? bic.defaultFactorForBeAttacked : 1;
    const prev = b.immobilized, count = prev ? prev.count : 0;
    let dur = cfg.durationMs / 1000 * (V.dingShenDef * factor * (1 - cfg.repeatedDef * count) + add) / 100;
    dur = Math.max(dur, cfg.minDurationMs / 1000);
    const victimBuffs = cfg.begin.filter((e) => e.type === "AddBuff" && e.target === "Victim" && e.value > 0).map((e) => e.value);
    const maxHp = b.maxHp * V.immobilityHpRatio;
    const im = prev || { mod: this, t: 0, hp: maxHp, maxHp };
    if (prev) { prev.t = 0; this.restoreGold(); }
    Object.assign(im, {
      cfg, duration: dur, remain: dur, almost: cfg.almostEndAheadMs / 1000, count: count + 1, buffs: victimBuffs,
      dmgDefAdd: attrSum(this.I.buffs, victimBuffs, "DmgDefBase"), noBreakAnim: states.includes(145) || states.includes("DisableImmobilizedBreakAnim"),
      onHit: (dmg) => this.onImmobilizedHit(im, dmg), relieve: (reason) => this.relieve(im, reason),
    });
    im.quick = im.almost > 0 && dur <= im.almost; // DoQuickRelieveImmobilized: QuickEnd FX instead of the loop
    im.almostDone = im.quick;
    b.immobilized = im; this.im = im;
    if (b.task && !prev) b.moveVel?.set(0, 0, 0);
    this.collectGold();
    const lp = b.lockPoint();
    this.burst(im.quick ? "spellsDingHint" : "spellsDingHit", lp, 1);
    this.game.audio?.post("EVT_player_wk_fashu_dss_hit", b);
    this.game.debugLog({ ev: "immobilize", config: cfg.id, duration: +dur.toFixed(3), factor, stiff, dingshenDefAdd: add, repeat: count,
      immobilizeHp: +im.hp.toFixed(1), dmgDefAdd: im.dmgDefAdd, clip: b.ch.clipName, clipTime: +b.ch.clipTime.toFixed(3), state: b.state });
  }

  onImmobilizedHit(im, dmg) {
    im.hp -= dmg; // ImmobilizeHit = 0 for every player effect here (FUStSkillDamageExpandDesc)
    this.burst("spellsDingSpark", this.game.boss.lockPoint(), 0.6);
    this.game.debugLog({ ev: "immobilizedHit", dmg, immobilizeHp: +Math.max(0, im.hp).toFixed(1) });
    return im.hp <= 0 ? "break" : null;
  }

  tickImmobilize(dt) {
    const im = this.im, b = this.game.boss;
    if (b.immobilized !== im) { this.im = null; this.restoreGold(); return; }
    im.t += dt; im.remain -= dt;
    if (im.remain <= 0) return this.relieve(im, "end");
    if (!im.almostDone && im.almost > 0 && im.remain <= im.almost) {
      im.almostDone = true;
      this.burst("spellsDingHint", b.lockPoint(), 1);
      this.game.audio?.stop("EVT_player_wk_fashu_dss_hit");
      this.game.audio?.post("EVT_player_wk_fashu_dss_hit_rise", b);
      this.game.debugLog({ ev: "immobilizeAlmostEnd", remain: +im.remain.toFixed(2) });
    }
    this.applyGold(im);
    // NG_WuKong_DingShen_Hit_Loop: gold motes drifting off the frozen body
    this.fxAcc += dt;
    while (this.fxAcc > 0.06) {
      this.fxAcc -= 0.06;
      const bone = this.randomBone(b.ch);
      if (bone) this.L.star.spawn(bone.x, bone.y, bone.z, rand(-0.3, 0.3), rand(0.4, 1.2), rand(-0.3, 0.3),
        { size: [0.35, 0.05], life: rand(0.5, 0.9), color: GOLD, alpha: 0.9, rotSpeed: rand(-2, 2) });
    }
  }

  /** BUS_BeImmobilizedComp.RelieveImmobilized / OnRelieveImmobilizedClient (end, break, death) */
  relieve(im, reason, silent = false) {
    const b = this.game.boss;
    if (b.immobilized === im) b.immobilized = null;
    if (this.im === im) this.im = null;
    this.restoreGold();
    this.game.audio?.stop("EVT_player_wk_fashu_dss_hit");
    if (silent) return;
    this.burst("spellsDingEnd", b.lockPoint(), reason === "break" ? 1.2 : 1); // EndFXs = DBC_Dingshen_End
    this.game.audio?.post("EVT_player_wk_fashu_dss_break", b);
    this.game.vfx?.shake("lv1", b.ch.position);
    this.game.debugLog({ ev: "immobilizeEnd", reason, after: +im.t.toFixed(3), duration: +im.duration.toFixed(3),
      immobilizeHp: +Math.max(0, im.hp).toFixed(1), clip: b.ch.clipName, clipTime: +b.ch.clipTime.toFixed(3) });
  }

  // golden look: DBC_Dingshen_Loop material context curves (brightness ramps in over 0.3 s, glow flash 10 -> 0.2 in
  // 0.4 s). The context layer brightens the victim's own texture: emission = gold x albedo map (emissiveMap = map)
  collectGold() {
    if (this.gold) return;
    const mats = new Set();
    this.game.boss.ch.model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m?.emissive) mats.add(m);
    });
    this.gold = [...mats].map((m) => {
      const g = { m, e: m.emissive.clone(), i: m.emissiveIntensity, em: m.emissiveMap };
      if (m.map && !m.emissiveMap) { m.emissiveMap = m.map; m.needsUpdate = true; }
      return g;
    });
  }

  applyGold(im) {
    if (!this.gold) return;
    const F = this.I.fx.curves;
    const ramp = curveAt(F.C_Wukong_DingShen_Context_TexBrightness, im.t) / 2;   // 0..1
    const flash = curveAt(F.C_Wukong_DingShen_Glow, im.t) / 10;                   // 1 -> 0.02
    let k = 0.45 * ramp + 1.6 * flash;
    if (im.almostDone) k *= 0.5 + 0.5 * Math.abs(Math.sin(im.remain * 9)); // NG_WuKong_DingShen_Hint flicker [INFERENCE]
    for (const g of this.gold) { g.m.emissive.setRGB(GOLD[0], GOLD[1] * 0.9, GOLD[2] * 0.6); g.m.emissiveIntensity = k; }
  }

  restoreGold() {
    if (!this.gold) return;
    for (const g of this.gold) {
      g.m.emissive.copy(g.e); g.m.emissiveIntensity = g.i;
      if (g.m.emissiveMap !== g.em) { g.m.emissiveMap = g.em; g.m.needsUpdate = true; }
    }
    this.gold = null;
  }

  // ------------------------------------------------------------------ 聚形散气
  castCloud(dir) {
    const p = this.p, S = this.C.enter;
    if (this.rush) return false; // BUS_PhantomRushComp: ignored while already in PhantomRush
    if (this.cd.cloud > 0) { this.game.hud.toast("聚形散气　回转中", 0.8); return false; }
    if (p.mp < S.mpRequired) { this.game.hud.toast("法力不足", 0.8); return false; }
    // FUStSkillSMappingDesc 10095 SkillDirection: F/R/B/L, no input -> B. Free (unlocked) input turns toward the input
    // and uses F, like the free-mode dodge [INFERENCE]
    let key = "B";
    if (dir) {
      if (p.lockOn) {
        const rel = wrapAngle(Math.atan2(dir.x, dir.z) - p.ch.yaw), a = Math.abs(rel);
        key = a < Math.PI / 4 ? "F" : a > 3 * Math.PI / 4 ? "B" : rel > 0 ? "L" : "R";
      } else key = "F";
    }
    const clip = this.C.enterClips[key];
    this.cd.cloud = this.cdMax.cloud = S.cooldown;
    // pose snapshot -> decoy at the cast point (summon 1001301), before the montage replaces the pose
    this.spawnDecoy();
    if (dir && !p.lockOn) p.ch.setYaw(Math.atan2(dir.x, dir.z));
    p.sprinting = false;
    this.enterRush();
    this.game.debugLog({ ev: "spell", name: "cloud", skill: S.id, clip, dir: key, mp: p.mp, cooldown: S.cooldown });
    return p.playAction(KIND.cloud, clip, { skill: S.id, spec: { skill: S.id }, fade: 0.05 });
  }

  enterRush() {
    const p = this.p, cfg = this.C.config;
    this.rush = { t: 0, timer: cfg.duration, noMp: cfg.noMagicProtect, drain: 0, mats: this.fadeMaterials(p.ch.model) };
    // buff 1059 纵横 (talent 101001): ChangeMoveSpeed [jog, run, sprint] summed into SpeedCtrlInfo, read as 1/10000 rates
    const ms = this.C.buffs["1059"]?.effects?.find((e) => e.type === "ChangeMoveSpeed");
    this.baseMove = p.d.movement;
    if (ms && this.talent(101001) >= 1) {
      const [jog, run, sprint] = ms.rates;
      p.d.movement = { ...this.baseMove, walk: this.baseMove.walk * (1 + jog / 10000), run: this.baseMove.run * (1 + run / 10000), sprint: this.baseMove.sprint * (1 + sprint / 10000) };
    }
    p.windWalk = true; // buff 118 SwitchCollisionProfile WindWalk_Pawn
    this.game.audio?.post("EVT_player_wk_fashu_jxsq_loop", p);
    this.game.debugLog({ ev: "phantomRush", duration: cfg.duration, buffs: cfg.beginBuffs });
  }

  tickRush(dt, active) {
    const R = this.rush, p = this.p, cfg = this.C.config;
    R.t += dt; R.timer -= dt;
    // buff 122: RecoverAttr Mp -3 every interval
    const drain = this.C.buffs["122"]?.effects?.find((e) => e.type === "RecoverAttr");
    const iv = this.C.buffs["122"]?.interval || 1;
    R.drain += dt;
    while (drain && R.drain >= iv) { R.drain -= iv; p.mp = Math.max(0, p.mp + drain.value); }
    if (!p.alive) return this.exitRush("dead");
    if (!this.wukong) return this.exitRush("form");
    if (R.timer <= 0) return this.exitRush("timeout");
    if (p.mp <= 0) { R.noMp -= dt; if (R.noMp <= 0) return this.exitRush("noMana"); }
    // DA_PhantomRushRelatedSkillConfig.PhantomRushAtkSkill: released heavy attacks also end 化气
    const sk = p.state === "action" ? p.action.spec?.skill ?? p.action.skill : null;
    if (sk != null && cfg.exitOnSkills.includes(Number(sk)) && p.action.kind !== KIND.strike) return this.exitRush("attack:" + sk);
    // DBC_JXSQ_1: translucent body with a fresnel rim (opacity 0.9 -> 0.55 -> 0.3, fresnel 0 -> 2 -> 5)
    const F = this.C.fx.curves;
    const op = curveAt(F.C_JXSQ_Opacity_Input, R.t), fr = curveAt(F.C_JXSQ_Fresnel_Input, R.t) / 5;
    // MLB_BaseColor_Add_jxsq adds a pale fresnel layer over the body texture: emissive = pale blue x albedo (emissiveMap)
    for (const x of R.mats) { x.m.opacity = op * x.o; if (x.m.emissive) { x.m.emissive.setRGB(0.8, 0.88, 1.0); x.m.emissiveIntensity = 0.25 + 0.9 * fr; } }
    // NG_WuKong_JXSQ_Smoke: white qi wisps around the hidden body
    R.acc = (R.acc ?? 0) + dt;
    while (R.acc > 0.045) {
      R.acc -= 0.045;
      const b = this.randomBone(p.ch) || p.ch.position;
      this.L.qi.spawn(b.x + rand(-0.15, 0.15), b.y, b.z + rand(-0.15, 0.15), rand(-0.2, 0.2), rand(0.3, 0.9), rand(-0.2, 0.2),
        { size: [0.35, 1.0], life: rand(0.5, 0.8), color: QI, alpha: 0.32, frames: 64, rotSpeed: rand(-1, 1) });
    }
  }

  /** BUS_PhantomRushComp.ExitPhantomRush: remove begin buffs, end effects (destroy decoy 1009602, buff 2096), noise */
  exitRush(reason, silent = false) {
    const R = this.rush, p = this.p;
    if (!R) return;
    this.rush = null;
    for (const x of R.mats) { x.m.opacity = x.o; x.m.transparent = x.t; x.m.depthWrite = x.dw; if (x.m.emissive) { x.m.emissive.copy(x.e); x.m.emissiveIntensity = x.i; x.m.emissiveMap = x.em; } x.m.needsUpdate = true; }
    if (this.baseMove) { p.d.movement = this.baseMove; this.baseMove = null; }
    p.windWalk = false;
    this.game.audio?.stop("EVT_player_wk_fashu_jxsq_loop");
    if (this.decoy) this.removeDecoy("rushEnd", silent);
    if (silent) return;
    this.burst("spellsQiEnd", p.ch.bonePos("spine_02") || p.ch.position, 0.8);
    this.game.debugLog({ ev: "phantomRushEnd", reason, after: +R.t.toFixed(2), mp: p.mp });
  }

  /** translucent copy of the current material state; returns restore records */
  fadeMaterials(model) {
    const out = [], seen = new Set();
    model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        out.push({ m, o: m.opacity, t: m.transparent, dw: m.depthWrite, e: m.emissive?.clone(), i: m.emissiveIntensity, em: m.emissiveMap });
        m.transparent = true; m.depthWrite = false; m.needsUpdate = true;
        if (m.emissive && m.map && !m.emissiveMap) m.emissiveMap = m.map;
      }
    });
    return out;
  }

  spawnDecoy() {
    const p = this.p, D = this.C.decoy, scene = this.game.r.scene;
    if (this.decoy) this.removeDecoy("replaced", true);
    const model = cloneSkinned(p.ch.model); // bones keep the current pose (FPoseSnapshot)
    const mats = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      const one = (m) => { const c = m.clone(); c.transparent = true; c.depthWrite = false; mats.push({ m: c, o: m.opacity }); return c; };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
      o.frustumCulled = false; o.castShadow = true;
    });
    const root = new THREE.Group();
    root.name = "phantomRushDecoy";
    root.position.copy(p.ch.position); root.rotation.y = p.ch.yaw;
    root.add(model);
    scene.add(root);
    const game = this.game, mod = this;
    const decoy = {
      isDecoy: true, root, model, mats, age: 0, life: D.aliveTime, removed: false,
      ch: { position: root.position, yaw: p.ch.yaw, bonePos: () => null }, capsule: p.capsule,
      cap: { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 },
      maxHp: p.maxHp * D.hpRatio, hp: p.maxHp * D.hpRatio,
      stats: { ...p.stats, attack: p.stats.attack * D.atkRatio },
      get alive() { return !this.removed && this.hp > 0; },
      hasBuff: () => false,
      applySlowTime() {},
      // buff 120: ImmueStiff / ImmueImmobilizing / ImmuneNegative -> no reaction, HP only
      receiveHit(attacker, e, point, info) {
        if (!this.alive) return 0;
        const { damage } = computeDamage(game.damageModel, attacker.stats, { stats: this.stats, maxHp: this.maxHp, isPlayer: false }, e);
        this.hp = Math.max(0, this.hp - damage);
        game.hud.damage(game.r.camera, point || this.root.position, damage, "player");
        game.debugLog({ ev: "decoyHit", dmg: damage, hp: this.hp, effect: info.effectId, clip: attacker.ch.clipName });
        mod.burst("spellsQiPuff", point || this.root.position, 0.6);
        if (this.hp <= 0) mod.removeDecoy("killed");
        return damage;
      },
    };
    this.decoy = decoy;
    // FPhantomRushServantInstance: NotifySwitchTarget(master -> decoy, TriggerTaunt)
    const b = this.game.boss;
    b.decoy = decoy;
    this.tauntLogged = new Set();
    this.burst("spellsQiOp", root.position, 1);
    const rel = b.relation();
    this.game.debugLog({ ev: "tigerTarget", target: "decoy", source: "SwitchTarget_PhantomRush", dist: +rel.dist.toFixed(2), angle: +rel.angle.toFixed(1) });
  }

  tickDecoy(dt) {
    const d = this.decoy, b = this.game.boss, F = this.C.fx.curves;
    d.age += dt;
    if (d.age >= d.life) return this.removeDecoy("aliveTime");
    const op = curveAt(F.C_JXSQ_Ghost_Opacity_Input, d.age);
    for (const x of d.mats) x.m.opacity = op * x.o;
    // NG_WuKong_JXSQ_Ghost_Smoke
    d.acc = (d.acc ?? 0) + dt;
    while (d.acc > 0.12) {
      d.acc -= 0.12;
      const y = d.root.position.y + rand(0.2, 1.6);
      this.L.qi.spawn(d.root.position.x + rand(-0.35, 0.35), y, d.root.position.z + rand(-0.35, 0.35), 0, rand(0.2, 0.6), 0,
        { size: [0.4, 1.1], life: rand(0.7, 1.1), color: QI, alpha: 0.22, frames: 64, rotSpeed: rand(-0.8, 0.8) });
    }
    // log what the tiger does against the decoy (relation / turning / attack aim use boss.foe)
    if (b.foe === d) {
      const rel = b.relation();
      if (b.state === "skill" && b.skill && !this.tauntLogged.has(b.skill.id + ":" + b.ch.cur?.stamp)) {
        this.tauntLogged.add(b.skill.id + ":" + b.ch.cur?.stamp);
        this.game.debugLog({ ev: "tigerAttacksDecoy", skill: b.skill.id, clip: b.skill.clip, dist: +rel.dist.toFixed(2), angle: +rel.angle.toFixed(1) });
      } else if (b.state === "move" && (this.lastMoveLog ?? -1) < this.game.simTime - 1) {
        this.lastMoveLog = this.game.simTime;
        this.game.debugLog({ ev: "tigerTurnsToDecoy", dist: +rel.dist.toFixed(2), angle: +rel.angle.toFixed(1) });
      }
    }
  }

  removeDecoy(reason, silent = false) {
    const d = this.decoy;
    if (!d) return;
    d.removed = true;
    this.decoy = null;
    const b = this.game.boss;
    if (b.decoy === d) b.decoy = null;
    d.root.parent?.remove(d.root);
    for (const x of d.mats) x.m.dispose();
    if (silent) return;
    this.burst("spellsQiPuff", d.root.position, 1.3); // AM_PhantomRushSummon_Disappear not exported: smoke dissolve [INFERENCE]
    this.game.debugLog({ ev: "decoyGone", reason, hp: d.hp, after: +d.age.toFixed(2) });
    this.game.debugLog({ ev: "tigerTarget", target: "player" });
  }

  // ------------------------------------------------------------------ 破隐一击 (10096)
  castStrike(dir) {
    const p = this.p, S = this.C.strike;
    // FUStPlayerSkillCtrlDesc 10096: SstMeleeAutoLock, AttackRange 14 m -> face the tiger when close, else the input
    const b = this.game.boss;
    const v = _v.subVectors(b.ch.position, p.ch.position).setY(0);
    if (b.alive && b.canBeLocked() && v.length() < 14) p.ch.setYaw(Math.atan2(v.x, v.z));
    else if (dir) p.ch.setYaw(Math.atan2(dir.x, dir.z));
    p.sprinting = false;
    const ok = p.playAction(KIND.strike, S.clip, { skill: S.id, spec: { skill: S.id }, fade: 0.05 });
    if (ok) this.exitRush("attack:" + S.id); // OnUnitCastSkillSuccess -> ExitPhantomRushByAttack
    this.game.debugLog({ ev: "spell", name: "strike", skill: S.id, clip: S.clip });
    return ok;
  }

  strikeHits() {
    const p = this.p, b = this.game.boss, S = this.C.strike;
    if (!b.alive) return;
    const hits = p.hitter.test(hurtCapsule(b.ch, b.capsule, b.cap), "boss");
    for (const h of hits) {
      const ids = (h.event.effects || [h.event.id]).map(String);
      const id = ids.find((x) => S.damage[x]);
      if (!id) continue;
      const res = b.receiveHit(p, S.damage[id], h.point, { effectId: id, skill: S.id });
      if (!res) continue;
      this.game.debugLog({ ev: "strikeHit", effect: id, dmg: res.damage, bounced: !!res.bounced, bossHp: b.hp });
      this.game.audio?.hit(p, b, h, res);
      for (const m of p.mods) m.onHitLanded?.(h, { skill: S.id, damage: S.damage }, id, res);
      if (res.bounced) continue;
      this.game.vfx?.hit("staff", h.point, S.damage[id]);
      this.burst("spellsStrikeHit", h.point, 1);
      // EffectsWithCondition_Before: 1009603 TimeScale (TC_Wukong_JXSQ_Atk_01), 1009604 CS_wukong_jxsq_hit_01
      this.game.vfx?.shake(S.onHit["1009604"]?.str?.[0] || "jxsq", null);
      this.startHitstop(S.timeScale);
    }
  }

  startHitstop(ts) {
    if (!ts || this.hitstop) return;
    this.hitstop = { t0: performance.now(), ts, base: this.game.timeScale ?? 1 };
  }

  updateHitstop() {
    const H = this.hitstop;
    if (!H) return;
    const t = (performance.now() - H.t0) / 1000, { scale, total, blendIn, blendOut } = H.ts;
    let k;
    if (t < blendIn) k = 1 + (scale - 1) * t / blendIn;
    else if (t < total) k = scale;
    else if (t < total + blendOut) k = scale + (1 - scale) * (t - total) / blendOut;
    else { this.game.timeScale = H.base; this.hitstop = null; return; }
    this.game.timeScale = H.base * k;
  }

  // ------------------------------------------------------------------ HUD / debug
  updateHud() {
    const hud = this.game.hud, p = this.p;
    const ri = this.I.skills["10518"].mpRequired, rc = this.C.enter.mpRequired;
    hud.setSlot(KIND.immobilize, {
      cd: this.cd.immobilize / this.cdMax.immobilize, ready: this.cd.immobilize <= 0 && p.mp >= ri && this.wukong,
      active: !!this.im, text: this.cd.immobilize > 0 ? Math.ceil(this.cd.immobilize).toString() : "",
    });
    hud.setSlot(KIND.cloud, {
      cd: this.cd.cloud / this.cdMax.cloud, ready: this.cd.cloud <= 0 && p.mp >= rc && this.wukong && !this.rush,
      active: !!this.rush, text: this.rush ? this.rush.timer.toFixed(1) : this.cd.cloud > 0 ? Math.ceil(this.cd.cloud).toString() : "",
    });
  }

  /** debug: state snapshot */
  state() {
    const b = this.game.boss, im = b.immobilized;
    return {
      cd: { immobilize: +this.cd.immobilize.toFixed(2), cloud: +this.cd.cloud.toFixed(2) }, mp: this.p.mp,
      immobilized: im ? { remain: +im.remain.toFixed(2), duration: +im.duration.toFixed(2), hp: +im.hp.toFixed(1), config: im.cfg.id, clip: b.ch.clipName, clipTime: +b.ch.clipTime.toFixed(3) } : null,
      rush: this.rush ? { timer: +this.rush.timer.toFixed(2) } : null,
      decoy: this.decoy ? { hp: this.decoy.hp, pos: this.decoy.root.position.toArray().map((x) => +x.toFixed(2)) } : null,
      bossTarget: b.foe === b.opponent ? "player" : "decoy",
    };
  }

  /** debug: clear cooldowns and refill MP */
  ready() { this.cd.immobilize = this.cd.cloud = 0; this.p.mp = this.p.maxMp; }

  // ------------------------------------------------------------------ VFX (Vfx extension API)
  randomBone(ch) {
    if (!ch.boneList) { ch.boneList = []; ch.model.traverse((o) => { if (o.isBone) ch.boneList.push(o); }); }
    const bn = ch.boneList[Math.floor(Math.random() * ch.boneList.length)];
    return bn ? bn.getWorldPosition(_w) : null;
  }

  burst(name, p, s = 1) { this.game.vfx?.burst(name, p, s); }

  setupVfx() {
    const vfx = this.game.vfx;
    if (!vfx) return;
    const tex = {};
    for (const [k, t] of Object.entries(this.d.textures)) tex[k] = { file: t.file, ...(t.flipbook ? { flipbook: t.flipbook } : {}) };
    vfx.addTextures(tex);
    this.L = {
      ding: vfx.addLayer("spellsDing", "spells_ding", { blend: "additive", max: 8, gain: 1.6, bright: 2.2 }),
      flare: vfx.addLayer("spellsFlare", "spells_flare20", { blend: "additive", max: 48, gain: 2, bright: 2.5 }),
      ring: vfx.addLayer("spellsRing", "spells_atypical027", { blend: "additive", max: 24, gain: 2.5, bright: 2.5 }),
      star: vfx.addLayer("spellsStar", "spells_flare04", { blend: "additive", max: 160, gain: 2.5, bright: 3 }),
      smoke: vfx.addLayer("spellsSmoke", "spells_smoke8x8", { blend: "normal", max: 96, gain: 1.6 }),
      qi: vfx.addLayer("spellsQi", "spells_fire8x8", { blend: "normal", max: 480, gain: 3, bright: 1.4, soft: true }),
    };
    const L = this.L, spark = () => vfx.layers.spark, debris = () => vfx.layers.debris;
    const sparks = (p, n, s, color, speed = 9) => {
      for (let i = 0; i < n; i++) {
        _v.set(rand(-1, 1), rand(-0.4, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.4, 1) * speed * s);
        spark()?.spawn(p.x, p.y, p.z, _v.x, _v.y, _v.z, { size: [0.28, 0.08], life: rand(0.25, 0.5), color, gravity: 6, drag: 2.5, stretch: 4 });
      }
    };
    // NG_WuKong_DingShen_Start (FX_Dingshen_Start, left hand gathers light)
    vfx.addRecipe("spellsDingStart", (v, p, s) => {
      L.flare.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [1.2 * s, 0.25 * s], life: 0.3, color: GOLD, alpha: 0.9 });
      for (let i = 0; i < 6; i++) L.star.spawn(p.x + rand(-0.5, 0.5), p.y + rand(-0.3, 0.5), p.z + rand(-0.5, 0.5), 0, 0, 0, { size: [0.4, 0.05], life: 0.3, color: GOLD });
    });
    // NG_WuKong_DingShen_BaoFa (FX_DingShen_BaoFa: shockwave M_kuosan_01, hard sparks, trail flash)
    vfx.addRecipe("spellsDingBaoFa", (v, p, s) => {
      L.ring.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [0.2 * s, 2.6 * s], life: 0.35, color: GOLD, alpha: 1 });
      L.flare.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [0.4 * s, 2.2 * s], life: 0.25, color: [1, 0.9, 0.6], alpha: 1 });
      sparks(p, 18, s, GOLD, 7);
    });
    // NG_WuKong_DingShen_Hit (+ Hit_Loop start): flash, expanding ring, sparks and the 定 glyph on the victim
    vfx.addRecipe("spellsDingHit", (v, p, s) => {
      L.flare.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [1.5 * s, 7 * s], life: 0.4, color: [1, 0.85, 0.5], alpha: 1 });
      L.ring.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [1 * s, 9 * s], life: 0.5, color: GOLD, alpha: 0.9 });
      L.ding.spawn(p.x, p.y + 0.6, p.z, 0, 0.15, 0, { size: [4 * s, 3 * s], life: 0.9, color: GOLD, alpha: 1, rot: 0 });
      sparks(p, 30, s, GOLD, 10);
    });
    vfx.addRecipe("spellsDingSpark", (v, p, s) => { sparks(p, 10, s, GOLD, 6); L.flare.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [0.5, 1.6 * s], life: 0.15, color: GOLD, alpha: 0.8 }); });
    // NG_WuKong_DingShen_Hint (almost end / quick end): glyph flicker, smoke, sparks
    vfx.addRecipe("spellsDingHint", (v, p, s) => {
      L.ding.spawn(p.x, p.y + 0.6, p.z, 0, 0, 0, { size: [3 * s, 3.3 * s], life: 0.7, color: GOLD, alpha: 0.75, rot: 0 });
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * 6.283;
        L.smoke.spawn(p.x + Math.cos(a) * 0.8, p.y - 0.4, p.z + Math.sin(a) * 0.8, Math.cos(a) * 0.6, 0.5, Math.sin(a) * 0.6,
          { size: [1.2 * s, 2.8 * s], life: 1.1, color: [0.85, 0.72, 0.5], alpha: 0.35, frames: 64, rotSpeed: rand(-0.5, 0.5) });
      }
      sparks(p, 12, s, GOLD, 5);
    });
    // NG_WuKong_DingShen_End (shatter: glyph, M_SuiPian_01 debris, shockwave, sparks)
    vfx.addRecipe("spellsDingEnd", (v, p, s) => {
      L.ding.spawn(p.x, p.y + 0.6, p.z, 0, 0.4, 0, { size: [3.2 * s, 5 * s], life: 0.45, color: GOLD, alpha: 1, rot: 0 });
      L.ring.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [1 * s, 8 * s], life: 0.45, color: GOLD, alpha: 0.8 });
      L.flare.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [1 * s, 5 * s], life: 0.3, color: [1, 0.85, 0.5], alpha: 1 });
      sparks(p, 40, s, GOLD, 12);
      for (let i = 0; i < 14 * s; i++) {
        _v.set(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize().multiplyScalar(rand(3, 8));
        debris()?.spawn(p.x, p.y, p.z, _v.x, _v.y, _v.z, { size: [0.22, 0.16], life: rand(0.7, 1.1), color: [1, 0.8, 0.4], gravity: 16, frame: Math.floor(Math.random() * 16), rotSpeed: rand(-8, 8) });
      }
    });
    // NG_WuKong_JXSQ_OP (cast puff at the feet: M_SubUV_Fire_01 white smoke, M_Flog fog, flare)
    vfx.addRecipe("spellsQiOp", (v, p, s) => {
      for (let i = 0; i < 26 * s; i++) {
        const a = Math.random() * 6.283, r = rand(0.1, 0.6), sp = rand(1, 3);
        L.qi.spawn(p.x + Math.cos(a) * r, p.y + rand(0.1, 1.6), p.z + Math.sin(a) * r, Math.cos(a) * sp, rand(0.3, 1.2), Math.sin(a) * sp,
          { size: [0.8 * s, 2.4 * s], life: rand(0.7, 1.2), color: QI, alpha: 0.55, drag: 2, frames: 64, rotSpeed: rand(-1, 1) });
      }
      L.star.spawn(p.x, p.y + 1, p.z, 0, 0, 0, { size: [0.5, 2.5 * s], life: 0.3, color: [0.9, 0.95, 1], alpha: 0.9 });
    });
    vfx.addRecipe("spellsQiPuff", (v, p, s) => {
      for (let i = 0; i < 14 * s; i++) {
        const a = Math.random() * 6.283, sp = rand(0.5, 2);
        L.qi.spawn(p.x, p.y + rand(0.2, 1.4), p.z, Math.cos(a) * sp, rand(0.2, 1), Math.sin(a) * sp,
          { size: [0.6 * s, 1.8 * s], life: rand(0.6, 1), color: QI, alpha: 0.5, drag: 2, frames: 64, rotSpeed: rand(-1, 1) });
      }
    });
    // NG_WuKong_JXSQ_End (spine_02, strike start: the qi re-condenses into the body)
    vfx.addRecipe("spellsQiEnd", (v, p, s) => {
      for (let i = 0; i < 20 * s; i++) {
        const a = Math.random() * 6.283, r = rand(0.6, 1.4);
        L.qi.spawn(p.x + Math.cos(a) * r, p.y + rand(-0.8, 0.8), p.z + Math.sin(a) * r, -Math.cos(a) * r * 2, rand(-0.2, 0.4), -Math.sin(a) * r * 2,
          { size: [1.2 * s, 0.4 * s], life: rand(0.35, 0.55), color: QI, alpha: 0.6, frames: 64, rotSpeed: rand(-2, 2) });
      }
      L.star.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [2.5 * s, 0.4 * s], life: 0.35, color: [0.9, 0.95, 1], alpha: 1 });
    });
    // NG_JXSQ_Hit_LV1 (破隐一击 connect: kuosan ring, lens flare, smoke, hard sparks)
    vfx.addRecipe("spellsStrikeHit", (v, p, s) => {
      L.ring.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [0.5 * s, 5 * s], life: 0.35, color: [0.95, 0.95, 1], alpha: 1 });
      L.flare.spawn(p.x, p.y, p.z, 0, 0, 0, { size: [1 * s, 4.5 * s], life: 0.25, color: [1, 0.95, 0.85], alpha: 1 });
      sparks(p, 26, s, [1, 0.9, 0.7], 11);
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * 6.283;
        L.qi.spawn(p.x, p.y, p.z, Math.cos(a) * 3, rand(0, 1.5), Math.sin(a) * 3, { size: [0.8, 2.2], life: 0.6, color: QI, alpha: 0.5, drag: 3, frames: 64 });
      }
    });
    // montage Niagara notifies of the spell clips (vfx.js resolves them on the player's timeline)
    vfx.addSystems({
      NG_WuKong_DingShen_Start: { kind: "burst", layers: ["spellsDingStart"], source: "AM_Wukong_DingShen BANS_GSTimedPlayNiagaraFX (spells.js recipe)" },
      NG_WuKong_DingShen_BaoFa: { kind: "burst", layers: ["spellsDingBaoFa"], source: "AM_Wukong_DingShen / AM_wukong_dingshen_02 (spells.js recipe)" },
      NG_WuKong_JXSQ_OP: { kind: "burst", layers: ["spellsQiPuff"], scale: 0.7, source: "AM_Wukong_JXSQ_Enter_* (spells.js recipe)" },
      NG_WuKong_JXSQ_End: { kind: "burst", layers: ["spellsQiEnd"], source: "AM_Wukong_JXSQ_Atk_01 (spells.js recipe)" },
      spellsDingHit: { kind: "burst", layers: ["spellsDingHit"] }, spellsDingHint: { kind: "burst", layers: ["spellsDingHint"] },
      spellsDingEnd: { kind: "burst", layers: ["spellsDingEnd"] }, spellsDingSpark: { kind: "burst", layers: ["spellsDingSpark"] },
      spellsQiOp: { kind: "burst", layers: ["spellsQiOp"] }, spellsQiPuff: { kind: "burst", layers: ["spellsQiPuff"] },
      spellsQiEnd: { kind: "burst", layers: ["spellsQiEnd"] }, spellsStrikeHit: { kind: "burst", layers: ["spellsStrikeHit"] },
    });
  }

  /** dash afterimage: dense qi along the path while the enter montage moves away from the decoy */
  qiTrail() {
    const p = this.p.ch.position;
    for (let i = 0; i < 3; i++) this.L.qi.spawn(p.x + rand(-0.2, 0.2), p.y + rand(0.2, 1.6), p.z + rand(-0.2, 0.2), 0, rand(0.1, 0.5), 0,
      { size: [0.7, 1.6], life: rand(0.5, 0.8), color: QI, alpha: 0.4, frames: 64, rotSpeed: rand(-1, 1) });
  }
}
