// Game audio from the Wwise banks (extract/audio/build.py -> web/assets/audio/audio.json + sfx.bin + bgm_*.ogg).
// Montage sounds: every frame the current clip of each actor (game.player.ch / game.boss.ch, so transformations and
// new skill bundles are covered) is scanned for audio notifies crossed during the last Character.update, with the same
// rule as Character.crossed: BAN_GSAkEvent (props.AkEvent), BAN_GSPlayMappedSoundFX (EquipPosition:ActionTypeID ->
// FUStAudioExtendDesc event of the worn equipment) and AnimNotify_GSFootStep (unit StepAudioPath).
// Hits: hit(attacker, victim, h, res) composes the game's hit event name (BUS_AttackFeedbackPerformComp
// .OnPlayAttackHitAudioByRule): <PreAkEventName of HitChrAudioID>_<perform>_<material>, then _<perform>_all, then
// _normal_meat. BGM: EVT_music_hfm_battle_huxianfeng_* (music switch container on STA_music_hfm_battle_huxianfeng).
// The AudioContext starts on the start click (unlock); decoding runs before that on an OfflineAudioContext.
import * as THREE from "three";
import { fetchAsset } from "./assets.js";

const DIR = "assets/audio/";
const DECODE_RATE = 32000;   // Opus SFX are band-limited well below 16 kHz at 32 kb/s
const MAX_VOICES = 40;
// Manifest gains restore Wwise's relative mix (node + bus volumes) but not its HDR/loudness stage, so the whole mix sits
// low; a fixed make-up gain into a limiter brings it to a normal game level [INFERENCE: value chosen by ear/RMS].
const MAKEUP = 2.5;
const LATE = 0.15;           // a sound whose buffer decodes later than this after its notify is dropped
const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();

/** first value of `key` anywhere inside a notify's props */
function deepFind(o, key) {
  if (!o || typeof o !== "object") return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) { const r = deepFind(v, key); if (r !== undefined) return r; }
  return undefined;
}

/** piecewise-linear volume attenuation [[metres, gain]] (Wwise curve shapes approximated linearly) */
function curveGain(pts, d) {
  if (!pts?.length) return 1;
  if (d <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (d <= x1) { const [x0, y0] = pts[i - 1]; return y0 + (y1 - y0) * (d - x0) / Math.max(x1 - x0, 1e-6); }
  }
  return pts[pts.length - 1][1];
}

export class GameAudio {
  constructor(game, manifest) {
    this.game = game;
    this.m = manifest || null;
    this.events = this.m?.events || {};
    this.volume = 0.8; this.muted = false;
    this.ctx = null; this.loaded = false; this.loadError = null;
    this.buffers = new Map();     // pack offset -> AudioBuffer | Promise<AudioBuffer>
    this.voices = [];
    this.lastVariant = new Map();
    this.cueCache = new WeakMap(); // clip meta -> audio cues
    this.tracked = new Set();     // extra Characters (summons) whose montages make sound
    this.recent = [];             // played events (ring buffer, debug)
    this.played = 0;
    this.unmapped = new Map();    // event name -> times requested without a sound
    this.bgm = { state: "off", el: {}, buf: {}, gains: {}, cur: null, timers: [] };
    this.ready = this.m ? this.load().catch((e) => { this.loadError = String(e?.message || e); console.warn("[audio]", e); }) : null;
  }

  // ------------------------------------------------------------------ loading / context
  async load() {
    const bgm = this.m.bgm?.pieces || {};
    const [pack, ...music] = await Promise.all([fetchAsset(DIR + this.m.pack), ...Object.values(bgm).map((p) => fetchAsset(DIR + p.file))]);
    this.pack = pack;
    this.decoder = new OfflineAudioContext(1, 1, DECODE_RATE);
    const decodeBgm = new OfflineAudioContext(2, 1, 48000);
    const keys = Object.keys(bgm);
    for (let i = 0; i < keys.length; i++) {
      const p = bgm[keys[i]];
      if (p.loop) this.bgm.el[keys[i]] = URL.createObjectURL(new Blob([music[i]], { type: "audio/ogg" })); // streamed
      else this.bgm.buf[keys[i]] = await decodeBgm.decodeAudioData(music[i].slice().buffer);
    }
    this.loaded = true;
    this.warm();
  }

