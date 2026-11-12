// Effects: the particle pools.
//
// Every particle is one instanced quad. Nothing about it is simulated on the CPU: its place, velocity, birth time,
// life and look are written once into a ring buffer when it is born, and the vertex shader works out where it is
// now from those (drag, gravity, one bounce on the water, wander). So a burst costs a few floats, a thousand live
// particles cost one draw call, and a picture run gives the same picture every time.
//
// Two pools, one shader:
//   hot   glowing things (sparks, embers, motes, glints of water, flashes): layer 0, so the water mirrors them
//   soft  veils (mist, dust, the body of a splash): layer 2, soft where they meet the scene when its depth is known
// Both blend with colour already multiplied by alpha, so a glow (alpha 0) and a veil can share a draw call.
//
// Not part of the contract: other modules use ctx.vfx (src/gfx/vfx.js).
import * as THREE from 'three';
import { WATER_Y } from '../core/constants.js';
import { GLSL_OUT, PREMULTIPLIED, passInfo, blankTexture } from './fx_common.js';

/** What a particle looks like (and the two special motions: sparks bounce once on the water, drops end in it). */
export const KIND = { SPARK: 0, EMBER: 1, MOTE: 2, DROP: 3, FLASH: 4, RING: 5, PUFF: 6 };

const STRIDE = 20;

/** The birth certificate of one particle: fill it in and hand it to pool.emit(P). One shared object, never kept. */
export const P = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  life: 1,            // seconds
  size: 0.1,          // metres across (a streak's width)
  kind: 0, seed: 0,
  stretch: 0,         // seconds of its own motion a streak is drawn along (0 = a round dot)
  r: 1, g: 1, b: 1,   // linear colour, may be far above 1 for glowing kinds; for PUFF it is the veil's own colour
  a: 1,               // PUFF: opacity. glowing kinds: an extra brightness factor
  gravity: 0,         // m/s2 along y (negative falls)
  drag: 0,            // per second
  growth: 1,          // size at the end of life / size at birth
  extra: 0,           // glowing kinds: wander (metres). PUFF: how much it is broken into droplets (0..1). RING: its line's thickness (0 or 1 = as designed)
};

