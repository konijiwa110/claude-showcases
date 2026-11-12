// Tiger bullets (BANS_GSSpawnBullets): wind blades 20221001, tornadoes 20220702/20220703, empty 20010103.
// Numbers/shapes from data/tiger.json bullets + montages[clip].bullets; spawn times/sockets from tiger.anims.json.
// The game's Niagara VFX are not exportable, so each bullet is drawn as its real hit volume (translucent wind).
import * as THREE from "three";
import { segSegDist2, hurtCapsule } from "./combat.js";

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class Hazards {
  constructor(game, tigerData) {
    this.game = game;
    this.d = tigerData;
    this.defs = tigerData.bullets;
    this.list = [];
    this.group = new THREE.Group();
    game.r.scene.add(this.group);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xcfe3ea, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
  }

  reset() { for (const h of this.list) this.group.remove(h.obj); this.list = []; }
  onSkillStart() {}

  /** montage bullet row (direction/speed) matching an anim bullet event */
  rowFor(clip, ev) {
    const rows = this.d.montages[clip]?.bullets || [];
    return rows.find((r) => Math.abs(r.start - ev.start) < 0.02) || null;
  }

  poll(boss) {
    if (boss.state !== "skill") return;
    const ch = boss.ch;
    for (const ev of ch.crossed("bullet")) {
      const row = this.rowFor(ch.clipName, ev);
      const id = ev.bulletId ?? row?.bullet;
      if (id == null) { this.game.debugLog({ ev: "bulletNoId", clip: ch.clipName }); continue; }
      this.spawn(boss, String(id), ev.socket ?? row?.socket, row?.direction ?? "LookAtTargetPos", row?.speed ?? 0);
    }
    for (const ev of ch.crossed("destroyProjectile")) this.destroy(ev.ids);
  }

  spawn(boss, id, socket, direction, speed) {
    const def = this.defs[id];
    if (!def) { this.game.debugLog({ ev: "bulletUnknown", id }); return; }
    const node = socket && boss.ch.bone(socket);
    const pos = node ? node.getWorldPosition(new THREE.Vector3()) : boss.lockPoint();
    let dir;
    if (direction === "UseSlotDir" && node) dir = new THREE.Vector3(1, 0, 0).applyQuaternion(node.getWorldQuaternion(_q));
    else if (direction === "BaseActorRot") dir = boss.ch.forward();
    else dir = new THREE.Vector3().subVectors((boss.foe ?? boss.opponent).ch.position, pos);
    dir.y = 0; if (dir.lengthSq() < 1e-6) dir.copy(boss.ch.forward()); dir.normalize();
    const h = { id, def, boss, socket: node, pos, dir, speed: speed || 0, age: 0, nextSweep: def.sweepDelay ?? 0, hits: 0 };
    // StraightMode with speed 0 + LifeOverWithDetach: stays on its spawn socket for its life [CombatData INFERENCE]
    h.follow = !!node && h.speed === 0 && def.moveMode === "StraightMode";
    h.traceSocketPrefix = def.moveMode === "TraceMode" && def.moveInt?.[0] === 2 ? def.moveStr?.[0] : null;
    h.obj = this.visual(def);
    h.obj.visible = !this.game.vfx; // with VFX loaded the bullet is drawn by its Niagara-derived particles
    this.group.add(h.obj);
    this.place(h);
    this.list.push(h);
    this.game.debugLog({ ev: "bullet", id, socket, speed: h.speed });
  }

  visual(def) {
    const s = def.shape;
    let geo;
    if (s.box) geo = new THREE.BoxGeometry(s.box[1] * 2, s.box[2] * 2, s.box[0] * 2); // web: x=right, y=up, z=fwd
    else if (s.capsule) geo = new THREE.CylinderGeometry(s.capsule.radius * 2.2, s.capsule.radius * 0.6, s.capsule.halfHeight * 2, 16, 1, true);
    else geo = new THREE.SphereGeometry(s.sphere ?? 1, 16, 12);
    const m = new THREE.Mesh(geo, this.mat);
    m.renderOrder = 10;
    return m;
  }

  place(h) {
    h.obj.position.copy(h.pos);
    const s = h.def.shape;
    if (s.capsule) h.obj.position.y += s.capsule.halfHeight * 0.5; // tornado column stands on the ground
    h.obj.rotation.set(0, Math.atan2(h.dir.x, h.dir.z), 0);
  }

  destroy(ids) { for (const h of this.list) if (ids.map(String).includes(h.id)) h.dead = true; }

  /** effect SwitchBullet (20229904): bullets `from` become `to`; `to` has no table row here -> removed */
  switchBullets(from, to) {
    for (const h of this.list) if (h.id === String(from)) {
      if (this.defs[String(to)]) { h.id = String(to); h.def = this.defs[h.id]; h.age = 0; } else h.dead = true;
    }
    this.game.debugLog({ ev: "switchBullet", from, to });
  }

  update(dt) {
    const boss = this.game.boss;
    dt *= boss?.timeScale ?? 1;
    if (boss) this.poll(boss);
    const player = this.game.player;
    for (const h of this.list) {
      h.age += dt;
      if (h.age >= h.def.lifeTime) { h.dead = true; continue; }
      const prev = h.pos.clone();
      if (h.follow) h.socket.getWorldPosition(h.pos);
      else if (h.traceSocketPrefix) {
        // TraceMode type 2: home on the tiger's sockets with that prefix (turn rate moveFloat)
        const target = nearestSocket(h.boss.ch, h.traceSocketPrefix, h.pos);
        if (target) this.steer(h, target, dt);
      } else if (h.def.moveMode === "TraceMode") {
        this.steer(h, player.ch.position, dt);
        h.pos.addScaledVector(h.dir, h.speed * dt);
      } else h.pos.addScaledVector(h.dir, h.speed * dt);
      // keep ground-hugging bullets on the floor
      if (h.def.shape.capsule && !h.follow) {
        const g = this.game.world.groundAt(h.pos.x, h.pos.z, h.pos.y + 4, 12);
        if (g) h.pos.y = g.point.y;
      }
      this.place(h);
      this.game.vfx?.bulletTick(h, dt);
      if (h.age >= h.nextSweep && player.alive && this.game.state === "fight") {
        if (this.overlaps(h, prev, player)) {
          h.nextSweep = h.age + (h.def.sweepInterval ?? 99);
          for (const eid of h.def.hitEffects || []) {
            const e = this.d.effects[String(eid)];
            if (e?.type === "damage" && player.receiveHit(h.boss, e, h.pos.clone(), { effectId: eid, bullet: h.id }) > 0)
              this.game.audio?.bulletHit(h.id, player, h.pos);
          }
        }
      }
    }
    this.list = this.list.filter((h) => { if (h.dead) this.group.remove(h.obj); return !h.dead; });
  }

  steer(h, target, dt) {
    const want = _v.subVectors(target, h.pos).setY(0);
    if (want.lengthSq() < 1e-4) return;
    want.normalize();
    const rate = h.def.moveFloat?.[0] ?? 0; // TraceMode turn rate (rad/s) [INFERENCE: unit not documented]
    const a = Math.atan2(h.dir.x, h.dir.z), b = Math.atan2(want.x, want.z);
    let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d));
    const step = Math.max(-rate * dt, Math.min(rate * dt, d));
    h.dir.set(Math.sin(a + step), 0, Math.cos(a + step));
    if (h.traceSocketPrefix) h.pos.lerp(target, Math.min(1, rate * dt));
  }

  overlaps(h, prev, player) {
    const cap = hurtCapsule(player.ch, player.capsule, player.cap);
    const s = h.def.shape;
    if (s.sphere != null) { const r = s.sphere + cap.r; return segSegDist2(prev, h.pos, cap.a, cap.b) <= r * r; }
    if (s.capsule) {
      const r = s.capsule.radius + cap.r;
      const a = _v.copy(h.pos), b = _w.copy(h.pos).setY(h.pos.y + s.capsule.halfHeight * 2);
      return segSegDist2(a, b, cap.a, cap.b) <= r * r;
    }
    if (s.box) {
      // oriented box (half extents fwd/right/up) vs capsule: sample the capsule axis, point-in-expanded-box
      const yaw = Math.atan2(h.dir.x, h.dir.z), c = Math.cos(-yaw), sn = Math.sin(-yaw);
      for (let i = 0; i <= 4; i++) {
        const p = _v.copy(cap.a).lerp(cap.b, i / 4).sub(h.pos);
        const lx = p.x * c + p.z * sn, lz = -p.x * sn + p.z * c; // into box frame (+z fwd, +x left)
        if (Math.abs(lz) <= s.box[0] + cap.r && Math.abs(lx) <= s.box[1] + cap.r && Math.abs(p.y) <= s.box[2] + cap.r) return true;
      }
    }
    return false;
  }
}

function nearestSocket(ch, prefix, from) {
  let best = null, bd = Infinity;
  for (const [name, node] of ch.bones) {
    if (!name.startsWith(prefix)) continue;
    const p = node.getWorldPosition(new THREE.Vector3());
    const d = p.distanceToSquared(from);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