  /** decodes every variant in the background (sounds requested earlier decode on demand) */
  async warm() {
    for (const e of Object.values(this.events)) for (const v of e.v) { await this.buffer(v); }
  }

  buffer(v) {
    const have = this.buffers.get(v[0]);
    if (have) return have;
    const bytes = this.pack.slice(v[0], v[0] + v[1]);
    const p = this.decoder.decodeAudioData(bytes.buffer).then((b) => { this.buffers.set(v[0], b); return b; });
    this.buffers.set(v[0], p);
    return p;
  }

  /** called from the start click / Enter (user gesture): creates and resumes the AudioContext */
  unlock() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      const ctx = this.ctx = new C({ latencyHint: "interactive" });
      this.master = ctx.createGain(); this.master.connect(ctx.destination);
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003; this.limiter.release.value = 0.12;
      this.limiter.connect(this.master);
      this.mix = ctx.createGain(); this.mix.gain.value = MAKEUP; this.mix.connect(this.limiter);
      this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.mix);
      this.bgmBus = ctx.createGain(); this.bgmBus.connect(this.mix);
      this.bgmBus.gain.value = this.m?.bgm?.gain ?? 1;
      this.analysers = {};
      for (const [k, node] of [["master", this.master], ["sfx", this.sfxBus], ["bgm", this.bgmBus]]) {
        const a = ctx.createAnalyser(); a.fftSize = 2048; node.connect(a); this.analysers[k] = a;
      }
      this.applyVolume();
    }
    this.ctx.resume();
  }

  applyVolume() { if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.applyVolume(); }
  toggleMute() { this.muted = !this.muted; this.applyVolume(); this.game.hud?.toast?.(this.muted ? "静音" : "声音开启", 0.8); }

  get running() { return this.ctx?.state === "running" && this.loaded; }

  // ------------------------------------------------------------------ playback
  /**
   * Plays a Wwise event by name. at: THREE.Vector3 (fixed point) | Character | {ch, bone} (follows the bone) | null
   * (2D). who: label for the debug log. Unknown names are counted in `unmapped`.
   */
  post(name, at = null, who = "") {
    if (!name) return;
    const bgm = this.m?.bgm?.events;
    if (bgm && name === bgm.play) return void this.bgmPlay();
    if (bgm && name === bgm.lv2) return void this.bgmState("lv2");
    if (bgm && name === bgm.stop) return void this.bgmStop();
    const e = this.events[name];
    if (!e) { this.unmapped.set(name, (this.unmapped.get(name) || 0) + 1); return; }
    if (!this.running) return;
    const n = e.v.length;
    let k = Math.floor(Math.random() * n);
    if (n > 1 && k === this.lastVariant.get(name)) k = (k + 1 + Math.floor(Math.random() * (n - 1))) % n; // avoid repeat
    this.lastVariant.set(name, k);
    const c = at?.ch?.cur;
    const entry = { t: +this.game.simTime.toFixed(3), name, who, v: k, ...(c && { clip: c.name, clipTime: +c.time.toFixed(3) }) };
    this.recent.push(entry); if (this.recent.length > 300) this.recent.shift();
    this.played++;
    if (e.cat !== "footstep" && e.cat !== "mapped") this.game.debugLog?.({ ev: "sfx", name, who });
    const b = this.buffers.get(e.v[k][0]);
    if (b instanceof AudioBuffer) this.start(name, e, b, at);
    else {
      const t0 = this.ctx.currentTime;
      this.buffer(e.v[k]).then((buf) => { if (this.ctx.currentTime - t0 < LATE) this.start(name, e, buf, at); });
    }
  }

  /** stops every playing voice of an event (looping sounds), linear fade in seconds */
  stop(name, fade = 0.2) {
    for (const v of this.voices) if (v.name === name) this.fadeOut(v, fade);
  }

  fadeOut(v, fade) {
    if (v.stopped) return;
    const now = this.ctx.currentTime;
    v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.linearRampToValueAtTime(0, now + fade);
    v.stopped = true;
    try { v.src.stop(now + fade); } catch { /* ended */ }
  }

  start(name, e, buf, at) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = !!e.loop;
    const g = ctx.createGain();
    src.connect(g);
    let pan = null, fixed = null;
    if (at && e.att) {
      pan = ctx.createPanner();
      pan.panningModel = "equalpower"; pan.distanceModel = "linear"; pan.rolloffFactor = 0; // distance gain = Wwise curve
      g.connect(pan); pan.connect(this.sfxBus);
      if (at.isVector3) fixed = at.clone();
    } else g.connect(this.sfxBus);
    const voice = { name, e, src, g, pan, at, fixed };
    this.place(voice);
    src.onended = () => { const i = this.voices.indexOf(voice); if (i >= 0) this.voices.splice(i, 1); g.disconnect(); pan?.disconnect(); };
    src.start();
    this.voices.push(voice);
    if (this.voices.length > MAX_VOICES) {
      const i = Math.max(0, this.voices.findIndex((x) => !x.e.loop));
      const old = this.voices.splice(i, 1)[0];
      try { old.src.stop(); } catch { /* already stopped */ }
    }
  }

  /** world position of a voice's emitter */
  emitter(v, out) {
    if (v.fixed) return out.copy(v.fixed);
    const a = v.at;
    const ch = a.ch || a;
    // `at` may be a Character (whose prototype has a bone() method) -> only {ch, bone: "<name>"} cues carry a socket
    if (typeof a.bone === "string" && ch.bonePos?.(a.bone, out)) return out;
    out.copy(ch.position); out.y += (ch.anims?.height || 1.8) * 0.5;
    return out;
  }

  place(v) {
    if (!v.pan) { v.g.gain.value = v.e.gain; return; }
    const p = this.emitter(v, _p);
    v.pan.positionX.value = p.x; v.pan.positionY.value = p.y; v.pan.positionZ.value = p.z;
    const d = p.distanceTo(this.game.r.camera.position);
    v.g.gain.value = v.e.gain * curveGain(v.e.att, d);
  }

  /** impact sound for a resolved hit. h = HitTracker hit {event, point}; res = Boss.receiveHit result (optional) */
  hit(attacker, victim, h, res) {
    if (!this.m) return;
    const isPlayerSide = attacker === this.game.player;
    const id = this.hitAudioId(attacker.ch, h?.event) ?? (isPlayerSide ? 1001 : 1301); // [INFERENCE] fallback ids
    this.hitById(id, isPlayerSide, victim, h?.point, res);
  }

  /** tiger bullet hit (FUStProjectileDispDesc.HitChrAudioID) */
  bulletHit(bulletId, victim, point) {
    const id = this.m?.bullets?.[String(bulletId)];
    if (id) this.hitById(id, false, victim, point, null);
  }

  hitById(id, isPlayerSide, victim, point, res) {
    const map = isPlayerSide ? this.m.playerHitMapping : 0;
    const pre = this.m.hits[`${map}:${id}`] ?? this.m.hits[`0:${id}`];
    if (!pre) { this.unmapped.set(`HitChrAudioID ${id}`, (this.unmapped.get(`HitChrAudioID ${id}`) || 0) + 1); return; }
    const boss = this.game.boss;
    let perform = "normal", material = "meat";
    if (victim === boss) {
      // BUS_BeAttackedComp: BounceAttack -> ParryHit; immobilized -> ImmobilizedHit; super armor window -> SkillSurperArmorHit
      if (res?.bounced) perform = "parry";
      else if (boss.immobilized) perform = "immobilizedhit";
      else if (boss.armorWindow?.()) perform = "skillsuperarmor";
      else if (res?.crit) perform = "critical";
      if (boss.stiffConfig?.() === "stone") material = "stone"; // BeAttackedInfo 202202 -> HitItemAudioType Stone
    }
    const name = [`${pre}_${perform}_${material}`, `${pre}_${perform}_all`, `${pre}_normal_meat`].find((n) => this.events[n]);
    this.post(name || `${pre}_${perform}_${material}`, point ? point.clone() : victim?.ch || null, "hit");
  }

  hitAudioId(ch, ev) {
    const n = ev && ch?.cur?.meta?.notifies?.[ev.notify];
    if (!n) return null;
    const id = deepFind(n.props, "HitChrAudioID");
    return id > 0 ? id : null;
  }

  /** non-damage skill effects (Boss.triggerEffect): SetBgmState rows of the BGM state group */
  effect(id) {
    const st = this.m?.bgm?.effects?.[String(id)];
    if (st) this.bgmState(st.includes("lv2") ? "lv2" : "lv1");
  }

  /** extra actors (summons) whose montage notifies should sound */
  track(ch) { this.tracked.add(ch); }
  untrack(ch) { this.tracked.delete(ch); }

  // ------------------------------------------------------------------ montage notifies
  cues(meta) {
    let c = this.cueCache.get(meta);
    if (c) return c;
    c = [];
    (meta.notifies || []).forEach((n, i) => {
      const cls = n.class || n.name, p = n.props || {};
      const at = n.start ?? 0;
      if (cls === "AnimNotify_GSFootStep") {
        c.push({ i, at, foot: true, bone: String(p.FootStepType || "").endsWith("RightFoot") ? "foot_r" : "foot_l" });
        return;
      }
      if (cls === "BAN_GSPlayMappedSoundFX") {
        const pos = String(p.EquipPosition || "").split("::").pop();
        c.push({ i, at, name: this.m.mapped[`${pos}:${p.ActionTypeID}`] || `mapped ${pos}:${p.ActionTypeID}`, bone: p.SocketName });
        return;
      }
      const ak = p.AkEvent?.AssetPathName || p.AkEvent?.ObjectPath;
      if (ak) c.push({ i, at, name: ak.split("/").pop().split(".")[0], bone: p.AttachPointName || p.SocketName });
    });
    this.cueCache.set(meta, c);
    return c;
  }

  poll(who, ch) {
    const c = ch?.cur;
    if (!c?.meta?.notifies?.length) return;
    for (const q of this.cues(c.meta)) {
      const key = "au" + q.i;
      if (c.fired.has(key) || c.time < q.at || !(c.prev <= q.at || c.prev > c.time)) continue;
      c.fired.add(key);
      const name = q.foot ? (this.m.footsteps[ch.anims?.id] ?? this.m.footsteps.wukong) : q.name;
      this.post(name, { ch, bone: q.bone, stamp: c.stamp }, who);
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    const g = this.game;
    if (g.input.wasPressed("KeyM")) this.toggleMute();
    if (!this.m) return;
    if (g.player?.ch) this.poll("player", g.player.ch);
    if (g.boss?.ch) this.poll("tiger", g.boss.ch);
    for (const ch of this.tracked) this.poll(ch.name || "unit", ch);
    if (!this.running) return;
    const cam = g.r.camera, L = this.ctx.listener;
    cam.getWorldDirection(_f); _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (L.positionX) {
      L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z;
      L.forwardX.value = _f.x; L.forwardY.value = _f.y; L.forwardZ.value = _f.z;
      L.upX.value = _u.x; L.upY.value = _u.y; L.upZ.value = _u.z;
    } else { L.setPosition(cam.position.x, cam.position.y, cam.position.z); L.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z); }
    for (const v of this.voices) {
      if (v.stopped) continue;
      // looping notify sounds (e.g. charge rise loops) end with their montage [INFERENCE: CanHandleStopRequest]
      if (v.e.loop && v.at?.stamp != null && v.at.ch.cur?.stamp !== v.at.stamp) { this.fadeOut(v, 0.15); continue; }
      if (v.pan) this.place(v);
    }
    this.updateBgm();
  }

  // ------------------------------------------------------------------ BGM
  /** TAMER BtlBGMBPConfig: AkEventBegin when the tiger enters battle, AkEventStop when the fight ends */
  updateBgm() {
    const g = this.game, s = this.bgm.state;
    if (s === "off" && g.state === "fight" && g.boss?.aware && g.boss.alive) this.bgmPlay();
    else if ((s === "lv1" || s === "lv2") && (g.state === "victory" || g.state === "defeat")) this.bgmStop();
  }

  bgmLog(what) { this.game.debugLog?.({ ev: "bgm", what }); }

  /** a media element (looped piece) or buffer source (intro/outro) routed through its own gain into the BGM bus */
  bgmSource(piece) {
    const ctx = this.ctx, b = this.bgm;
    const gain = ctx.createGain(); gain.connect(this.bgmBus);
    if (b.el[piece]) {
      if (!b.nodes) b.nodes = {};
      let node = b.nodes[piece];
      if (!node) {
        const el = new Audio(b.el[piece]); el.loop = true; el.preload = "auto";
        node = b.nodes[piece] = { el, src: ctx.createMediaElementSource(el) };
      }
      node.src.disconnect(); node.src.connect(gain);
      node.el.currentTime = 0; node.el.play().catch((e) => console.warn("[audio] bgm", e));
      return { piece, gain, stop: () => { node.el.pause(); gain.disconnect(); } };
    }
    const src = ctx.createBufferSource(); src.buffer = b.buf[piece]; src.connect(gain); src.start();
    return { piece, gain, src, stop: () => { try { src.stop(); } catch { /* ended */ } gain.disconnect(); } };
  }

  bgmSwitch(piece, fade) {
    const ctx = this.ctx, b = this.bgm, now = ctx.currentTime;
    const old = b.cur;
    if (old) {
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fade);
      b.timers.push(setTimeout(old.stop, fade * 1000 + 50));
    }
    const cur = b.cur = this.bgmSource(piece);
    cur.gain.gain.setValueAtTime(old && fade > 0 ? 0 : 1, now);
    if (old && fade > 0) cur.gain.gain.linearRampToValueAtTime(1, now + fade);
    return cur;
  }

  bgmPlay() {
    if (!this.running || !this.m?.bgm) return;
    this.bgmReset();
    this.bgm.state = "lv1";
    this.bgmLog("play lv1");
    const intro = this.bgmSwitch("lv1Intro", 0);
    // intro segment -> looping lv1 sequence (CAkMusicRanSeqCntr: intro once, then [A, B] looped)
    intro.src.onended = () => { if (this.bgm.state === "lv1" && this.bgm.cur === intro) this.bgmSwitch("lv1Loop", 0); };
  }

  /** SetBgmState: lv1 / lv2 (transition rule: 900 ms crossfade) */
  bgmState(level) {
    if (!this.running || this.bgm.state === level || this.bgm.state === "off" || this.bgm.state === "stopping") return;
    this.bgm.state = level;
    this.bgmLog("state " + level);
    this.bgmSwitch(level === "lv2" ? "lv2Loop" : "lv1Loop", this.m.bgm.crossfade);
  }

  /** EVT_..._stop: SetState(outro) then Stop after DelayTime 6 s with a 2.5 s linear fade */
  bgmStop() {
    if (!this.running || this.bgm.state === "off" || this.bgm.state === "stopping") return;
    const bg = this.m.bgm;
    this.bgm.state = "stopping";
    this.bgmLog("stop");
    const outro = this.bgmSwitch("outro", bg.crossfade);
    const t = this.ctx.currentTime + bg.stopDelay;
    outro.gain.gain.setValueAtTime(1, t);
    outro.gain.gain.linearRampToValueAtTime(0, t + bg.stopFade);
    this.bgm.timers.push(setTimeout(() => { if (this.bgm.cur === outro) { outro.stop(); this.bgm.cur = null; this.bgm.state = "off"; } }, (bg.stopDelay + bg.stopFade) * 1000 + 100));
  }

  bgmReset() {
    const b = this.bgm;
    for (const t of b.timers) clearTimeout(t);
    b.timers = [];
    b.cur?.stop(); b.cur = null;
    b.state = "off";
  }

  /** new fight: silence everything */
  reset() {
    for (const v of this.voices.splice(0)) { try { v.src.stop(); } catch { /* ended */ } }
    if (this.ctx) this.bgmReset();
  }

  // ------------------------------------------------------------------ debug
  rms(bus = "master") {
    const a = this.analysers?.[bus];
    if (!a) return 0;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let s = 0; for (const x of buf) s += x * x;
    return Math.sqrt(s / buf.length);
  }

  debugState() {
    return {
      ctx: this.ctx?.state ?? "none", loaded: this.loaded, loadError: this.loadError, volume: this.volume, muted: this.muted,
      events: Object.keys(this.events).length, decoded: [...this.buffers.values()].filter((b) => b instanceof AudioBuffer).length,
      voices: this.voices.length, played: this.played, bgm: { state: this.bgm.state, piece: this.bgm.cur?.piece ?? null },
      rms: { master: +this.rms("master").toFixed(4), sfx: +this.rms("sfx").toFixed(4), bgm: +this.rms("bgm").toFixed(4) },
      recent: this.recent.slice(-40), unmapped: Object.fromEntries(this.unmapped), manifestUnmapped: this.m?.unmapped ?? [],
    };
  }
}
