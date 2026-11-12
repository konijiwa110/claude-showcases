// Effects: the air when nothing is happening. Mist lying on the water in slow sheets, dust that shows where the
// moon's shaft comes down from the rose window, and a few pale moths that keep to the candlelight and leave when
// it goes out. Three draw calls; the mist and dust move in the shader, the moths are steered on the CPU.
//
// Not part of the contract: other modules use ctx.vfx (src/gfx/vfx.js).
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { GLSL_OUT, PREMULTIPLIED, passInfo, blankTexture } from './fx_common.js';

// =============================================================================================================== mist
const mistVert = (probe) => /* glsl */`
attribute vec4 iA;   // x, z, seed, how fast it drifts
attribute vec4 iB;   // width, height, opacity, lift over the water
uniform float uTime;
uniform vec4 uDom;   // centre x, centre z, half width, half length of the hall the mist lives in
uniform vec2 uWind;
uniform float uWaterY, uCentre;
varying vec2 vUv;
varying vec3 vW;
varying vec4 vI;     // seed, opacity, width, view depth
varying vec4 vAir;
${probe.glsl}
void main() {
  vec2 c = iA.xy + uWind * uTime * iA.w;
  vec2 rel = mod(c - uDom.xy + uDom.zw, 2.0 * uDom.zw) - uDom.zw;
  vec2 xz = uDom.xy + rel;
  float edge = smoothstep(uDom.z, uDom.z - 5.0, abs(rel.x)) * smoothstep(uDom.w, uDom.w - 5.0, abs(rel.y));
  // it gathers along the arcades and at both ends, and thins where the fight is
  float gather = max(smoothstep(5.0, 11.5, abs(xz.x)), smoothstep(9.0, 17.0, abs(xz.y)));
  float a = iB.z * edge * mix(uCentre, 1.0, gather);
  vec3 base = vec3(xz.x, uWaterY + iB.w, xz.y);
  vec2 toCam = cameraPosition.xz - base.xz;
  vec2 rt = normalize(vec2(toCam.y, -toCam.x) + 1e-5);
  vec3 wp = base + vec3(rt.x, 0.0, rt.y) * (position.x * iB.x) + vec3(0.0, (position.y + 0.5) * iB.y, 0.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vUv = position.xy + 0.5; vW = wp; vI = vec4(iA.z, a, iB.x, -mv.z);
  vAir = fxAir(cameraPosition, wp);
  gl_Position = a > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const mistFrag = (probe) => /* glsl */`