const vert = (probe) => /* glsl */`
attribute vec4 aA;   // place, birth time
attribute vec4 aB;   // velocity, life
attribute vec4 aC;   // colour, alpha
attribute vec4 aD;   // size, kind, seed, stretch
attribute vec4 aE;   // gravity, drag, growth, extra
uniform float uTime;
uniform float uWaterY;
uniform vec2 uRes;
uniform float uGain;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vInfo;   // kind, age 0..1, seed, length / width
varying vec4 vMore;   // view depth (positive), extra, spin angle, size in metres
${probe.glsl}

void fly(vec3 p0, vec3 v0, float g, float k, float t, out vec3 p, out vec3 v) {
  k = max(k, 0.02);
  vec3 term = vec3(0.0, g / k, 0.0);
  float e = exp(-k * t);
  v = term + (v0 - term) * e;
  p = p0 + term * t + (v0 - term) * (1.0 - e) / k;
}
/* when does something thrown from height y0 at speed vy come down to the water (g < 0) */
float fallTime(float y0, float vy, float g, float k) {
  k = max(k, 0.02);
  float h = max(y0 - uWaterY, 0.0), term = g / k;
  float t = (vy + sqrt(vy * vy - 2.0 * g * h)) / (-g);
  for (int i = 0; i < 3; i++) {
    float e = exp(-k * t);
    float y = max(y0, uWaterY) + term * t + (vy - term) * (1.0 - e) / k - uWaterY;
    float w = term + (vy - term) * e;
    t -= y / min(w, -0.05);
  }
  return max(t, 0.0);
}
vec3 heat(float h) {
  vec3 hot = mix(vec3(1.0, 0.50, 0.14), vec3(1.0, 0.90, 0.70), smoothstep(0.5, 1.0, h));
  return mix(vec3(0.75, 0.13, 0.02) * 0.22, hot, smoothstep(0.0, 0.5, h));
}

void main() {
  float kind = aD.y, seed = aD.z;
  float t = uTime - aA.w, life = aB.w, age = t / life;
  vec3 p, v;
  float alive = step(0.0, t) * step(t, life);
  float g = aE.x, k = aE.y;
  float glow = 1.0;
  if (kind < 0.5) {                                   // spark: falls, bounces once on the water, dies
    float th = g < -0.01 ? fallTime(aA.y, aB.y, g, k) : 1e9;
    if (t > th) {
      vec3 ph, vh; fly(aA.xyz, aB.xyz, g, k, th, ph, vh);
      vec3 v1 = vec3(vh.x * 0.55, -vh.y * (0.22 + 0.2 * fract(seed * 7.13)), vh.z * 0.55);
      ph.y = uWaterY;
      float t2 = t - th;
      fly(ph, v1, g, k, t2, p, v);
      if (t2 > fallTime(uWaterY, v1.y, g, k)) alive = 0.0;
      glow = 0.4;
    } else fly(aA.xyz, aB.xyz, g, k, t, p, v);
  } else if (kind > 2.5 && kind < 3.5) {              // drop: ends in the water
    fly(aA.xyz, aB.xyz, g, k, t, p, v);
    if (g < -0.01 && t > fallTime(aA.y, aB.y, g, k)) alive = 0.0;
  } else if (kind > 4.5 && kind < 5.5) {              // ring: stays where it is; its "velocity" is the way it faces
    p = aA.xyz; v = aB.xyz;
  } else fly(aA.xyz, aB.xyz, g, k, t, p, v);

  float wander = (kind > 0.5 && kind < 2.5) ? aE.w : 0.0;
  if (wander > 0.0) {
    float s = seed * 40.0, ramp = 1.0 - exp(-t * 1.5);
    p += wander * ramp * vec3(sin(t * (0.9 + fract(s) * 0.8) + s * 3.1) + 0.5 * sin(t * 2.3 + s * 5.0),
                              0.6 * sin(t * (1.1 + fract(s * 1.7)) + s * 1.3),
                              cos(t * (0.8 + fract(s * 2.3) * 0.9) + s * 2.2) + 0.5 * sin(t * 2.0 + s * 4.1));
  }

  float size = aD.x * mix(1.0, aE.z, 1.0 - (1.0 - age) * (1.0 - age));
  if (kind < 0.5 || (kind > 2.5 && kind < 3.5)) size *= 3.0;                // sparks and drops: a thin core inside its own glow
  if (kind > 5.5) p.y = max(p.y, uWaterY + size * 0.22);                    // veils lie on the water, not in it
  if (kind > 0.5 && kind < 2.5) p.y = max(p.y, uWaterY + 0.02);             // embers and motes never go under it

  // colour by kind
  vec3 col = aC.rgb; float alpha = aC.a;
  if (kind < 0.5) { col *= heat(1.0 - age) * glow * (0.8 + 0.2 * sin(seed * 91.0 + t * 60.0)) * alpha; alpha = 0.0; }
  else if (kind < 1.5) { float env = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.3); col = mix(col, col * vec3(1.0, 0.45, 0.2), age * age) * env * (0.65 + 0.35 * sin(seed * 97.0 + t * (9.0 + seed * 8.0))) * alpha; alpha = 0.0; }
  else if (kind < 2.5) { float env = smoothstep(0.0, 0.18, age) * (1.0 - smoothstep(0.5, 1.0, age)); col *= env * (0.7 + 0.3 * sin(seed * 71.0 + t * (2.0 + seed * 3.0))) * alpha; alpha = 0.0; }
  else if (kind < 3.5) {
    // a drop is a small lens: it shows the lights, far brighter than a matt thing would be, and it winks as it turns
    vec3 light = uAmbCol * 0.6 + uMoonCol * 0.9 + fxPoints(p) * 1.5 + fxCandleGlow(p.y) * 0.9;
    float tw = 0.5 + 0.5 * sin(seed * 131.0 + t * (22.0 + seed * 30.0));
    col *= light * (0.35 + 2.2 * tw * tw * tw * tw) * (1.0 - smoothstep(0.8, 1.0, age)) * alpha; alpha = 0.0;
  }
  else if (kind < 4.5) { col *= (1.0 - age) * (1.0 - age) * alpha; alpha = 0.0; }
  else if (kind < 5.5) { col *= alpha; alpha = 0.0; }
  else {
    vec3 light = uAmbCol + uMoonCol * 0.2 + fxPoints(p) * 0.25;
    col *= light; alpha *= smoothstep(0.0, 0.07, age);
  }
  vec4 air = fxAir(cameraPosition, p);
  col = kind > 5.5 ? col * air.a + air.rgb : col * air.a;

  // the quad: along the particle's own motion for streaks, facing the camera otherwise
  vec3 hv = (viewMatrix * vec4(p, 1.0)).xyz;
  float depth = max(-hv.z, 0.05);
  float px = depth * 2.0 / (projectionMatrix[1][1] * uRes.y);      // one pixel, in metres, at this depth
  // never smaller than a few pixels (a lone hot pixel is eaten by the antialiasing): far ones get dimmer, not smaller
  float minPx = kind < 3.5 ? 4.0 : 0.0;
  float w = max(size, minPx * px);
  col *= kind > 0.5 && kind < 2.5 ? sqrt(size / w) : size / w;
  vec2 c = position.xy;
  float spin = 0.0;
  vec3 pos;
  float aspect = 1.0;
  if (kind > 4.5 && kind < 5.5) {                     // ring: a quad square to the way it faces
    vec3 n = normalize(v + vec3(0.0, 1e-4, 0.0));
    vec3 a1 = normalize(cross(n, abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 a2 = cross(n, a1);
    vec3 wp = p + (a1 * c.x + a2 * c.y) * w;
    pos = (viewMatrix * vec4(wp, 1.0)).xyz;
  } else if (aD.w > 0.0) {
    vec3 tv = (viewMatrix * vec4(p - v * aD.w, 1.0)).xyz;
    vec3 ax = hv - tv; float len = length(ax);
    vec3 dir = len > 1e-5 ? ax / len : vec3(0.0, 1.0, 0.0);
    vec3 side = cross(dir, normalize(-hv)); float sl = length(side);
    side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
    pos = mix(tv, hv, c.y + 0.5) + dir * (c.y * w) + side * (c.x * w);
    aspect = (len + w) / w;
  } else {
    if (kind > 5.5) { spin = seed * 6.2831 + t * (fract(seed * 13.7) - 0.5) * 0.5; float cs = cos(spin), sn = sin(spin); c = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs); }
    pos = hv + vec3(c * w, 0.0);
  }
  vUv = position.xy + 0.5;
  vCol = vec4(col * uGain, alpha) * alive;
  vInfo = vec4(kind, age, seed, aspect);
  vMore = vec4(-pos.z, aE.w, spin, w);
  gl_Position = alive > 0.5 ? projectionMatrix * vec4(pos, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform sampler2D tDepth;
uniform float uSoft;
uniform vec2 uRes;
uniform vec2 uNearFar;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vInfo;
varying vec4 vMore;
#include <packing>

void main() {
  float kind = vInfo.x, age = vInfo.y, seed = vInfo.z, aspect = vInfo.w;
  vec2 q = vec2((vUv.x - 0.5) * 2.0, (vUv.y - 0.5) * 2.0 * aspect);
  float d = length(vec2(q.x, max(abs(q.y) - (aspect - 1.0), 0.0)));        // 0 on the axis, 1 at the rim
  if (d >= 1.0) discard;
  float edge = 1.0 - smoothstep(0.82, 1.0, d);
  vec3 rgb; float a = 0.0;
  if (kind < 0.5) {                                   // spark: a white-hot thread with a little halo, brighter at the head
    float i = exp(-d * d * 14.0) + 0.1 * exp(-d * d * 3.2);
    rgb = vCol.rgb * i * mix(0.2, 1.0, vUv.y * vUv.y);
  } else if (kind < 1.5) {                            // ember
    rgb = vCol.rgb * (0.75 * exp(-d * d * 3.2) + 0.25 * exp(-d * d * 12.0));
  } else if (kind < 2.5) {                            // mote
    rgb = vCol.rgb * (0.8 * exp(-d * d * 3.0) + 0.2 * exp(-d * d * 12.0));
  } else if (kind < 3.5) {                            // drop: a glint
    rgb = vCol.rgb * (exp(-d * d * 36.0) + 0.07 * exp(-d * d * 3.2)) * mix(0.4, 1.0, vUv.y);
  } else if (kind < 4.5) {                            // flash: a ball of light; drawn long (stretch > 0) it is a line that thins to a point at both ends
    float al = abs(vUv.y - 0.5) * 2.0, tp = aspect > 1.5 ? max(1.0 - al * al, 0.0) : 1.0;
    float dd = d / max(tp, 0.04);
    rgb = vCol.rgb * (0.55 * exp(-dd * dd * 5.0) + exp(-dd * dd * 30.0)) * tp;
  } else if (kind < 5.5) {                            // ring: a thin circle opening out (extra: how thick its line is, 1 = as designed)
    float e = 1.0 - (1.0 - age) * (1.0 - age);
    float rr = mix(0.12, 0.9, e), wd = mix(0.09, 0.022, e) * (vMore.y > 0.0 ? vMore.y : 1.0);
    float x = (d - rr) / wd;
    rgb = vCol.rgb * exp(-x * x) * (1.0 - age) * (1.0 - age);
  } else {                                            // veil: cloud noise, worn away from thin to nothing as it ages
    vec2 uv = vUv - 0.5;
    vec2 nuv = uv * (0.42 + 0.3 * fract(seed * 5.3)) + vec2(fract(seed * 17.0), fract(seed * 29.0));
    vec4 n = texture2D(tNoise, nuv);
    vec4 n2 = texture2D(tNoise, nuv * 2.7 + 0.37);
    float fine = texture2D(tNoise, nuv * 6.5 + 0.11).a;
    float body = pow(max(1.0 - d * d, 0.0), 1.4);
    float f = n.r * 0.55 + n.g * 0.3 + n2.g * 0.15 + (body - 0.5) * 0.55;
    float worn = mix(0.02, 0.92, pow(age, 1.35));
    float dens = smoothstep(worn, worn + 0.42, f) * body;
    float speck = vMore.y;
    float dots = smoothstep(0.35, 0.62, fine) * (0.35 + 0.65 * n2.r);
    dens *= mix(1.0, 0.4 + 1.7 * dots, speck);
    a = clamp(dens * vCol.a, 0.0, 1.0);
    float lit = 0.75 + 0.5 * n.g + speck * dots * 1.5;
    rgb = vCol.rgb * lit * a;
    // soft where it meets the scene, and thin right at the eye
    float fade = smoothstep(0.25, 1.1, vMore.x);
    if (uSoft > 0.5) {
      float sceneZ = -perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x, uNearFar.x, uNearFar.y);
      fade *= clamp((sceneZ - vMore.x) / max(0.25, vMore.w * 0.35), 0.0, 1.0);
    }
    rgb *= fade; a *= fade;
  }
  gl_FragColor = vec4(rgb * edge, a * edge);
  ${GLSL_OUT}
}`;

