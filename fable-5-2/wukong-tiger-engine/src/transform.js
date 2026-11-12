// 赤潮 (SpellDesc 5001, key 4): the Destined One transforms into 广智 (Unit_player_gycy_lang, ResID 12) and back.
// Data: data/bianhua.json (extract/B1Data/build_bianhua.py) — energy rules from SpellDesc.FloatParam + BUS_TransEnergyComp,
// form moveset in the player.json schema (Player's dodge / movement / hit reactions run it), CCG_player_gycy_lang combo
// graph for light/heavy (owned here while transformed), CostPlayerTransEnergy / IncreasePevalue effects from the
// montages' hits and triggers. The swap re-binds Player to the form's Character + capsule + data (Player.setForm); the
// Destined One's values are saved and restored, damage while transformed lands on the form's own HP bar.
import * as THREE from "three";
import { Character } from "./character.js";
import { CapsuleController } from "./collision.js";
import { Ribbon } from "./vfx.js";

export const FORM_LANG = "gycy_lang";
const KEY = "Digit4";
const rand = (a, b) => a + Math.random() * (b - a);
const _p = new THREE.Vector3(), _q = new THREE.Vector3();

/** Destined One cast clips (trans to/from 广智 + 精魄 enter/leave): one animation-only bundle, merged once */
export function ensureCastClips(game, ch) {
  const F = game.assets.files;
  if (!ch.has("AM_wukong_trans_to_gycy_lang")) ch.addAnimations(F.bianhuaGlb, F.bianhuaAnims);
}

/** shared VFX textures/layers (game Niagara material textures, see bianhua README notes) */
export function ensureVfx(vfx) {
  vfx.addTextures({
    T_ember_Fire0001: { file: "T_ember_Fire0001.webp", flipbook: [8, 8], source: "b1/Content/03_VFXRes/Textures/Fire/T_ember_Fire0001", material: "M_Emer_oneFire01_Inst Main_Tex (NG_GYGY_Lang_04_r1_trail / trail1)" },
    T_FluidSmoke_03_D: { file: "T_FluidSmoke_03_D.webp", flipbook: [8, 8], source: "b1/Content/00MainHZ/VFXRes/Textures/Smoke/T_FluidSmoke_03_D", material: "M_Howitzer_Smoke_Cheaper_Inst1 (NG_GYCY_SheBang_ChuXian, NG_GYCY_Lang_04_Foot_Smoke)" },
    T_Venus_Trail: { file: "T_Venus_Trail.webp", source: "b1/Content/00MainHZ/VFXRes/Textures/Trails/T_Venus_Trail", material: "M_Fire_Trail_01_Inst1 TEXB (luminance, rotated for Ribbon mask mode)" },
    T_Trai_mohul: { file: "T_Trai_mohul.webp", source: "b1/Content/00MainHZ/VFXRes/Textures/Trails/T_Trai_mohul", material: "M_Fire_Trail_01_Inst1 TEXA (NG_GYCY_SheBang_Bullet)" },
    Glow_028: { file: "Glow_028.webp", source: "b1/Content/00MainHZ/VFXRes/Textures/Glow/Glow_028", material: "M_kuosan_01_Inst4 Tex (NG_GYCY_Lang_04_Biansheng_BaoFa)" },
    T_Dian_01: { file: "T_Dian_01.webp", source: "b1/Content/00MainHZ/VFXRes/Textures/Glow/T_Dian_01", material: "M_Glow_Inst2 Texture (NG_GYCY_SheBang_*)" },
  });
  const L = vfx.layers;
  // gain/bright stand in for the materials' HDR emissive multipliers (Bright_Color 2.0, Edge color 10) [INFERENCE]
  L.bhFire ??= vfx.addLayer("bhFire", "T_ember_Fire0001", { blend: "additive", max: 480, gain: 2.2, bright: 2.4 });
  L.bhSmoke ??= vfx.addLayer("bhSmoke", "T_FluidSmoke_03_D", { blend: "normal", max: 260, gain: 2.2 });
  L.bhGlow ??= vfx.addLayer("bhGlow", "Glow_028", { blend: "additive", max: 64, gain: 1.6, bright: 2 });
  L.bhDot ??= vfx.addLayer("bhDot", "T_Dian_01", { blend: "additive", max: 256, gain: 2, bright: 2 });
  return L;
}

