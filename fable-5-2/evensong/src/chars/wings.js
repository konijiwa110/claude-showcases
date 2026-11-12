// The Cantor's wings: two fans of organ pipes behind her shoulders, and the halo behind her head.
//
// Every pipe is a real pipe (tools/kit_weapons/build_props.py, "pipe": a toe, a mouth, a slim body), stretched to its
// own length and hung by its toe on a gilded yoke that rides on her upper spine. All sixty are ONE skinned mesh with
// one bone a pipe, so they cost one draw call and cast one shadow.
//   open 0   folded: every pipe hangs down her back, swept a little away from her, like a closed fan
//   open 1   the fan of the painting: the tallest pipes rise beside her head, the rest spread out and round, cupped
//            toward whoever faces her; about 2.4 units wide and 2.9 high on a 1.8 unit figure
// Each pipe's far end is a small weight on a spring that follows where the pipe should be, in the world: so the fan
// lags behind her turns, overshoots a little and settles, and the pipes open one after another. Tips cannot go under
// the water: when she kneels the folded pipes trail out behind her on it.
//
// The pipes are solid to the hall: they do not pass through the walls of the play area (ctx.arena.bounds: the piers
// stand just beyond), the fallen stones (ctx.arena.colliders), the pilgrim, or anything named with wings.obstacle().
// A pipe that would reach into one is turned aside, and the wing on that side is drawn in (wings.squeeze) so the fan
// folds toward her rather than flattening against the stone.
//
//   const wings = new Wings(ctx, char, { fade, capsules });   wings.open = 1; wings.glow = 0.6; wings.pulse(1);
//   wings.update(dt) each step after the pose (the skeleton's world matrices current); wings.teleport(); wings.dispose()
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { place, patch, standard, fadeable } from './weapons.js';

const DEG = Math.PI / 180;
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _hit = new Float32Array(7);                       // closest points of two segments: on the first (0..2), on the second (3..5), how far along the first (6)
/** Closest points between segment p-q and segment a-b (numbers in, _hit out); returns their distance. */
function segSeg(px, py, pz, qx, qy, qz, ax, ay, az, bx, by, bz) {
  const d1x = qx - px, d1y = qy - py, d1z = qz - pz, d2x = bx - ax, d2y = by - ay, d2z = bz - az, rx = px - ax, ry = py - ay, rz = pz - az;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz, c = d1x * rx + d1y * ry + d1z * rz, b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
  let s = den > 1e-9 ? (b * f - c * e) / den : 0; s = s < 0 ? 0 : s > 1 ? 1 : s;
  let t = e > 1e-9 ? (b * s + f) / e : 0;
  if (t < 0) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; } else if (t > 1) { t = 1; s = (b - c) / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
  _hit[0] = px + d1x * s; _hit[1] = py + d1y * s; _hit[2] = pz + d1z * s; _hit[3] = ax + d2x * t; _hit[4] = ay + d2y * t; _hit[5] = az + d2z * t; _hit[6] = s;
  return Math.hypot(_hit[0] - _hit[3], _hit[1] - _hit[4], _hit[2] - _hit[5]);
}
const smoother = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));

// The carrier: a frame fixed to Spine2, given by where its origin is on the figure at rest (the figure's own units).
// Pipes hang from pivots along an arch on each side of it: inner end high beside the neck, outer end lower and wide.
const CARRIER = [0, 1.5, -0.235];
const LAYER = 0.031;                                    // rows of pipes stand this far behind one another
const N_MAIN = 21, N_SMALL = 9;                         // per side: the long pipes, and a row of short ones in front of their roots
function archPoint(side, u, out) { const a = u * 1.45; out[0] = side * (0.118 + 0.272 * Math.sin(a)); out[1] = 0.03 - 0.17 * (1 - Math.cos(a)); return out; }

/** The list of pipes: where each hangs, how long and thick it is, and where it points folded and open. */
function layout() {
  const pipes = [], p2 = [0, 0];
  for (const side of [-1, 1]) {
    for (let i = 0; i < N_MAIN; i++) {
      const u = i / (N_MAIN - 1); archPoint(side, u, p2);
      const len = 1.36 * (1 - 0.40 * Math.pow(u, 1.25)) * (1 + 0.035 * Math.cos(i * Math.PI)) * (1 - 0.06 * Math.exp(-((u - 0.5) * (u - 0.5)) / 0.02));
      pipes.push({ side, u, x: p2[0], y: p2[1], z: -(i % 3) * LAYER, len, dia: 0.031 + 0.022 * Math.pow(len / 1.36, 1.3),
        open: (4 + 96 * Math.pow(u, 0.92)) * DEG, fold: (178 - 13 * u) * DEG, tiltOpen: (-7 + 21 * u) * DEG, tiltFold: (-21 + 3 * u) * DEG,
        order: u, delay: 1 - u, soft: 0.75 + 0.5 * (len / 1.36) });
    }
    for (let j = 0; j < N_SMALL; j++) {
      const u = 0.05 + 0.84 * j / (N_SMALL - 1); archPoint(side, u, p2);
      const len = 0.64 - 0.27 * u + 0.03 * Math.cos(j * Math.PI);
      pipes.push({ side, u, x: p2[0], y: p2[1] - 0.004, z: LAYER, len, dia: 0.036 - 0.007 * u,
        open: (4 + 96 * Math.pow(u, 0.92) + 2.3) * DEG, fold: (176 - 13 * u) * DEG, tiltOpen: (-2 + 21 * u) * DEG, tiltFold: (-17 + 3 * u) * DEG,
        order: u, delay: 1 - u * 0.9, soft: 1.25 });
    }
  }
  return pipes;
}