export function makeParticleMaterial(probe, noise) {
  const m = new THREE.ShaderMaterial({
    name: 'fx.particles',
    uniforms: Object.assign({
      uTime: { value: 0 }, uWaterY: { value: WATER_Y }, uRes: { value: new THREE.Vector2(1600, 900) }, uGain: { value: 1 },
      tNoise: { value: noise }, tDepth: { value: blankTexture() }, uSoft: { value: 0 }, uNearFar: { value: new THREE.Vector2(0.1, 400) },
    }, probe.uniforms),
    vertexShader: vert(probe), fragmentShader: FRAG,
  });
  return Object.assign(m, PREMULTIPLIED);
}

const QUAD = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);

export class Pool {
  /**
   * @param ctx       the game's context
   * @param material  from makeParticleMaterial (each pool has its own, so its uniforms are its own)
   * @param o         { capacity, layer, renderOrder, soft: bool (use the scene's depth), name }
   */
  constructor(ctx, material, o) {
    this.ctx = ctx; this.capacity = o.capacity; this.material = material; this.soft = !!o.soft;
    this.data = new Float32Array(this.capacity * STRIDE);
    this.head = 0; this.dirty = 0; this.until = -1; this.now = 0; this.live = 0;
    const geo = this.geometry = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const buf = this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    ['aA', 'aB', 'aC', 'aD', 'aE'].forEach((name, i) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)));
    geo.instanceCount = this.capacity;
    this.rangeA = { start: 0, count: 0 }; this.rangeB = { start: 0, count: 0 };
    buf.onUpload(() => { this.dirty = 0; });
    const mesh = this.mesh = new THREE.Mesh(geo, material);
    mesh.name = o.name || 'fx.pool'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = o.renderOrder || 0;
    mesh.layers.set(o.layer || 0); mesh.visible = false; mesh.castShadow = false; mesh.receiveShadow = false;
    const u = material.uniforms;
    mesh.onBeforeRender = (renderer, scene, camera) => { passInfo(renderer, camera, ctx, u); if (!this.soft) u.uSoft.value = 0; material.uniformsNeedUpdate = true; };
  }

  /** Give birth to the particle described by P. */
  emit(p) {
    const d = this.data, o = this.head * STRIDE;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = this.now;
    d[o + 4] = p.vx; d[o + 5] = p.vy; d[o + 6] = p.vz; d[o + 7] = p.life;
    d[o + 8] = p.r; d[o + 9] = p.g; d[o + 10] = p.b; d[o + 11] = p.a;
    d[o + 12] = p.size; d[o + 13] = p.kind; d[o + 14] = p.seed; d[o + 15] = p.stretch;
    d[o + 16] = p.gravity; d[o + 17] = p.drag; d[o + 18] = p.growth; d[o + 19] = p.extra;
    this.head = (this.head + 1) % this.capacity; this.dirty++;
    const end = this.now + p.life; if (end > this.until) this.until = end;
  }

  /** Once per step: the clock, and whether there is anything to draw at all. */
  update(time) { this.now = time; this.mesh.visible = time <= this.until + 0.05; }

  /** Before a frame is drawn: the clock the shader sees, and whatever was born since the last upload. */
  frame(time) {
    this.material.uniforms.uTime.value = time;
    if (!this.dirty) return;
    const buf = this.buffer, ur = buf.updateRanges; ur.length = 0;
    if (this.dirty < this.capacity) {
      const start = (this.head - this.dirty + this.capacity) % this.capacity;
      if (start + this.dirty <= this.capacity) { this.rangeA.start = start * STRIDE; this.rangeA.count = this.dirty * STRIDE; ur.push(this.rangeA); }
      else {
        this.rangeA.start = start * STRIDE; this.rangeA.count = (this.capacity - start) * STRIDE;
        this.rangeB.start = 0; this.rangeB.count = (start + this.dirty - this.capacity) * STRIDE; ur.push(this.rangeB, this.rangeA);
      }
    }
    buf.needsUpdate = true;
  }

  /** Move the clock's zero (births are kept as small numbers so a long session stays exact). */
  rebase(by) { const d = this.data; for (let o = 3; o < d.length; o += STRIDE) d[o] -= by; this.until -= by; this.now -= by; this.dirty = this.capacity; }

  /** Every particle gone at once. */
  clear() { const d = this.data; for (let o = 7; o < d.length; o += STRIDE) d[o] = 0; this.until = -1; this.dirty = this.capacity; this.mesh.visible = false; }

  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}
