// Afterimages (BAN_GSGhost) and the perfect-dodge screen pass (BAN_GSSpawnStaticMeshActor post cube), driven by
// the player montages' notifies through vfx.js. Numbers from the data assets dumped to out/vfx/bp/:
//  DA_GhostActor_PreciseDodge_{F,B,L,R}: GhostActorClass BP_ShadowActor_WukongStatic, MatParams Globle_Opacity =
//    CurveFloat C_Sunwukong_Ghost_PreciseDoge_Alpha (0 s 0.75 -> 2 s 0), Scale 1.
//  DA_JNSB_Benti_Vibration_{F,B,L,R}: Shape_Cube + JNSB_Post_wukong_Benti_Inst (parent MLP_JNSB: GlitchTiling 10,
//    ShapeGlitchAmount 0.55), attached to the owner; BlurAmount = C_JNSB_Benti_BlurAmount_WuKong, TimeGlitchAmount =
//    C_JNSB_Benti_TimeAmount_WuKong, Direction (-1,0,0) (actor space).
import * as THREE from "three";

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _w = new THREE.Vector3();

/** piecewise-linear curve [[t, v], ...] */
export function curveAt(keys, t) {
  if (!keys?.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) { const [t0, v0] = keys[i - 1], [t1, v1] = keys[i]; return v0 + (v1 - v0) * (t - t0) / Math.max(1e-6, t1 - t0); }
  }
  return keys[keys.length - 1][1];
}

/** frozen copies of a character's meshes (skinned meshes keep the snapshot's bone matrices) */
export class Ghosts {
  constructor(game, cfg) {
    this.game = game; this.cfg = cfg;
    this.list = [];
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...(cfg.color || [0.55, 0.62, 0.7])), transparent: true,
      opacity: 0.75, depthWrite: false, blending: THREE.NormalBlending });
  }

  spawn(ch, setting) {
    const S = this.cfg.settings?.[setting] || this.cfg.settings?.default;
    if (!S) return;
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    const mat = this.mat.clone();
    ch.model.updateMatrixWorld(true);
    ch.model.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let g;
      if (o.isSkinnedMesh) {
        const sk = o.skeleton;
        const frozen = new THREE.Skeleton(sk.bones, sk.boneInverses);
        frozen.boneMatrices.set(sk.boneMatrices.subarray(0, frozen.boneMatrices.length));
        frozen.update = () => {}; // keep the snapshot pose
        g = new THREE.SkinnedMesh(o.geometry, mat);
        g.bindMode = o.bindMode;
        g.bind(frozen, o.bindMatrix);
        g.skeleton.update = frozen.update;
      } else g = new THREE.Mesh(o.geometry, mat);
      g.matrixAutoUpdate = false;
      g.matrix.copy(o.matrixWorld);
      g.frustumCulled = false;
      g.renderOrder = 9;
      root.add(g);
    });
    this.game.r.scene.add(root);
    this.list.push({ root, mat, t: 0, S });
  }

  update(dt) {
    let w = 0;
    for (const gh of this.list) {
      gh.t += dt;
      const a = curveAt(gh.S.opacity, gh.t);
      if (gh.t >= gh.S.opacity[gh.S.opacity.length - 1][0] || a <= 0.002) { this.dispose(gh); continue; }
      gh.mat.opacity = a;
      this.list[w++] = gh;
    }
    this.list.length = w;
  }

  dispose(gh) {
    this.game.r.scene.remove(gh.root);
    gh.root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.boneTexture?.dispose(); });
    gh.mat.dispose();
  }

  clear() { for (const gh of this.list) this.dispose(gh); this.list.length = 0; }
}