// ---- the yoke: the gilded arch the pipes hang from, a bridge behind the neck with a rose at its middle, struts to her back
function tubeAlong(points, radius, sides, flat, taper) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal');
  const segs = Math.max(8, points.length * 3), g = new THREE.TubeGeometry(curve, segs, radius, sides, false), pos = g.attributes.position;
  if (taper) {                                            // thinner toward one end: each ring drawn in toward its own centre
    const c = new THREE.Vector3();
    for (let i = 0; i <= segs; i++) { curve.getPointAt(i / segs, c); const f = taper[0] + (taper[1] - taper[0]) * (i / segs); for (let j = 0; j <= sides; j++) { const k = i * (sides + 1) + j; pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * f, c.y + (pos.getY(k) - c.y) * f, c.z + (pos.getZ(k) - c.z) * f); } }
  }
  if (flat) { const z0 = points[0][2]; for (let i = 0; i < pos.count; i++) pos.setZ(i, z0 + (pos.getZ(i) - z0) * flat); }
  if (flat || taper) g.computeVertexNormals();
  return g;
}
function ball(r, at, squash) { const g = new THREE.SphereGeometry(r, 14, 10); if (squash) g.scale(squash[0], squash[1], squash[2]); g.translate(at[0], at[1], at[2]); return g; }
function yokeGeometry() {
  const parts = [], p2 = [0, 0], zc = -LAYER;
  for (const side of [-1, 1]) {
    const pts = []; for (let i = 0; i <= 14; i++) { archPoint(side, i / 14, p2); pts.push([p2[0], p2[1] + 0.012, zc]); }
    parts.push(tubeAlong(pts, 0.021, 10, 2.3, [1, 0.62]));                                                                          // the beam, slimmer toward its outer end
    archPoint(side, 1, p2); parts.push(ball(0.024, [p2[0] + side * 0.01, p2[1] + 0.004, zc], [1, 1, 1.35]));                         // the outer end: a bud
    parts.push(ball(0.012, [p2[0] + side * 0.036, p2[1] - 0.004, zc], [1.7, 0.8, 1]));
    archPoint(side, 0, p2); parts.push(ball(0.03, [p2[0], p2[1] + 0.022, zc], [1, 1, 1.4]));                                       // the inner end
    parts.push(tubeAlong([[p2[0], p2[1] + 0.012, zc], [side * 0.085, -0.02, zc], [side * 0.04, -0.062, zc], [0, -0.075, zc]], 0.016, 8, 2.0));   // the bridge
    parts.push(tubeAlong([[side * 0.05, -0.066, zc + 0.01], [side * 0.058, -0.105, 0.05], [side * 0.06, -0.13, 0.108]], 0.012, 8, 1));           // a strut to her back
    parts.push(ball(0.022, [side * 0.06, -0.132, 0.11], [1.3, 1.3, 0.5]));
  }
  // the rose at the middle of the bridge: a boss in a ring, facing backward
  const rose = new THREE.LatheGeometry([[0.0, -0.03], [0.022, -0.028], [0.04, -0.02], [0.046, -0.008], [0.04, 0.0], [0.028, 0.004], [0.0, 0.006]].map((p) => new THREE.Vector2(p[0] + 1e-5, p[1])), 20);
  rose.rotateX(Math.PI / 2); rose.translate(0, -0.075, zc - 0.012); parts.push(rose);
  const ring = new THREE.TorusGeometry(0.05, 0.007, 8, 24); ring.translate(0, -0.075, zc - 0.014); parts.push(ring);
  const out = parts.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k); return n; });
  return mergeGeometries(out, false);
}

const WING_VERT_PARS = /* glsl */`attribute vec2 aPipe;\nvarying vec2 vPipe;\n`;
const PIPE_BODY = 0.36, PIPE_MOUTH = 6.0, PIPE_GOLD = 0.5;      // the pipes' own glow along the body and at the mouth (times uWingColor * glow), and the kit's gold laid on them (the kit's own is 2.4)
const WING_FRAG_PARS = /* glsl */`
#define PIPE_BODY ${PIPE_BODY.toFixed(3)}
#define PIPE_MOUTH ${PIPE_MOUTH.toFixed(3)}
varying vec2 vPipe;
uniform vec4 uWing;            // glow, pulse reach, -, -
uniform vec3 uWingColor;
uniform vec2 uWingPulse[ 3 ];  // each: where the wave is (0 the middle .. 1 the outermost pipe, running on past it), how strong
`;
const WING_FRAG = /* glsl */`
	if ( vPipe.x >= 0.0 ) {
		float wave = 0.0;
		for ( int i = 0; i < 3; i ++ ) { float d = ( vPipe.x - uWingPulse[ i ].x ) * 4.5; wave += uWingPulse[ i ].y * exp( - d * d ); }
		// Organ pipes lit from inside, not pale sticks (look polish, 8 Nov): the light gathers at the mouth, hot enough
		// to bloom, and at the open top; the pipe's own body glows half as much and from WITHIN: brightest along its
		// middle as it is seen, falling away toward its edges, so each pipe keeps its roundness. The wave runs up it.
		float mouth = exp( - pow( ( vPipe.y - 0.2 ) * 11.0, 2.0 ) ), top = smoothstep( 0.8, 1.0, vPipe.y );
		float face = saturate( dot( normal, normalize( vViewPosition ) ) ), mid = 0.12 + 0.88 * face * face * face;
		float along = PIPE_BODY * mid + PIPE_MOUTH * mouth * ( 0.4 + 0.6 * face ) + 0.6 * top * mid;
		totalEmissiveRadiance += uWingColor * ( uWing.x * along + wave * ( 0.6 * mid + 2.0 * mouth + 0.6 * top ) );
	}`;

