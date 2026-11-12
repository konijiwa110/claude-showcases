// Sky and air: the night sky dome with its moon, the height fog every material shares (see shaders/chunks.js),
// and the image-based light, which is a small picture of the hall baked into a PMREM and re-baked IN PLACE (the
// same texture object, so no material has to look for its program again) when the mood has moved a step.
import * as THREE from 'three';
import { AIR, patchChunks } from './shaders/chunks.js';
import { SKY_VERT, SKY_FRAG, HALL_FRAG, CLOUD_VERT, CLOUD_FRAG } from './shaders/sky.js';

const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const _c = new THREE.Color(), _a = new THREE.Color(), _b = new THREE.Color();
const addScaled = (to, c, k) => { to.r += c.r * k; to.g += c.g * k; to.b += c.b * k; return to; };

/** The colours of the night, in linear light. Everything that follows the mood is mixed from these. */
export const PALETTE = {
  moonCool: rgb(0.80, 0.89, 1.0), moonGold: rgb(1.0, 0.90, 0.70),
  skyTop: rgb(0.0045, 0.0095, 0.028), skyLow: rgb(0.017, 0.031, 0.070),
  // phase two: the night goes blue-violet and deeper (see lights.js); only the moon's disc and what it lights is gold
  skyTopGold: rgb(0.0055, 0.0050, 0.026), skyLowGold: rgb(0.023, 0.020, 0.068),
  cloud: rgb(0.034, 0.050, 0.085), cloudGold: rgb(0.032, 0.028, 0.072),
  haze: rgb(0.040, 0.066, 0.128), hazeGold: rgb(0.030, 0.028, 0.094),
  mist: rgb(0.070, 0.105, 0.185), mistWarm: rgb(0.090, 0.042, 0.012), mistGold: rgb(0.034, 0.030, 0.084),
  warm: rgb(1.0, 0.50, 0.19), gold: rgb(1.0, 0.78, 0.40),
  stone: rgb(0.030, 0.040, 0.062), stoneGold: rgb(0.030, 0.035, 0.082),
};

// The seen moon (see Env.moon). With 30 m behind and a radius of 9 m (the first numbers tried) the disc was larger
// than the window from the doors and a third of it stood over the broken gable; from a high camera it left the
// window altogether. At 4 m behind, 86% of the window's radius, it stays inside the window's circle from every place
// in the nave and from the cutscenes' high cameras, and still slides a little behind the tracery as the camera moves.
const MOON_BEHIND = 4, MOON_UP = 1.1, MOON_FILL = 0.86;

const ENV_SIZE = 128;                    // per face of the environment cube (three's PMREM filter takes 256 samples a texel: keep it small)
// The cloud field is baked into a square texture (shaders/sky.js): CLOUD_SPAN is its width in the field's own
// coordinates (the dome reaches +-3.97 of them; the rest is room for the cloud to drift before the next bake).
const CLOUD_SIZE = 1024, CLOUD_SPAN = 8.7, CLOUD_DRIFT = [0.004, 0.0017], CLOUD_ROOM = 0.2;
const MOOD_STEPS = 12;                   // the image-based light is re-baked when the mood crosses one of these steps

