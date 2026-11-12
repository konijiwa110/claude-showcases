// 棍法三式 (Z 劈棍 / X 立棍 / C 戳棍) + 棍花 (V): stance state, per-stance heavy attacks, stance light->heavy
// follow-ups, 识破. Data: data/stances.json (extract/B1Data/build_stances.py: CCG_Player_Wukong combo graph,
// FUStSkillSDesc / FUStChargeSkillSDesc / buffs / talents); clips: player/stances.glb (animation-only bundle).
// Smash heavy charging stays in player.js (startCharge..releaseHeavy); everything else that is stance specific lives here.
import * as THREE from "three";
import { computeDamage } from "./damage.js";

const KEYS = { KeyZ: "smash", KeyX: "pillar", KeyC: "thrust" };
const CYCLE = "StanceCycle"; // touch stance slot: next unlocked stance
const T_SHIPO = 100607, T_GUANSUO = 100608, T_ZHANGUN = 100609, T_FENGYUN = 100705, T_TUICUN = 100807, T_BUDONG = 100704;
// montage buffs whose SetSimpleState includes 116 CommonDamageImmue (FUStBuffDesc 114 GP无敌, 272 GP成功无敌, 297 戳棍GP成功无敌);
// 114 is already an `iframe` event in the anims export, 272/297 are not
const IMMUNE_BUFFS = new Set([114, 272, 297]);
const CEILING_OK = true; // 卧虎寺 has open sky: every CCG CeilingHeight condition passes (the *_low attacks never play)
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export function createStances(game) { return new Stances(game); }

/** comboWindow whitelist / blacklist test (same rule as player.js) */
function allowed(cw, skill) {
  if (!cw) return false;
  if (cw.whitelist?.length) return cw.whitelist.map(String).includes(String(skill));
  if (cw.blacklist?.length) return !cw.blacklist.map(String).includes(String(skill));
  return true;
}

/** focus gain of a charge stage: FUStChargeSkillSDesc buff with an IncreasePevalue tick; a negative begin offset counts
 * back from the end of the stage's begin montage [INFERENCE] */
function gainOf(fg, beginLen) {
  if (!fg) return null;
  return { perSec: fg.perSec, at: fg.begin < 0 ? Math.max(0, beginLen + fg.begin) : fg.begin, buff: fg.buff };
}