export class Wings {
  /**
   * @param ctx   needs ctx.assets ('prop.pipe') and ctx.scene
   * @param char  the Character
   * @param o     { fade: from weapons.makeFade (kit.fade), floor: world y the tips rest on (default 0.09), holder: Object3D under char.root,
   *                 capsules + avoid: a cloth.js Capsules and the names of those the pipes keep off (her arms) }
   */
  constructor(ctx, char, o = {}) {
    this.ctx = ctx; this.char = char; this.open = 0; this.glow = 0; this.speed = 0.55; this.now = 0; this.time = 0; this.floor = o.floor !== undefined ? o.floor : 0.09;
    this.hang = 0.72; this.poise = 0.5;                  // how upright the pipes stay whatever her spine does: folded (they hang), open (the fan keeps its composure)
    this.carrier = place(char, 'Spine2', CARRIER, 'kit:wings');
    const pipes = this.pipes = layout(), n = this.n = pipes.length;
    // one pipe from the file, re-made at each length and thickness
    const src = ctx.assets.gltf('prop.pipe').scene; let mesh = null; src.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
    const s0 = src.getObjectByName('stretch0').position.y, s1 = src.getObjectByName('stretch1').position.y, top = src.getObjectByName('top').position.y;
    const base = mesh.geometry, bp = base.attributes.position, bn = base.attributes.normal, bu = base.attributes.uv, bc = base.attributes.color, bi = base.index;
    const yoke = yokeGeometry(), yn = yoke.attributes.position.count, vc = bp.count, total = vc * n + yn;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2), col = new Float32Array(total * 3), skinI = new Uint16Array(total * 4), skinW = new Float32Array(total * 4), ap = new Float32Array(total * 2);
    const idx = new Uint32Array(bi.count * n + yn);
    for (let k = 0; k < n; k++) {
      const p = pipes[k], sd = p.dia / 0.05, L = p.len, stretch = (L - s0 * sd - (top - s1) * sd) / (s1 - s0), o3 = k * vc;
      for (let i = 0; i < vc; i++) {
        const y = bp.getY(i), yy = y <= s0 ? y * sd : y >= s1 ? L - (top - y) * sd : s0 * sd + (y - s0) * stretch, v = o3 + i;
        pos[v * 3] = bp.getX(i) * sd; pos[v * 3 + 1] = yy; pos[v * 3 + 2] = bp.getZ(i) * sd;
        nor[v * 3] = bn.getX(i); nor[v * 3 + 1] = bn.getY(i); nor[v * 3 + 2] = bn.getZ(i);
        uv[v * 2] = bu.getX(i); uv[v * 2 + 1] = yy * 4;
        col[v * 3] = bc.getX(i); col[v * 3 + 1] = bc.getY(i); col[v * 3 + 2] = bc.getZ(i);
        skinI[v * 4] = k; skinW[v * 4] = 1; ap[v * 2] = p.order; ap[v * 2 + 1] = yy / L;
      }
      for (let i = 0; i < bi.count; i++) idx[k * bi.count + i] = bi.getX(i) + o3;
    }
    const yp = yoke.attributes.position, ynn = yoke.attributes.normal, o3 = vc * n;
    for (let i = 0; i < yn; i++) {
      const v = o3 + i;
      pos[v * 3] = yp.getX(i); pos[v * 3 + 1] = yp.getY(i); pos[v * 3 + 2] = yp.getZ(i); nor[v * 3] = ynn.getX(i); nor[v * 3 + 1] = ynn.getY(i); nor[v * 3 + 2] = ynn.getZ(i);
      uv[v * 2] = yp.getX(i) * 4; uv[v * 2 + 1] = yp.getY(i) * 4; col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = 0.82;
      skinI[v * 4] = n; skinW[v * 4] = 1; ap[v * 2] = -1; ap[v * 2 + 1] = 0; idx[bi.count * n + i] = v;
    }
    yoke.dispose();
    const g = this.geometry = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('skinIndex', new THREE.BufferAttribute(skinI, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
    g.setAttribute('aPipe', new THREE.BufferAttribute(ap, 2)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.6, 0, -0.3), new THREE.Vector3(0.6, 1.8, 0.3));

    // material: champagne gold that can be lit from inside
    const has = (nm) => ctx.assets.has && ctx.assets.has(nm);
    const rep = (nm) => { if (!has(nm)) return null; const t = ctx.assets.texture(nm).clone(); t.repeat.set(3, 3); t.needsUpdate = true; this.textures.push(t); return t; };
    this.textures = [];
    const orm = rep('prop.tex.metal_orm'), nm = rep('prop.tex.metal_n');
    const mat = this.material = standard(ctx, 'metal', { color: new THREE.Color().setRGB(0.98, 0.72, 0.34), roughness: 0.36, metalness: 1, vertexColors: true,      // (gold, as the hall's organ pipes are: it was a champagne of 0.95, 0.80, 0.54, which the night turned to ivory)
      roughnessMap: orm || undefined, metalnessMap: orm || undefined, normalMap: nm || undefined, normalScale: nm ? new THREE.Vector2(0.4, 0.4) : undefined });
    mat.name = 'kit.pipes';
    this.uniforms = { uWing: { value: new THREE.Vector4(0, 0, 0, 0) }, uWingColor: { value: new THREE.Color().setRGB(1.0, 0.60, 0.21).multiplyScalar(1.5) }, uWingPulse: { value: [new THREE.Vector2(9, 0), new THREE.Vector2(9, 0), new THREE.Vector2(9, 0)] } };
    patch(mat, 'kitwing', (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('void main() {', WING_VERT_PARS + 'void main() {\n\tvPipe = aPipe;');
      let f = shader.fragmentShader.replace('void main() {', WING_FRAG_PARS + '\nvoid main() {');
      const tag = '#include <emissivemap_fragment>'; f = f.replace(tag, tag + '\n' + WING_FRAG);
      shader.fragmentShader = f;
    });
    if (o.fade) fadeable(mat, o.fade, { gold: PIPE_GOLD / ((o.fade.who && o.fade.who.gold) || 2.4) });

    // bones: one a pipe and one for the yoke, kept in the fighter root's space and written here every step
    const holder = this.holder = o.holder || char.root;
    this.bones = []; for (let k = 0; k <= n; k++) { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.name = 'kit:pipe' + k; holder.add(b); this.bones.push(b); }
    const mesh2 = this.mesh = new THREE.SkinnedMesh(g, mat); mesh2.name = 'kit:wings'; mesh2.frustumCulled = false; mesh2.castShadow = true; mesh2.receiveShadow = true; mesh2.userData.kit = true;
    holder.add(mesh2); mesh2.bind(new THREE.Skeleton(this.bones, this.bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
    // The water's mirror draws her a second time, and the sixty pipes (1,100 triangles each: 67,000 of the 85,000 her
    // kit has) are the heaviest thing she wears. Behind ripples a pipe is a plain six-sided tube: a stand-in on the
    // same bones with the same material (so light, glow and fading are the pipes' own) is drawn in the mirror
    // instead: wings.mirror(true) puts the fine mesh on layer 2 (the main camera and the shadow pass) and the
    // stand-in on layer 3, the mirror's alone (docs/engine.md). On only where the camera sees layer 2 (the game's
    // renderer); in a lab page everything stays on layer 0 and the stand-in is not drawn.
    { const SIDES = 6, ring = SIDES + 1, pv = ring * 2 + 2, yk = yokeGeometry(), ykp = yk.attributes.position, ykn2 = yk.attributes.normal, ykc = ykp.count, tv = pv * n + ykc;
      const P = new Float32Array(tv * 3), N = new Float32Array(tv * 3), U = new Float32Array(tv * 2), C = new Float32Array(tv * 3).fill(0.9), SI = new Uint16Array(tv * 4), SW = new Float32Array(tv * 4), A = new Float32Array(tv * 2);
      const I = new (tv > 65535 ? Uint32Array : Uint16Array)(SIDES * 12 * n + ykc); let ii = 0;
      for (let k = 0; k < n; k++) {
        const pp = pipes[k], r = pp.dia * 0.5, L = pp.len, o = k * pv, c0 = o + ring * 2;
        for (let e = 0; e < 2; e++) {
          for (let j = 0; j <= SIDES; j++) { const v = o + e * ring + j, a = j / SIDES * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a); P[v * 3] = c * r; P[v * 3 + 1] = e * L; P[v * 3 + 2] = sn * r; N[v * 3] = c; N[v * 3 + 2] = sn; U[v * 2] = j / SIDES; U[v * 2 + 1] = e * L * 4; SI[v * 4] = k; SW[v * 4] = 1; A[v * 2] = pp.order; A[v * 2 + 1] = e; }
          const v = c0 + e; P[v * 3 + 1] = e * L; N[v * 3 + 1] = e ? 1 : -1; U[v * 2] = 0.5; U[v * 2 + 1] = e * L * 4; SI[v * 4] = k; SW[v * 4] = 1; A[v * 2] = pp.order; A[v * 2 + 1] = e;
        }
        for (let j = 0; j < SIDES; j++) { const a = o + j, b = a + 1, c = a + ring, d = c + 1; I[ii++] = a; I[ii++] = c; I[ii++] = b; I[ii++] = b; I[ii++] = c; I[ii++] = d; I[ii++] = c0; I[ii++] = a; I[ii++] = b; I[ii++] = c0 + 1; I[ii++] = d; I[ii++] = c; }
      }
      for (let i = 0, v = pv * n; i < ykc; i++, v++) { P[v * 3] = ykp.getX(i); P[v * 3 + 1] = ykp.getY(i); P[v * 3 + 2] = ykp.getZ(i); N[v * 3] = ykn2.getX(i); N[v * 3 + 1] = ykn2.getY(i); N[v * 3 + 2] = ykn2.getZ(i); U[v * 2] = ykp.getX(i) * 4; U[v * 2 + 1] = ykp.getY(i) * 4; C[v * 3] = C[v * 3 + 1] = C[v * 3 + 2] = 0.82; SI[v * 4] = n; SW[v * 4] = 1; A[v * 2] = -1; I[ii++] = v; }
      yk.dispose();
      const g2 = this.plainGeometry = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.BufferAttribute(P, 3)); g2.setAttribute('normal', new THREE.BufferAttribute(N, 3)); g2.setAttribute('uv', new THREE.BufferAttribute(U, 2)); g2.setAttribute('color', new THREE.BufferAttribute(C, 3));
      g2.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4)); g2.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4)); g2.setAttribute('aPipe', new THREE.BufferAttribute(A, 2)); g2.setIndex(new THREE.BufferAttribute(I, 1));
      g2.boundingSphere = g.boundingSphere; g2.boundingBox = g.boundingBox;
      const plain = this.plain = new THREE.SkinnedMesh(g2, mat); plain.name = 'kit:wings-mirror'; plain.frustumCulled = false; plain.castShadow = false; plain.receiveShadow = false; plain.userData.kit = true;
      mesh2.add(plain); plain.bind(mesh2.skeleton, new THREE.Matrix4());      // (a child of the fine mesh: hidden with it)
      const cam = ctx.gfx && ctx.gfx.camera; this.mirror(!!(cam && cam.layers && (cam.layers.mask & 4)));
    }
    // the far end of each pipe, in the world, and how it moves
    this.tip = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.kick = new Float32Array(n); this.fresh = true;
    this.pulses = [{ at: 9, s: 0 }, { at: 9, s: 0 }, { at: 9, s: 0 }]; this.nextPulse = 0;
    this.guard = [new Float32Array(6), new Float32Array(6)];              // an inner pipe of each side, root to tip (world): the veil keeps off it
    this.guardPipe = [3, N_MAIN + N_SMALL + 3];
    this.body = o.capsules || null; this.avoidNames = o.avoid || []; this.avoid = null;
    // the hall: walls, standing stones, people. Each obstacle is an upright cylinder [x, z, radius, top] (world metres)
    this.walls = true;                                    // keep inside ctx.arena.bounds: at the sides + wallGap (the piers stand 2 m beyond the play area's walls, their faces 1 m)
    this.wallGap = 1.0; this.wallGapZ = 3.5;              // ... and at the hall's two ends the organ's case and the doors stand 3.5 m beyond (over the dais there is air)
    this.stoneTop = 2.6;                                  // how high the fallen stones of ctx.arena.colliders stand
    this.squeeze = [0, 0];                                // 0..1: how far each wing (her right, her left) is drawn in now
    this.near = new Float32Array(4 * 24); this.nearN = 0; this.told = new Float32Array(4 * 8); this.toldN = 0;
    this.pushed = [0, 0];
  }

  /**
   * Something solid the pipes must keep out of, for this step only (call it every step while it matters): an upright
   * cylinder at (x, z) of this radius, as high as `top` (world metres; leave out for a pier that goes to the vault).
   * The walls of the play area, the stones in ctx.arena.colliders and the pilgrim are known without being told.
   */
  obstacle(x, z, radius, top = Infinity) { if (this.toldN < 8) { const k = this.toldN++ * 4; this.told[k] = x; this.told[k + 1] = z; this.told[k + 2] = radius; this.told[k + 3] = top; } }
  /** How far the fan reaches from her middle now, sideways (world metres): for whoever keeps her off the walls. */
  get reach() { return this.span || 0; }

  /** A wave of light from the middle pipes outward (she sings). */
  pulse(strength = 1) {
    const p = this.pulses[this.nextPulse]; this.nextPulse = (this.nextPulse + 1) % this.pulses.length;
    p.at = -0.25; p.s = Math.max(0, strength);
  }
  teleport() { this.fresh = true; }
  /** Set at once, with no easing (a cut in a film). */
  snap(open = this.open) { this.open = open; this.now = open; this.fresh = true; }

  update(dt) {
    const { pipes, n, tip, vel, kick, char } = this, s = char.scale;
    this.time += dt;
    // the fan eases toward what was asked for
    const d = this.open - this.now, step = this.speed * dt; this.now += Math.abs(d) <= step ? d : Math.sign(d) * step;
    const now = this.now, SPREAD = 0.55, t = this.time, fresh = this.fresh; this.fresh = false;
    // waves of light, and the little start each gives the pipe it passes
    const U = this.uniforms.uWingPulse.value;
    for (let k = 0; k < this.pulses.length; k++) { const p = this.pulses[k]; if (p.s > 0.001) { p.at += dt * 1.9; p.s *= Math.exp(-dt * (p.at > 1 ? 4 : 0.9)); } else { p.s = 0; p.at = 9; } U[k].set(p.at, p.s); }
    this.uniforms.uWing.value.x = this.glow;
    const C = this.carrier.matrixWorld.elements, inv = _inv.copy(this.holder.matrixWorld).invert().elements;
    const ax = C[0] / s, ay = C[1] / s, az = C[2] / s, bx = C[4] / s, by = C[5] / s, bz = C[6] / s, cx = C[8] / s, cy = C[9] / s, cz = C[10] / s;   // the carrier's axes, unit length
    // an upright frame facing the way her chest faces: the fan keeps its composure when she bends (it leans with her
    // only in part), and the folded pipes hang
    const R = this.holder.matrixWorld.elements, rl = Math.hypot(R[8], R[10]) || 1, hl0 = Math.hypot(cx, cz);
    let hx = cx * hl0 + (R[8] / rl) * (1 - hl0), hz = cz * hl0 + (R[10] / rl) * (1 - hl0); const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;   // forward, level
    const ux = hz, uz = -hx;                                                                                                               // her left, level
    const fy = this.floor;
    if (this.body && !this.avoid && this.body.cur) this.avoid = this.body.ids(this.avoidNames);
    const avoid = this.avoid && this.avoid.length && !fresh ? this.avoid : null;
    // what of the hall is near enough to matter: stones, the pilgrim, what the boss named; and the walls
    const near = this.near, arena = this.ctx.arena, hx0 = R[12], hz0 = R[14], far = 2.0 * s + 2; let nn = 0;
    const add = (x, z, r, top) => { if (nn < 24 && Math.hypot(x - hx0, z - hz0) < far + r) { const i = nn++ * 4; near[i] = x; near[i + 1] = z; near[i + 2] = r; near[i + 3] = top; } };
    if (arena && arena.colliders) for (const c of arena.colliders) add(c.x, c.z, c.r, c.top !== undefined ? c.top : this.stoneTop);
    { const pl = this.ctx.player, q = pl && pl.pos; if (q && pl.char !== char) add(q.x, q.z, 0.45, q.y + 1.9); }
    for (let i = 0; i < this.toldN; i++) add(this.told[i * 4], this.told[i * 4 + 1], this.told[i * 4 + 2], this.told[i * 4 + 3]);
    this.toldN = 0; this.nearN = nn;
    const B2 = this.walls && arena && arena.bounds ? arena.bounds : null, wallX = B2 ? B2.hx + this.wallGap : Infinity, wallZ = B2 ? B2.hz + this.wallGapZ : Infinity;
    const pushed = this.pushed; pushed[0] = pushed[1] = 0; let span = 0;
    // a wing that met stone last step is drawn in; one that is clear opens again, slowly
    const sq = this.squeeze;
    for (let k = 0; k < n; k++) {
      const p = pipes[k], q = k * 3, wing = p.side < 0 ? 0 : 1;
      // where the pipe should point, in the carrier's frame
      let pr = smoother((now * (1 + SPREAD) - p.delay * SPREAD));
      let kk = kick[k]; for (let j = 0; j < this.pulses.length; j++) { const w = this.pulses[j]; if (w.s > 0) { const dd = (p.order - w.at) * 5; kk = Math.max(kk, w.s * Math.exp(-dd * dd)); } }
      kick[k] = kk * Math.exp(-dt * 5);
      const breathe = Math.sin(t * 0.8 + p.u * 2.6 + (p.side > 0 ? 0.9 : 0)) * 0.012 * pr;
      let th = p.fold + (p.open - p.fold) * pr + breathe + kk * 0.045 * pr; const ti = p.tiltFold + (p.tiltOpen - p.tiltFold) * pr + kk * 0.03 * pr;
      // drawn in: toward upright if it stands above level, toward hanging if it droops below (either way it reaches less far)
      if (sq[wing] > 0) th = th < 1.5708 ? th * (1 - sq[wing]) : Math.PI - (Math.PI - th) * (1 - sq[wing]);
      const ct = Math.cos(ti), lx = p.side * Math.sin(th) * ct, ly = Math.cos(th) * ct, lz = Math.sin(ti);
      const L = p.len * s, up = this.hang + (this.poise - this.hang) * pr, own = 1 - up;
      // pivot and wanted tip, in the world: the direction is part her spine's, part upright
      const px = C[0] * p.x + C[4] * p.y + C[8] * p.z + C[12], py = C[1] * p.x + C[5] * p.y + C[9] * p.z + C[13], pz = C[2] * p.x + C[6] * p.y + C[10] * p.z + C[14];
      let tx = (ax * lx + bx * ly + cx * lz) * own + (ux * lx + hx * lz) * up, ty = (ay * lx + by * ly + cy * lz) * own + ly * up, tz = (az * lx + bz * ly + cz * lz) * own + (uz * lx + hz * lz) * up;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const wx = px + tx * L, wy = py + ty * L, wz = pz + tz * L;
      let x, y, z;
      if (fresh) { x = wx; y = wy; z = wz; vel[q] = vel[q + 1] = vel[q + 2] = 0; }
      else {
        // a weight on a spring toward where it should be: lag, a little overshoot, settle
        const kS = 150 / p.soft, cS = 15 / Math.sqrt(p.soft);
        vel[q] += ((wx - tip[q]) * kS - vel[q] * cS) * dt; vel[q + 1] += ((wy - tip[q + 1]) * kS - vel[q + 1] * cS) * dt; vel[q + 2] += ((wz - tip[q + 2]) * kS - vel[q + 2] * cS) * dt;
        x = tip[q] + vel[q] * dt; y = tip[q + 1] + vel[q + 1] * dt; z = tip[q + 2] + vel[q + 2] * dt;
        // never further from its place than a third of its length (a leap, a blow)
        const ex = x - wx, ey = y - wy, ez = z - wz, e2 = ex * ex + ey * ey + ez * ez, lim = L * 0.34;
        if (e2 > lim * lim) { const f = lim / Math.sqrt(e2); x = wx + ex * f; y = wy + ey * f; z = wz + ez * f; const vd = (vel[q] * ex + vel[q + 1] * ey + vel[q + 2] * ez) / e2; if (vd > 0) { vel[q] -= ex * vd; vel[q + 1] -= ey * vd; vel[q + 2] -= ez * vd; } }
      }
      // her arms brush the pipes aside (an elbow drawn back for a blow), like a hand through feathers
      if (avoid) {
        const cur = this.body.cur, rad = this.body.rad, mine = p.dia * 0.5 * s;
        for (let pass = 0; pass < 2; pass++) {
          let touched = false;
          for (let a = 0; a < avoid.length; a++) {
            const c = avoid[a], k6 = c * 6, Rr = rad[c] + mine;
            const dd = segSeg(px, py, pz, x, y, z, cur[k6], cur[k6 + 1], cur[k6 + 2], cur[k6 + 3], cur[k6 + 4], cur[k6 + 5]);
            if (dd >= Rr) continue;
            let nx = _hit[0] - _hit[3], ny = _hit[1] - _hit[4], nz = _hit[2] - _hit[5];
            if (dd < 1e-5) { nx = -cx; ny = -cy; nz = -cz; } else { nx /= dd; ny /= dd; nz /= dd; }
            const push = (Rr - dd) / Math.max(_hit[6], 0.12);               // the tip moves further than the place that was touched
            x += nx * push; y += ny * push; z += nz * push; touched = true;
            const vn = vel[q] * nx + vel[q + 1] * ny + vel[q + 2] * nz; if (vn < 0) { vel[q] -= nx * vn; vel[q + 1] -= ny * vn; vel[q + 2] -= nz * vn; }
          }
          if (!touched) break;
        }
      }
      // the hall: a wall stops the far end; a stone, a pier or a man turns the pipe aside
      if (!fresh) {
        if (x > wallX) { pushed[wing] += x - wallX; x = wallX; if (vel[q] > 0) vel[q] = 0; } else if (x < -wallX) { pushed[wing] += -wallX - x; x = -wallX; if (vel[q] < 0) vel[q] = 0; }
        if (z > wallZ) { pushed[wing] += z - wallZ; z = wallZ; if (vel[q + 2] > 0) vel[q + 2] = 0; } else if (z < -wallZ) { pushed[wing] += -wallZ - z; z = -wallZ; if (vel[q + 2] < 0) vel[q + 2] = 0; }
        for (let i = 0; i < nn; i++) {
          const ox = near[i * 4], oz = near[i * 4 + 1], top = near[i * 4 + 3]; if (py > top && y > top) continue;
          const Ro = near[i * 4 + 2] + p.dia * 0.5 * s, ex = x - px, ez = z - pz, e2 = ex * ex + ez * ez;
          let u = e2 > 1e-8 ? ((ox - px) * ex + (oz - pz) * ez) / e2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
          if (top < Infinity) { const yu = py + (y - py) * u; if (yu > top) continue; }      // it passes over
          let nx = px + ex * u - ox, nz = pz + ez * u - oz; const d = Math.hypot(nx, nz); if (d >= Ro) continue;
          if (d < 1e-5) { nx = hx0 - ox; nz = hz0 - oz; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; } else { nx /= d; nz /= d; }
          const move = (Ro - d) / Math.max(u, 0.25); x += nx * move; z += nz * move; if (top === Infinity) pushed[wing] += Ro - d;      // (a low stone only turns pipes aside: the wing is not drawn in for it)
          const vn = vel[q] * nx + vel[q + 2] * nz; if (vn < 0) { vel[q] -= nx * vn; vel[q + 2] -= nz * vn; }
        }
      }
      // rigid: exactly its length from the pivot; and never under the water (it slides out along it instead)
      let dx = x - px, dy = y - py, dz = z - pz, len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; dx /= len; dy /= len; dz /= len;
      if (py + dy * L < fy && py > fy) {
        const down = (py - fy) / L, flat = Math.sqrt(Math.max(0, 1 - down * down)); let hx = dx, hz = dz, hl = Math.hypot(hx, hz);
        if (hl < 0.05) { hx = -cx; hz = -cz; hl = Math.hypot(hx, hz) || 1; }                 // straight down: slide out behind her
        dx = hx / hl * flat; dz = hz / hl * flat; dy = -down;
        if (vel[q + 1] < 0) vel[q + 1] = 0;
      }
      x = px + dx * L; y = py + dy * L; z = pz + dz * L; tip[q] = x; tip[q + 1] = y; tip[q + 2] = z;
      { const sx = (x - hx0) * ux + (z - hz0) * uz; if (sx > span) span = sx; else if (-sx > span) span = -sx; }
      // the pipe's frame: +y along it, its mouth (+z) toward her front
      let zx = cx - dx * (cx * dx + cy * dy + cz * dz), zy = cy - dy * (cx * dx + cy * dy + cz * dz), zz = cz - dz * (cx * dx + cy * dy + cz * dz), zl = Math.sqrt(zx * zx + zy * zy + zz * zz);
      if (zl < 1e-4) { zx = bx; zy = by; zz = bz; zl = 1; } zx /= zl; zy /= zl; zz /= zl;
      const xx = dy * zz - dz * zy, xy = dz * zx - dx * zz, xz = dx * zy - dy * zx;
      const e = _m.elements;
      e[0] = xx * s; e[1] = xy * s; e[2] = xz * s; e[3] = 0; e[4] = dx * s; e[5] = dy * s; e[6] = dz * s; e[7] = 0; e[8] = zx * s; e[9] = zy * s; e[10] = zz * s; e[11] = 0; e[12] = px; e[13] = py; e[14] = pz; e[15] = 1;
      const b = this.bones[k]; b.matrix.multiplyMatrices(_inv, _m); b.matrixWorldNeedsUpdate = true;
      for (let w = 0; w < 2; w++) if (k === this.guardPipe[w]) { const gq = this.guard[w]; gq[0] = px + dx * L * 0.12; gq[1] = py + dy * L * 0.12; gq[2] = pz + dz * L * 0.12; gq[3] = x; gq[4] = y; gq[5] = z; }
    }
    const yb = this.bones[n]; yb.matrix.multiplyMatrices(_inv, this.carrier.matrixWorld); yb.matrixWorldNeedsUpdate = true;
    this.span = span;
    for (let w = 0; w < 2; w++) sq[w] = pushed[w] > 0.02 * s ? Math.min(0.92, sq[w] + dt * Math.min(2.4, 0.6 + pushed[w] / s)) : Math.max(0, sq[w] - dt * 0.35);
  }

  /** true: the water's mirror draws the plain stand-in, everything else the fine pipes. false: the fine pipes everywhere (as before). */
  mirror(on) { this.mirrored = !!on; this.mesh.layers.set(on ? 2 : 0); this.plain.layers.set(3); this.plain.visible = !!on; }

  dispose() {
    this.plainGeometry.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    for (const b of this.bones) if (b.parent) b.parent.remove(b);
    if (this.carrier.parent) this.carrier.parent.remove(this.carrier);
    this.mesh.skeleton.dispose(); this.geometry.dispose(); this.material.dispose(); for (const t of this.textures) t.dispose();
  }
}

