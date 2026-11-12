// The post chain: everything between the scene's HDR picture and the canvas.
//
//   scene (half-float, multisampled, with depth)
//     -> half resolution: ambient occlusion + the moonlit air (one pass), then a blur that keeps to surfaces
//     -> composite (occlusion in, shafts added)                                   [HDR]
//     -> depth of field, only while gfx.post.dof.on                               [HDR]
//     -> bloom: a chain of halvings and back
//     -> grade: exposure, film curve, tints, vignette, hurt, letterbox, fade     [display colour]
//     -> FXAA
//     -> output: up to the canvas's size, sharpen, grain                          [canvas]
//
// It also keeps gfx.sceneDepth: a copy of the scene's depth taken in the middle of the scene pass, after everything
// opaque and before anything transparent, so soft particles and the water's edges read THIS frame's depth.
import * as THREE from 'three';
import * as S from './shaders/post.js';
import { AIR } from './shaders/chunks.js';

const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const GRADE = {
  shadow: rgb(0.90, 0.97, 1.10), light: rgb(1.035, 1.0, 0.95),                 // phase one: cool shadows, warm lights
  shadowGold: rgb(0.93, 0.91, 1.16), lightGold: rgb(1.09, 1.0, 0.82),           // phase two: blue-violet shadows, gold lights
  shaft: rgb(0.62, 0.76, 1.0), shaftGold: rgb(1.0, 0.86, 0.60),
};

const LAMPS = 12;               // the point lights whose glow in the air is drawn (shaders/post.js): 8 candle lights, lantern, her light, 2 flashes
const _lc = new THREE.Color();

