// DOM HUD (Chinese): boss bar, player bars, focus pips, gourd, lock-on marker, damage numbers, end screens.
import * as THREE from "three";

const $ = (s) => document.querySelector(s);
const _v = new THREE.Vector3();

export class Hud {
  constructor() {
    this.el = $("#hud");
    this.bossHp = $("#boss-hp"); this.bossPoise = $("#boss-poise");
    this.pHp = $("#p-hp"); this.pMp = $("#p-mp"); this.pSt = $("#p-st"); this.pFocus = $("#p-focus");
    this.pips = $("#focus .pips"); this.gourd = $("#gourd-count");
    this.lock = $("#lock-marker"); this.dmg = $("#dmg-layer"); this.toastEl = $("#toast");
    this.help = $("#help"); this.fps = $("#fps");
    this.end = $("#endscreen");
    this.pipCount = -1;
    this.toastTimer = 0;
    this.slots = new Map(); // id -> {el, order}
    this.gauges = new Map(); // id -> gauge element
  }
  show() { this.el.classList.remove("hidden"); }

  /** skill slot in the bottom-right strip (sorted by order): key hint, short label, cooldown sweep; `code` = the input
   * code a touch on the slot holds (touch.js) */
  addSlot(id, { key = "", label = "", order = 0, code = "" } = {}) {
    if (this.slots.has(id)) return this.slots.get(id).el;
    const el = document.createElement("div");
    el.className = "slot";
    if (code) el.dataset.code = code;
    el.innerHTML = `<div class="cd"></div><span class="label"></span><span class="key"></span><span class="text"></span>`;
    el.querySelector(".label").textContent = label;
    el.querySelector(".key").textContent = key;
    this.slots.set(id, { el, order });
    const box = $("#skills");
    const after = [...this.slots.values()].filter((s) => s.el !== el && s.order > order).sort((a, b) => a.order - b.order)[0];
    box.insertBefore(el, after?.el ?? null);
    return el;
  }
  /** cd = remaining cooldown fraction 0..1 (sweep), ready = usable now (mana etc.), active = effect running */
  setSlot(id, { cd = 0, ready = true, active = false, text = "", label } = {}) {
    const s = this.slots.get(id);
    if (!s) return;
    s.el.style.setProperty("--cd", Math.max(0, Math.min(1, cd)).toFixed(3));
    s.el.classList.toggle("notready", !ready);
    s.el.classList.toggle("active", !!active);
    s.el.querySelector(".text").textContent = text;
    if (label != null) s.el.querySelector(".label").textContent = label;
  }

  /** labelled bar under the player's bars (transformation / spirit energy) */
  addGauge(id, { label = "", color = "#d8b45a" } = {}) {
    if (this.gauges.has(id)) return this.gauges.get(id);
    const el = document.createElement("div");
    el.className = "gauge hidden";
    el.innerHTML = `<span></span><div class="bar"><div class="fill"></div></div>`;
    el.querySelector("span").textContent = label;
    el.querySelector(".fill").style.background = color;
    $("#gauges").appendChild(el);
    this.gauges.set(id, el);
    return el;
  }
  setGauge(id, frac, visible = true) {
    const el = this.gauges.get(id);
    if (!el) return;
    el.classList.toggle("hidden", !visible);
    if (visible) this.setBar(el.querySelector(".bar"), frac);
  }
  setBar(bar, frac, widthScale) {
    frac = Math.max(0, Math.min(1, frac));
    bar.querySelector(".fill").style.width = `${frac * 100}%`;
    const lag = bar.querySelector(".fill-lag");
    if (lag) lag.style.width = `${frac * 100}%`;
    if (widthScale != null) bar.style.width = `${widthScale * 100}%`;
  }
  /** max values scale bar widths a little, like the game (longer bar = bigger pool) */
  update(p, boss) {
    this.setBar(this.pHp, p.hp / p.maxHp);
    this.setBar(this.pMp, p.mp / Math.max(p.maxMp, 1));
    this.setBar(this.pSt, p.stamina / p.maxStamina);
    const lv = p.focusLevels.length;
    if (this.pipCount !== lv) {
      this.pips.innerHTML = "";
      for (let i = 0; i < lv; i++) { const d = document.createElement("div"); d.className = "pip"; this.pips.appendChild(d); }
      this.pipCount = lv;
    }
    const pipEls = this.pips.children;
    for (let i = 0; i < pipEls.length; i++) pipEls[i].classList.toggle("on", p.focusPips > i);
    this.setBar(this.pFocus, p.focusFrac);
    this.gourd.textContent = `${p.gourdCharges}`;
    this.setBar(this.bossHp, boss.hp / boss.maxHp);
    this.bossPoise.classList.toggle("hidden", !(boss.maxPoise > 0));
    if (boss.maxPoise > 0) this.setBar(this.bossPoise, boss.poise / boss.maxPoise);
  }
  lockMarker(camera, worldPos) {
    if (!worldPos) { this.lock.classList.add("hidden"); return; }
    _v.copy(worldPos).project(camera);
    if (_v.z > 1) { this.lock.classList.add("hidden"); return; }
    this.lock.classList.remove("hidden");
    this.lock.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`;
    this.lock.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
  }
  damage(camera, worldPos, amount, kind = "") {
    _v.copy(worldPos).project(camera);
    if (_v.z > 1) return;
    const d = document.createElement("div");
    d.className = `dmg ${kind}`;
    d.textContent = `${Math.round(amount)}`;
    d.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth + (Math.random() - 0.5) * 30}px`;
    d.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
    this.dmg.appendChild(d);
    setTimeout(() => d.remove(), 950);
  }
  toast(text, secs = 1.6) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("show"), secs * 1000);
  }
  endScreen(kind) {
    this.end.className = kind;
    this.end.querySelector(".big").textContent = kind === "victory" ? "得胜" : "身死";
    this.end.querySelector(".small").textContent = kind === "victory" ? "虎先锋　已被击败" : "败于 虎先锋 之手";
  }
  hideEnd() { this.end.className = "hidden"; }
  toggleHelp() { this.help.classList.toggle("hidden"); }
}