/** full-screen pass over a copy of the frame: directional blur + time-glitch slices around the owner (MLP_JNSB) */
export class ScreenPass {
  constructor(game, screen, cfg) {
    this.game = game; this.screen = screen; this.cfg = cfg;
    this.t = -1; this.S = null; this.ch = null;
    this.uniforms = { uScreen: { value: null }, uRes: { value: screen.res }, uBlur: { value: 0 }, uGlitch: { value: 0 },
      uDir: { value: new THREE.Vector2(1, 0) }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uRadius: { value: 0.2 },
      uTime: { value: 0 }, uTiling: { value: cfg.glitchTiling ?? 10 }, uShape: { value: cfg.shapeGlitch ?? 0.55 } };
    screen.users.push(this.uniforms.uScreen);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false, transparent: true,
      vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform sampler2D uScreen; uniform vec2 uRes, uDir, uCenter; uniform float uBlur, uGlitch, uTime, uTiling, uShape, uRadius;
        float h1(float x) { return fract(sin(x * 91.17) * 43758.5453); }
        void main() {
          vec2 uv = gl_FragCoord.xy / uRes;
          vec2 d = (uv - uCenter) * vec2(uRes.x / uRes.y, 1.0);
          float mask = 1.0 - smoothstep(uRadius * 0.6, uRadius * 1.6, length(d));
          if (mask < 0.002) discard;
          float slice = floor(uv.y * uTiling * 4.0), tick = floor(uTime * 24.0);
          float g = (h1(slice + tick * 7.0) - 0.5) * step(1.0 - uShape * 0.6, h1(slice * 3.1 + tick));
          vec2 o = vec2(g * uGlitch * 0.03, 0.0) * mask;
          vec3 c = vec3(0.0);
          for (int i = 0; i < 8; i++) c += texture2D(uScreen, uv + o + uDir * uBlur * mask * (float(i) / 7.0 - 0.5) * 2.0).rgb;
          gl_FragColor = vec4(c / 8.0, mask);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1000; this.mesh.visible = false;
    this.mesh.onBeforeRender = (r) => screen.grab(r, true);
    game.r.scene.add(this.mesh);
  }

  trigger(setting, ch) {
    const S = this.cfg.settings?.[setting];
    if (!S) return;
    this.S = S; this.ch = ch; this.t = 0;
  }

  update(dt) {
    if (!this.S || this.t < 0) { this.mesh.visible = false; return; }
    this.t += dt;
    const blur = curveAt(this.S.blur, this.t), glitch = curveAt(this.S.glitch, this.t);
    const end = Math.max(this.S.blur.at(-1)[0], this.S.glitch.at(-1)[0]);
    if (this.t > end || this.screen.failed) { this.t = -1; this.mesh.visible = false; return; }
    const cam = this.game.r.camera, ch = this.ch;
    // owner centre / size on screen
    _v.copy(ch.position); _v.y += 1.0; _v.project(cam);
    _w.copy(ch.position); _w.y += 2.0; _w.project(cam);
    this.uniforms.uCenter.value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    this.uniforms.uRadius.value = Math.min(0.6, Math.max(0.08, Math.abs(_w.y - _v.y) * 0.5 * 1.4));
    // Direction (-1,0,0) in actor space (UE X = forward) -> screen
    const f = ch.forward ? ch.forward() : _w.set(0, 0, 1);
    const dx = this.S.dir?.[0] ?? -1;
    _w.copy(ch.position).addScaledVector(f, dx).setY(ch.position.y + 1.0).project(cam);
    const sx = (_w.x - _v.x) * cam.aspect, sy = _w.y - _v.y, l = Math.hypot(sx, sy) || 1;
    this.uniforms.uDir.value.set(sx / l, sy / l);
    this.uniforms.uBlur.value = blur;
    this.uniforms.uGlitch.value = glitch;
    this.uniforms.uTime.value += dt;
    this.mesh.visible = blur > 1e-4 || glitch > 1e-3;
  }

  clear() { this.t = -1; this.S = null; this.mesh.visible = false; }
}

/** blade-light arcs (SM_DaoGuang06 + M_HFM_HuStone_DG03: WipeTex T_Trail046_2_A, additive): a flat crescent in the
 * horizontal plane through the spawn point, opening along the owner's facing; U runs along the arc (wipe), V across */
export class Arcs {
  constructor(game, tex) {
    this.game = game; this.list = [];
    const seg = 40, inner = 0.55, t0 = -Math.PI * 0.62, t1 = Math.PI * 0.62;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const u = i / seg, a = t0 + (t1 - t0) * u, c = Math.cos(a), s = Math.sin(a);
      // taper: thin at both ends, widest a third of the way in (direction of the swing)
      const w = Math.sin(Math.PI * Math.min(1, u * 1.25)) * (1 - inner);
      pos.push(s * (1 - w), 0, c * (1 - w), s, 0, c);
      uv.push(u, 0, u, 1);
      if (i < seg) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uColor: { value: new THREE.Color() }, uAlpha: { value: 1 }, uWipe: { value: 0 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform float uAlpha, uWipe; varying vec2 vUv;
        void main(){
          float m = texture2D(map, vec2(clamp(vUv.x - uWipe + 0.5, 0.0, 1.0), vUv.y)).r * smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
          gl_FragColor = vec4(uColor * m * uAlpha, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
  }

  spawn(p, fwd, em, s) {
    const mesh = new THREE.Mesh(this.geo, this.mat.clone());
    mesh.material.uniforms.map.value = this.mat.uniforms.map.value; // ShaderMaterial.clone() clones textures; share the original
    mesh.material.uniforms.uColor.value.setRGB(...(em.color || [1, 1, 1]));
    mesh.renderOrder = 13; mesh.frustumCulled = false;
    mesh.position.copy(p);
    mesh.rotation.y = fwd ? Math.atan2(fwd.x, fwd.z) : 0;
    this.game.r.scene.add(mesh);
    const life = Array.isArray(em.life) ? em.life[0] : em.life ?? 0.35;
    this.list.push({ mesh, t: 0, life, s0: em.size[0] * s, s1: em.size[1] * s, a0: em.alpha ?? 1 });
  }

  update(dt) {
    let w = 0;
    for (const a of this.list) {
      a.t += dt;
      const k = a.t / a.life;
      if (k >= 1) { this.game.r.scene.remove(a.mesh); a.mesh.material.dispose(); continue; }
      const sc = a.s0 + (a.s1 - a.s0) * Math.sqrt(k);
      a.mesh.scale.set(sc, 1, sc);
      const u = a.mesh.material.uniforms;
      u.uAlpha.value = a.a0 * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
      u.uWipe.value = k * 0.6;
      this.list[w++] = a;
    }
    this.list.length = w;
  }

  clear() { for (const a of this.list) { this.game.r.scene.remove(a.mesh); a.mesh.material.dispose(); } this.list.length = 0; }
}
