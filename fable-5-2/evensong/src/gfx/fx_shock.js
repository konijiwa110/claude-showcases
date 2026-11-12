// Effects: rings of light on the water (the Cantor's Chorale). A ring travels outward at a steady speed, so the
// player can judge it: a thin hot line on the water, a soft halo with a glow trailing inside it, and a low curtain
// of light standing on the line, which is what makes it readable from a camera a metre and a half up.
// One instanced mesh for every ring alive; the water mirrors it (layer 0).
//
// Not part of the contract: other modules use ctx.vfx (src/gfx/vfx.js).
import * as THREE from 'three';
import { GLSL_OUT, PREMULTIPLIED } from './fx_common.js';

const SEG = 144, BAND = 1.5, HEIGHT = 1.05, AFTER = 0.3;

const vert = (probe) => /* glsl */`
attribute vec4 iA;   // centre, birth time
attribute vec4 iB;   // first radius, last radius, seconds, seed
attribute vec4 iC;   // colour, strength
uniform float uTime;
varying vec4 vQ;     // metres across the line (flat part) or height (curtain), part, metres round the ring, radius
varying vec4 vCol;   // colour, envelope
varying float vSeed;
${probe.glsl}
void main() {
  float tau = uTime - iA.w, k = clamp(tau / iB.z, 0.0, 1.0);
  float alive = step(0.0, tau) * step(tau, iB.z + ${AFTER.toFixed(2)});
  float R = mix(iB.x, iB.y, k);
  float th = position.x * 6.2831853;
  vec2 dir = vec2(sin(th), cos(th));
  vec3 wp; float q;
  if (position.z < 0.5) { float rr = max(R + position.y * ${BAND.toFixed(2)}, 0.02); wp = vec3(iA.x + dir.x * rr, iA.y + 0.015, iA.z + dir.y * rr); q = rr - R; }
  else { q = position.y * ${HEIGHT.toFixed(2)}; wp = vec3(iA.x + dir.x * R, iA.y + q, iA.z + dir.y * R); }
  float env = smoothstep(0.0, 0.1, tau) * (1.0 - smoothstep(iB.z * 0.86, iB.z + ${(AFTER * 0.8).toFixed(2)}, tau));
  vQ = vec4(q, position.z, th * R, R);
  vCol = vec4(iC.rgb * (iC.a * fxAir(cameraPosition, wp).a), env * alive);
  vSeed = iB.w;
  gl_Position = alive > 0.5 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform float uTime;
uniform float uGain;
varying vec4 vQ;
varying vec4 vCol;
varying float vSeed;
void main() {
  float q = vQ.x, along = vQ.z, i;
  if (vQ.y < 0.5) {                                   // on the water: the line, its halo, the glow it leaves inside
    float core = exp(-q * q / 0.0016);
    float halo = 0.2 * exp(-q * q / 0.09);
    float n = texture2D(tNoise, vec2(along * 0.11 + vSeed, q * 0.35 - uTime * 0.25)).b;
    float wake = q < 0.0 ? 0.16 * exp(q / 0.55) * (0.25 + 1.5 * n * n) : 0.03 * exp(-q / 0.25);
    i = core * 3.2 + halo + wake;
    i *= 1.0 - smoothstep(${(BAND * 0.7).toFixed(2)}, ${BAND.toFixed(2)}, abs(q));
  } else {                                            // the curtain: brightest at its foot, rising in threads
    float n = texture2D(tNoise, vec2(along * 0.16 + vSeed * 3.0, q * 0.22 - uTime * 0.5)).b;
    float n2 = texture2D(tNoise, vec2(along * 0.45 + vSeed, q * 0.4 - uTime * 0.9)).b;
    float threads = 0.25 + 1.3 * n * n + 0.6 * n2 * n2 * n2;
    i = 1.3 * exp(-q / 0.07) + 0.42 * exp(-q / 0.42) * threads;
    i *= 1.0 - smoothstep(${(HEIGHT * 0.6).toFixed(2)}, ${HEIGHT.toFixed(2)}, q);
  }
  gl_FragColor = vec4(vCol.rgb * (i * vCol.a * uGain), 0.0);
  ${GLSL_OUT}
}`;