/** smoke puff of a transformation (GS_Trans fluid smoke / NG_wukong_HS_In) at p */
export function transSmoke(L, p, s = 1, tint = [0.75, 0.68, 0.6]) {
  for (let i = 0; i < 12 * s; i++) {
    const a = Math.random() * 6.283, r = rand(0.2, 0.9) * s, v = rand(0.8, 2.6) * s;
    L.bhSmoke.spawn(p.x + Math.cos(a) * r, p.y + rand(0.2, 2.2) * s, p.z + Math.sin(a) * r, Math.cos(a) * v, rand(0.3, 1.6), Math.sin(a) * v,
      { size: [0.9 * s, 2.6 * s], life: rand(0.7, 1.2), color: tint, alpha: 0.32, drag: 1.6, frames: 64, rotSpeed: rand(-0.8, 0.8) });
  }
  L.bhGlow.spawn(p.x, p.y + 1.2 * s, p.z, 0, 0, 0, { size: [1 * s, 5 * s], life: 0.35, color: [1, 0.85, 0.6], alpha: 0.8 });
}

/** fire burst (NG_GYCY_Lang_04_bs_fire / Biansheng_BaoFa) */
function fireBurst(L, p, s = 1) {
  for (let i = 0; i < 34 * s; i++) {
    const a = Math.random() * 6.283, v = rand(1.5, 5) * s;
    L.bhFire.spawn(p.x + Math.cos(a) * 0.3, p.y + rand(0, 1.5), p.z + Math.sin(a) * 0.3, Math.cos(a) * v, rand(1, 4), Math.sin(a) * v,
      { size: [1.0 * s, 2.6 * s], life: rand(0.45, 0.8), color: [1, 0.75, 0.5], alpha: 1, drag: 2.2, frames: 64, rotSpeed: rand(-2, 2) });
  }
  L.bhGlow.spawn(p.x, p.y + 1.2, p.z, 0, 0, 0, { size: [1.5 * s, 7 * s], life: 0.4, color: [1, 0.5, 0.2], alpha: 1 });
}

/**
 * Binds `form` ({id, ch, ctl, d}) to the player at the current unit's position/facing, swapping model visibility.
 * Runtime values (hp, stamina, focus) are left to the caller. loco=false: the caller starts an action right away (forms
 * without locomotion clips, e.g. the spirit).
 */
export function swapForm(player, form, { loco = true } = {}) {
  const from = player.ch, to = form.ch;
  to.position.copy(from.position); to.setYaw(from.yaw);
  form.ctl.vy = player.ctl.vy; form.ctl.grounded = player.ctl.grounded; form.ctl.limitArea = player.ctl.limitArea;
  from.root.visible = false; to.root.visible = true;
  player.setForm(to, form.ctl, form.d, form.id);
  player.state = "idle"; player.action = null; player.queued = null; player.locoClip = null;
  player.armor.clear(); player.vel.set(0, 0, 0); player.sprinting = false; player.pdTimer = 0;
  if (loco) player.playLoco(player.act.idle, 0);
}

/** snapshot / restore of the per-unit runtime values */
export const saveVitals = (p) => ({ hp: p.hp, stamina: p.stamina, focus: p.focus, lastFocusGain: p.lastFocusGain, noRegen: p.noRegen, depleted: p.depleted });
export const loadVitals = (p, v) => Object.assign(p, v);

/** comboWindow whitelist / blacklist (same rule as player.js) */
function allowed(cw, skill) {
  if (cw.whitelist?.length) return cw.whitelist.map(String).includes(String(skill));
  if (cw.blacklist?.length) return !cw.blacklist.map(String).includes(String(skill));
  return true;
}

