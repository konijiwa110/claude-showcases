// Dev only (&grips=1): draw where Mixamo's own props sit in our characters' hands, as bright sticks, to check the
// measured holds in source-art/mixamo/wprop/grips.json against what the wardrobe shows. See docs/grips.md.
import * as THREE from 'three';

export async function showGrips(ctx, hideKit) {
  const g = await fetch('source-art/mixamo/wprop/grips.json').then((r) => r.json());
  const mat = (c) => new THREE.MeshBasicMaterial({ color: c, depthTest: true });
  const socket = (bone, e, kx, ky, kz) => {
    const o = new THREE.Object3D(); const m = new THREE.Matrix4();
    m.makeBasis(new THREE.Vector3(...e[kx]), new THREE.Vector3(...e[ky]), new THREE.Vector3(...e[kz])); m.setPosition(...e.position);
    o.applyMatrix4(m); bone.add(o); return o;
  };
  const sword = (bone, e, len, color) => {
    const s = socket(bone, e, 'x_edge', 'y_blade', 'z_flat'), p = e.mixamo_prop;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, len, 0.008), mat(color)); blade.position.y = p.guard_above_palm + len / 2; s.add(blade);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, p.guard_above_palm + p.pommel_end_below_palm, 8), mat(0xffffff)); grip.position.y = (p.guard_above_palm - p.pommel_end_below_palm) / 2; s.add(grip);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.02), mat(0xffffff)); guard.position.y = p.guard_above_palm; s.add(guard);
    if (p.left_palm_below_right_palm) { const k = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), mat(0x00ffff)); k.position.y = -0.137; s.add(k); }
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), mat(0xffff00)); s.add(palm);
    return s;
  };
  const k = ctx.player.char, c = ctx.boss.char;
  sword(k.bones.RightHand, g.knight_sword, 0.9, 0xff40ff);
  sword(c.bones.RightHand, g.cantor_sword, 1.2, 0x40ff40);
  const sh = socket(k.bones.LeftForeArm, g.knight_shield, 'x_side', 'y_top', 'z_face');
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.02, 32), new THREE.MeshBasicMaterial({ color: 0xff8030, transparent: true, opacity: 0.6 })); disc.rotation.x = Math.PI / 2; disc.position.z = 0.03; sh.add(disc);
  const up = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.31, 0.03), mat(0xffffff)); up.position.set(0, 0.155, 0.05); sh.add(up);
  if (hideKit) for (const f of [ctx.player, ctx.boss]) { const kit = f.kit; for (const key of ['sword', 'shield']) if (kit[key] && kit[key].object) kit[key].object.visible = false; }
}
