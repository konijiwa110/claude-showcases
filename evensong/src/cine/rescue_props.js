// The rescue's things (Kevin, 10 Nov: "when you lose, there's a spotlight on you ... and then a french fries (in the
// french fries container that's red but no logo) falls down from the spot light. When it reaches you, you go back to
// full life"). Made here, in code, once, when the game loads, and kept hidden until a rescue:
//
//   the beam     a narrow cone of light from a lamp high over him to a pool on the water: a volume, marched in the
//                shader along each ray (so it reads from outside, from inside looking up, and in the water's mirror),
//                stopped by what stands in it (the scene's depth); brightest toward the lamp, dust drifting in it
//   the pool     the beam's circle on the water, laid on the surface (the water lets 7% of the floor's light through,
//                so a spot on the stone alone would hardly show)
//   the lamp     one spot light (src/gfx/lights.js makes it with the others, at nothing, so no shader changes when it
//                comes on): the key light on him and the carton while the hall around is dimmed
//   the carton   a paperboard fry carton, plain red with no print, its front cut low in an arc, twenty-six fries standing
//                in it. A little larger than life (FRIES.scale), so that it reads falling in a wide shot.
//
//   props.spot(x, z, level)        the beam, the pool and the lamp over (x, z); level 0..1 (0: all off and hidden)
//   props.carton                   the carton's Object3D (its origin is the middle of its bottom)
//   props.show(on)                 the carton in the scene or not
//   props.burst(k)                 0..1: the carton giving itself up as light (scale and glow), 1 = gone
//   props.update(dt)               once a step (the dust's clock)
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WATER_Y } from '../core/constants.js';
import { GLSL_OUT, PREMULTIPLIED, passInfo, blankTexture, makeNoiseTexture } from '../gfx/fx_common.js';

/** The lamp and its beam. */
export const SPOT = {
  height: 18,            // metres: where the lamp hangs over the water (the dark under the vault)
  radius: 1.45,          // metres: the circle on the water (he lies about 1.8 m long; the pool takes all of him)
  color: [1.0, 0.95, 0.86],   // a stage lamp's white: whiter than the candles, warmer than the moon
  lamp: 5200,            // the spot light's strength (candela) at level 1
  beam: 0.04,            // how much light the air in the beam gives back, per metre (seen across it)
  pool: 0.4,             // how bright the circle on the water is
  bounce: 7,             // the light the circle gives back, low over it (candela)
};
/** The carton: its sizes are a real medium carton's (metres), then all of it times `scale`. */
export const FRIES = { scale: 1.6, color: 0xc0181b, fries: 26 };

const _v = new THREE.Vector3(), _c = new THREE.Color();