class Transform {
  constructor(game) {
    this.game = game;
    const F = game.assets.files;
    this.D = F.bianhuaData;
    this.T = this.D.transform; this.F = this.D.form;
    this.E = this.T.energy;
    this.langGltf = F.langGlb; this.langAnims = F.langAnims;
    this.energy = this.E.max; this.phase = "none"; this.buffs = new Map(); this.dt = 1 / 60;
  }

  // ------------------------------------------------------------------ setup
  attach(p) {
    this.p = p;
    const g = this.game;
    ensureCastClips(g, p.ch);
    this.base = { id: "wukong", ch: p.ch, ctl: p.ctl, d: p.d };
    this.cam0 = { height: g.cam.height, distance: g.cam.distance, lockDistance: g.cam.lockDistance };
    this.addWeaponNodes(this.langGltf.scene);
    const ch = new Character(this.langGltf, this.langAnims, FORM_LANG);
    ch.root.visible = false;
    g.r.scene.add(ch.root);
    this.form = { id: FORM_LANG, ch, ctl: new CapsuleController(g.world, this.langAnims.capsule, { limitArea: false, areaLatch: true }), d: this.formData() };
    this.L = ensureVfx(g.vfx);
    this.trail = new Ribbon(g.r.scene, g.vfx.tex.T_Venus_Trail, { mode: "mask", tint: [1, 0.42, 0.1], life: 0.2, gain: 2.4, max: 40 });
    g.hud.addSlot("bianhua", { key: "4", label: this.T.spell.name, order: 40, code: KEY });
    g.hud.addGauge("bianhua", { label: "变身", color: "#e0662a" });
    // form HP 0 reverts instead of killing (BUS_DeadComp.CheckIsPlayerInTransState, DeadDontTransback 0)
    const die = p.die.bind(p);
    p.die = (stiff, attacker) => (p.form === FORM_LANG ? this.beginBack("hp") : die(stiff, attacker));
    g.transform = this;
    this.installDebug();
  }

  /** weapon-skeleton sockets (Hit_Weapon_1..5, FX_Trail_Fire_*) under the weapon node; fire emitters under weapon_r */
  addWeaponNodes(scene) {
    let weapon = null, hand = null;
    // the weapon attachment node keeps its name through the optimizer (node extras may not survive gltfpack)
    scene.traverse((o) => { if (o.name === "weapon" && !o.isBone) weapon ??= o; if (o.name === "weapon_r" && !o.isMesh) hand ??= o; });
    if (!weapon || !hand) throw new Error("gycy_lang.glb: weapon attachment / weapon_r node missing");
    for (const s of this.T.weaponSockets) {
      const n = new THREE.Object3D(); n.name = s.name; n.position.fromArray(s.pos); weapon.add(n);
    }
    this.firePts = this.T.weaponFire.points.map((pt, i) => {
      const n = new THREE.Object3D(); n.name = `bh_weaponFire_${i}`; n.position.fromArray(pt); hand.add(n); return n.name;
    });
  }

  /** player.json-schema data of the form; stats from the Destined One's (FUStPlayerTransAttrDesc 12) */
  formData() {
    const F = this.F, S = this.base.d.stats, A = F.statsFromDestinedOne;
    const stats = {
      ...S, hpMax: Math.round(S.hpMax * A.hpMul + A.hpBase), attack: S.attack * A.atkMul + A.atkBase,
      defense: S.defense * A.defMul + A.defBase, critRate: S.critRate * A.critRateMul + A.critRateBase,
      critMultiplier: S.critMultiplier * A.critMultiplierMul + A.critMultiplierBase,
      dmgAddition: S.dmgAddition * A.dmgAdditionMul + A.dmgAdditionBase, dmgDef: S.dmgDef * A.dmgDefMul + A.dmgDefBase,
      tenacity: (S.tenacity ?? 0) * A.tenacityMul + A.tenacityBase, trueDamageRatio: A.trueDamageRatio,
    };
    return {
      stats, movement: F.movement, stamina: F.stamina, dodge: F.dodge, lightCombo: F.lightCombo, sprintLight: F.lightCombo[0],
      heavy: F.heavy, focus: F.focus, gourd: F.gourd, hitReactions: F.hitReactions, reboundClips: F.reboundClips,
    };
  }