uniform sampler2D tNoise;
uniform sampler2D tDepth;
uniform float uTime, uSoft, uGain, uOpacity;
uniform vec2 uRes, uNearFar;
uniform vec4 uWho[2];    // x, z, radius, strength: the mist parts round the fighters
uniform vec4 uGust[3];   // x, z, when, power: a slam blows a hole that widens and heals
varying vec2 vUv;
varying vec3 vW;
varying vec4 vI;
varying vec4 vAir;
${probe.glsl}
#include <packing>
void main() {
  float u = vUv.x, v = vUv.y, seed = vI.x;
  float mx = 1.0 - (u * 2.0 - 1.0) * (u * 2.0 - 1.0); mx *= mx;
  float my = smoothstep(0.0, 0.22, v) * pow(1.0 - v, 1.5) * 2.2;
  vec2 nuv = vec2(u * vI.z * 0.055 + seed * 7.3 + uTime * 0.004, v * 0.32 + seed * 3.1);
  float n = texture2D(tNoise, nuv).r;
  float w = texture2D(tNoise, nuv * vec2(2.3, 1.6) + vec2(uTime * 0.007, uTime * 0.002)).g;
  float a = smoothstep(0.42, 0.98, n * 0.72 + w * 0.42) * mx * my * vI.y * uOpacity;
  for (int i = 0; i < 2; i++) { vec2 d = vW.xz - uWho[i].xy; a *= 1.0 - uWho[i].w * exp(-dot(d, d) / (uWho[i].z * uWho[i].z)); }
  for (int i = 0; i < 3; i++) {
    float tau = uTime - uGust[i].z; if (tau < 0.0 || tau > 9.0) continue;
    float R = 1.2 + tau * 3.2; vec2 d = vW.xz - uGust[i].xy;
    a *= 1.0 - clamp(uGust[i].w * exp(-tau * 0.55) * (1.0 - exp(-tau * 6.0)) * exp(-dot(d, d) / (R * R)), 0.0, 0.95);
  }
  vec3 ray = vW - cameraPosition; float dist = length(ray); ray /= dist;
  a *= smoothstep(1.2, 5.5, dist) * (1.0 - smoothstep(40.0, 60.0, dist));
  if (uSoft > 0.5) {
    float sceneZ = -perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x, uNearFar.x, uNearFar.y);
    a *= clamp((sceneZ - vI.w) / 0.9, 0.0, 1.0);
  }
  a = clamp(a, 0.0, 1.0);
  if (a < 0.002) discard;
  // lit from behind by the moon when you look its way; warmed by whatever lamp is in it
  float toMoon = max(dot(ray, uMoonDir), 0.0);
  vec3 light = fxMistCol() * 1.25 + fxMoonGlow() * (0.6 + 5.0 * toMoon * toMoon * toMoon * toMoon) + fxPoints(vW) * 0.02;
  light = light * (0.8 + 0.4 * w) * vAir.a + vAir.rgb;
  gl_FragColor = vec4(light * a * uGain, a);
  ${GLSL_OUT}
}`;

export class Mist {
  constructor(ctx, probe, noise, rng, count = 84) {
    this.ctx = ctx; this.count = count; this.gusts = 0;
    const geo = this.geometry = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
    const A = new Float32Array(count * 4), B = new Float32Array(count * 4);
    const hx = 17, hz = 26;
    for (let i = 0; i < count; i++) {
      const o = i * 4, tall = rng.next();
      A[o] = rng.signed() * hx; A[o + 1] = rng.signed() * hz; A[o + 2] = rng.next(); A[o + 3] = 0.6 + 0.8 * rng.next();
      B[o] = 6.5 + 5.5 * rng.next(); B[o + 1] = 0.75 + 1.25 * tall * tall; B[o + 2] = 0.5 + 0.5 * rng.next(); B[o + 3] = -0.04;
    }
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4)); geo.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 4)); geo.instanceCount = count;
    this.who = [new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0)];
    this.gust = [new THREE.Vector4(0, 0, -100, 0), new THREE.Vector4(0, 0, -100, 0), new THREE.Vector4(0, 0, -100, 0)];
    const u = this.uniforms = Object.assign({
      uTime: { value: 0 }, uDom: { value: new THREE.Vector4(0, -1, hx, hz) }, uWind: { value: new THREE.Vector2(0.075, 0.1) }, uWaterY: { value: WATER_Y }, uCentre: { value: 0.42 },
      tNoise: { value: noise }, tDepth: { value: blankTexture() }, uSoft: { value: 0 }, uGain: { value: 1 }, uOpacity: { value: 0.06 }, uRes: { value: new THREE.Vector2(1600, 900) }, uNearFar: { value: new THREE.Vector2(0.1, 400) },
      uWho: { value: this.who }, uGust: { value: this.gust },
    }, probe.uniforms);
    const mat = this.material = Object.assign(new THREE.ShaderMaterial({ name: 'fx.mist', uniforms: u, vertexShader: mistVert(probe), fragmentShader: mistFrag(probe) }), PREMULTIPLIED);
    const mesh = this.mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx.mist'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = 10; mesh.layers.set(2);
    mesh.onBeforeRender = (renderer, scene, camera) => { passInfo(renderer, camera, ctx, u); mat.uniformsNeedUpdate = true; };
  }
  /** A slam at (x, z): the mist is blown open there and closes again over some seconds. power 0..1. */
  blow(x, z, power, time) { const g = this.gust[this.gusts++ % 3]; g.set(x, z, time, Math.min(0.95, power)); }
  update(time) {
    const p = this.ctx.player, b = this.ctx.boss;
    if (p) this.who[0].set(p.pos.x, p.pos.z, 1.5, 0.75);
    if (b) this.who[1].set(b.pos.x, b.pos.z, 3.6, b.alive === false ? 0.3 : 0.8);
  }
  /** `clock` is the effects' whole running time (never set back), the same clock blow() was given. */
  frame(clock) { this.uniforms.uTime.value = clock; }
  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}

// =============================================================================================================== dust
const dustVert = (probe) => /* glsl */`
attribute vec4 iA;   // a place in a unit box, seed
uniform float uTime, uGain;
uniform vec3 uBox, uShaftA, uShaftDir;
uniform float uShaftR;
uniform vec2 uRes;
varying vec2 vUv;
varying vec3 vCol;
${probe.glsl}
void main() {
  float seed = iA.w;
  vec3 p = iA.xyz * uBox + vec3(sin(uTime * 0.11 + seed * 40.0) * 0.7, uTime * (0.015 + 0.03 * fract(seed * 7.0)) * (fract(seed * 3.0) > 0.4 ? -1.0 : 1.0), cos(uTime * 0.09 + seed * 23.0) * 0.7) + vec3(0.06, 0.0, 0.08) * uTime;
  vec3 q;
  q.xz = cameraPosition.xz + mod(p.xz - cameraPosition.xz + 0.5 * uBox.xz, uBox.xz) - 0.5 * uBox.xz;   // the box follows the camera
  q.y = 0.12 + mod(p.y, uBox.y);
  q += 0.05 * vec3(sin(uTime * 0.7 + seed * 90.0), sin(uTime * 0.9 + seed * 50.0), cos(uTime * 0.8 + seed * 70.0));
  // the moon's shaft through the rose window, broken into lanes by its tracery
  vec3 rel = q - uShaftA; float along = dot(rel, uShaftDir); vec3 perp = rel - uShaftDir * along; float dr = length(perp);
  vec3 e1 = normalize(cross(uShaftDir, vec3(0.0, 1.0, 0.0))), e2 = cross(uShaftDir, e1);
  float ang = atan(dot(perp, e1), dot(perp, e2));
  float lanes = 0.35 + 0.65 * smoothstep(-0.3, 0.5, cos(ang * 8.0) * cos(dr * 2.2 + 0.6));
  float shaft = (1.0 - smoothstep(uShaftR * 0.7, uShaftR, dr)) * step(0.0, along) * lanes;
  vec3 light = (uAmbCol * 0.07 + uMoonCol * shaft * 0.5 + fxCandleGlow(q.y) * 0.22 + fxPoints(q) * 0.1) * fxAir(cameraPosition, q).a;
  vec4 mv = viewMatrix * vec4(q, 1.0);
  float depth = max(-mv.z, 0.05);
  float px = depth * 2.0 / (projectionMatrix[1][1] * uRes.y);
  float size = 0.006 + 0.012 * fract(seed * 11.0);
  float nearK = 1.0 + 2.2 * (1.0 - smoothstep(0.4, 2.2, depth));                // out of focus close to the eye: bigger and fainter
  float w = max(size * nearK, 3.0 * px);                                      // never under three pixels: a soft speck, not a hot pixel
  float tw = 0.45 + 0.55 * sin(seed * 60.0 + uTime * (0.6 + 1.6 * fract(seed * 17.0)));
  float fade = (1.0 - smoothstep(11.0, 17.0, depth)) * smoothstep(0.15, 0.5, depth);
  vCol = light * tw * fade * uGain * min(1.0, size / w) * 6.0;
  vUv = position.xy;
  mv.xy += position.xy * w;
  gl_Position = dot(vCol, vec3(1.0)) > 0.0015 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const DUST_FRAG = /* glsl */`
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float d2 = dot(vUv, vUv) * 4.0; if (d2 >= 1.0) discard;
  gl_FragColor = vec4(vCol * exp(-d2 * 3.5) * (1.0 - d2), 0.0);
  ${GLSL_OUT}
}`;

export class Dust {
  constructor(ctx, probe, rng, count = 1500) {
    this.ctx = ctx;
    const geo = this.geometry = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
    const A = new Float32Array(count * 4); for (let i = 0; i < A.length; i++) A[i] = rng.next();
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4)); geo.instanceCount = count;
    const u = this.uniforms = Object.assign({
      uTime: { value: 0 }, uGain: { value: 1 }, uBox: { value: new THREE.Vector3(26, 9.5, 26) }, uShaftA: { value: new THREE.Vector3(0, 15, -25.5) },
      uShaftDir: { value: new THREE.Vector3(0, -0.35, 0.94) }, uShaftR: { value: 5 }, uRes: { value: new THREE.Vector2(1600, 900) },
    }, probe.uniforms);
    const mat = this.material = Object.assign(new THREE.ShaderMaterial({ name: 'fx.dust', uniforms: u, vertexShader: dustVert(probe), fragmentShader: DUST_FRAG }), PREMULTIPLIED);
    const mesh = this.mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx.dust'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = 11; mesh.layers.set(2);
    mesh.onBeforeRender = (renderer, scene, camera) => { passInfo(renderer, camera, ctx, u); mat.uniformsNeedUpdate = true; };
    this.next = 0;
  }
  update(time) {
    if (time < this.next) return; this.next = time + 2;                          // the window and the moon are where the arena says
    const a = this.ctx.arena, u = this.uniforms;
    if (a && a.window) { u.uShaftA.value.set(a.window.x, a.window.y, a.window.z); u.uShaftR.value = a.window.r || 5; }
    if (a && a.moonDir) u.uShaftDir.value.copy(a.moonDir).negate().normalize();
  }
  frame(clock) { this.uniforms.uTime.value = clock; }
  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}

