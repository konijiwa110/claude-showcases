// Third-person orbit camera with lock-on. The camera is pulled in front of the collision world and of the
// render-only occluders (arena meshes near the fight; much of the visible temple has no game collision).
import * as THREE from "three";
import { wrapAngle } from "./character.js";

const _t = new THREE.Vector3(), _f = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3();
const _o = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const PROBE = 0.35; // m: radius of the ray disc, so the near-plane corners do not cut into walls and ledges
const PROBES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
const DOWN = new THREE.Vector3(0, -1, 0);
const FLOOR_CLEAR = 1.3; // m

export class OrbitCam {
  constructor(camera, world, occluders = []) {
    this.camera = camera;
    this.world = world;
    this.occluders = occluders;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true; // three-mesh-bvh accelerated raycast
    this.yaw = 0; this.pitch = -0.18;
    this.distance = 4.6;
    this.sens = 0.0024;
    this.height = 1.5;
    this.smoothTarget = new THREE.Vector3();
    this.first = true;
    this.lift = 0;
    this.lockDistance = 6.8; // m: locked onto the ~6.8 m tall boss, the 4.6 m follow distance frames only his legs
    this.curDistance = this.distance;
  }

  /** horizontal forward/right for camera-relative movement */
  basis() {
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    return { f, r };
  }

  update(dt, focus, mouse, lockTarget) {
    this.yaw -= mouse.dx * this.sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - mouse.dy * this.sens, -1.1, 0.75);
    if (lockTarget) {
      _d.subVectors(lockTarget, focus);
      const want = Math.atan2(_d.x, _d.z);
      const horiz = Math.hypot(_d.x, _d.z);
      const wantPitch = THREE.MathUtils.clamp(Math.atan2(lockTarget.y - (focus.y + this.height), Math.max(horiz, 1)) - 0.22, -0.7, 0.3);
      const k = 1 - Math.exp(-8 * dt);
      this.yaw += wrapAngle(want - this.yaw) * k;
      this.pitch += (wantPitch - this.pitch) * k;
    }
    this.yaw = wrapAngle(this.yaw);
    _t.copy(focus); _t.y += this.height;
    if (this.first) { this.smoothTarget.copy(_t); this.first = false; }
    this.smoothTarget.lerp(_t, 1 - Math.exp(-14 * dt));
    _f.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    // shortest unobstructed distance over a small disc of rays parallel to the view ray
    this.curDistance += ((lockTarget ? this.lockDistance : this.distance) - this.curDistance) * (1 - Math.exp(-3 * dt));
    let dist = this.curDistance;
    _d.copy(_f).negate();
    _r.crossVectors(_f, UP).normalize();
    _u.crossVectors(_r, _f);
    for (const [a, b] of PROBES) {
      _o.copy(this.smoothTarget).addScaledVector(_r, a * PROBE).addScaledVector(_u, b * PROBE);
      if (this.world) {
        const hit = this.world.raycast(_o, _d, dist + 0.3);
        if (hit) dist = Math.max(0.6, hit.distance - 0.3);
      }
      if (this.occluders.length) {
        this.raycaster.set(_o, _d);
        this.raycaster.far = dist + 0.3;
        const hits = this.raycaster.intersectObjects(this.occluders, false);
        if (hits.length) dist = Math.max(0.6, Math.min(dist, hits[0].distance - 0.3));
      }
    }
    _p.copy(this.smoothTarget).addScaledVector(_f, -dist);
    // keep the camera FLOOR_CLEAR above the floor under it: behind a step (terraces, stairs) a camera level with the
    // target hugs the upper floor and its edge hides the player and boss below
    let lift = 0;
    if (this.world) {
      _o.set(_p.x, Math.max(_p.y, this.smoothTarget.y) + 0.5, _p.z);
      const floor = this.world.raycast(_o, DOWN, 6);
      if (floor) lift = Math.max(0, floor.point.y + FLOOR_CLEAR - _p.y);
    }
    this.lift += (lift - this.lift) * (1 - Math.exp(-10 * dt));
    _p.y += this.lift;
    this.camera.position.copy(_p);
    this.camera.lookAt(this.smoothTarget);
  }
}