  reset() {
    const p = this.p;
    this.energy = this.E.max; // resting refills (BUS_PlayerRestComp)
    this.phase = "none"; this.buffs = new Map(); this.swapped = false;
    if (p.form === FORM_LANG) this.restoreBase(false);
    this.trail.count = 0;
  }

  /** back to the Destined One after a fight reset (Player.reset already ran on the form) */
  restoreBase() {
    const p = this.p, pos = p.ch.position.clone(), yaw = p.ch.yaw;
    swapForm(p, this.base);
    p.ch.position.copy(pos); p.ch.setYaw(yaw);
    p.hp = p.maxHp; p.stamina = p.maxStamina; p.focus = 0; p.gourdCharges = p.d.gourd.charges;
    this.applyCamera(false);
  }

  applyCamera(form) {
    const cam = this.game.cam, c = this.T.camera;
    if (!form) { Object.assign(cam, this.cam0); return; }
    // CameraBoom1: arm 950 cm at capsule centre + 140 cm (Destined One: 470 cm) -> scale the port's distances
    const k = c.armLength / c.wukongArmLength;
    cam.distance = this.cam0.distance * k; cam.lockDistance = Math.max(this.cam0.lockDistance, cam.distance);
    cam.height = this.langAnims.capsule.halfHeight + c.boomZ;
  }

  // ------------------------------------------------------------------ module hooks
  get inForm() { return this.p.form === FORM_LANG; }
  get busy() { return this.phase !== "none" || this.inForm; }

  owns(name) {
    if (name === "bianhua:toggle") return true;
    return this.inForm && (name === "light" || name === "heavy" || name === "gourd");
  }

  bufferable(name) {
    const ch = this.p.ch;
    if (name === "bianhua:toggle" || name === "gourd") return true;
    return ch.inEvent("inputBuffer") || ch.inEvent("comboWindow") || ch.inEvent("dodgeInputBuffer");
  }

  update(dt, active) {
    const g = this.game, p = this.p;
    this.dt = dt;
    if (g.state === "fight") this.tickEnergy(dt);
    for (const [b, t] of this.buffs) { const left = t - dt; if (left <= 0) this.buffs.delete(b); else this.buffs.set(b, left); }
    // born / return montages cancelled through their combo / dodge windows end the phase too
    const k = p.action?.kind;
    if (this.phase === "born" && k !== "bianhua:born") this.phase = "form";
    if (this.phase === "return" && k !== "bianhua:return") this.phase = "none";
    if (active && g.input.wasPressed(KEY)) p.press("bianhua:toggle");
    this.hud();
  }

  tickEnergy(dt) {
    const E = this.E;
    if (this.inForm) {
      // BUS_TransEnergyComp: CurEnergy -= EnergyConsumeSpeed*dt while Transforming; buff 12100 -1/s while sprinting
      this.spendEnergy((E.drainPerSec + (this.p.sprinting ? E.sprintDrainPerSec : 0)) * dt);
    } else if (this.phase === "none") this.energy = Math.min(E.max, this.energy + E.regenPerSec * dt);
  }

  spendEnergy(n) {
    if (!this.inForm || !(n > 0)) return;
    this.energy = Math.max(0, this.energy - n);
    if (this.energy <= 0 && this.phase === "form") { this.game.debugLog({ ev: "bianhuaEnd", reason: "energy" }); this.beginBack("energy"); }
  }

  hud() {
    const h = this.game.hud, E = this.E, f = this.energy / E.max;
    h.setSlot("bianhua", { cd: this.inForm ? 0 : 1 - f, ready: this.inForm || (f >= 1 && this.p.form === "wukong"), active: this.inForm,
      text: this.inForm ? "" : `${Math.floor(this.energy)}` });
    h.setGauge("bianhua", f, true);
  }

