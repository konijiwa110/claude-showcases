// 虎先锋 stone visuals + the 化石遁形 stone decoy unit, and the montage-driven body dissolves (tiger + player death).
// Data: local research notes summarised in extract/notes/vfx.md (§ stone); numbers below cite their tables/assets.
//  * tiger body material MF_HFM_HuXianFeng_Yi_Body = MLI_Monster_Skin_Layers with ML_Stone blended by MLB_Stone; fur cards
//    (comp tag Hair) = M_hfm_huxianfeng_yi_hair_headcards. BANS_DispLibTimedModifyMaterial / BANS_GSSetCurveValueToMesh /
//    BANS_SetCurveValueToHair notifies drive RockMaskIntensity, Globle_Opacity / Cha_Opacity (body + fur) and
//    HairTransparency; modes: UCurve = curve over the normalised notify window, Standard = Value in the window, then
//    EndValue over EndStageDuration, control released after DelayTimeAfterStop.
//  * Unit_HFM_Hu_Stone_Fake (FUStSummonCommDesc 20220201, ResID 202202): static mesh HuStoneMesh_New1 (two rock MICs of
//    M_SkinPacked: Rock D T_HFM_HuStone_D, tint #81772B), +320 cm over the summoner, mesh at (-50,0,-340) under the
//    capsule (half 340.64 -> stands on the floor), SummonAliveTime 2.5 s, Timeline Cha_Opacity (2.0 s 1 -> 2.7007 s 0),
//    NG_HuStone_Rock_Body1 at 0 s, NG_HuStone_Rock_Body2 at 1.9 s; birth buffs 202202 (ImmueDamage + BounceAttack ->
//    player hits rebound), 202203 (CantBeLock), 202204 (on BeAttacked: tiger gets 202205 for 1 s). No death row.
//  * tiger death: UDDConfig dep01 NormalDissolveDBC DBC_Common_Die_Dissolve_Big (NG_Common_die +
//    C_common_die_Dissolve_Intensity); FUStDefeatSlowTimeConfigDesc 202201 (5 s, DefeatSlowTime curve).
//  * player death: AM_Wukong_die_* notifies on MLB_dissolve_wukong_die_inst (Dissolve_Intensity, Body_brightness_Glow).
import * as THREE from "three";
import { HitTracker } from "./combat.js";

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const MAT_CLASSES = new Set(["BANS_DispLibTimedModifyMaterial", "BANS_GSSetCurveValueToMesh", "BANS_SetCurveValueToHair"]);

function keysAt(keys, t) {
  if (!keys?.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
    const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
    return v0 + (v1 - v0) * (t - t0) / Math.max(1e-6, t1 - t0);
  }
  return keys[keys.length - 1][1];
}
const curveName = (c) => (c?.ObjectName || "").split("'")[1] || "";

// fragment injection shared by every patched material: rock layer, dithered opacity, noise dissolve with an ember edge
const FX_PARS = /* glsl */ `
uniform float uFxRock, uFxOpacity, uFxDissolve, uFxGlow, uFxRockTiling;
uniform vec3 uFxRockTint, uFxEmber;
uniform sampler2D uFxRockMap;
float fxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fxNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1, 0)), f.x), mix(fxHash(i + vec2(0, 1)), fxHash(i + vec2(1, 1)), f.x), f.y); }
`;

/** patches a MeshStandardMaterial with the shared uniforms object U (uFx*) */
function patchMaterial(mat, U, { rock = false } = {}) {
  if (mat.userData.stoneFx) return;
  mat.userData.stoneFx = true;
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    let fs = sh.fragmentShader.replace("#include <common>", "#include <common>\n" + FX_PARS);
    if (rock) {
      fs = fs.replace("#include <map_fragment>", `#include <map_fragment>
#ifdef USE_MAP
        if (uFxRock > 0.001) { vec3 rk = texture2D(uFxRockMap, vMapUv * uFxRockTiling).rgb; diffuseColor.rgb = mix(diffuseColor.rgb, rk * uFxRockTint, uFxRock); }
#endif`)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.9, uFxRock);")
        .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n metalnessFactor *= 1.0 - uFxRock;");
    }
    fs = fs.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      if (uFxOpacity < 0.999) { if (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= uFxOpacity) discard; }