/**
 * The halo: a thin double ring of gold behind her head, on the Head bone. halo.glow 0..1 lights it.
 * Returns { object, glow, update(), dispose() }.
 */
export function makeHalo(ctx, char, o = {}) {
  const parts = [];
  const add = (g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k); parts.push(n); };
  add(new THREE.TorusGeometry(0.214, 0.0052, 8, 72)); add(new THREE.TorusGeometry(0.236, 0.0026, 6, 72));
  for (let i = 0; i < 24; i++) {                       // small beads between the two rings, like the rim of a monstrance
    const a = i / 24 * Math.PI * 2, g = new THREE.SphereGeometry(i % 2 ? 0.0042 : 0.0062, 8, 6); g.translate(Math.cos(a) * 0.225, Math.sin(a) * 0.225, 0); add(g);
  }
  const geometry = mergeGeometries(parts, false);
  // (last polish: the halo's own light is the pipes' gold, 1.0 0.60 0.21, and it takes a third of the kit's gold as the
  // pipes take a fifth: with the whole of it and a champagne light of its own it was a cream ring beside gold pipes)
  const material = standard(ctx, 'metal', { color: new THREE.Color().setRGB(0.98, 0.74, 0.38), roughness: 0.28, metalness: 1, emissive: new THREE.Color().setRGB(1.0, 0.60, 0.21), emissiveIntensity: 0 });
  material.name = 'kit.halo'; if (o.fade) fadeable(material, o.fade, { gold: 0.35 });
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'kit:halo'; mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.kit = true;
  const at = new THREE.Matrix4().makeRotationX(-10 * DEG).setPosition(0, 1.612, -0.118);
  const socket = place(char, 'Head', at, 'kit:halo'); socket.add(mesh);
  const halo = {
    object: mesh, glow: 0, material,
    update() { material.emissiveIntensity = 0.06 + this.glow * 2.4; },
    dispose() { if (socket.parent) socket.parent.remove(socket); geometry.dispose(); material.dispose(); },
  };
  return halo;
}