  canInterrupt(name, A) {
    const p = this.p, ch = p.ch;
    if (A.kind?.startsWith("bianhua:") && A.kind !== "bianhua:born") return false;
    if (name === "bianhua:toggle") {
      if (A.kind === "hit" || A.kind === "knockdown") return false;
      return ch.inEvent("comboWindow") || ch.inEvent("dodgeWindow") || ch.inEvent("moveWindow");
    }
    if (name === "gourd") return true;
    // inside a combo window the form's light/heavy are always consumed here (start() applies the CCG rules), so the
    // built-in Destined One combo path never sees them
    return ch.activeEvents("comboWindow").length > 0;
  }

  start(name, dir, from) {
    const p = this.p, A = from === "action" ? p.action : null;
    if (name === "gourd") return true; // FUStPlayerTransUnitConfDesc 1200 DrinkSkillId 0: no gourd while transformed
    if (name === "bianhua:toggle") {
      if (p.form === FORM_LANG) return this.phase === "form" ? this.beginBack("cast") : false;
      return this.beginCast();
    }
    const spec = name === "light" ? this.nextLight(A) : this.nextHeavy(A);
    if (!spec) return false;
    const cw = A && p.ch.activeEvents("comboWindow")[0];
    if (cw && !allowed(cw, spec.skill)) return false;
    const step = name === "light" ? (spec.step ?? 1) - 1 : undefined;
    return p.startAttack(name, spec, dir, { step });
  }

  /** CCG_player_gycy_lang light chain: R1_01..04 (Fire variants at 满棍势), loops back to R1_01 */
  nextLight(A) {
    const F = this.F, step = A?.kind === "light" ? (A.step + 1) % F.lightCombo.length : 0;
    return (this.p.focusPips >= 1 ? F.lightComboFire : F.lightCombo)[step];
  }

  /** heavy branch: R2_01 -> R2_02 while buff 12030 (R2-01 hit); at 满棍势 Fire variants, after a dodge (buffs
   * 12060-12063) the directional R2_F/B/S_Fire */
  nextHeavy(A) {
    const H = this.F.heavy, full = this.p.focusPips >= 1;
    if (A?.kind === "heavy") {
      const s = A.spec?.skill;
      if (!this.buffs.has(12030)) return null;
      return s === 12031 ? H.r2Follow : s === 12041 ? H.r2FireFollow : null;
    }
    if (!full) return H.r2;
    if (A && (A.kind === "dodge" || A.kind === "perfectDodge")) {
      const dir = this.p.ch.activeEvents("buff").map((e) => this.F.dodge.dirBuffs[String(e.buff)]).find(Boolean);
      if (dir) return H.dodgeFire[dir === "F" ? "F" : dir === "B" ? "B" : "S"];
    }
    return H.r2Fire;
  }

  onActionEnd(A) {
    if (A.kind === "bianhua:cast") { if (!this.swapped) this.swapIn(); return true; }
    if (A.kind === "bianhua:back") { if (this.inForm) this.swapOut(); return true; }
    if (A.kind === "bianhua:born") { this.phase = "form"; return false; }
    if (A.kind === "bianhua:return") { this.phase = "none"; return false; }
    return false;
  }

  // ------------------------------------------------------------------ transformation flow
  beginCast() {
    const p = this.p, g = this.game;
    if (p.form !== "wukong" || this.phase !== "none" || g.spirit?.busy) return false;
    if (this.energy < this.E.max) { g.hud.toast("变身能量未满", 0.8); return false; }
    if (!p.ctl.grounded) return false; // BUIAUseSkillByType: no BianShen while falling
    p.sprinting = false;
    if (!p.playAction("bianhua:cast", this.T.cast.clip, { fade: 0.1 })) return false;
    p.aimAtStart(p.inputDir());
    this.phase = "cast"; this.swapped = false; this.hidden = false;
    g.debugLog({ ev: "bianhuaCast", energy: this.energy });
    return true;
  }