class Stances {
  constructor(game) {
    this.game = game;
    const f = game.assets.files;
    this.d = f.stancesData;
    this.gltf = f.stancesGlb;
    this.doc = f.stancesAnims;
    this.stance = "smash";
    this.talents = new Set(Object.entries(this.d.talents).filter(([, t]) => t.inPreset).map(([id]) => Number(id)));
    // CostAttrBySkillEffect rows (effect -> stamina) of every stance clip
    this.costOf = new Map();
    const walk = (o) => {
      if (Array.isArray(o)) { for (const v of o) walk(v); return; }
      if (!o || typeof o !== "object") return;
      if (o.effect != null && o.value != null) this.costOf.set(String(o.effect), o.value);
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    };
    walk(this.d);
    for (const L of [...this.d.pillar, ...this.d.thrust]) {
      for (const w of L.loopCostWindows || []) this.costOf.set(String(w.effect), L.loopCost);
    }
    this.bodyCap = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.32 };
    this.staffCap = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.12 };
  }

  has(t) { return this.talents.has(t); }
  unlocked(id) { const s = this.d.stances.find((x) => x.id === id); return !!s && (!s.talent || this.has(s.talent)); }
  stanceDef(id = this.stance) { return this.d.stances.find((x) => x.id === id); }

  // ------------------------------------------------------------------ module hooks
  attach(p) {
    this.p = p;
    p.stances = this; // player.js startCharge / combo-window heavy + light hooks
    p.ch.addAnimations(this.gltf, this.doc);
    const g = this.game;
    g.hud.addSlot("stance", { key: "Z X C", label: this.stanceDef().label, order: 40, code: CYCLE });
    g.hud.addSlot("spin", { key: "V", label: "棍花", order: 41, code: "KeyV" });
    // Niagara systems used only by the stance montages: fallbacks through the Vfx API when vfx.json has no entry yet
    // (look reuses the XuLiGun spark recipes) [INFERENCE]
    const sys = g.vfx?.d?.systems;
    if (sys) {
      const add = {};
      if (!sys.NG_wukong_chenggun_baofa) add.NG_wukong_chenggun_baofa = { kind: "burst", ground: false, scale: 1.2, layers: ["goldSparks", "goldGlow"],
        source: "b1/Content/00Main/VFX/Characters/sunwukong/Niagara/Chenggun/NG_wukong_chenggun_baofa (stance fallback look)" };
      if (!sys.NG_WuKong_Atk_Lv4_ZaDi) add.NG_WuKong_Atk_Lv4_ZaDi = { kind: "burst", ground: true, scale: 1.6, layers: ["debris", "dust", "goldGlow"],
        source: "b1/Content/00Main/VFX/Characters/sunwukong/Niagara/FootEffects/LV4ZaDi/NG_WuKong_Atk_Lv4_ZaDi (stance fallback look)" };
      if (!sys.NG_WuKong_WeaponTrail_Qiang && sys.NG_WuKong_WeaponTrail) add.NG_WuKong_WeaponTrail_Qiang = { ...sys.NG_WuKong_WeaponTrail,
        source: "b1/Content/00Main/VFX/Characters/sunwukong/Niagara/NG_WuKong_WeaponTrail_Qiang (stance fallback: staff trail look)" };
      g.vfx.addSystems(add);
    }
    const dbg = typeof window !== "undefined" && window.__WK_DEBUG__;
    if (dbg) Object.assign(dbg, {
      setStance: (id) => this.setStance(id, false),
      stance: () => this.state(),
      setFocus: (v) => { p.focus = Math.max(0, Math.min(p.focusMax, v)); p.lastFocusGain = p.time; return p.focusPips; },
    });
  }

  reset() {
    this.cur = null; this.gpUntil = -1; this.hitUntil = -1; this.bodyHits = new Set();
    this.hud();
  }

  owns(name) { return typeof name === "string" && name.startsWith("stance:") && this.on(); }

  /** stances only exist in the Destined One's own form (BUIASwitchWeaponPose: no switching while Transforming) */
  on() { const f = this.p?.form; return !f || f === "wukong"; }

  start(name, dir) {
    if (name === "stance:spin") return this.startSpin(dir);
    return false;
  }

  canInterrupt(name, A) {
    if (name !== "stance:spin") return false;
    const ch = this.p.ch;
    if (allowed(ch.activeEvents("comboWindow")[0], this.d.spin.start.skill)) return true;
    return A.kind === "stance:attack" && ch.clipTime >= (A.entry?.attackStateEnd ?? Infinity);
  }

  onActionEnd(A) {
    if (A.kind === "stance:charge" || A.kind === "stance:spin" || A.kind === "stance:fyz") {
      if (A.stage === "begin") { this.enterLoop(A); return true; }
    }
    return false;
  }

  state() {
    const p = this.p, A = p.action;
    const pel = p.ch.bonePos("pelvis", _a);
    return {
      stance: this.stance, label: this.stanceDef().label, kind: A?.kind ?? null, mode: A?.mode ?? null, level: A?.level ?? null,
      stage: A?.stage ?? null, clip: p.ch.clipName, focus: +p.focus.toFixed(1), focusPips: p.focusPips,
      pelvisAboveFeet: pel ? +(pel.y - p.ch.position.y).toFixed(3) : null, gp: p.time < this.gpUntil,
    };
  }

  // ------------------------------------------------------------------ stance switching
  /** BUIASwitchWeaponPose*: no montage; allowed whenever battle input is accepted and the unlock talent is learned */
  setStance(id, fromKey = true) {
    if (!this.unlocked(id)) { if (fromKey) this.game.hud.toast("未习得此棍式", 0.8); return false; }
    if (id === this.stance) return true;
    this.stance = id;
    const def = this.stanceDef();
    this.game.hud.toast(def.name, 0.7);
    this.game.debugLog({ ev: "stance", stance: id, input: def.input });
    this.hud();
    const tip = this.p.ch.bonePos("weapon_r", _a);
    if (tip) this.game.vfx?.burst("NG_WuKong_XuLiGun_BaoFa_01_burst", tip, 0.35); // [INFERENCE] switch feedback
    return true;
  }

  /** next unlocked stance in stances.json order (touch has one stance slot instead of Z / X / C) */
  cycleStance() {
    const list = this.d.stances, at = list.findIndex((s) => s.id === this.stance);
    for (let i = 1; i < list.length; i++) {
      const s = list[(at + i) % list.length];
      if (this.unlocked(s.id)) return this.setStance(s.id);
    }
    return false;
  }

  hud() {
    const h = this.game.hud, A = this.p?.action;
    const def = this.stanceDef();
    h.setSlot("stance", { label: def.label, active: A?.kind === "stance:charge" || A?.kind === "heavyStart" || A?.kind === "heavyLoop", text: "" });
    h.setSlot("spin", { active: A?.kind === "stance:spin", ready: (this.p?.stamina ?? 1) > 0 });
  }

  // ------------------------------------------------------------------ per frame
  update(dt, active) {
    if (!this.on()) return;
    const p = this.p, I = this.game.input;
    if (active) {
      for (const code in KEYS) if (I.wasPressed(code)) this.setStance(KEYS[code]);
      if (I.wasPressed(CYCLE)) this.cycleStance();
      if (I.wasPressed("KeyV")) p.press("stance:spin");
    }
    const A = p.state === "action" ? p.action : null;
    if (A !== this.cur) { this.cur = A; if (A) { A.costFired ??= new Set(); A.lastT = -1; } }
    if (A && this.owns(A.kind)) {
      this.tickCosts(A);
      const dir = active ? p.inputDir() : null;
      if (A.kind === "stance:charge") this.chargeTick(A, dt, active);
      else if (A.kind === "stance:spin") this.spinTick(A, dir, active, dt);
      else if (A.kind === "stance:fyz") this.fyzTick(A, active);
      else if (A.kind === "stance:attack" && dir && p.ch.clipTime >= (A.entry?.attackStateEnd ?? Infinity) &&
        p.ch.clipTime > 0.05) { p.toFree(); p.vel.copy(dir).multiplyScalar(p.d.movement.run * 0.5); }
    }
    this.camLift(dt);
    this.hud();
  }

  /** buff 275 撑棍改变主角镜头参考点为pelvis: while on the staff the camera pivot follows the raised pelvis
   * (additive offset on OrbitCam.height, eased in/out) */
  camLift(dt) {
    const cam = this.game.cam, p = this.p;
    if (!cam) return;
    let want = 0;
    if (this.climbing()) {
      const pel = p.ch.bonePos("pelvis", _a);
      if (pel) want = Math.max(0, pel.y - p.ch.position.y - (this.pelvisRest ??= 1.0));
    }
    const lift = this.lift ?? 0;
    if (!want && !lift) return;
    const next = Math.abs(want - lift) < 1e-3 ? want : lift + (want - lift) * Math.min(1, dt * 5);
    cam.height += next - lift;
    this.lift = next;
  }

  /** BANS_GSCostAttrBySkillEffect: the effect's stamina is paid when its window starts (loop clips: every pass) */
  tickCosts(A) {
    const ch = this.p.ch, c = ch.cur, t = ch.clipTime;
    if (!c?.meta?.events) return;
    if (t < A.lastT) { A.costFired.clear(); this.p.hitter.reset(); } // looped: costs and hit windows repeat
    A.lastT = t;
    c.meta.events.forEach((e, i) => {
      if (e.type !== "cost" || A.costFired.has(i) || t < e.start) return;
      A.costFired.add(i);
      this.p.spend(this.costOf.get(String(e.effect)) ?? 0);
    });
  }

  // ------------------------------------------------------------------ actions
  play(kind, clip, extra = {}) {
    const p = this.p;
    if (!p.playAction(kind, clip, { fade: 0.1, ...extra })) return false;
    p.action.costFired = new Set(); p.action.lastT = -1;
    this.cur = p.action;
    return true;
  }

  loopCurrent() { const c = this.p.ch.cur; if (c) { c.loop = true; c.sections = null; } }

  spec(entry) { return { skill: entry.skill, damage: entry.damage, focusGain: [] }; }

  /** a stance attack montage (release / follow-up / spin end); buff 116 at its start removes 100 focus */
  attack(entry, extra = {}) {
    const p = this.p;
    if (!this.play("stance:attack", entry.clip, { spec: this.spec(entry), entry, fade: 0.08, ...extra })) return false;
    if (entry.buffs?.some((b) => b.buff === 116 && b.start <= 0.01)) p.focus = Math.max(0, p.focus - 100);
    p.sprinting = false;
    return true;
  }

  /** player.js startCharge(): heavy from free / combo window. false = Smash (player.js keeps its own charge) */
  startHeavy(dir) {
    if (!this.on()) return false;
    if (this.stance === "smash") return false;
    const p = this.p, lv = Math.min(4, p.focusPips);
    const L = (this.stance === "pillar" ? this.d.pillar : this.d.thrust)[lv];
    if (p.stamina < (L.start.minStaminaToStart ?? 0) || p.stamina <= 0) return true; // MinAttrCost: nothing happens
    p.aimAtStart(dir);
    p.sprinting = false;
    const held = this.game.input.held("Mouse2");
    this.play("stance:charge", L.start.clip, { mode: this.stance, level: lv, stage: "begin", t: 0, released: !held,
      gain: gainOf(L.focusGain, L.start.length), spec: null });
    this.game.debugLog({ ev: "stanceCharge", stance: this.stance, level: lv, clip: L.start.clip });
    return true;
  }

  enterLoop(A) {
    const p = this.p, keep = { mode: A.mode, level: A.level, released: A.released, gain: A.gain, t: A.t, fyz: A.fyz };
    let clip;
    if (A.kind === "stance:charge") clip = (A.mode === "pillar" ? this.d.pillar : this.d.thrust)[A.level].charge.loopClip;
    else if (A.kind === "stance:spin") clip = this.d.spin.loopClip;
    else clip = this.d.followUps.pillar.fengyunzhuan.charge.loopClip;
    const spec = A.kind === "stance:charge" ? null
      : this.spec(A.kind === "stance:spin" ? this.d.spin.loop : this.d.followUps.pillar.fengyunzhuan.loop);
    this.play(A.kind, clip, { ...keep, stage: "loop", spec, fade: 0.05 });
    this.loopCurrent();
  }

  /** 立棍 / 戳棍 charge: focus gain buff, level growth (立棍), stamina, release (deferred until the loop stage:
   * BUS_PlayerInputActionComp caches attack-key events while a charge skill is in its Begin stage) */
  chargeTick(A, dt, active) {
    const p = this.p, I = this.game.input;
    if (!I.held("Mouse2") || !active) A.released = true;
    A.t += dt;
    if (A.gain && A.t >= A.gain.at && p.focus < p.chargeCap) p.focus = Math.min(p.chargeCap, p.focus + A.gain.perSec * dt);
    p.lastFocusGain = p.time; // charging holds focus (no decay), like the smash charge
    if (p.lockOn) p.faceTowards(p.toBoss(), p.d.movement.turnSpeed, dt);
    if (A.mode === "pillar") {
      // EAttackPELevelGrowUp: start_N/loop_N -> Xuli_C_loop_<N>to<N+1> (ChargeSkillBegin 10865-10867), only up to level 3
      const L = this.d.pillar[A.level];
      if (L.growUp && p.focusPips > A.level && CEILING_OK) {
        const G = L.growUp;
        this.play("stance:charge", G.clip, { mode: "pillar", level: G.toLevel, stage: "begin", t: 0, released: A.released,
          gain: gainOf(G.focusGain, G.length), fade: 0.08 });
        this.game.debugLog({ ev: "pillarGrow", level: G.toLevel, clip: G.clip });
        return;
      }
      if (p.stamina <= 0) return this.pillarStaminaOver(A);
    } else if (p.stamina <= 0) return this.releaseCharge(A); // 戳棍 EAttackChargeStaminaOver -> attack by focus level
    if (A.released && A.stage === "loop") this.releaseCharge(A);
  }

  releaseCharge(A) {
    const p = this.p;
    let lv, entry;
    if (A.mode === "pillar") { lv = A.level; entry = this.d.pillar[lv].attack; } // CeilingHeight ok -> attack_N (not _low)
    else { lv = Math.min(4, p.focusPips); entry = this.d.thrust[lv].attack; } // xuli_B_attack_<focus level>
    p.aimAtStart(p.inputDir());
    this.attack(entry, { level: lv, mode: A.mode });
    // buff 247 ClearPevalue at the attack start; 戳棍 attacks also carry a focus -99 notify
    if (!p.ch.events("focus").some((e) => e.value === -99)) p.focus = 0;
    this.game.debugLog({ ev: "stanceHeavy", stance: A.mode, level: lv, clip: entry.clip, skill: entry.skill });
  }

  /** 立棍 stamina over: talent 100704 不动身 ? attack : ComboA_z5_fall_N (fall off the staff) */
  pillarStaminaOver(A) {
    const L = this.d.pillar[A.level];
    if (this.has(T_BUDONG) || !L.fallClip) return this.releaseCharge(A);
    this.play("stance:fall", L.fallClip, { fade: 0.08 });
    this.game.debugLog({ ev: "pillarFall", level: A.level, clip: L.fallClip });
  }

  /** light/sprint-light combo window, heavy pressed: stance follow-ups from the combo graph (Default branch) */
  heavyFollowUp(A, cw, dir) {
    if (!this.on()) return false;
    const p = this.p, F = this.d.followUps, pips = p.focusPips;
    if (A.kind === "light" || A.kind === "sprintLight") {
      if (this.stance === "smash") {
        const e = F.smash.shipo;
        if (pips > 0 && this.has(T_SHIPO) && allowed(cw, e.skill)) return this.followUp(e, dir, { gpWindow: e.gpBuff.duration });
      } else if (this.stance === "thrust") {
        const e = F.thrust.tuicun;
        if (this.has(T_TUICUN) && allowed(cw, e.skill)) return this.followUp(e, dir);
      } else if (this.stance === "pillar") {
        const e = F.pillar.fengyunzhuan;
        if (pips > 0 && this.has(T_FENGYUN) && allowed(cw, e.start.skill)) return this.startFyz(dir);
      }
      return false;
    }
    if (A.kind === "stance:attack") {
      const s = A.entry?.skill;
      if (s === F.smash.shipo.skill && this.has(T_ZHANGUN) && p.time < this.hitUntil && pips > 0 && allowed(cw, F.smash.zhangunshi.skill))
        return this.followUp(F.smash.zhangunshi, dir);
      if (s === F.thrust.tuicun.skill && pips > 0 && allowed(cw, F.thrust.tuicunThrust.skill))
        return this.followUp(F.thrust.tuicunThrust, dir);
    }
    return false;
  }

  /** combo window, light pressed: 贯索 — after a successful 识破 (buff 1007, 3 s) the light combo continues at q3 */
  lightNext(A) {
    if (!this.on()) return null;
    if (A.kind === "stance:attack" && A.entry?.skill === this.d.followUps.smash.shipo.skill && this.has(T_GUANSUO) &&
      this.p.time < this.gpUntil) return 2;
    return null;
  }

  followUp(entry, dir, extra = {}) {
    const p = this.p;
    if (p.stamina < (entry.minStaminaToStart ?? 0) || p.stamina <= 0) return false;
    p.aimAtStart(dir);
    if (!this.attack(entry, extra)) return false;
    this.game.debugLog({ ev: "stanceFollowUp", stance: this.stance, name: entry.name ?? null, skill: entry.skill, clip: entry.clip });
    return true;
  }

  /** 风云转 (立棍 light->heavy, focus level > 0): comboc_z_01_start -> loop while held -> end */
  startFyz(dir) {
    const p = this.p, E = this.d.followUps.pillar.fengyunzhuan;
    if (p.stamina <= 0) return false;
    p.aimAtStart(dir);
    this.play("stance:fyz", E.start.clip, { stage: "begin", spec: this.spec(E.start), entry: E.start, fade: 0.08,
      released: !this.game.input.held("Mouse2") });
    if (E.start.buffs?.some((b) => b.buff === 116)) p.focus = Math.max(0, p.focus - 100);
    this.game.debugLog({ ev: "stanceFollowUp", stance: "pillar", name: E.name, skill: E.start.skill, clip: E.start.clip });
    return true;
  }

  fyzTick(A, active) {
    if (!this.game.input.held("Mouse2") || !active) A.released = true;
    if (A.stage === "loop" && (A.released || this.p.stamina <= 0)) this.attack(this.d.followUps.pillar.fengyunzhuan.end);
  }

  // ------------------------------------------------------------------ 棍花
  startSpin(dir) {
    const p = this.p, S = this.d.spin;
    if (p.stamina < (S.start.minStaminaToStart ?? 0) || p.stamina <= 0) return false;
    p.sprinting = false;
    if (p.lockOn) p.aimAtStart(null); else if (dir) p.ch.setYaw(Math.atan2(dir.x, dir.z));
    this.play("stance:spin", S.start.clip, { stage: "begin", spec: this.spec(S.start), fade: 0.08, released: !this.game.input.held("KeyV") });
    this.game.debugLog({ ev: "spin", clip: S.start.clip });
    return true;
  }

  /** spin projectile sweep (EffectID -10 on weapon_r, r 1.5 m): tiger bullets touching it are destroyed [INFERENCE] */
  blockBullets() {
    const hz = this.game.hazards, sw = this.d.spin.projectileSweep;
    if (!hz?.list?.length) return;
    const c = this.p.ch.bonePos(sw.socket, _a);
    if (!c) return;
    for (const h of hz.list) {
      if (h.dead) continue;
      const s = h.def.shape, r = sw.radius + (s.sphere ?? s.capsule?.radius ?? (s.box ? Math.min(s.box[0], s.box[1]) : 0));
      const y = s.capsule ? Math.max(h.pos.y, Math.min(c.y, h.pos.y + 2 * s.capsule.halfHeight)) : h.pos.y;
      if (_b.set(h.pos.x, y, h.pos.z).distanceTo(c) > r) continue;
      h.dead = true;
      this.game.vfx?.hit("staff", _b);
      this.game.debugLog({ ev: "spinBlock", bullet: h.id });
    }
  }

  /** release / move input (no 棍花移步) / heavy / stamina over -> q_end_left|right by the side buff (266/267) */
  spinTick(A, dir, active, dt) {
    const p = this.p, I = this.game.input, S = this.d.spin;
    if (!I.held("KeyV") || !active) A.released = true;
    if (active && I.wasPressed("Mouse2")) A.heavy = true; // EAttackHeavy pin
    if (p.lockOn) p.faceTowards(p.toBoss(), 360, dt); // LoopCanRotate (ChargeSkill 10842)
    this.blockBullets();
    const exit = A.released || dir || A.heavy || p.stamina <= 0;
    if (!exit || A.stage !== "loop") return;
    const t = p.ch.clipTime;
    const left = (S.loop.buffs || []).some((b) => b.buff === S.sideBuffs.left && t >= b.start && t < b.end);
    const end = left ? S.end.left : S.end.right;
    const why = A.released ? "release" : dir ? "move" : p.stamina <= 0 ? "stamina" : "heavy";
    this.attack(end);
    this.game.debugLog({ ev: "spinEnd", clip: end.clip, why });
  }

  // ------------------------------------------------------------------ incoming hits
  inSpin() { const A = this.p.action; return this.p.state === "action" && A?.kind === "stance:spin"; }
  climbing() { const A = this.p.action; return this.p.state === "action" && A?.kind === "stance:charge" && A.mode === "pillar"; }

  caps() {
    const ch = this.p.ch;
    const pel = ch.bonePos("pelvis", this.bodyCap.a), head = ch.bonePos("head", this.bodyCap.b);
    const s0 = ch.bonePos("weapon_tou_1", this.staffCap.a), s1 = ch.bonePos("weapon_wei_1", this.staffCap.b);
    return pel && head && s0 && s1;
  }

  receiveHit(attacker, e, point, info) {
    if (!this.on()) return undefined;
    const p = this.p;
    // 棍花 intercepts projectiles
    if (info.bullet && this.inSpin()) { this.game.debugLog({ ev: "spinBlock", bullet: info.bullet, effect: info.effectId }); return 0; }
    const A = p.state === "action" ? p.action : null;
    if (A?.kind === "stance:attack" && (e.damageImmuneLevel ?? 0) < 1 && !p.god) {
      const t = p.ch.clipTime;
      const b = A.entry?.buffs?.find((x) => IMMUNE_BUFFS.has(x.buff) && t >= x.start && t < x.end && !(A.gpWindow && t < A.gpWindow));
      if (b) { this.game.debugLog({ ev: "stanceImmune", buff: b.buff, effect: info.effectId }); return 0; }
    }
    // 识破: buff 287 (talent 100607, 0.4 s from the start of ComboA_z_01) BeAttacked -> 288 GP success + 1007 (3 s)
    if (A?.kind === "stance:attack" && A.gpWindow && !info.pillarBody && p.ch.clipTime < A.gpWindow) {
      if (!A.gp) {
        A.gp = true;
        this.gpUntil = p.time + (this.d.followUps.smash.guansuo.buffDuration ?? 3);
        p.game.hud.toast("识破", 0.8);
        const tip = p.ch.bonePos("weapon_r", _a);
        if (tip) this.game.vfx?.burst("NG_WuKong_XuLiGun_BaoFa_01_burst", tip, 0.8);
        this.game.debugLog({ ev: "shipo", effect: info.effectId, clip: attacker.ch?.clipName });
      }
      return 0;
    }
    if (!this.climbing() || info.pillarBody || !this.caps()) return undefined;
    // 立棍 on the staff (StateLib SL_ComboAZ5, PartRule 1002): the body is up on the staff, the staff bodies take the
    // low hits and lose stamina instead of HP (x(1 + 铁树)); hits that touch neither miss
    let part;
    if (info.bullet || !attacker.hitter) part = point && point.y < this.bodyCap.a.y - 0.5 ? "staff" : "body";
    else if (attacker.hitter.overlapsNow("hit", this.bodyCap)) part = "body";
    else part = attacker.hitter.overlapsNow("hit", this.staffCap) ? "staff" : "miss";
    if (part === "body") return info.bullet ? undefined : 0; // melee body hits are resolved by resolveHits (body capsule)
    if (part === "miss") {
      this.game.debugLog({ ev: "pillarEvade", effect: info.effectId, clip: attacker.ch?.clipName, pelvisY: +(this.bodyCap.a.y - p.ch.position.y).toFixed(2) });
      return 0;
    }
    const { damage } = computeDamage(this.game.damageModel, attacker.stats, p, e);
    const cost = p.god ? 0 : damage * this.d.staffHit.staffScale;
    p.spend(cost);
    this.game.debugLog({ ev: "pillarStaffHit", effect: info.effectId, stamina: +cost.toFixed(1), left: +p.stamina.toFixed(1) });
    return 0;
  }

  /** while climbing, tiger hit windows are also tested against the raised body (pelvis..head) once per window */
  resolveHits() {
    if (!this.on()) return;
    const p = this.p, A = p.state === "action" ? p.action : null;
    // 斩棍式 needs buff 289 (重棍变招第一下击中, 3 s): the 识破 swing connected
    if (A?.kind === "stance:attack" && A.entry?.skill === this.d.followUps.smash.shipo.skill && p.hitter.hitKeys.size && !A.hitMarked) {
      A.hitMarked = true; this.hitUntil = p.time + 3;
    }
    const b = this.game.boss;
    if (!this.climbing() || !b?.alive || b.state !== "skill" || !this.caps()) return;
    const ev = b.hitter.overlapsNow("hit", this.bodyCap);
    if (!ev) return;
    const key = `${b.ch.cur.stamp}:${b.ch.cur.meta.events.indexOf(ev)}`;
    if (this.bodyHits.has(key)) return;
    this.bodyHits.add(key);
    for (const id of ev.effectIds || ev.effects || [ev.id]) {
      const e = b.effects[String(id)];
      if (e?.type === "damage") {
        this.game.debugLog({ ev: "pillarBodyHit", effect: id });
        if (p.receiveHit(b, e, this.bodyCap.b.clone(), { effectId: id, pillarBody: true }) > 0) this.game.vfx?.hit("tiger", this.bodyCap.b);
      }
    }
  }
}