#ifdef USE_MAP
      if (uFxDissolve < 0.999) { float dn = fxNoise(vMapUv * 48.0) * 0.6 + fxNoise(vMapUv * 9.0) * 0.4; if (dn > uFxDissolve) discard;
        totalEmissiveRadiance += uFxEmber * smoothstep(uFxDissolve - 0.06, uFxDissolve, dn); }
#endif
      totalEmissiveRadiance += diffuseColor.rgb * uFxGlow;`);
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : "") + (rock ? "+stonefx-rock" : "+stonefx");
  mat.needsUpdate = true;
}

function makeUniforms(rockMap, cfg) {
  return {
    uFxRock: { value: 0 }, uFxOpacity: { value: 1 }, uFxDissolve: { value: 1 }, uFxGlow: { value: 0 },
    uFxRockTiling: { value: cfg?.tiling ?? 4 }, uFxRockTint: { value: new THREE.Color().setRGB(...(cfg?.albedo ?? [0.62, 0.56, 0.45])) },
    uFxEmber: { value: new THREE.Color().setRGB(...(cfg?.ember ?? [3.0, 1.2, 0.35])) }, uFxRockMap: { value: rockMap },
  };
}

export class StoneFx {
  constructor(game, vfx, cfg) {
    this.game = game; this.vfx = vfx; this.cfg = cfg || {};
    this.ownsTigerVisibility = true;
    const L = new THREE.TextureLoader();
    const tex = (f, srgb = true) => { const t = L.load(`assets/vfx/${f}`); t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
    this.rockD = tex("T_HFM_HuStone_D.webp");
    this.rockWeaponD = tex("T_HFM_HuStone_Weapon_D.webp");
    this.rockN = tex("T_HFM_HuStone_N.webp", false);
    // the decoy mesh shares the tiger body UV layout; the rock layer is tiled (M_SkinPacked Detail Tiling 20)
    const rep = this.cfg.rock?.tiling ?? 20;
    for (const t of [this.rockD, this.rockWeaponD, this.rockN]) t.repeat.set(rep, rep);
    // shared uniforms: tiger body / tiger fur / player
    this.T = makeUniforms(this.rockD, this.cfg.rock);
    this.TH = makeUniforms(this.rockD, this.cfg.rock);
    this.P = makeUniforms(this.rockD, this.cfg.rock);
    this.P.uFxEmber.value.setRGB(...(this.cfg.playerDeath?.ember ?? [3.0, 1.6, 0.7]));
    this.patched = new WeakSet();
    this.decoys = [];
    this.death = null; this.slowmo = null;
    this.vals = { tiger: {}, player: {} };
  }

  // ------------------------------------------------------------------ material patching
  patchCharacter(ch, who) {
    if (this.patched.has(ch.model)) return;
    this.patched.add(ch.model);
    ch.model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m?.isMeshStandardMaterial) continue;
        if (who === "tiger") {
          const hair = /hair|fur/i.test(m.name), body = /_Body$/i.test(m.name);
          patchMaterial(m, hair ? this.TH : this.T, { rock: body });
        } else patchMaterial(m, this.P);
      }
    });
  }

  // ------------------------------------------------------------------ montage material parameters
  /** current value of each driven parameter channel ({rock, opacity, hair, dissolve, glow}) or undefined = released.
   * A montage switch "stops" the notifies that were inside their window: they run their end stage from the value
   * they had (EndValue over EndStageDuration, released after max(DelayTimeAfterStop, EndStageDuration)). */
  evalNotifies(ch, who, dt) {
    const c = ch.cur, out = {};
    const st = (this.notifyState ||= {})[who] ||= { stamp: null, active: {}, tails: {} };
    if (c && st.stamp !== c.stamp) {
      for (const [k, a] of Object.entries(st.active)) if (a.inWindow) {
        const P = a.e.ProcessValue;
        if (!P) continue;
        st.tails[k] = { v0: a.v, t: 0, esd: P.EndStageDuration ?? 0, end: P.EndValue ?? a.v, hold: Math.max(a.nf.props?.DelayTimeAfterStop ?? 0, P.EndStageDuration ?? 0) };
      }
      st.stamp = c?.stamp; st.active = {};
    }
    for (const [k, tl] of Object.entries(st.tails)) {
      tl.t += dt;
      if (tl.t > tl.hold) { delete st.tails[k]; continue; }
      out[k] = tl.esd > 0 ? tl.v0 + (tl.end - tl.v0) * Math.min(1, tl.t / tl.esd) : tl.v0;
    }
    if (!c?.meta?.notifies) return out;
    const t = c.time;
    const starts = {};
    st.active = {};
    for (const nf of c.meta.notifies) {
      if (!MAT_CLASSES.has(nf.class) || t < nf.start) continue;
      const p = nf.props || {};
      const hairOnly = (p.FilterMode?.CompTags || []).includes("Hair") || nf.class === "BANS_SetCurveValueToHair";
      const entries = p.SetScalarParam || p.FloatCurveParamList || [];
      for (const e of entries) {
        const ch_ = this.channel(e.ParamName, hairOnly);
        if (!ch_ || (starts[ch_] ?? -1) > nf.start) continue;
        const v = this.notifyValue(nf, e, t);
        if (v === undefined) continue;
        out[ch_] = v; starts[ch_] = nf.start;
        st.active[ch_] = { nf, e, v, inWindow: t <= (nf.end ?? nf.start) };
        delete st.tails[ch_];
      }
    }
    return out;
  }

  channel(name, hairOnly) {
    switch (name) {
      case "RockMaskIntensity": return "rock";
      case "Globle_Opacity": case "Cha_Opacity": case "GlobalOpacity": return hairOnly ? "hair" : "opacity";
      case "HairTransparency": return "hair";
      case "Dissolve_Intensity": return "dissolve";
      case "Body_brightness_Glow": return "glow";
      default: return null; // arm stone masks (RockMaskIntensity_L/_R, SSS_Temp_*), RGBMaskAlpha_*, dissolve edge styling
    }
  }

  notifyValue(nf, e, t) {
    const s = nf.start, end = nf.end ?? s, len = Math.max(1e-4, end - s);
    const delay = nf.props?.DelayTimeAfterStop ?? 0;
    const P = e.ProcessValue;
    const curve = this.cfg.curves?.[curveName(P ? P.Curve : e.CurveFloat)];
    const win = (tt) => {
      if (!P) return e.NotUseCurve ? e.TargetFloatValue : keysAt(curve, (tt - s) / len); // SetCurveValueTo*
      const mode = (P.Mode || "").split("::").pop();
      if (mode === "UCurve") return curve ? keysAt(curve, (tt - s) / len) * (P.Scale || 1) : P.Value;
      return curve && P.Scale > 0 ? keysAt(curve, (tt - s) / len) * P.Scale : P.Value; // Standard (TurnStone_01_02 hide uses its curve)
    };
    if (t <= end) return win(t);
    if (!P) return undefined;
    const esd = P.EndStageDuration ?? 0, v1 = win(end);
    if (esd > 0 && t <= end + esd) return v1 + ((P.EndValue ?? v1) - v1) * (t - end) / esd;
    if (t <= end + Math.max(delay, esd)) return esd > 0 ? P.EndValue : v1;
    return undefined; // control released -> material default
  }

  /** eases released channels back to their defaults (montage switches cut notify windows short) */
  apply(who, target, U, Uh, dt) {
    const defaults = { rock: 0, opacity: 1, hair: 1, dissolve: 1, glow: 0 };
    const cur = this.vals[who];
    for (const k of Object.keys(defaults)) {
      const goal = target[k] ?? defaults[k];
      const v = cur[k] ?? defaults[k];
      cur[k] = target[k] !== undefined ? goal : v + (goal - v) * Math.min(1, dt / 0.25);
    }
    U.uFxRock.value = cur.rock; U.uFxOpacity.value = cur.opacity; U.uFxDissolve.value = cur.dissolve; U.uFxGlow.value = cur.glow;
    if (Uh) { Uh.uFxOpacity.value = cur.opacity * cur.hair; Uh.uFxDissolve.value = cur.dissolve; }
    return cur;
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    const g = this.game, boss = g.boss, player = g.player;
    this.patchCharacter(boss.ch, "tiger");
    this.patchCharacter(player.ch, "player");
    // tiger: stone skin / hide / show from the running montage; death dissolve after the die montage
    const tv = this.evalNotifies(boss.ch, "tiger", dt);
    if (this.death) tv.dissolve = this.deathDissolve(dt);
    else if (boss.state === "dead") this.startDeath(boss);
    const cur = this.apply("tiger", tv, this.T, this.TH, dt);
    boss.ch.model.visible = cur.opacity > 0.01 && cur.dissolve > 0.002;
    // player: death dissolve notifies (MLB_dissolve_wukong_die_inst)
    this.apply("player", this.evalNotifies(player.ch, "player", dt), this.P, null, dt);
    this.updateDecoys(dt);
    this.updateSlowmo();
  }

  // ------------------------------------------------------------------ tiger death
  startDeath(boss) {
    const D = this.cfg.death || {};
    if (!this.slowmo && D.slowmo) {
      this.slowmo = { t0: performance.now(), base: this.game.timeScale ?? 1, keys: D.slowmo.curve, total: D.slowmo.total };
    }
    // DBC_Common_Die_Dissolve_Big starts when the die montage has played out [INFERENCE: DBC timing not decodable]
    if (!boss.ch.cur?.ended) return;
    this.death = { t: 0, keys: D.dissolve || [[0, 1], [1.7, 0]], timeScale: D.timeScale ?? 1 };
    this.deathFx = this.vfx.burst(D.fx || "NG_Common_die", boss.ch.position.clone(), 1, { ch: boss.ch, socket: "root" });
    // the system is notify-timed in vfx.json; here it runs for the whole dissolve instead of one notify window
    if (this.deathFx) { this.deathFx.timed = false; this.deathFx.dur = this.death.keys[this.death.keys.length - 1][0] * this.death.timeScale; }
    this.game.debugLog?.({ ev: "tigerDissolve" });
  }

  deathDissolve(dt) {
    const d = this.death;
    d.t += dt;
    const v = keysAt(d.keys, d.t / d.timeScale);
    return v;
  }

  /** FUStDefeatSlowTimeConfigDesc 202201: TotalTime 5 s of world time dilation (DefeatSlowTime curve) */
  updateSlowmo() {
    const s = this.slowmo;
    if (!s || s.done) return;
    const t = (performance.now() - s.t0) / 1000;
    if (t >= s.total) { this.game.timeScale = s.base; s.done = true; return; }
    this.game.timeScale = s.base * keysAt(s.keys, t);
  }

  // ------------------------------------------------------------------ 化石遁形 decoy
  summon(boss, effect) {
    const C = this.cfg.decoy || {};
    const src = this.game.assets?.files?.stoneDecoyGlb;
    if (!src) { this.game.debugLog?.({ ev: "stoneDecoyMissing" }); return; }
    const U = makeUniforms(this.rockD, this.cfg.rock);
    const root = new THREE.Group();
    const scene = src.scene.clone(true);
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const weapon = /Weapon/i.test(o.material?.name || "");
      const m = new THREE.MeshStandardMaterial({ map: weapon ? this.rockWeaponD : this.rockD, normalMap: this.rockN, normalScale: new THREE.Vector2(2, 2), roughness: C.roughness ?? 0.8, metalness: 0,
        color: new THREE.Color().setRGB(...(C.tint ?? [1, 1, 1])) });
      patchMaterial(m, U);
      o.material = m; o.castShadow = true; o.receiveShadow = true;
    });
    root.add(scene);
    // summoner capsule centre +320 cm, mesh at (-50, 0, -340) under the decoy capsule (half 340.64) -> on the floor,
    // 0.5 m behind the summoner along its facing; yaw = the summoner's facing (mesh +X = UE forward)
    const f = boss.ch.forward();
    const p = boss.ch.position.clone().addScaledVector(f, (C.meshOffset?.[0] ?? -0.5));
    const gnd = this.game.world.groundAt(p.x, p.z, p.y + 3.2, 8);
    if (gnd) p.y = gnd.point.y;
    root.position.copy(p);
    root.rotation.y = Math.atan2(f.x, f.z) - Math.PI / 2;
    this.game.r.scene.add(root);
    root.updateMatrixWorld(true);
    const d = { root, U, t: 0, fwd: f.clone(), fired: new Set(), hits: new HitTracker(this.game.player.ch, 0.5), hp: C.hp ?? 2880 };
    this.decoys.push(d);
    this.game.debugLog?.({ ev: "stoneClone", phase: "spawn", summon: effect?.int?.[0] ?? null, pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] });
  }

  updateDecoys(dt) {
    const C = this.cfg.decoy || {}, alive = C.alive ?? 2.5;
    let w = 0;
    for (const d of this.decoys) {
      d.t += dt;
      for (const [name, at] of C.fx || []) if (!d.fired.has(name) && d.t >= at) {
        d.fired.add(name);
        this.vfx.burst(name, d.root.position.clone().addScaledVector(d.fwd, 1.6), 1, { fwd: d.fwd });
      }
      d.U.uFxOpacity.value = keysAt(C.opacity || [[2.0, 1], [2.7, 0]], d.t);
      this.decoyHits(d);
      if (d.t >= alive) {
        this.game.r.scene.remove(d.root);
        d.root.traverse((o) => { if (o.isMesh) o.material.dispose(); });
        this.game.debugLog?.({ ev: "stoneClone", phase: "expire" });
        continue;
      }
      this.decoys[w++] = d;
    }
    this.decoys.length = w;
  }

  /** player melee vs the decoy's hurt capsule: ImmueDamage + BounceAttack (202202) -> rebound montage, stone hit FX;
   * 202204 BeAttacked -> tiger buff 202205 (1 s flag; only TurnStone_01_03, not in this fight, reads it) */
  decoyHits(d) {
    const pl = this.game.player, spec = pl.action?.spec;
    if (pl.state !== "action" || !spec?.damage) return;
    const H = this.cfg.decoy?.hurt || { a: [-0.6, 1.5, 0], b: [3.6, 1.5, 0], r: 1.5 };
    _a.set(...H.a).applyMatrix4(d.root.matrixWorld); _b.set(...H.b).applyMatrix4(d.root.matrixWorld);
    const hits = d.hits.test({ a: _a, b: _b, r: H.r }, "stoneDecoy");
    for (const h of hits) {
      const ids = h.event.effects || h.event.effectIds || [h.event.id];
      if (!ids.map(String).some((id) => spec.damage[id])) continue;
      this.vfx.burst("hit_stone", h.point);
      this.game.boss.addBuff?.("202205", 1);
      this.game.debugLog?.({ ev: "stoneClone", phase: "hit", skill: spec.skill });
      const clip = pl.d.reboundClips?.[String(spec.skill)];
      if (clip) { pl.playAction("rebound", clip, { fade: 0.05 }); this.game.debugLog?.({ ev: "rebound", clip, by: "stoneDecoy" }); }
      break;
    }
  }

  clear() {
    for (const d of this.decoys) this.game.r.scene.remove(d.root);
    this.decoys.length = 0;
    this.death = null; this.deathFx = null;
    if (this.slowmo && !this.slowmo.done) this.game.timeScale = this.slowmo.base;
    this.slowmo = null;
    this.vals = { tiger: {}, player: {} }; this.notifyState = {};
    for (const U of [this.T, this.TH, this.P]) { U.uFxRock.value = 0; U.uFxOpacity.value = 1; U.uFxDissolve.value = 1; U.uFxGlow.value = 0; }
  }
}