  swapIn() {
    const p = this.p, g = this.game;
    this.swapped = true;
    this.saved = saveVitals(p);
    swapForm(p, this.form);
    p.hp = p.maxHp; // PlayerTransAttrDataInit: Hp = HpMax; born effect 2200000 RecoverAttr 151 100%
    p.stamina = p.maxStamina; p.focus = 0; p.lastFocusGain = p.time; p.noRegen = 0; p.depleted = 0;
    this.applyCamera(true);
    this.buffs.clear();
    p.playAction("bianhua:born", this.T.born.clip, { fade: 0.05, spec: this.T.born.spec });
    this.phase = "born";
    fireBurst(this.L, _p.copy(p.ch.position).setY(p.ch.position.y + 0.2), 1.2);
    g.vfx.shake("Middle", null);
    g.debugLog({ ev: "bianhuaIn", hp: p.hp, maxHp: p.maxHp, wukongHp: this.saved.hp });
  }

  /** reason: cast (key 4) | energy | hp */
  beginBack(reason) {
    const p = this.p;
    if (!this.inForm || this.phase === "back") return false;
    this.phase = "back"; this.backReason = reason;
    p.invulnUntil = p.time + this.T.back.swapAt; // buff 12009: ImmueDamage/Stiff until the swap
    p.sprinting = false;
    p.playAction("bianhua:back", this.T.back.clip, { fade: 0.08 });
    this.game.debugLog({ ev: "bianhuaBack", reason, energy: +this.energy.toFixed(2), formHp: p.hp });
    return true;
  }

  swapOut() {
    const p = this.p, g = this.game, E = this.E, R = this.T.wukongReturn.energy;
    // BUS_TransPlayerDataBindComp attr 188: at most TransEnergyMax - EnergyMinConsume survives the return
    this.energy = Math.min(this.energy, E.capAfterReturn);
    swapForm(p, this.base);
    loadVitals(p, this.saved);
    this.applyCamera(false);
    // effect 2200999 RecoverAttr 188 (ratio) on AM_wukong_trans_from_gycy_lang [INFERENCE: ratio of max]
    this.energy = Math.min(E.max, this.energy + E.max * (R.float[0] ?? 0) / 10000);
    this.phase = "return";
    p.playAction("bianhua:return", this.T.wukongReturn.clip, { fade: 0.05 });
    transSmoke(this.L, p.ch.position, 1.1);
    g.debugLog({ ev: "bianhuaOut", reason: this.backReason, hp: p.hp, energy: +this.energy.toFixed(2) });
  }

  // ------------------------------------------------------------------ per-frame after movement (montage time is current)
  resolveHits() {
    const p = this.p, ch = p.ch, A = p.action;
    if (A?.kind === "bianhua:cast") {
      const t = ch.clipTime;
      if (!this.hidden && t >= this.T.cast.hideAt) { this.hidden = true; ch.root.visible = false; transSmoke(this.L, ch.position, 1); }
      if (!this.swapped && t >= this.T.cast.swapAt) this.swapIn();
      else if (Math.random() < 0.6) this.L.bhFire.spawn(ch.position.x + rand(-0.4, 0.4), ch.position.y + rand(0.4, 1.4), ch.position.z + rand(-0.4, 0.4),
        0, rand(1, 2.5), 0, { size: [0.4, 1.0], life: 0.4, color: [1, 0.7, 0.45], frames: 64 });
    }
    if (A?.kind === "bianhua:back" && this.inForm && ch.clipTime >= this.T.back.swapAt) this.swapOut();
    if (!this.inForm) { this.trail.update(this.dt, false); return; }
    for (const e of ch.crossed("trigger")) this.applyEffect(e.effect);
    this.formVfx();
  }

