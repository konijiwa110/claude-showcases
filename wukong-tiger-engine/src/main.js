// Entry: loading screen -> world setup -> fight loop -> victory/defeat -> restart.
import * as THREE from "three";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { loadAll, hasServerAssets, useLocalFolder } from "./assets.js";
import { Renderer } from "./render.js";
import { CollisionWorld, CapsuleController } from "./collision.js";
import { Character } from "./character.js";
import { OrbitCam } from "./camera.js";
import { Input } from "./input.js";
import { Hud } from "./hud.js";
import { Player } from "./player.js";
import { Boss } from "./boss.js";
import { Hazards } from "./hazards.js";
import { installDebug } from "./debug.js";
import { TOUCH, TouchControls } from "./touch.js";
import { Vfx } from "./vfx.js";
import { GameAudio } from "./audio.js";
import { PLAYER_MODULES } from "./modules.js";

const $ = (s) => document.querySelector(s);
// meshes with geometry.boundsTree (camera occluders) raycast through their BVH; others fall back to three's default
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** point inside an arena.json box marker {center, halfExtents, yaw (arena yaw convention)} */
function inBox(m, p) {
  const dx = p.x - m.center[0], dy = p.y - m.center[1], dz = p.z - m.center[2];
  // facing (cos yaw, 0, -sin yaw) is the box's local +X
  const c = Math.cos(m.yaw || 0), s = Math.sin(m.yaw || 0);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= m.halfExtents[0] && Math.abs(dy) <= m.halfExtents[1] && Math.abs(lz) <= m.halfExtents[2];
}

class Game {
  constructor() {
    this.r = new Renderer($("#app"), { mobile: TOUCH });
    this.input = new Input(this.r.dom);
    this.touch = TOUCH ? new TouchControls(this.input) : null;
    this.hud = new Hud();
    this.state = "loading"; // loading | ready | fight | victory | defeat
    this.timeScale = 1;
    this.clock = new THREE.Clock(false);
    this.frameTimes = [];
    this.simTime = 0;
  }

  async load() {
    const bar = $("#load-bar .fill"), txt = $("#load-text");
    if (!(await hasServerAssets())) await this.pickAssetFolder(txt);
    this.assets = await loadAll((f, t) => {
      if (this.loadError) return;
      bar.style.width = `${(f * 100).toFixed(1)}%`; txt.textContent = t;
    });
    txt.textContent = "构建场景…";
    await new Promise((r) => setTimeout(r, 0));
    this.setupWorld();
    txt.textContent = "就绪";
    this.state = "ready";
    $("#load-start").classList.remove("hidden");
    const start = () => {
      if (this.state !== "ready") return;
      $("#loading").classList.add("hidden");
      this.hud.show();
      this.audio?.unlock(); // user gesture: AudioContext may start now
      this.startFight();
      if (this.touch) { this.touch.layout(); this.touch.enterFullscreen(); } else this.r.dom.requestPointerLock?.();
    };
    $("#loading").addEventListener("click", start);
    addEventListener("keydown", (e) => { if (e.code === "Enter") { if (this.state === "ready") start(); else if (this.state === "victory" || this.state === "defeat") this.restart(); } });
    $("#endscreen").addEventListener("click", () => this.restart());
  }

  /** Asset-free host (the Pages build): wait until the player picks a folder holding every contract file. */
  async pickAssetFolder(txt) {
    const pick = $("#load-pick"), input = pick.querySelector("input");
    txt.textContent = "需要本机的资源文件夹";
    pick.classList.remove("hidden");
    for (;;) {
      await new Promise((r) => input.addEventListener("change", r, { once: true }));
      const missing = useLocalFolder(input.files);
      if (!missing.length) break;
      txt.textContent = `这个文件夹缺少 ${missing.length} 个文件（如 ${missing[0]}），请选 web/assets`;
      input.value = "";
    }
    pick.classList.add("hidden");
  }