export class Post {
  constructor(gfx) {
    this.gfx = gfx; const r = this.renderer = gfx.renderer; this.gl = r.getContext();
    this.w = 0; this.h = 0; this.ow = 0; this.oh = 0; this.samples = -1; this.frame = 0;
    // what the quality level sets
    this.q = { ao: [3, 5], shafts: 20, bloomLevels: 6, fxaa: true, dofTaps: 48 };
    // strengths (the renderer mixes the mood into some of them)
    this.look = { ao: 1, aoRadius: 1.1, aoPower: 1.35, shafts: 1.0, shaftReach: 70, shaftForward: 0.3, bloom: 1.25, bloomWide: 0.72, bloomThreshold: 1.15, bloomKnee: 0.6, exposure: 0.7, contrast: 1.3, saturation: 1.18, grain: 0.018, sharpen: 0.12,
      // phase two: fuller colour (her gold against the night's blue-violet), and bright warm things keep their gold
      // through the film curve instead of going to cream (0 = the curve's own answer)
      goldSaturation: 0.1, goldLights: 1, shaftsGold: 1.35,
      // the air round the lamps: how strongly it glows (1 = what air that scatters evenly would do), per kind; and how large each kind of lamp is (m)
      lamps: 1, lampCandle: 1.7, lampLantern: 1.5, lampBoss: 0.7, lampFlash: 1.2, sizeCandle: 0.85, sizeLantern: 0.3, sizeBoss: 2.2, sizeFlash: 0.6,
      reachCandle: 4.5, reachLantern: 2.5, reachBoss: 14, reachFlash: 9 };
    this.debug = null;                                                    // 'ao' | 'shafts' | 'bloom' | 'depth' | null

    const g = this.tri = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(g, null); this.mesh.frustumCulled = false; this.cam = new THREE.Camera();
    const M = (frag, uniforms) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: S.VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
    const T = () => ({ value: null }), V2 = () => ({ value: new THREE.Vector2() }), V4 = (x = 0, y = 0, z = 0, w = 0) => ({ value: new THREE.Vector4(x, y, z, w) });
    const proj = this.uProj = V4(0.1, 400, 1, 1), depth = this.uDepth = T(), air = { value: AIR }, camWorld = this.uCamWorld = { value: new THREE.Matrix4() };
    const texel = this.uTexel = V2(), half = this.uHalf = V2(), halfTexel = this.uHalfTexel = V2();
    this.m = {
      airAO: M(S.AIR_AO_FRAG, { tDepth: depth, uProj: proj, uTexel: texel, uHalf: half, uAO: V4(), uShaft: V4(), uCamWorld: camWorld, uShadowMatrix: { value: new THREE.Matrix4() }, tShadow: T(), uHasShadow: { value: 0 }, evAir: air,
        uLamp: { value: Array.from({ length: LAMPS }, () => new THREE.Vector4(0, 0, 0, 1)) }, uLampPower: { value: Array.from({ length: LAMPS }, () => new THREE.Vector4()) } }),
      airBlur: M(S.AIR_AO_BLUR_FRAG, { tDepth: depth, uProj: proj, tIn: T(), uTexel: texel, uHalfTexel: halfTexel }),
      composite: M(S.COMPOSITE_FRAG, { tDepth: depth, uProj: proj, tScene: T(), tHalf: T(), uTexel: texel, uHalf: half, uMix: V4(1), uShaftColor: { value: new THREE.Color() }, uLampWarm: { value: new THREE.Color() }, uLampOther: { value: new THREE.Color() }, uCamWorld: camWorld, evAir: air }),
      bloomPre: M(S.BLOOM_PRE_FRAG, { tIn: T(), uTexel: V2(), uBloom: V4() }),
      bloomDown: M(S.BLOOM_DOWN_FRAG, { tIn: T(), uTexel: V2() }),
      bloomUp: M(S.BLOOM_UP_FRAG, { tLow: T(), tHigh: T(), uTexel: V2(), uSpread: { value: 1 } }),
      dofPrep: M(S.DOF_PREP_FRAG, { tDepth: depth, uProj: proj, uDof: V4(), tIn: T(), uTexel: texel }),
      dofTile: M(S.DOF_TILE_FRAG, { tIn: T(), uTexel: halfTexel }),
      dofTileMax: M(S.DOF_TILE_MAX_FRAG, { tIn: T(), uTexel: V2() }),
      dofBlur: M(S.DOF_BLUR_FRAG, { tIn: T(), tTile: T(), uTexel: halfTexel }),
      dofFill: M(S.DOF_FILL_FRAG, { tFar: T(), tNear: T(), tTile: T(), uTexel: halfTexel }),
      dofComposite: M(S.DOF_COMPOSITE_FRAG, { tDepth: depth, uProj: proj, uDof: V4(), tIn: T(), tFar: T(), tNear: T() }),
      grade: M(S.GRADE_FRAG, { tIn: T(), tBloom: T(), uTone: V4(1, 0, 1, 1), uShadowTint: { value: new THREE.Color(1, 1, 1) }, uLightTint: { value: new THREE.Color(1, 1, 1) }, uFrame: V4(), uAspect: V4(), uGold: V4() }),
      fxaa: M(S.FXAA_FRAG, { tIn: T(), uTexel: texel }),
      output: M(S.OUTPUT_FRAG, { tIn: T(), uTexel: texel, uOut: V4() }),
      copy: M(S.COPY_FRAG, { tIn: T(), uScale: V4(1, 1, 1, 1) }),
    };
    this.m.dofPrep.uniforms.uDof = this.m.dofComposite.uniforms.uDof;      // one set of numbers for both

    // targets (sized in setSize)
    const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    const ldr = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    const dt = () => { const d = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType); d.minFilter = d.magFilter = THREE.NearestFilter; return d; };
    this.sceneDepthTexture = dt(); this.copyDepthTexture = dt(); this.copyDepthTexture.name = 'gfx.sceneDepth';
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: true, depthTexture: this.sceneDepthTexture, samples: 0 });
    this.sceneRT.texture.name = 'gfx.scene';
    this.depthCopy = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, depthTexture: this.copyDepthTexture, generateMipmaps: false });
    this.half = [new THREE.WebGLRenderTarget(4, 4, hdr), new THREE.WebGLRenderTarget(4, 4, hdr)];      // r occlusion, g moonlit air, b and a the air round the lamps
    this.hdrA = new THREE.WebGLRenderTarget(4, 4, hdr); this.hdrB = new THREE.WebGLRenderTarget(4, 4, hdr);
    this.ldrA = new THREE.WebGLRenderTarget(4, 4, ldr); this.ldrB = new THREE.WebGLRenderTarget(4, 4, ldr);
    this.down = []; this.up = [];
    for (let i = 0; i < 7; i++) { this.down.push(new THREE.WebGLRenderTarget(4, 4, hdr)); this.up.push(new THREE.WebGLRenderTarget(4, 4, hdr)); }
    this.dofHalf = new THREE.WebGLRenderTarget(4, 4, hdr);
    this.dofTile = new THREE.WebGLRenderTarget(4, 4, { ...hdr, format: THREE.RedFormat }); this.dofTileMax = new THREE.WebGLRenderTarget(4, 4, { ...hdr, format: THREE.RedFormat });
    this.dofBlur = new THREE.WebGLRenderTarget(4, 4, { ...hdr, count: 2 }); this.dofFill = new THREE.WebGLRenderTarget(4, 4, { ...hdr, count: 2 });
    this.all = [this.sceneRT, this.depthCopy, ...this.half, this.hdrA, this.hdrB, this.ldrA, this.ldrB, ...this.down, ...this.up, this.dofHalf, this.dofTile, this.dofTileMax, this.dofBlur, this.dofFill];

    // the hook in the scene pass: first among the transparent things, it copies the opaque scene's depth
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const hook = this.hook = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, depthTest: false, depthWrite: false, fog: false }));
    hook.name = 'gfx.depthCopy'; hook.frustumCulled = false; hook.renderOrder = -1e9; hook.layers.set(2); hook.castShadow = false;
    hook.onBeforeRender = (renderer, scene, camera) => { if (renderer.getRenderTarget() === this.sceneRT && camera === gfx.camera) this.copyDepth(); };
    gfx.scene.add(hook);
  }

  /** The scene's depth after everything opaque: valid while transparent things are drawn, and until the next frame. */
  get sceneDepth() { return this.copyDepthTexture; }

  /** w, h: the size the scene is drawn at; ow, oh: the canvas's drawing buffer; samples: multisampling of the scene. */
  setSize(w, h, ow, oh, samples) {
    w = Math.max(8, Math.round(w)); h = Math.max(8, Math.round(h));
    this.ow = ow; this.oh = oh;
    if (samples !== this.samples) { this.samples = samples; this.sceneRT.samples = samples; this.sceneRT.dispose(); }
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    this.sceneRT.setSize(w, h); this.depthCopy.setSize(w, h);
    this.hdrA.setSize(w, h); this.hdrB.setSize(w, h); this.ldrA.setSize(w, h); this.ldrB.setSize(w, h);
    this.half[0].setSize(hw, hh); this.half[1].setSize(hw, hh);
    let bw = hw, bh = hh;
    for (let i = 0; i < this.down.length; i++) { this.down[i].setSize(bw, bh); this.up[i].setSize(bw, bh); bw = Math.max(2, Math.ceil(bw / 2)); bh = Math.max(2, Math.ceil(bh / 2)); }
    this.dofHalf.setSize(hw, hh); this.dofBlur.setSize(hw, hh); this.dofFill.setSize(hw, hh);
    const tw = Math.max(2, Math.ceil(hw / 8)), th = Math.max(2, Math.ceil(hh / 8));
    this.dofTile.setSize(tw, th); this.dofTileMax.setSize(tw, th);
    this.uTexel.value.set(1 / w, 1 / h); this.uHalf.value.set(hw, hh); this.uHalfTexel.value.set(1 / hw, 1 / hh);
    this.m.dofTileMax.uniforms.uTexel.value.set(1 / tw, 1 / th);
    this.renderer.initRenderTarget(this.depthCopy);
  }

  /** Copy the depth of what has been drawn so far in the scene pass into gfx.sceneDepth. */
  copyDepth() {
    const r = this.renderer, gl = this.gl, st = r.state, a = r.properties.get(this.sceneRT), b = r.properties.get(this.depthCopy);
    const from = a.__webglMultisampledFramebuffer || a.__webglFramebuffer, to = b.__webglFramebuffer;
    if (!from || !to) return;
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, from); st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    st.bindFramebuffer(gl.FRAMEBUFFER, from);
  }

  /**
   * Where the point lights are and how strongly the air round each glows (for the half-resolution pass), and the two
   * colours the composite gives those glows. Evenly scattering air sends 1 / (4 pi) of a lamp's light each way.
   */
  setLamps(strength, cu) {
    const L = this.look, lights = this.gfx.lights, k = strength / (4 * Math.PI), S = this._lampSum || (this._lampSum = { n: 0, other: 0 });
    S.n = 0; S.other = 0; _lc.setRGB(0, 0, 0);
    // (a candle light's glow grows more slowly than its strength, about a cluster of ten: the few very strong ones at the
    // dais must not be all there is to see, the ordinary ones in the nave should show too)
    for (let i = 0; i < lights.candles.length; i++) { const l = lights.candles[i], c = l.intensity > 1e-3 ? Math.pow(10 / l.intensity, 0.25) : 1; this._lamp(l, L.lampCandle * k * c, L.sizeCandle, L.reachCandle, true); }
    this._lamp(lights.managed.lantern[0], L.lampLantern * k, L.sizeLantern, L.reachLantern, true);
    this._lamp(lights.managed.boss[0], L.lampBoss * k, L.sizeBoss, L.reachBoss, false);
    for (let i = 0; i < lights.managed.flash.length; i++) this._lamp(lights.managed.flash[i], L.lampFlash * k, L.sizeFlash, L.reachFlash, false);
    const W = this.m.airAO.uniforms.uLampPower.value;
    for (let n = S.n; n < LAMPS; n++) W[n].set(0, 0, 0, 0);
    cu.uLampWarm.value.copy(lights.candles[0].color);
    if (S.other > 1e-6) cu.uLampOther.value.setRGB(_lc.r / S.other, _lc.g / S.other, _lc.b / S.other); else cu.uLampOther.value.setRGB(0, 0, 0);
  }
  _lamp(l, gain, size, reach, warm) {
    const S = this._lampSum, n = S.n; if (n >= LAMPS) return;
    const u = this.m.airAO.uniforms, e = l.matrixWorld.elements, i = l.userData.noAir ? 0 : l.intensity * gain;      // (noAir: a light with no glow of its own in the air: the rescue's light off the water)
    u.uLamp.value[n].set(e[12], e[13], e[14], size * size);
    if (warm) u.uLampPower.value[n].set(i, 0, 1 / (reach * reach), 0);
    else { u.uLampPower.value[n].set(0, i, 1 / (reach * reach), 0); S.other += i; _lc.r += l.color.r * i; _lc.g += l.color.g * i; _lc.b += l.color.b * i; }
    S.n = n + 1;
  }

  draw(material, target) { this.mesh.material = material; this.renderer.setRenderTarget(target); this.renderer.render(this.mesh, this.cam); }

  /**
   * Compile every program of the chain (some are used only in cutscenes), each for the kind of target it is drawn into:
   * all of them into targets of the chain's own, except the last pass (and the plain copy, which stands in for the
   * whole chain with `nopost`), which draw onto the canvas.
   */
  warm() {
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.ldrA);
    for (const k in this.m) if (k !== 'output') { this.mesh.material = this.m[k]; r.compile(this.mesh, this.cam); }
    r.setRenderTarget(null);
    for (const k of ['output', 'copy']) { this.mesh.material = this.m[k]; r.compile(this.mesh, this.cam); }
    r.setRenderTarget(prev);
  }

  /** The whole chain, from the scene target to the canvas. */
  render(camera, mood, time) {
    const gfx = this.gfx, r = this.renderer, m = this.m, p = gfx.post, L = this.look, q = this.q;
    const c = Math.min(1, Math.max(0, mood.candle)), g = Math.min(1, Math.max(0, mood.gold));
    const w = this.w, h = this.h;
    this.frame++;
    const tan = Math.tan((camera.fov * Math.PI) / 360) / (camera.zoom || 1);
    this.uProj.value.set(camera.near, camera.far, tan * camera.aspect, tan);
    this.uCamWorld.value.copy(camera.matrixWorld);
    this.uDepth.value = this.sceneDepthTexture;
    const prevAuto = r.autoClear; r.autoClear = true;

    // ---- half resolution: occlusion and the moonlit air
    const ao = L.ao * (p.ao !== undefined ? p.ao : 1), sh = L.shafts * (p.shafts !== undefined ? p.shafts : 1) * (1 + (L.shaftsGold - 1) * g);
    let u = m.airAO.uniforms;
    u.uAO.value.set(L.aoRadius, L.aoPower, ao > 0.001 ? q.ao[0] : 0, q.ao[1]);
    const lamps = L.lamps * (p.lamps !== undefined ? p.lamps : 1);
    u.uShaft.value.set(sh > 0.001 ? q.shafts : 0, L.shaftReach, lamps > 0.001 && q.lamps !== false ? 1 : 0, L.shaftForward);
    this.setLamps(lamps, m.composite.uniforms);
    const shadow = gfx.lights.shadowMap; u.tShadow.value = shadow; u.uHasShadow.value = shadow ? 1 : 0; u.uShadowMatrix.value.copy(gfx.lights.shadowMatrix);
    this.draw(m.airAO, this.half[0]);
    m.airBlur.uniforms.tIn.value = this.half[0].texture; this.draw(m.airBlur, this.half[1]);

    // ---- composite
    u = m.composite.uniforms; u.tScene.value = this.sceneRT.texture; u.tHalf.value = this.half[1].texture; u.uMix.value.x = Math.min(1, ao);
    u.uShaftColor.value.copy(GRADE.shaft).lerp(GRADE.shaftGold, g).multiplyScalar(sh * gfx.lights.moon.intensity * 0.16);
    this.draw(m.composite, this.hdrA);
    let cur = this.hdrA;

    // ---- depth of field (cutscenes)
    const dof = p.dof;
    if (dof && dof.on && dof.aperture > 0) {
      const hh = this.half[0].height, maxR = Math.min(0.045, Math.max(0, dof.maxBlur)) * hh;
      m.dofComposite.uniforms.uDof.value.set(Math.max(0.05, dof.focus), dof.aperture, maxR, hh);
      m.dofPrep.uniforms.tIn.value = cur.texture; this.draw(m.dofPrep, this.dofHalf);
      m.dofTile.uniforms.tIn.value = this.dofHalf.texture; this.draw(m.dofTile, this.dofTile);
      m.dofTileMax.uniforms.tIn.value = this.dofTile.texture; this.draw(m.dofTileMax, this.dofTileMax);
      u = m.dofBlur.uniforms; u.tIn.value = this.dofHalf.texture; u.tTile.value = this.dofTileMax.texture; this.draw(m.dofBlur, this.dofBlur);
      u = m.dofFill.uniforms; u.tFar.value = this.dofBlur.textures[0]; u.tNear.value = this.dofBlur.textures[1]; u.tTile.value = this.dofTileMax.texture; this.draw(m.dofFill, this.dofFill);
      u = m.dofComposite.uniforms; u.tIn.value = cur.texture; u.tFar.value = this.dofFill.textures[0]; u.tNear.value = this.dofFill.textures[1];
      this.draw(m.dofComposite, this.hdrB); cur = this.hdrB;
    }

    // ---- bloom
    // as many halvings as bring the smallest level to about 14 lines: the glow is then as wide on the picture whatever size it is drawn at
    const levels = Math.max(3, Math.min(this.down.length, q.bloomLevels + 1, Math.round(Math.log2(this.half[0].height / 14)) + 1)), bloom = L.bloom * (p.bloom !== undefined ? p.bloom : 1);
    if (bloom > 0.001) {
      u = m.bloomPre.uniforms; u.tIn.value = cur.texture; u.uTexel.value.set(1 / w, 1 / h); u.uBloom.value.set(L.bloomThreshold, L.bloomKnee, 0, 0);
      this.draw(m.bloomPre, this.down[0]);
      for (let i = 1; i < levels; i++) { u = m.bloomDown.uniforms; u.tIn.value = this.down[i - 1].texture; u.uTexel.value.set(1 / this.down[i - 1].width, 1 / this.down[i - 1].height); this.draw(m.bloomDown, this.down[i]); }
      let low = this.down[levels - 1];
      for (let i = levels - 2; i >= 0; i--) {
        u = m.bloomUp.uniforms; u.tLow.value = low.texture; u.tHigh.value = this.down[i].texture; u.uTexel.value.set(1 / low.width, 1 / low.height); u.uSpread.value = L.bloomWide;
        this.draw(m.bloomUp, this.up[i]); low = this.up[i];
      }
    }

    // ---- grade
    u = m.grade.uniforms; u.tIn.value = cur.texture; u.tBloom.value = this.up[0].texture;
    const exposure = L.exposure * (p.exposure !== undefined ? p.exposure : 1) * (1 + 0.22 * (1 - c) * (1 - 0.4 * g));
    u.uTone.value.set(exposure, bloom > 0.001 ? (bloom * 1.0) / levels : 0, L.contrast, L.saturation * (1 + L.goldSaturation * g));
    u.uGold.value.set(L.goldLights * g, 0, 0, 0);
    u.uShadowTint.value.copy(GRADE.shadow).lerp(GRADE.shadowGold, g); u.uLightTint.value.copy(GRADE.light).lerp(GRADE.lightGold, g);
    const aspect = w / h, bar = Math.max(0, (1 - aspect / 2.39) / 2) * Math.min(1, Math.max(0, p.letterbox || 0));
    u.uFrame.value.set(p.vignette !== undefined ? p.vignette : 0.3, Math.min(1, Math.max(0, p.hurt || 0)), bar, Math.min(1, Math.max(0, p.fade || 0)));
    u.uAspect.value.set(aspect, Math.min(1.5, Math.max(0, p.impact || 0)), Math.min(1, Math.max(0, p.flash || 0)), 0);
    this.draw(m.grade, this.ldrA);
    let out = this.ldrA;

    // ---- debug views replace the picture
    if (this.debug) {
      u = m.copy.uniforms; u.uScale.value.set(1, 1, 1, 1);
      if (this.debug === 'ao') { u.tIn.value = this.half[1].texture; u.uScale.value.set(1, 0, 0, 1); }
      else if (this.debug === 'shafts') { u.tIn.value = this.half[1].texture; u.uScale.value.set(0, 1, 0, 1); }
      else if (this.debug === 'lamps') { u.tIn.value = this.half[1].texture; u.uScale.value.set(0, 0, 4, 1); }
      else if (this.debug === 'bloom') u.tIn.value = this.up[0].texture;
      else if (this.debug === 'hdr') u.tIn.value = cur.texture;
      else u.tIn.value = this.sceneRT.texture;
      this.draw(m.copy, this.ldrA);
    } else if (q.fxaa) { m.fxaa.uniforms.tIn.value = out.texture; this.draw(m.fxaa, this.ldrB); out = this.ldrB; }

    // ---- to the canvas
    u = m.output.uniforms; u.tIn.value = out.texture;
    const scale = w / Math.max(1, this.ow);
    const sharpen = this.debug ? 0 : Math.min(1, (p.sharpen !== undefined ? p.sharpen : L.sharpen) + (scale < 0.999 ? 0.55 * (1 - scale) + 0.2 : 0));
    u.uOut.value.set(sharpen, this.debug ? 0 : (p.grain !== undefined ? p.grain : L.grain) * (1 - Math.min(1, p.fade || 0)), (this.frame % 61) * 0.618, bar);
    this.draw(m.output, null);
    r.autoClear = prevAuto;
  }

  dispose() {
    this.gfx.scene.remove(this.hook); this.hook.geometry.dispose(); this.hook.material.dispose();
    for (const k in this.m) this.m[k].dispose();
    for (const t of this.all) t.dispose();
    this.sceneDepthTexture.dispose(); this.copyDepthTexture.dispose(); this.tri.dispose();
  }
}