// ============================================================================================================== moths
const mothVert = (probe) => /* glsl */`
attribute float aPart;   // 0 body, 1 and 2 the wings, 3 the glow round it
attribute float aEdge;   // 0 on a wing's outline, 1 inside
attribute vec4 iP;       // place, half span
attribute vec4 iV;       // velocity, wing phase
attribute vec4 iM;       // how wide the wings beat, seed, shown 0..1, -
uniform float uLead, uGain;
varying vec4 vCol;       // light on it, part
varying vec3 vQ;         // edge, wing coordinates
${probe.glsl}
void main() {
  vec3 centre = iP.xyz + iV.xyz * uLead;
  float size = iP.w, shown = iM.z;
  vec3 f = normalize(vec3(iV.x, 0.0, iV.z) + vec3(1e-4, 0.0, 2e-4));
  float pitch = 0.5 + clamp(iV.y * 0.35, -0.45, 0.6);                       // they fly nose up
  vec3 fwd = normalize(f * cos(pitch) + vec3(0.0, sin(pitch), 0.0));
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up2 = cross(right, fwd);
  vec3 lp = position, n = vec3(0.0, 1.0, 0.0);
  if (aPart > 0.5 && aPart < 2.5) {
    float flap = iM.x * (0.28 + sin(iV.w));
    float cx = cos(flap), sx = sin(flap), sgn = aPart < 1.5 ? 1.0 : -1.0;
    lp = vec3(lp.x * cx, abs(lp.x) * sx, lp.z);
    n = vec3(-sgn * sx, cx, 0.0);
  }
  vec3 wp = centre;
  if (aPart > 2.5) { vec4 mv = viewMatrix * vec4(centre, 1.0); mv.xy += position.xy * size * 4.5; gl_Position = projectionMatrix * mv; }
  else { wp = centre + (right * lp.x + up2 * lp.y + fwd * lp.z) * size; gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0); }
  vec3 nw = normalize(right * n.x + up2 * n.y + fwd * n.z);
  vec3 light = uAmbCol + uMoonCol * 0.25 * (0.35 + 0.65 * abs(dot(nw, uMoonDir))) + fxPoints(wp) * 0.25 + fxCandleGlow(wp.y) * 0.35;   // thin wings: light comes through
  light *= fxAir(cameraPosition, wp).a;
  vCol = vec4(light * uGain, aPart);
  vQ = vec3(aEdge, position.x, aPart > 2.5 ? position.y : position.z);
  if (shown < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ.x *= shown;
}`;
const MOTH_FRAG = /* glsl */`
uniform vec3 uPale;
uniform float uOwn;
varying vec4 vCol;
varying vec3 vQ;
void main() {
  float part = vCol.a; vec3 rgb; float a;
  if (part > 2.5) {                                   // the soft light a pale thing has in the dark
    float d2 = dot(vQ.yz, vQ.yz); if (d2 >= 1.0) discard;
    rgb = uPale * (vCol.rgb * 0.05 + uOwn * 0.35) * exp(-d2 * 5.0) * (1.0 - d2) * min(vQ.x * 4.0, 1.0); a = 0.0;
  } else if (part > 0.5) {
    float span = abs(vQ.y);
    float band = 1.0 - 0.3 * smoothstep(0.55, 0.95, span) - 0.18 * (1.0 - smoothstep(0.0, 0.2, span));
    float eye = 1.0 - 0.3 * exp(-((span - 0.62) * (span - 0.62) + (vQ.z - 0.22) * (vQ.z - 0.22)) / 0.006);
    a = smoothstep(0.0, 0.28, vQ.x) * 0.93;
    rgb = uPale * band * eye * (vCol.rgb + uOwn) * a;
  } else { a = 0.95; rgb = uPale * vec3(0.5, 0.46, 0.4) * (vCol.rgb + uOwn * 0.6) * a; }
  gl_FragColor = vec4(rgb, a);
  ${GLSL_OUT}
}`;