  setupWorld() {
    const A = this.assets, s = this.r.scene;
    this.arena = A.arena.json;
    this.r.setupEnvironment(this.arena);
    const arenaScene = A.arena.gltf.scene;
    // shadow casting only near the arena (ArenaAssets: ~6.6M tris / 245 instanced batches); everything receives
    const pc = new THREE.Vector3(...this.arena.playArea.center), castR = this.arena.playArea.radius + 40;
    // camera occluders: opaque render meshes within 45 m of the play centre (covers the spawn pavilion and the approach)
    const occluders = [], occR = 45;
    arenaScene.updateMatrixWorld(true);
    arenaScene.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = true;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      if (o.isInstancedMesh) o.computeBoundingSphere();
      const bs = (o.isInstancedMesh ? o.boundingSphere : o.geometry.boundingSphere).clone().applyMatrix4(o.matrixWorld);
      const gap = bs.center.distanceTo(pc) - bs.radius;
      o.castShadow = gap < castR;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (gap < occR && !m.transparent && !(m.alphaTest > 0)) {
        o.geometry.boundsTree ??= new MeshBVH(o.geometry);
        occluders.push(o);
      }
    });
    s.add(arenaScene);
    this.world = new CollisionWorld(A.collisionGeometry, this.arena);
    s.add(this.world.mesh);

    this.playerCh = new Character(A.player.gltf, A.player.anims, "player");
    this.tigerCh = new Character(A.tiger.gltf, A.tiger.anims, "tiger");
    s.add(this.playerCh.root, this.tigerCh.root);
    this.cam = new OrbitCam(this.r.camera, this.world, occluders);
    this.cam.height = Math.max(1.2, (A.player.anims.height || 1.8) * 0.85);

    this.player = new Player(this, this.playerCh, new CapsuleController(this.world, A.player.anims.capsule, { limitArea: false, areaLatch: true }), A.data.player);
    this.boss = new Boss(this, this.tigerCh, new CapsuleController(this.world, A.tiger.anims.capsule, { stepHeight: 0.5 }), A.data.tiger);
    this.damageModel = A.data.tiger.damageModel;
    this.hazards = new Hazards(this, A.data.tiger);
    this.vfx = new Vfx(this, A.vfx);
    this.audio = new GameAudio(this, A.files.audio);
    this.player.opponent = this.boss; this.boss.opponent = this.player;
    for (const make of PLAYER_MODULES) this.player.use(make(this));
  }

  startFight() {
    const ps = this.arena.playerSpawn, bs = this.arena.bossSpawn;
    // arena.json yaw = web rotation about +Y of a +X-forward (UE) actor (facing = (cos, 0, -sin));
    // Character yaw faces (sin, 0, cos) => +PI/2
    const toYaw = (y) => y + Math.PI / 2;
    this.player.reset(new THREE.Vector3(...ps.pos), toYaw(ps.yaw));
    this.boss.reset(new THREE.Vector3(...bs.pos), toYaw(bs.yaw));
    this.hazards.reset();
    this.vfx.clear();
    this.audio?.reset();
    this.cam.yaw = toYaw(ps.yaw); this.cam.pitch = -0.15; this.cam.first = true;
    this.hud.hideEnd();
    this.state = "fight";
    this.simTime = 0;
    this.clock.start();
  }

  restart() {
    if (this.state !== "victory" && this.state !== "defeat") return;
    this.startFight();
    if (!this.touch) this.r.dom.requestPointerLock?.();
  }

  onBossDefeated() {
    if (this.state !== "fight") return;
    this.state = "victory";
    setTimeout(() => { this.hud.endScreen("victory"); document.exitPointerLock?.(); }, 2500);
  }

  onPlayerDefeated() {
    if (this.state !== "fight") return;
    this.state = "defeat";
    setTimeout(() => { this.hud.endScreen("defeat"); document.exitPointerLock?.(); }, 2200);
  }

  step(dt) {
    this.simTime += dt;
    const fighting = this.state === "fight";
    if (this.input.wasPressed("KeyH")) this.hud.toggleHelp();
    if (this.input.wasPressed("Backquote")) this.world.mesh.visible = !this.world.mesh.visible;
    this.player.update(dt, fighting);
    // arena.json markers.forceFightBox (ForceFightControllerBox, player filter): entering forces the boss into battle
    const ff = this.arena.markers?.forceFightBox;
    if (fighting && !this.boss.aware && ff && inBox(ff, this.player.ch.position)) this.boss.becomeAware("forceFightBox");
    // perfect-dodge slowTime windows slow the world (tiger + its bullets), not the player
    this.boss.timeScale = this.worldSlow ?? 1;
    this.boss.update(dt, fighting || this.state === "victory");
    this.hazards.update(dt);
    this.vfx.update(dt);
    if (fighting) {
      this.player.resolveHits();
      this.boss.resolveHits();
    }
    this.separate();
    const mouse = this.input.takeMouse();
    const lock = this.player.lockOn && this.boss.canBeLocked() ? this.boss.lockPoint() : null;
    this.cam.update(dt, this.player.ch.position, mouse, lock);
    this.vfx.applyShake(this.r.camera);
    this.r.followSun(this.player.ch.position);
    this.hud.update(this.player, this.boss);
    this.hud.lockMarker(this.r.camera, lock);
    this.audio?.update(dt); // after every Character.update this frame + camera (listener)
    this.input.endFrame();
  }

  /** residual overlap after pawn blocking (e.g. a pass-through window ending inside the player): push the player out */
  separate() {
    const p = this.player.ch.position, b = this.boss.ch.position;
    const rp = this.player.ctl.radius, rb = this.boss.ctl.radius;
    const dx = p.x - b.x, dz = p.z - b.z, d = Math.hypot(dx, dz), min = rp + rb;
    if (d < min && d > 1e-4 && this.boss.alive && !this.boss.passThrough()) {
      const push = min - d;
      p.x += dx / d * push; p.z += dz / d * push;
    }
  }

  loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      if (this.lastFrame != null) {
        this.frameTimes.push(now - this.lastFrame);
        if (this.frameTimes.length > 120) this.frameTimes.shift();
      }
      this.lastFrame = now;
      // portrait on a phone: the rotate overlay covers the fight, which waits
      if (this.state === "loading" || this.paused || (this.touch?.portrait && this.state !== "ready")) return;
      const raw = Math.min(this.clock.running ? this.clock.getDelta() : 1 / 60, 1 / 20);
      if (this.state !== "ready") this.step(raw * this.timeScale);
      this.r.render();
      if ((this.fpsTick = (this.fpsTick || 0) + 1) % 30 === 0) this.hud.fps.textContent = `${this.fps().toFixed(0)} fps`;
    };
    requestAnimationFrame(tick);
  }

  fps() {
    if (!this.frameTimes.length) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return 1000 / avg;
  }
}

const game = new Game();
installDebug(game);
game.loop();
game.load().catch((e) => {
  console.error(e);
  game.loadError = String(e?.stack || e);
  $("#load-text").textContent = `载入失败：${e.message}`;
});