  /** CostPlayerTransEnergy / IncreasePevalue / AddBuff / RecoverAttr rows referenced by hits and montage triggers */
  applyEffect(id) {
    const T = this.T, k = String(id), p = this.p;
    if (T.energyEffects[k] != null) this.spendEnergy(T.energyEffects[k]);
    if (T.peEffects[k] != null) {
      const v = T.peEffects[k];
      if (v > 0) p.gainFocus(v); else p.focus = Math.max(0, p.focus + v);
    }
    if (T.buffEffects[k] != null) {
      const b = T.buffEffects[k], d = T.buffs[String(b)]?.duration;
      this.buffs.set(b, d > 0 ? d : 1e9);
    }
    const h = T.healEffects[k];
    if (h?.attr === 151) p.hp = Math.min(p.maxHp, p.hp + (h.ratio ? p.maxHp * h.value / 10000 : h.value));
  }

  onHitLanded(h) {
    if (!this.inForm) return;
    for (const id of h.event.effects || []) this.applyEffect(id);
  }

  // ------------------------------------------------------------------ form visuals
  formVfx() {
    const p = this.p, ch = p.ch, L = this.L, dt = 1 / 60;
    // weapon fire trail (NG_GYGY_Lang_04_r1_trail / trail1 / Weapon_Trail windows) between FX_Trail_Fire_01/02
    const trails = p.state === "action" ? ch.activeEvents("vfx").filter((e) => /trail|Fire_sword/i.test(e.name || "")) : [];
    const a = trails.length ? ch.bonePos("FX_Trail_Fire_01", _p) : null, b = trails.length ? ch.bonePos("FX_Trail_Fire_02", _q) : null;
    this.trail.update(this.dt, !!(a && b), a, b);
    // flames at the notify sockets (FX_Weapon_Trail_01 / FX_Weapon_HuoYan_02 ...) while those windows run
    for (const e of trails) {
      if (Math.random() > 0.7) continue;
      const s = e.socket && ch.bonePos(e.socket, _p);
      if (s) L.bhFire.spawn(s.x, s.y, s.z, rand(-0.5, 0.5), rand(0.5, 1.5), rand(-0.5, 0.5), { size: [0.5, 1.1], life: rand(0.25, 0.4), color: [1, 0.75, 0.5], frames: 64 });
    }
    // 满棍势: the weapon's six NG_GYCY_Lang_04_WeaponFire_01 emitters burn [INFERENCE: shown with full 气势 / Fire skills]
    const fire = p.focusPips >= 1 || /_Fire$/.test(ch.clipName || "");
    if (fire) for (const n of this.firePts) {
      if (Math.random() > 0.35) continue;
      const s = ch.bonePos(n, _p);
      if (s) L.bhFire.spawn(s.x, s.y, s.z, rand(-0.2, 0.2), rand(0.6, 1.4), rand(-0.2, 0.2), { size: [0.35, 0.8], life: rand(0.3, 0.5), color: [1, 0.7, 0.45], frames: 64, rotSpeed: rand(-1, 1) });
    }
    // born slash / heavy landings (NG_GYCY_Lang_04_bs_fire, NG_Wukong_HS_Daolang_zadi) at the montage's vfx points
    for (const e of ch.crossed("vfx")) if (/bs_fire|Daolang_zadi|BaoFa/i.test(e.name || "")) fireBurst(L, (e.socket && ch.bonePos(e.socket, _p)) || _p.copy(ch.position), 0.8);
  }

  // ------------------------------------------------------------------ debug (window.__WK_DEBUG__.bianhua)
  installDebug() {
    const dbg = window.__WK_DEBUG__;
    if (!dbg) return;
    dbg.bianhua = {
      state: () => ({ form: this.p.form, phase: this.phase, energy: +this.energy.toFixed(2), maxEnergy: this.E.max, hp: this.p.hp, maxHp: this.p.maxHp,
        wukongHp: this.inForm ? this.saved?.hp : this.p.hp, focus: this.p.focus, buffs: [...this.buffs.keys()], action: this.p.action?.kind ?? null, clip: this.p.ch.clipName }),
      setEnergy: (v) => { this.energy = Math.max(0, Math.min(this.E.max, v)); },
      toggle: () => this.p.press("bianhua:toggle"),
    };
  }
}

export const makeTransform = (game) => new Transform(game);