// ------------------------------------------------------------------------------------------------ the carton
/** A deterministic random source (mulberry32), so the carton is the same carton on every load. */
function rng(seed) { let s = seed >>> 0; return () => { let t = (s += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * The carton's walls: a tapered tube with rounded corners, thick board (an outside, an inside and the cut edge between
 * them) and a bottom. The top edge is high at the back, slopes down the sides, and dips in an arc across the front.
 */
function cartonShape(S) {
  const H = { back: 0.128 * S, corner: 0.097 * S, mid: 0.072 * S };          // the top edge's height: back, front corners, front middle
  const W0 = 0.074 * S, D0 = 0.043 * S, W1 = 0.108 * S, D1 = 0.066 * S;     // width and depth at the bottom and at the back's top
  const R = 0.0075 * S, T = 0.0016 * S;                                      // corner radius, board thickness
  const EDGE = 14, ARC = 9, N = 4 * (EDGE + ARC), ROWS = 12;
  const half = (y) => { const k = y / H.back; return [(W0 + (W1 - W0) * k) / 2, (D0 + (D1 - D0) * k) / 2]; };
  // a point of the rounded rectangle of half sizes a, b (corner radius r): sample i of N, going round counter-clockwise
  // seen from above, starting on the front's left
  const point = (i, a, b, r, out) => {
    const seg = Math.floor(i / (EDGE + ARC)), j = i % (EDGE + ARC);
    // the four sides in turn: front (+z), right (+x), back (-z), left (-x); each a straight run then its corner
    const sx = [1, 0, -1, 0][seg], sz = [0, -1, 0, 1][seg];                // the direction of the straight run
    const nx = [0, 1, 0, -1][seg], nz = [1, 0, -1, 0][seg];                // the side's outward normal
    const along = seg % 2 === 0 ? a - r : b - r, off = seg % 2 === 0 ? b : a;
    if (j < EDGE) { const t = -along + (2 * along) * (j / EDGE); out[0] = nx * off + sx * t; out[1] = nz * off + sz * t; return out; }
    const u = (j - EDGE) / ARC, ang0 = Math.atan2(nz, nx), ang = ang0 - u * Math.PI / 2;
    const cx = nx * (off - r) + sx * along, cz = nz * (off - r) + sz * along;
    out[0] = cx + Math.cos(ang) * r; out[1] = cz + Math.sin(ang) * r; return out;
  };
  // the height of the top edge over a point of the top ring, in the ring's own measure (-1..1 across, -1..1 back to front)
  const top = (xn, zn) => {
    const ax = Math.min(1, Math.abs(xn));
    const front = H.mid + (H.corner - H.mid) * Math.pow(ax, 2.3);
    const back = H.back + 0.004 * S * (1 - ax * ax);
    const s = (zn + 1) / 2;
    return back + (front - back) * (s * s * (3 - 2 * s));
  };
  return { H, half, point, top, R, T, N, ROWS };
}

function cartonGeometry(S) {
  const C = cartonShape(S), { N, ROWS, R, T } = C, p = [0, 0];
  const pos = [], idx = [];
  const [aTop, bTop] = C.half(C.H.back);
  const heights = [];
  for (let i = 0; i < N; i++) { C.point(i, aTop, bTop, R, p); heights.push(C.top(p[0] / aTop, p[1] / bTop)); }
  // one wall surface: inset 0 (outside) or T (inside), from y0 up to the top edge
  const wall = (inset, y0, flip) => {
    const base = pos.length / 3;
    for (let j = 0; j <= ROWS; j++) for (let i = 0; i < N; i++) {
      const h = heights[i], y = y0 + (h - y0) * (j / ROWS), [a, b] = C.half(y);
      C.point(i, a - inset, b - inset, R - inset * 0.8, p); pos.push(p[0], y, p[1]);
    }
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < N; i++) {
      const i1 = (i + 1) % N, a = base + j * N + i, b = base + j * N + i1, c = base + (j + 1) * N + i, d = base + (j + 1) * N + i1;
      if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
    return base;
  };
  const geoms = [];
  // colour (linear): the printed red outside, a little darker toward the foot; inside, the same red in its own shade;
  // the cut edge along the top shows the board's pale core, as real paperboard does
  const lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  const RED = lin(FRIES.color), INSIDE = lin(0x9e1216), EDGE = lin(0xe8dfd2), FOOT = lin(0x8e1013);
  const finish = (paint) => {
    const g = new THREE.BufferGeometry(), P = pos.splice(0), cols = [];
    for (let i = 0; i < P.length; i += 3) { paint(P[i + 1], _c); cols.push(_c.r, _c.g, _c.b); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx.splice(0)); g.computeVertexNormals(); geoms.push(g);
  };
  const H = C.H.back;
  wall(0, 0, false); finish((y, c) => c.copy(FOOT).lerp(RED, Math.min(1, 0.35 + y / (H * 0.45))));
  wall(T, T, true); finish((y, c) => c.copy(INSIDE).multiplyScalar(0.7 + 0.3 * Math.min(1, y / H)));
  // the cut edge along the top: outside ring to inside ring
  {
    for (let i = 0; i < N; i++) {
      const h = heights[i]; let [a, b] = C.half(h);
      C.point(i, a, b, R, p); pos.push(p[0], h, p[1]);
      C.point(i, a - T, b - T, R - T * 0.8, p); pos.push(p[0], h, p[1]);
    }
    for (let i = 0; i < N; i++) { const i1 = (i + 1) % N, o = 2 * i, q = 2 * i1; idx.push(o, q + 1, o + 1, o, q, q + 1); }
    finish((y, c) => c.copy(EDGE));
  }
  // the bottom: outside (facing down) and inside (facing up)
  for (const [y, inset, up] of [[0, 0, false], [T, T, true]]) {
    const [a, b] = C.half(y); pos.push(0, y, 0);
    for (let i = 0; i < N; i++) { C.point(i, a - inset, b - inset, R - inset * 0.8, p); pos.push(p[0], y, p[1]); }
    for (let i = 0; i < N; i++) { const i1 = (i + 1) % N; if (up) idx.push(0, 1 + i, 1 + i1); else idx.push(0, 1 + i1, 1 + i); }
    finish((y, c) => c.copy(up ? INSIDE : FOOT).multiplyScalar(up ? 0.6 : 1));
  }
  const g = mergeGeometries(geoms, false); for (const x of geoms) x.dispose();
  return { geometry: g, shape: C };
}

/**
 * The fries: square sticks with softened edges, pale gold, a little browner at their ends, each its own shade and
 * thickness. They stand in four rows (seven, six, seven, six, back to front), their feet higher toward the back where
 * the carton is wider, and fan out above the rim as fries in a carton do, the back rows tallest. Each runs from a
 * point inside the carton to a point above its rim, both inside the carton's own measure, so no fry passes through
 * a wall (the carton widens upward and its inside is convex); tools/tests/rescue_fries.mjs measures that no two meet.
 */
function friesGeometry(S, C, n) {
  const r = rng(11), list = [], geoms = [];
  const rows = [
    { z: -0.72, n: 7, foot: 0.09, up: [0.026, 0.045] }, { z: -0.24, n: 6, foot: 0.08, up: [0.022, 0.04] },
    { z: 0.24, n: 7, foot: 0.069, up: [0.017, 0.034] }, { z: 0.72, n: 6, foot: 0.057, up: [0.012, 0.028] },
  ];
  const lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  const pale = lin(0xf6d77e), gold = lin(0xeec05c), deep = lin(0xdfa947), tip = lin(0xc58a36);
  const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), twist = new THREE.Quaternion(), m = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3();
  let made = 0;
  for (const row of rows) for (let k = 0; k < row.n && made < n; k++, made++) {
    const half = row.n === 7 ? 0.74 : 0.62, u = -half + (2 * half) * (k / (row.n - 1));
    const ju = (r() - 0.5) * 0.02, jv = (r() - 0.5) * 0.06;
    const w = (0.0068 + 0.0016 * r()) * S, yb = (row.foot + (r() - 0.5) * 0.008) * S, [aB, bB] = C.half(yb);
    a.set((u + ju) * aB, yb, (row.z + jv) * bB * 0.86);
    const rimY = C.top(u, row.z), above = (row.up[0] + (row.up[1] - row.up[0]) * r()) * S;
    const yTop = rimY + above, [aY, bY] = C.half(yTop);
    // above the rim they fan: outward a little more than the carton widens, each with a lean of its own
    const fan = 1.1 + 0.12 * r(), lx = (r() - 0.5) * 0.09, lz = (r() - 0.5) * 0.1;
    b.set(Math.max(-0.97, Math.min(0.97, (u + ju) * fan + lx)) * aY, yTop, Math.max(-0.95, Math.min(0.95, (row.z + jv) * fan + lz)) * bY * 0.86);
    const len = a.distanceTo(b), g = new RoundedBoxGeometry(w, len, w * (0.9 + 0.2 * r()), 2, w * 0.22);
    // colour along its length: the body pale to deep gold (each fry its own), its ends browned, the top end more
    const shade = r(), body = pale.clone().lerp(gold, Math.min(1, shade * 1.4)).lerp(deep, Math.max(0, shade - 0.7)), cols = [], P = g.attributes.position;
    const brown = 0.45 + 0.4 * r();
    for (let i = 0; i < P.count; i++) {
      const t = P.getY(i) / len + 0.5, end = t > 0.5 ? Math.max(0, (t - 0.88) / 0.12) : Math.max(0, (0.1 - t) / 0.1) * 0.5;
      _c.copy(body).lerp(tip, end * end * brown);
      cols.push(_c.r, _c.g, _c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const turn = (r() - 0.5) * 0.5; q.setFromUnitVectors(up, _v.copy(b).sub(a).normalize()); twist.setFromAxisAngle(up, turn);
    m.compose(_v.copy(a).add(b).multiplyScalar(0.5), q.multiply(twist), new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m); geoms.push(g); list.push({ a: a.clone(), b: b.clone(), w, r: (w / 2) * 1.1 * (Math.abs(Math.cos(turn)) + Math.abs(Math.sin(turn))) });      // r: how far it reaches across, turned as it is
  }
  const g = mergeGeometries(geoms, false); for (const x of geoms) x.dispose();
  return { geometry: g, list };
}

/** The carton's two geometries, the fries' centre lines and the carton's measure (for the props, and for the check in tools/tests/rescue_fries.mjs). */
export function cartonParts(S = FRIES.scale, n = FRIES.fries) {
  const { geometry: box, shape } = cartonGeometry(S), { geometry: fries, list } = friesGeometry(S, shape, n);
  return { box, fries, list, shape };
}

/** Dev: the closest two fries come (centre lines, metres) against their widths: nothing may pass through anything. */
export function friesGap(list) {
  let worst = Infinity;
  const seg = (p1, q1, p2, q2) => {                                          // distance between two segments
    const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2), a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
    let s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = (b * s + f) / e;
    if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
  };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) worst = Math.min(worst, seg(list[i].a, list[i].b, list[j].a, list[j].b) - (list[i].r + list[j].r));
  return worst;
}

// ------------------------------------------------------------------------------------------------ the beam
const BEAM_VERT = /* glsl */`
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const BEAM_FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform sampler2D tDepth;
uniform float uSoft, uTime, uGain, uTan, uLen, uFloor, uR;
uniform vec2 uRes, uNearFar;
uniform vec3 uApex, uColor;
varying vec3 vW;
#include <packing>
// the light the air gives back at a point of the beam (per metre)
float density(vec3 p) {
  vec3 q = p - uApex; float h = -q.y;                                 // metres down from the lamp
  if (h <= 0.0 || h > uLen) return 0.0;
  float R = h * uTan, r = length(q.xz), x = r / R;
  float edge = 1.0 - smoothstep(0.78, 1.0, x);
  float core = 0.55 + 0.45 * (1.0 - x * x);
  float near = clamp(uR / R, 1.0, 7.0);                                // the same light through a narrower beam: brighter toward the lamp
  float fromDark = smoothstep(0.5, 5.0, h);                            // it comes out of the dark under the vault
  float ang = atan(q.z, q.x);
  float n = texture2D(tNoise, vec2(ang * 0.32 + x * 0.25, h * 0.045 - uTime * 0.012)).r;
  float m = texture2D(tNoise, vec2(p.x * 0.35 + uTime * 0.01, p.z * 0.35 + h * 0.08)).a;
  float dust = 0.72 + 0.5 * n + 1.4 * m * m * m;
  float foot = 1.0 + 0.5 * exp(-max(p.y - uFloor, 0.0) * 2.5);       // the haze lying on the water lights up where the beam meets it
  return edge * core * near * fromDark * dust * foot;
}
void main() {
  vec3 ro = cameraPosition, rd = normalize(vW - ro);
  // where the ray is inside the cone (apex uApex, pointing down, half-angle atan(uTan)): solve, then keep the part
  // under the lamp and over the floor
  float c2 = 1.0 / (1.0 + uTan * uTan);
  vec3 co = ro - uApex; vec3 V = vec3(0.0, -1.0, 0.0);
  float dv = dot(rd, V), cv = dot(co, V);
  float A = dv * dv - c2, Bq = 2.0 * (dv * cv - dot(rd, co) * c2), Cq = cv * cv - dot(co, co) * c2;
  float t0 = 0.0, t1 = length(vW - ro);
  float disc = Bq * Bq - 4.0 * A * Cq;
  bool inside = Cq > 0.0 && cv > 0.0;
  if (disc > 0.0 && abs(A) > 1e-6) {
    float s = sqrt(disc), ta = (-Bq - s) / (2.0 * A), tb = (-Bq + s) / (2.0 * A);
    float lo = min(ta, tb), hi = max(ta, tb);
    // a hit counts only on the nappe under the lamp
    bool loOk = dot(co + rd * lo, V) > 0.0, hiOk = dot(co + rd * hi, V) > 0.0;
    if (inside) { t0 = 0.0; t1 = min(t1, (loOk && lo > 0.0) ? lo : ((hiOk && hi > 0.0) ? hi : t1)); }
    else if (loOk && hiOk) { t0 = max(lo, 0.0); t1 = min(t1, hi); }
    else if (hiOk) { t0 = max(hi, 0.0); }
    else if (loOk) { t1 = min(t1, lo); }
  }
  // the floor and the lamp's own height bound it too
  if (abs(rd.y) > 1e-5) {
    float tf = (uFloor - ro.y) / rd.y, ta2 = (uApex.y - ro.y) / rd.y;
    if (rd.y < 0.0) { t1 = min(t1, tf); t0 = max(t0, ta2); } else { t0 = max(t0, tf); t1 = min(t1, ta2); }
  }
  if (uSoft > 0.5) {
    float sceneZ = -perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x, uNearFar.x, uNearFar.y);
    vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);      // the lens's axis in the world
    t1 = min(t1, sceneZ / max(dot(rd, fwd), 1e-3));
  }
  if (t1 <= t0) discard;
  const int STEPS = 22;
  float dt = (t1 - t0) / float(STEPS);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float sum = 0.0;
  // (the air within a few metres of the lens hardly counts: from beside the beam its haze filled the whole picture)
  for (int i = 0; i < STEPS; i++) { float t = t0 + (float(i) + jitter) * dt; sum += density(ro + rd * t) * smoothstep(1.0, 7.0, t); }
  sum *= dt;
  // the haze sends most of the lamp's light on the way it was going: bright looking up toward the lamp, faint looking
  // down the way the light goes (Henyey-Greenstein, g = 0.35, as a share of what it sends sideways)
  float cs = dot(rd, vec3(0.0, 1.0, 0.0)), g = 0.35, hg = pow((1.0 + g * g) / (1.0 + g * g - 2.0 * g * cs), 1.5);
  vec3 col = uColor * (sum * uGain * hg);
  if (dot(col, vec3(1.0)) < 1e-4) discard;
  gl_FragColor = vec4(col, 0.0);
  ${GLSL_OUT}
}`;

const POOL_FRAG = /* glsl */`
uniform float uGain, uTime;
uniform vec3 uColor;
uniform sampler2D tNoise;
varying vec2 vUv;
void main() {
  vec2 d = vUv * 2.0 - 1.0; float r = length(d);
  float edge = 1.0 - smoothstep(0.62, 1.0, r);
  float lift = 0.55 + 0.45 * (1.0 - r * r);
  float n = texture2D(tNoise, d * 0.6 + vec2(uTime * 0.01, 0.0)).r;
  float halo = 0.12 * exp(-max(0.0, r - 1.0) * 9.0) * step(1.0, r);
  float i = edge * lift * (0.9 + 0.2 * n) + halo;
  if (i < 1e-3) discard;
  gl_FragColor = vec4(uColor * (i * uGain), 0.0);
  ${GLSL_OUT}
}`;

// (glow only: colour already counted, alpha 0. three's own AdditiveBlending multiplies by alpha, and alpha 0 gave nothing)
const ADD = { ...PREMULTIPLIED, fog: false };

export class RescueProps {
  constructor(ctx) {
    this.ctx = ctx; this.time = 0; this.level = 0; this.at = new THREE.Vector3();
    const scene = ctx.scene, noise = this.noise = makeNoiseTexture();
    const group = this.group = new THREE.Group(); group.name = 'rescue'; scene.add(group);
    const col = new THREE.Color().setRGB(SPOT.color[0], SPOT.color[1], SPOT.color[2]);

    // the beam: a closed cone round the volume, drawn from inside out (its far side), so a camera inside it still sees it
    const len = SPOT.height - WATER_Y, tan = SPOT.radius / len, top = 0.4;
    const cone = new THREE.CylinderGeometry(top * tan * 1.05 + 0.02, SPOT.radius * 1.05, len - top, 48, 1, false);
    cone.translate(0, -(top + (len - top) / 2), 0);                    // its origin is the lamp
    const bu = this.beamU = {
      tNoise: { value: noise }, tDepth: { value: blankTexture() }, uSoft: { value: 0 }, uRes: { value: new THREE.Vector2(1600, 900) }, uNearFar: { value: new THREE.Vector2(0.1, 400) },
      uTime: { value: 0 }, uGain: { value: 0 }, uTan: { value: tan }, uLen: { value: len }, uFloor: { value: WATER_Y }, uR: { value: SPOT.radius },
      uApex: { value: new THREE.Vector3(0, SPOT.height, 0) }, uColor: { value: col.clone() },
    };
    const beamMat = this.beamMat = Object.assign(new THREE.ShaderMaterial({ name: 'rescue.beam', uniforms: bu, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG }), ADD, { side: THREE.BackSide, depthTest: false });
    const beam = this.beam = new THREE.Mesh(cone, beamMat); beam.name = 'rescue:beam'; beam.frustumCulled = false; beam.renderOrder = 16;
    beam.onBeforeRender = (renderer, sc, camera) => { passInfo(renderer, camera, ctx, bu); beamMat.uniformsNeedUpdate = true; };
    group.add(beam);

    // the circle on the water
    const pu = this.poolU = { uGain: { value: 0 }, uTime: { value: 0 }, uColor: { value: col.clone() }, tNoise: { value: noise } };
    const disc = new THREE.PlaneGeometry(SPOT.radius * 2.6, SPOT.radius * 2.6); disc.rotateX(-Math.PI / 2);
    const poolMat = this.poolMat = Object.assign(new THREE.ShaderMaterial({
      name: 'rescue.pool', uniforms: pu, fragmentShader: POOL_FRAG,
      vertexShader: 'varying vec2 vUv; void main() { vUv = (uv - 0.5) * 1.3 + 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    }), ADD, { depthTest: true });
    const pool = this.pool = new THREE.Mesh(disc, poolMat); pool.name = 'rescue:pool'; pool.frustumCulled = false; pool.renderOrder = 15; pool.layers.set(2);
    group.add(pool);

    // the lamp (made with the hall's other lights: src/gfx/lights.js), and the light its circle on the water gives back:
    // one of the two 'flash' lights (the effects take the first), low over the circle on the side the cameras stand,
    // so what lies in it is not lit from straight above alone. It lights neither the air nor what hangs in it (spray,
    // mist, dust: userData.noAir, src/gfx/post.js and fx_common.js): a slam's spray glowed white in it.
    const L = ctx.gfx.lights;
    this.lamp = L && L.spot ? L.spot : null;
    if (this.lamp) this.lamp.color.copy(col);
    this.bounce = L && L.managed && L.managed.flash && L.managed.flash[1] ? L.managed.flash[1] : null;
    if (this.bounce) this.bounce.userData.noAir = true;
    this.side = new THREE.Vector3(1, 0, 0);

    // the carton and its fries
    const mats = ctx.gfx.materials;
    const { box: cg, fries: fg, list, shape } = cartonParts();
    const board = this.board = mats.stone({ color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0, detail: 0 });
    const fry = this.fryMat = mats.stone({ color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0, detail: 0 });
    this.friesList = list;
    const carton = this.carton = new THREE.Group(); carton.name = 'rescue:carton';
    const box = new THREE.Mesh(cg, board), sticks = new THREE.Mesh(fg, fry);
    box.name = 'rescue:box'; sticks.name = 'rescue:fries';
    for (const m of [box, sticks]) { m.castShadow = true; m.receiveShadow = true; carton.add(m); }
    this.height = shape.H.back;
    // its light as it gives itself up (the same gold as a flask's)
    this.glow = new THREE.Color(1.0, 0.66, 0.26); this.boost = 1;
    group.add(carton);
    this.hide();
  }

  /** The beam, the pool and the lamp over (x, z), at `level` (0..1). `side` (a unit vector on the floor): where the
   *  light off the water comes from. */
  spot(x, z, level, side) {
    this.level = level; this.at.set(x, WATER_Y, z);
    const on = level > 1e-3;
    this.beam.visible = on; this.pool.visible = on;
    this.beam.position.set(x, SPOT.height, z); this.beamU.uApex.value.set(x, SPOT.height, z);
    this.pool.position.set(x, WATER_Y + 0.004, z);
    this.beamU.uGain.value = SPOT.beam * level; this.poolU.uGain.value = SPOT.pool * level;
    const L = this.lamp;
    if (L) {
      L.intensity = SPOT.lamp * level; L.position.set(x, SPOT.height, z); L.target.position.set(x, 0, z);
      L.angle = Math.atan(SPOT.radius * 1.08 / SPOT.height); L.penumbra = 0.2; L.distance = 0; L.decay = 2;
      L.updateMatrixWorld(); L.target.updateMatrixWorld();
    }
    const Bn = this.bounce;
    if (Bn) {
      if (side) this.side.copy(side);
      if (!(this.boost > 1)) Bn.color.copy(this.lamp ? this.lamp.color : Bn.color);
      Bn.intensity = SPOT.bounce * level * (this.boost || 1);
      Bn.position.set(x + this.side.x * 0.95, WATER_Y + 0.35, z + this.side.z * 0.95); Bn.updateMatrixWorld();
    }
  }

  show(on) { this.carton.visible = on; if (on) this.burst(0); }
  hide() { this.carton.visible = false; this.spot(0, 0, 0); }

  /** The carton giving itself up as light: k 0..1 (1 = gone). It warms to gold as it shrinks away, and the light off
   *  the water swells gold with it (a white glow over the red read as a pale cut-out). */
  burst(k) {
    const s = k <= 0 ? 1 : Math.max(0.001, 1 - k * k * (3 - 2 * k));
    this.carton.scale.setScalar(s);
    const glow = k > 0 ? Math.sin(Math.min(1, k * 1.25) * Math.PI) : 0;
    for (const m of [this.board, this.fryMat]) m.emissive.copy(this.glow).multiplyScalar(0.95 * glow);
    if (this.bounce) { _c.copy(this.lamp ? this.lamp.color : this.glow).lerp(this.glow, glow); this.bounce.color.copy(_c); this.boost = 1 + 0.6 * glow; }
    if (k >= 1) { this.carton.visible = false; this.boost = 1; }
  }

  update(dt) { this.time += dt; this.beamU.uTime.value = this.time; this.poolU.uTime.value = this.time; }
}