export class Env {
  constructor(gfx) {
    patchChunks();
    this.gfx = gfx; const r = this.renderer = gfx.renderer, scene = this.scene = gfx.scene;
    this.moonDir = new THREE.Vector3(0, 13.3, -35.5).normalize();   // the light's direction (ctx.arena.moonDir): shadows and shafts
    // The moon that is SEEN is not at infinity (it would slide out of the rose window as the camera walks up the
    // nave): it is drawn as a sphere hanging close behind the east wall, so the window frames it from everywhere.
    // How close decides how far it slides in the window as the camera moves: MOON_BEHIND metres behind the window's
    // plane, MOON_UP above its centre (so that from the doors, 2 m up, it sits in the middle), MOON_FILL of its radius.
    this.moon = new THREE.Vector4(0, 15 + MOON_UP, -25.5 - MOON_BEHIND, 5 * MOON_FILL);      // x, y, z (world, metres), radius (metres)
    this.seen = new THREE.Vector3().copy(this.moonDir);             // the disc's direction from the game's camera
    this.time = 0; this.bakes = 0; this.bakedKey = ''; this.bakeWait = 0;

    // ---- the cloud field, baked (see shaders/sky.js): one small target, filled again when the cloud has drifted
    this.cloudRT = new THREE.WebGLRenderTarget(CLOUD_SIZE, CLOUD_SIZE, { type: THREE.UnsignedByteType, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    this.cloudRT.texture.name = 'gfx.cloud';
    this.cloudAt = new THREE.Vector4(0, 0, 1 / CLOUD_SPAN, 0); this.cloudBaked = false; this.cloudBakes = 0;
    { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      this.cloudMaterial = new THREE.ShaderMaterial({ name: 'sky.cloud', uniforms: { uSkyCloud: { value: this.cloudAt } }, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
      this.cloudMesh = new THREE.Mesh(g, this.cloudMaterial); this.cloudMesh.frustumCulled = false; this.cloudCam = new THREE.Camera(); }

    // ---- the visible sky: a box round the camera, pushed to the far plane, drawn after everything opaque
    const su = this.skyUniforms = {
      uMoon: { value: this.moon }, uMoonColor: { value: new THREE.Color() }, uSkyTop: { value: new THREE.Color() }, uSkyLow: { value: new THREE.Color() },
      uCloudColor: { value: new THREE.Color() }, uSkyParams: { value: new THREE.Vector4(0, 0, 1, 1) },
      tSkyCloud: { value: this.cloudRT.texture }, uSkyCloud: { value: this.cloudAt },
    };
    this.box = new THREE.BoxGeometry(2, 2, 2);
    this.skyMaterial = new THREE.ShaderMaterial({ name: 'sky', uniforms: su, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false });
    this.sky = new THREE.Mesh(this.box, this.skyMaterial); this.sky.name = 'sky'; this.sky.frustumCulled = false; this.sky.renderOrder = 1000; this.sky.matrixAutoUpdate = false;
    scene.add(this.sky);

    // ---- the picture of the hall for image-based light
    const hu = this.hallUniforms = {
      uMoon: su.uMoon, uMoonColor: { value: new THREE.Color() }, uSkyTop: su.uSkyTop, uSkyLow: su.uSkyLow, uCloudColor: su.uCloudColor,
      uSkyParams: { value: new THREE.Vector4(0, 0, 0, 0.6) }, tSkyCloud: su.tSkyCloud, uSkyCloud: su.uSkyCloud,
      uMood: { value: new THREE.Vector2(1, 0) }, uWarm: { value: new THREE.Color() }, uGold: { value: new THREE.Color() }, uStone: { value: new THREE.Color() },
      uHall: { value: new THREE.Vector4(14, -25.5, 21.5, 17) }, uWindow: { value: new THREE.Vector4(0, 15, -25.5, 5) }, uProbe: { value: new THREE.Vector3(0, 2.2, 0) },
    };
    this.hallMaterial = new THREE.ShaderMaterial({ name: 'env.hall', uniforms: hu, vertexShader: SKY_VERT, fragmentShader: HALL_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false });
    this.envScene = new THREE.Scene(); const hall = new THREE.Mesh(this.box, this.hallMaterial); hall.frustumCulled = false; this.envScene.add(hall);
    this.cube = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cube); this.cubeCam.position.copy(hu.uProbe.value);     // so the moon is where the probe would see it
    this.pmrem = new THREE.PMREMGenerator(r);
    this.target = null;

    // ---- three's own fog object: it switches the fog code on in every material, and its colour and density are a
    // one-number summary of the air for code that reads scene.fog (the real numbers are in AIR)
    scene.fog = new THREE.FogExp2(0x0a1220, 0.016);
    scene.background = null;
    scene.environmentIntensity = 1;

    // The air. near / full: the air between the eye and `near` metres hardly counts and counts in full from `full` on
    // (the near picture stays deep; the far end of the nave sinks into haze). candleGlow: the candles' light at the
    // water (see shaders/chunks.js, 4), candleHeight: the height over which it dies away, hx / hz: where candles float.
    this.air = { uniform: 0.003, haze: 0.008, hazeHeight: 9, mist: 0.034, mistHeight: 0.5, max: 0.93, glow: 0.03, waterY: 0.07, scale: 1,
      near: 9, full: 46, candleGlow: 1.6, candleHeight: 1.0, hx: 13, hz: 19, edge: 5, iblDiffuse: 0.45 };
    this.update(0, gfx.mood, 0);          // also bakes the first image-based light
  }

  /** Point the moon (and everything that follows it) along a new direction. */
  setMoonDir(v) { if (v && v.lengthSq() > 0 && this.moonDir.distanceToSquared(_n.copy(v).normalize()) > 1e-8) { this.moonDir.copy(_n); this.bakedKey = ''; return true; } return false; }

  /** Take the place of the rose window and of the candles from the arena (ctx.arena, when it exists). */
  setHall(arena) {
    if (!arena) return;
    const w = arena.window, h = this.hallUniforms, b = arena.bounds;
    if (w) {
      h.uWindow.value.set(w.x || 0, w.y || 15, w.z || -25.5, w.r || 5); h.uHall.value.y = w.z || -25.5;
      this.moon.set(w.x || 0, (w.y || 15) + MOON_UP, (w.z || -25.5) - MOON_BEHIND, (w.r || 5) * MOON_FILL);
    }
    if (b) { this.air.hx = (b.hx || 11) + 2; this.air.hz = (b.hz || 17) + 2; }
    this.bakedKey = '';
  }

  /** Once a frame: colours that follow the mood, the fog's numbers, and a re-bake of the image-based light if it is due. */
  update(time, mood, dt = 1 / 60) {
    this.time = time;
    const c = Math.min(1, Math.max(0, mood.candle)), g = Math.min(1, Math.max(0, mood.gold)), P = PALETTE;
    const su = this.skyUniforms, hu = this.hallUniforms, air = this.air;
    // the lights' dimmer (gfx.lights.dim: the rescue darkens the hall round its lamp) reaches the air and the light the
    // hall gives back too; at 1, as always, nothing here changes
    const dim = this.gfx.lights && typeof this.gfx.lights.dim === 'number' ? this.gfx.lights.dim : 1;
    this.scene.environmentIntensity = dim;
    su.uMoonColor.value.copy(P.moonCool).lerp(P.moonGold, g).multiplyScalar(2.1 + 0.25 * g);
    su.uSkyTop.value.copy(P.skyTop).lerp(P.skyTopGold, g); su.uSkyLow.value.copy(P.skyLow).lerp(P.skyLowGold, g);
    su.uCloudColor.value.copy(P.cloud).lerp(P.cloudGold, g);
    su.uSkyParams.value.y = time; su.uSkyParams.value.w = 1 - 0.55 * g;      // in phase two the cloud thins: a deeper sky round a gold moon
    // the cloud has drifted out of what was baked (about every fifty seconds), or nothing has been baked yet
    { const x = time * CLOUD_DRIFT[0], y = time * CLOUD_DRIFT[1], at = this.cloudAt; if (!this.cloudBaked || Math.abs(x - at.x) > CLOUD_ROOM || Math.abs(y - at.y) > CLOUD_ROOM) this.bakeCloud(x, y); }
    hu.uMoonColor.value.copy(su.uMoonColor.value);

    // the air
    const A = AIR, k = air.scale;
    _a.copy(P.haze).lerp(P.hazeGold, g);
    if (dim !== 1) _a.multiplyScalar(dim);
    A[0] = _a.r; A[1] = _a.g; A[2] = _a.b; A[3] = air.haze * k;
    _b.copy(P.mist).lerp(P.mistGold, g * 0.8).multiplyScalar(1 - 0.5 * c); addScaled(_b, P.mistWarm, c * (1 - 0.5 * g));
    if (dim !== 1) _b.multiplyScalar(dim);
    A[4] = _b.r; A[5] = _b.g; A[6] = _b.b; A[7] = air.mist * k;
    const cam = this.gfx.camera, seen = this.seen.set(this.moon.x - cam.position.x, this.moon.y - cam.position.y, this.moon.z - cam.position.z);
    if (seen.lengthSq() > 1e-6) seen.normalize(); else seen.copy(this.moonDir);
    A[8] = seen.x; A[9] = seen.y; A[10] = seen.z; A[11] = air.waterY;
    _c.copy(P.moonCool).lerp(P.moonGold, g).multiplyScalar(air.glow * dim);
    A[12] = _c.r; A[13] = _c.g; A[14] = _c.b; A[15] = air.uniform * k;
    A[16] = 1 / air.hazeHeight; A[17] = 1 / air.mistHeight; A[18] = air.max; A[19] = time;
    A[20] = c; A[21] = g; A[22] = air.near; A[23] = air.full;
    const glow = air.candleGlow * c * dim;
    A[24] = P.warm.r * glow + P.gold.r * 0.05 * g; A[25] = P.warm.g * glow + P.gold.g * 0.05 * g; A[26] = P.warm.b * glow + P.gold.b * 0.05 * g; A[27] = 1 / air.candleHeight;
    A[28] = air.hx; A[29] = air.hz; A[30] = air.edge; A[31] = 0;
    A[55] = 1 - air.iblDiffuse;                                          // how much of the image-based light's diffuse part is left out
    // the one-number summary: what 30 m of air at eye height hides
    const tau = (air.uniform + air.haze * Math.exp(-1.6 / air.hazeHeight) + air.mist * Math.exp(-1.6 / air.mistHeight)) * k * 30;
    this.scene.fog.density = Math.sqrt(tau) / 30; this.scene.fog.color.copy(_a).lerp(_b, 0.25);

    // image-based light: re-bake when the mood has moved a step (at most once every few frames)
    this.bakeWait -= 1;
    const key = Math.round(c * MOOD_STEPS) + ':' + Math.round(g * MOOD_STEPS);
    if (key !== this.bakedKey && this.bakeWait <= 0) this.bake(mood);
  }

  /** Fill the cloud texture round where the cloud field has drifted to (x, y in the field's own coordinates). */
  bakeCloud(x, y) {
    const r = this.renderer, prevTarget = r.getRenderTarget(), prevAuto = r.autoClear, prevXr = r.xr.enabled, prevShadow = r.shadowMap.autoUpdate, prevNeeds = r.shadowMap.needsUpdate;
    this.cloudAt.x = x; this.cloudAt.y = y;
    r.xr.enabled = false; r.autoClear = true; r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    r.setRenderTarget(this.cloudRT); r.render(this.cloudMesh, this.cloudCam);
    r.setRenderTarget(prevTarget); r.autoClear = prevAuto; r.xr.enabled = prevXr; r.shadowMap.autoUpdate = prevShadow; r.shadowMap.needsUpdate = prevNeeds;
    this.cloudBaked = true; this.cloudBakes++;
  }

  /** Draw the hall's picture into the cube and filter it into the PMREM that scene.environment points at. */
  bake(mood) {
    const r = this.renderer, c = Math.min(1, Math.max(0, mood.candle)), g = Math.min(1, Math.max(0, mood.gold)), P = PALETTE, hu = this.hallUniforms;
    const qc = Math.round(c * MOOD_STEPS) / MOOD_STEPS, qg = Math.round(g * MOOD_STEPS) / MOOD_STEPS;
    hu.uMood.value.set(qc, qg);
    hu.uWarm.value.copy(P.warm).multiplyScalar(0.17); hu.uGold.value.copy(P.gold).multiplyScalar(0.11);
    hu.uStone.value.copy(P.stone).lerp(P.stoneGold, qg);
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear, prevXr = r.xr.enabled, prevShadow = r.shadowMap.autoUpdate, prevNeeds = r.shadowMap.needsUpdate;
    r.xr.enabled = false; r.autoClear = true; r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    this.cubeCam.update(r, this.envScene);
    this.target = this.pmrem.fromCubemap(this.cube.texture, this.target);
    r.setRenderTarget(prevTarget); r.autoClear = prevAuto; r.xr.enabled = prevXr; r.shadowMap.autoUpdate = prevShadow; r.shadowMap.needsUpdate = prevNeeds;
    if (this.scene.environment !== this.target.texture) this.scene.environment = this.target.texture;
    this.bakedKey = Math.round(c * MOOD_STEPS) + ':' + Math.round(g * MOOD_STEPS); this.bakeWait = 3; this.bakes++;
  }

  dispose() {
    this.scene.remove(this.sky); if (this.scene.environment === (this.target && this.target.texture)) this.scene.environment = null;
    this.scene.fog = null;
    this.box.dispose(); this.skyMaterial.dispose(); this.hallMaterial.dispose(); this.cube.dispose(); if (this.target) this.target.dispose(); this.pmrem.dispose();
    this.cloudRT.dispose(); this.cloudMaterial.dispose(); this.cloudMesh.geometry.dispose();
  }
}
const _n = new THREE.Vector3();