const WING_F = [[0.05, 0.22], [0.55, 0.52], [1.0, 0.5], [0.95, 0.2], [0.6, -0.02], [0.05, 0.0]];
const WING_H = [[0.05, 0.0], [0.62, -0.05], [0.72, -0.38], [0.45, -0.62], [0.15, -0.48], [0.05, -0.2]];
const _m = new THREE.Vector3();

export class Moths {
  constructor(ctx, probe, rng, count = 26) {
    this.ctx = ctx; this.count = count; this.rng = rng; this.probe = probe;
    // one moth: two wings a side as fans round an inside point, a body, and the glow
    const pos = [], part = [], edge = [], idx = [];
    const fan = (outline, sign, p) => {
      let cx = 0, cz = 0; for (const q of outline) { cx += q[0]; cz += q[1]; } cx /= outline.length; cz /= outline.length;
      const base = pos.length / 3; pos.push(sign * cx, 0, cz); part.push(p); edge.push(1);
      for (const q of outline) { pos.push(sign * q[0], 0, q[1]); part.push(p); edge.push(0); }
      for (let i = 0; i < outline.length; i++) idx.push(base, base + 1 + i, base + 1 + ((i + 1) % outline.length));
    };
    fan(WING_F, 1, 1); fan(WING_H, 1, 1); fan(WING_F, -1, 2); fan(WING_H, -1, 2);
    const b0 = pos.length / 3; pos.push(0, 0, 0.34, 0, 0, -0.46, 0.06, 0, 0, -0.06, 0, 0, 0, 0.06, 0, 0, -0.06, 0); for (let i = 0; i < 6; i++) { part.push(0); edge.push(1); }
    idx.push(b0, b0 + 2, b0 + 4, b0, b0 + 4, b0 + 3, b0, b0 + 3, b0 + 5, b0, b0 + 5, b0 + 2, b0 + 1, b0 + 4, b0 + 2, b0 + 1, b0 + 3, b0 + 4, b0 + 1, b0 + 5, b0 + 3, b0 + 1, b0 + 2, b0 + 5);
    const h0 = pos.length / 3; pos.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0); for (let i = 0; i < 4; i++) { part.push(3); edge.push(1); }
    idx.push(h0, h0 + 1, h0 + 2, h0, h0 + 2, h0 + 3);
    // the glow's "wing coordinates" are its own corners
    const geo = this.geometry = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1)); geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    geo.setIndex(idx);
    this.iP = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4); this.iV = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4); this.iM = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    for (const a of [this.iP, this.iV, this.iM]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iP', this.iP); geo.setAttribute('iV', this.iV); geo.setAttribute('iM', this.iM); geo.instanceCount = count;
    const u = this.uniforms = Object.assign({ uLead: { value: 0 }, uGain: { value: 1 }, uPale: { value: new THREE.Color(0.7, 0.67, 0.58) }, uOwn: { value: 0.04 } }, probe.uniforms);
    const mat = this.material = Object.assign(new THREE.ShaderMaterial({ name: 'fx.moths', uniforms: u, vertexShader: mothVert(probe), fragmentShader: MOTH_FRAG }), PREMULTIPLIED);
    const mesh = this.mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx.moths'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = 9;
    // each moth: where it is, where it is going, what it is doing
    const n = count;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3); this.t = new Float32Array(n * 3);
    this.timer = new Float32Array(n); this.flee = new Float32Array(n); this.phase = new Float32Array(n); this.freq = new Float32Array(n);
    this.home = new Int16Array(n).fill(-1); this.seed = new Float32Array(n); this.span = new Float32Array(n); this.shown = new Float32Array(n);
    // the lights they keep to (found from the scene's candle lights, or these places when there are none yet)
    this.anchors = new Float32Array(16 * 3); this.nAnchors = 0; this.nextLook = 0; this.own = [];
    const b = ctx.arena && ctx.arena.bounds ? ctx.arena.bounds : { hx: 11, hz: 17 };
    for (let i = 0; i < 12; i++) { const side = i % 2 ? 1 : -1, k = i / 11; this.own.push({ x: side * (b.hx - 1.5 - 3 * rng.next()), y: 0.3, z: -b.hz + 2 + k * (2 * b.hz - 4) + rng.signed() * 1.5, rank: rng.next() }); }
    for (let i = 0; i < n; i++) {
      this.seed[i] = rng.next(); this.span[i] = 0.05 + 0.03 * rng.next(); this.freq[i] = 44 + 22 * rng.next(); this.phase[i] = rng.next() * 6.28; this.shown[i] = 1;
      const a = this.own[i % this.own.length];
      this.p[i * 3] = a.x + rng.signed() * 1.2; this.p[i * 3 + 1] = 0.6 + 1.2 * rng.next(); this.p[i * 3 + 2] = a.z + rng.signed() * 1.2;
      this.t[i * 3] = this.p[i * 3]; this.t[i * 3 + 1] = this.p[i * 3 + 1]; this.t[i * 3 + 2] = this.p[i * 3 + 2];
    }
    this.lit = 1; this.write();
  }

  /** Which lights are worth a moth's while: warm point lights that burn and are not the lantern, the Cantor's or a flash. */
  look(time, lit, skip) {
    this.nextLook = time + 0.5; this.lit = lit;
    const pr = this.probe, ctx = this.ctx, boss = ctx.boss; let n = 0;
    const lantern = ctx.player && ctx.player.kit && ctx.player.kit.lantern ? ctx.player.kit.lantern.light : null;
    for (let i = 0; i < pr.points.length && n < 16; i++) {
      const l = pr.points[i];
      if (l === lantern || l === skip || !(l.intensity > 0.05) || l.color.b > l.color.r * 0.9) continue;
      l.getWorldPosition(_m);
      if (boss && Math.hypot(_m.x - boss.pos.x, _m.z - boss.pos.z) < 2.5 && _m.y > 1.5) continue;
      this.anchors[n * 3] = _m.x; this.anchors[n * 3 + 1] = _m.y; this.anchors[n * 3 + 2] = _m.z; n++;
    }
    if (n === 0 && lit > 0.08) for (const a of this.own) { if (a.rank <= lit && n < 16) { this.anchors[n * 3] = a.x; this.anchors[n * 3 + 1] = a.y; this.anchors[n * 3 + 2] = a.z; n++; } }
    this.nAnchors = n;
  }

  /** Somewhere new to go. */
  choose(i) {
    const r = this.rng, o = i * 3, t = this.t, A = this.anchors;
    if (this.nAnchors > 0 && this.flee[i] <= 0) {
      let h = this.home[i];
      if (h < 0 || h >= this.nAnchors || r.next() < 0.12 || this.crowded(A[h * 3], A[h * 3 + 2]) > 0) {
        // the nearest of three tried, so they spread over the lights without crossing the hall; not the lights the fight is standing in
        let best = -1, bd = 1e9;
        for (let k = 0; k < 3; k++) { const j = Math.floor(r.next() * this.nAnchors), d = Math.hypot(A[j * 3] - this.p[o], A[j * 3 + 2] - this.p[o + 2]) * (0.6 + 0.8 * r.next()) + this.crowded(A[j * 3], A[j * 3 + 2]); if (d < bd) { bd = d; best = j; } }
        h = this.home[i] = best;
      }
      const ang = r.next() * 6.283, rad = 0.25 + 1.5 * r.next() * r.next();
      t[o] = A[h * 3] + Math.cos(ang) * rad; t[o + 1] = Math.max(WATER_Y + 0.3, A[h * 3 + 1] + 0.25 + 1.3 * r.next() * r.next()); t[o + 2] = A[h * 3 + 2] + Math.sin(ang) * rad;
      this.timer[i] = 0.5 + 1.9 * r.next();
    } else {                                                               // no flame to keep to: up into the moonlight, wide and slow
      this.home[i] = -1;
      t[o] = r.signed() * 11; t[o + 1] = 4.5 + 6 * r.next(); t[o + 2] = -4 + r.signed() * 15;
      this.timer[i] = 2 + 3.5 * r.next();
    }
  }

  /** How much a place is in the fighters' way (0 = clear): moths keep to the lights nobody is fighting in. */
  crowded(x, z) {
    const pl = this.ctx.player, bo = this.ctx.boss; let c = 0;
    if (pl) { const d = Math.hypot(x - pl.pos.x, z - pl.pos.z); if (d < 4.5) c += (4.5 - d) * 6; }
    if (bo) { const d = Math.hypot(x - bo.pos.x, z - bo.pos.z); if (d < 7) c += (7 - d) * 6; }
    return c;
  }

  /** The candles went out, or something struck the water near them: away. */
  scatter(x, z, radius, power) {
    const r = this.rng;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3, dx = this.p[o] - x, dz = this.p[o + 2] - z, d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const k = power * (1 - 0.6 * d / radius) / Math.max(0.3, d);
      this.v[o] += dx * k + r.signed() * power * 0.4; this.v[o + 1] += power * (0.5 + 0.6 * r.next()); this.v[o + 2] += dz * k + r.signed() * power * 0.4;
      this.flee[i] = 1.2 + 1.8 * r.next(); this.timer[i] = 0;
    }
  }

  update(time, dt, lit, skip) {
    if (time >= this.nextLook) this.look(time, lit, skip);
    const r = this.rng, ctx = this.ctx, pl = ctx.player, bo = ctx.boss, p = this.p, v = this.v, t = this.t;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      this.timer[i] -= dt; if (this.flee[i] > 0) this.flee[i] -= dt;
      if (this.timer[i] <= 0) this.choose(i);
      const fleeing = this.flee[i] > 0, roam = this.home[i] < 0;
      let ax = (t[o] - p[o]) * (roam ? 0.5 : 3.2), ay = (t[o + 1] - p[o + 1]) * (roam ? 0.6 : 3.6), az = (t[o + 2] - p[o + 2]) * (roam ? 0.5 : 3.2);
      // the weave of a moth: side to side across its own path, and a bob with every few beats
      const s = this.seed[i], wv = Math.sin(time * (5.2 + 3 * s) + s * 40) * (roam ? 1.6 : 4.2), sp = Math.hypot(v[o], v[o + 2]) || 1;
      ax += (-v[o + 2] / sp) * wv + r.signed() * 3; az += (v[o] / sp) * wv + r.signed() * 3; ay += Math.sin(time * (7 + 4 * s) + s * 17) * 3.4 + r.signed() * 2;
      // keep clear of the fighters, the water and the walls
      if (pl) { const dx = p[o] - pl.pos.x, dz = p[o + 2] - pl.pos.z, d = Math.hypot(dx, dz); if (d < 2.4 && p[o + 1] < 3) { const k = 10 * (2.4 - d) / Math.max(0.2, d); ax += dx * k; az += dz * k; ay += 3; } }
      if (bo) { const dx = p[o] - bo.pos.x, dz = p[o + 2] - bo.pos.z, d = Math.hypot(dx, dz); if (d < 5.5 && p[o + 1] < 9) { const k = 8 * (5.5 - d) / Math.max(0.3, d); ax += dx * k; az += dz * k; } }
      if (p[o + 1] < WATER_Y + 0.3) ay += 30 * (WATER_Y + 0.3 - p[o + 1]) + 4;
      if (Math.abs(p[o]) > 15) ax -= Math.sign(p[o]) * 6; if (p[o + 2] > 23) az -= 6; else if (p[o + 2] < -25) az += 6;
      const damp = fleeing ? 0.9 : 2.3;
      v[o] += (ax - v[o] * damp) * dt; v[o + 1] += (ay - v[o + 1] * damp) * dt; v[o + 2] += (az - v[o + 2] * damp) * dt;
      const speed = Math.hypot(v[o], v[o + 1], v[o + 2]), top = fleeing ? 5.5 : roam ? 1.3 : 1.9;
      if (speed > top) { const k = top / speed; v[o] *= k; v[o + 1] *= k; v[o + 2] *= k; }
      p[o] += v[o] * dt; p[o + 1] += v[o + 1] * dt; p[o + 2] += v[o + 2] * dt;
      this.phase[i] += dt * this.freq[i] * (0.75 + 0.25 * Math.min(1.5, speed));
      if (this.phase[i] > 6283) this.phase[i] -= 6283.185307;
    }
    this.write();
  }

  write() {
    const P = this.iP.array, V = this.iV.array, M = this.iM.array, p = this.p, v = this.v;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3, q = i * 4;
      P[q] = p[o]; P[q + 1] = p[o + 1]; P[q + 2] = p[o + 2]; P[q + 3] = this.span[i];
      V[q] = v[o]; V[q + 1] = v[o + 1]; V[q + 2] = v[o + 2]; V[q + 3] = this.phase[i];
      M[q] = 0.95; M[q + 1] = this.seed[i]; M[q + 2] = this.shown[i]; M[q + 3] = 0;
    }
    this.iP.needsUpdate = true; this.iV.needsUpdate = true; this.iM.needsUpdate = true;
  }
  frame(time, lead) { this.uniforms.uLead.value = lead; }
  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}
