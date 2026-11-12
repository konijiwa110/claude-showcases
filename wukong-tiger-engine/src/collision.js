// Static collision world (collision.bin) + capsule character controller.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _triPt = new THREE.Vector3();
const _capPt = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ray = new THREE.Ray();
const DOWN = new THREE.Vector3(0, -1, 0);

export class CollisionWorld {
  constructor(geometry, arenaJson) {
    this.geometry = geometry;
    this.bvh = new MeshBVH(geometry, { maxLeafSize: 16 });
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x00ff88 }));
    this.mesh.visible = false;
    const pa = arenaJson.playArea;
    this.playCenter = new THREE.Vector3(...pa.center);
    this.playRadius = pa.radius;
  }

  /** first hit of a ray (origin, dir normalized) up to far; returns {point, normal, distance} | null */
  raycast(origin, dir, far) {
    _ray.origin.copy(origin); _ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far);
    if (!hit) return null;
    const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
    if (n.dot(dir) > 0) n.negate();
    return { point: hit.point, normal: n, distance: hit.distance };
  }

  groundAt(x, z, fromY, maxDrop) {
    const o = new THREE.Vector3(x, fromY, z);
    return this.raycast(o, DOWN, maxDrop);
  }
}

/**
 * Capsule controller. Feet position = obj.position. Capsule {radius, halfHeight} uses UE semantics
 * (halfHeight includes the hemispherical cap). Walls are resolved by a capsule that starts `stepHeight` above the
 * feet (so steps/slopes are climbed); the floor is resolved by a downward ray (gravity + ground snap).
 */
export class CapsuleController {
  constructor(world, capsule, opts = {}) {
    this.world = world;
    this.radius = capsule.radius;
    this.height = Math.max(2 * capsule.halfHeight, 2 * capsule.radius);
    this.stepHeight = opts.stepHeight ?? Math.min(0.45, this.height * 0.25);
    this.snap = opts.snap ?? 0.35;
    this.gravity = opts.gravity ?? 9.8 * 2.2;
    this.vy = 0;
    this.grounded = false;
    this.noGravity = false;
    // playArea limit: always for the boss; for the player it locks in once they enter the arena circle
    this.limitArea = opts.limitArea ?? true;
    this.areaLatch = opts.areaLatch ?? false;
  }

  /** Moves `pos` (Vector3, feet) by `delta` (Vector3, world) with collision; mutates pos. */
  move(pos, delta, dt) {
    if (!this.noGravity) {
      if (!this.grounded || this.vy > 0) this.vy -= this.gravity * dt;
      else this.vy = Math.min(this.vy, 0);
      delta.y += this.vy * dt;
    } else this.vy = 0;
    pos.add(delta);

    // walls
    const r = this.radius;
    const bottom = this.stepHeight + r, top = Math.max(bottom, this.height - r);
    for (let iter = 0; iter < 3; iter++) {
      _seg.start.set(pos.x, pos.y + bottom, pos.z);
      _seg.end.set(pos.x, pos.y + top, pos.z);
      _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
      _box.min.addScalar(-r); _box.max.addScalar(r);
      let pushed = false;
      this.world.bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(_box),
        intersectsTriangle: (tri) => {
          const d = tri.closestPointToSegment(_seg, _triPt, _capPt);
          if (d < r) {
            _v.subVectors(_capPt, _triPt);
            _v.y = 0; // walls never lift/drop the character; the floor ray owns vertical
            const l = _v.length();
            if (l < 1e-6) return false;
            _v.multiplyScalar((r - d) / l);
            _seg.start.add(_v); _seg.end.add(_v);
            pushed = true;
          }
          return false;
        },
      });
      pos.x = _seg.start.x; pos.z = _seg.start.z;
      if (!pushed) break;
    }

    // play area limit
    const pc = this.world.playCenter, pr = this.world.playRadius - r;
    const dx = pos.x - pc.x, dz = pos.z - pc.z, dd = Math.hypot(dx, dz);
    if (!this.limitArea && this.areaLatch && dd <= pr) this.limitArea = true;
    if (this.limitArea && dd > pr) { pos.x = pc.x + dx / dd * pr; pos.z = pc.z + dz / dd * pr; }

    // floor
    this.grounded = false;
    const from = pos.y + this.stepHeight + 0.05;
    const reach = this.stepHeight + 0.05 + (this.vy <= 0 && !this.noGravity ? this.snap : 0);
    const g = this.world.groundAt(pos.x, pos.z, from, reach);
    if (g && g.normal.y > 0.45) {
      if (this.noGravity) { if (g.point.y > pos.y) pos.y = g.point.y; } // animation-driven vertical: never sink
      else if (this.vy <= 0) { pos.y = g.point.y; this.vy = 0; this.grounded = true; }
    }
    // safety net: fell through the world -> recover onto the highest floor above
    if (pos.y < this.world.playCenter.y - 50) {
      const g = this.world.groundAt(pos.x, pos.z, this.world.playCenter.y + 100, 400);
      pos.y = g ? g.point.y : this.world.playCenter.y;
      this.vy = 0;
    }
    return pos;
  }
}