export class Shocks {
  constructor(ctx, probe, noise, capacity = 8) {
    this.ctx = ctx; this.capacity = capacity; this.now = 0; this.dirty = false; this.active = 0;
    // one ring: a flat band across the line (part 0) and a strip standing on it (part 1)
    const pos = new Float32Array((SEG + 1) * 4 * 3), idx = [];
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG, o = i * 12;
      pos[o] = u; pos[o + 1] = -1; pos[o + 2] = 0; pos[o + 3] = u; pos[o + 4] = 1; pos[o + 5] = 0;
      pos[o + 6] = u; pos[o + 7] = 0; pos[o + 8] = 1; pos[o + 9] = u; pos[o + 10] = 1; pos[o + 11] = 1;
    }
    for (let i = 0; i < SEG; i++) { const a = i * 4, b = a + 4; idx.push(a, a + 1, b + 1, a, b + 1, b, a + 2, a + 3, b + 3, a + 2, b + 3, b + 2); }
    const geo = this.geometry = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx);
    this.attr = ['iA', 'iB', 'iC'].map((name) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a; });
    geo.instanceCount = capacity;
    for (let o = 3; o < capacity * 4; o += 4) this.attr[0].array[o] = -1e6;      // nothing born yet
    const mat = this.material = Object.assign(new THREE.ShaderMaterial({
      name: 'fx.shock', uniforms: Object.assign({ uTime: { value: 0 }, tNoise: { value: noise }, uGain: { value: 1 } }, probe.uniforms), vertexShader: vert(probe), fragmentShader: FRAG,
    }), PREMULTIPLIED);
    const mesh = this.mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx.shock'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = 14; mesh.visible = false;
    // what the caller holds: where the ring is now
    this.handles = [];
    for (let i = 0; i < capacity; i++) this.handles.push({ alive: false, x: 0, y: 0, z: 0, radius: 0, from: 0, to: 0, seconds: 1, age: 0, progress: 0, width: 0.35, height: HEIGHT, born: -1, fading: 0, slot: i });
    this.head = 0;
  }

  /** Start a ring. Returns its handle: { alive, x, z, radius (now), from, to, seconds, age, progress 0..1, width, height }. */
  spawn(x, y, z, from, to, seconds, color, strength, seed) {
    let i = this.head; for (let k = 0; k < this.capacity; k++) { const j = (this.head + k) % this.capacity; if (!this.handles[j].alive) { i = j; break; } }
    this.head = (i + 1) % this.capacity;
    const o = i * 4, [A, B, C] = this.attr, h = this.handles[i];
    A.array[o] = x; A.array[o + 1] = y; A.array[o + 2] = z; A.array[o + 3] = this.now;
    B.array[o] = from; B.array[o + 1] = to; B.array[o + 2] = seconds; B.array[o + 3] = seed;
    C.array[o] = color.r; C.array[o + 1] = color.g; C.array[o + 2] = color.b; C.array[o + 3] = strength;
    h.alive = true; h.x = x; h.y = y; h.z = z; h.radius = from; h.from = from; h.to = to; h.seconds = seconds; h.age = 0; h.progress = 0; h.born = this.now;
    this.dirty = true; this.mesh.visible = true;
    return h;
  }
  update(time, dt) {
    this.now = time; let n = 0;
    for (const h of this.handles) {
      if (!h.alive) continue;
      h.age += dt; h.progress = Math.min(1, h.age / h.seconds); h.radius = h.from + (h.to - h.from) * h.progress;
      if (h.age >= h.seconds) { h.alive = false; h.fading = AFTER; } else n++;
    }
    this.active = n;
    let fading = false; for (const h of this.handles) if (h.fading > 0) { h.fading -= dt; fading = true; }
    this.mesh.visible = n > 0 || fading;
  }
  frame(time) { this.material.uniforms.uTime.value = time; if (this.dirty) { this.dirty = false; for (const a of this.attr) a.needsUpdate = true; } }
  rebase(by) { const a = this.attr[0].array; for (let o = 3; o < a.length; o += 4) a[o] -= by; for (const h of this.handles) h.born -= by; this.now -= by; this.dirty = true; }
  clear() { const b = this.attr[1].array; for (let o = 2; o < b.length; o += 4) b[o] = 0; const a = this.attr[0].array; for (let o = 3; o < a.length; o += 4) a[o] = -1e6; for (const h of this.handles) { h.alive = false; h.fading = 0; } this.dirty = true; this.mesh.visible = false; }
  dispose() { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}
