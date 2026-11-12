// What a floating candle is made of: the brass bowl with its short candle (one lathe-turned mesh, instanced), the
// flame (an instanced quad drawn by a shader, HDR so it blooms), and the thread of smoke a snuffed wick leaves.
// The behaviour (where they float, how they go out) is in src/world/candles.js.
//
// The bowl and candle use three's physical material, so the renderer's light, fog and shadows reach them; added to it:
// each bowl is lit from inside by its own flame (worked out in the bowl's own space, no light needed), the wax glows
// a little near the flame, the wick keeps an ember when the flame dies, and the brass has a hammered, tarnished
// surface that holds up in a close-up.
import * as THREE from 'three';

export const BOWL = {
  radius: 0.125,       // outer radius of the bowl at scale 1 (metres)
  floor: 0.005,        // the bowl's inner floor, where the candle stands. The water's surface is y = 0: the floor is
                       // kept just above it, or the water's sheet would show inside the bowl
  waxTop: 0.046,       // top of a full-height candle
  waxR: 0.021,
  wick: 0.0075,        // how far the wick stands above the wax
};
/** The wick's tip in the bowl's own space, for a candle burned down to `h` (0.45 .. 1). */
export const wickY = (h) => BOWL.floor + (BOWL.waxTop + BOWL.wick * 0.6 - BOWL.floor) * h;

// The flicker every part shares, so a bowl's glow keeps time with its flame.
export const FLICK = /* glsl */`
float flick( float t, float seed ) {
  float a = sin( t * 9.1 + seed * 31.0 ) * 0.5 + sin( t * 15.7 + seed * 57.0 ) * 0.3 + sin( t * 23.3 + seed * 91.0 ) * 0.2;
  float flutter = smoothstep( 0.55, 0.9, sin( t * 0.7 + seed * 12.0 ) * 0.5 + 0.5 );
  return 1.0 + a * ( 0.035 + 0.11 * flutter );
}
`;

/**
 * Turn a profile [[r, y], ...] round the y axis. kind marks the part: 0 bowl outside, 1 bowl inside, 2 wax, 3 wick.
 * `pick` (indices into the profile) leaves points out: the surface is then turned through the picked points only,
 * but each keeps the normal it has on the whole profile, so a plainer mesh is shaded like the fine one.
 * A point that lies on the axis is one vertex and closes the surface with a fan (no wasted triangles).
 */
function lathe(out, profile, segs, kind, pick = null) {
  const n = profile.length, rings = [];
  let len = 0; const along = [0];
  for (let i = 1; i < n; i++) { len += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]); along.push(len); }
  for (let j = 0, m = pick ? pick.length : n; j < m; j++) {
    const i = pick ? pick[j] : j, a = profile[Math.max(0, i - 1)], b = profile[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nr = ty, ny = -tx;                                            // to the right of the direction of travel
    const axis = profile[i][0] < 1e-9;
    rings.push({ base: out.pos.length / 3, axis });
    if (axis) { out.pos.push(0, profile[i][1], 0); out.nor.push(0, ny < 0 ? -1 : 1, 0); out.uv.push(0.5, along[i] / (len || 1)); out.kind.push(kind); continue; }
    for (let s = 0; s <= segs; s++) {
      const ang = (s / segs) * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang);
      out.pos.push(profile[i][0] * c, profile[i][1], profile[i][0] * sn);
      out.nor.push(nr * c, ny, nr * sn);
      out.uv.push(s / segs, along[i] / (len || 1));
      out.kind.push(kind);
    }
  }
  for (let j = 0; j < rings.length - 1; j++) {
    const A = rings[j], B = rings[j + 1];
    if (A.axis && B.axis) continue;
    for (let s = 0; s < segs; s++) {
      const p0 = A.axis ? A.base : A.base + s, p1 = A.axis ? A.base : p0 + 1, p2 = B.axis ? B.base : B.base + s, p3 = B.axis ? B.base : p2 + 1;
      if (A.axis) out.idx.push(p1, p2, p3); else if (B.axis) out.idx.push(p0, p2, p1); else out.idx.push(p0, p2, p1, p1, p2, p3);
    }
  }
}

// The parts of a bowl with its candle, each a profile travelled so that its outside is to the right, and its kind.
// The flat underside is not modelled at all: it faces the floor, under water.
const B_ = BOWL, F_ = B_.floor, R_ = B_.waxR, T_ = B_.waxTop;
const PARTS = {
  hull: [0, [[0.045, -0.045], [0.080, -0.031], [0.102, -0.009], [0.118, 0.018], [0.1255, 0.0355]]],                              // from under the water up to the rim
  lip: [0, [[0.1255, 0.0355], [0.1245, 0.0382], [0.1205, 0.0392], [0.1168, 0.0380], [0.1160, 0.0355]]],
  inside: [1, [[0.1160, 0.0355], [0.1085, 0.0255], [0.095, 0.0155], [0.072, 0.0085], [0.040, F_ + 0.0008], [0, F_]]],            // from the rim down to the middle
  waxSide: [2, [[R_ * 1.04, F_], [R_, F_ + 0.004], [R_, T_ - 0.0012], [R_ * 0.93, T_]]],
  waxTop: [2, [[R_ * 0.93, T_], [R_ * 0.7, T_ - 0.0016], [R_ * 0.3, T_ - 0.0028], [0, T_ - 0.003]]],                             // the melted top with a shallow pool
  wick: [3, [[0.0012, T_ - 0.003], [0.0012, T_ + B_.wick], [0, T_ + B_.wick + 0.0006]]],
};
// The bowl at every fineness it is drawn with: [part, sides, which points of its profile (all if left out)].
// A candle a few metres away is a few dozen pixels wide and one far down the nave a handful, so it is turned with
// fewer sides through fewer points the smaller it is drawn; src/world/candles.js picks the level for each candle,
// each frame, by its size in the picture. The mirror's own shapes hold only what a mirror lying in the water can
// show of a floating bowl: its outside (the inside, the lip's top and the candle's top face away from it).
const LEVELS = {
  hero: [['hull', 48], ['lip', 48], ['inside', 48], ['waxSide', 24], ['waxTop', 24], ['wick', 8]],                             // 1488 triangles: the few nearest the camera
  near: [['hull', 16], ['lip', 16, [0, 2, 4]], ['inside', 16, [0, 1, 2, 3, 5]], ['waxSide', 8, [0, 2, 3]], ['waxTop', 8, [0, 2, 3]], ['wick', 4]],   // 372: a few dozen pixels wide
  mid: [['hull', 12, [1, 3, 4]], ['lip', 12, [0, 2, 4]], ['inside', 12, [0, 2, 4, 5]], ['waxSide', 6, [0, 3]], ['waxTop', 6, [0, 3]]],                // 174: one or two dozen pixels (the flame's quad draws the wick's glow and ember)
  far: [['hull', 6, [1, 4]], ['lip', 6, [0, 4]], ['inside', 6, [0, 3, 5]], ['waxSide', 4, [0, 3]], ['waxTop', 4, [0, 3]]],                           // 54: a handful of pixels
  'mirror-hero': [['hull', 24], ['lip', 24, [0, 1, 2]], ['waxSide', 8, [1, 2, 3]], ['wick', 4, [0, 1]]],                       // 328
  'mirror-near': [['hull', 12, [1, 2, 3, 4]], ['lip', 12, [0, 2]]],                                                            // 96
  'mirror-mid': [['hull', 8, [1, 3, 4]]],                                                                                       // 32 (the far ones are not in the mirror: a band a pixel high under a flame's image)
};

/** The bowl with its candle at one level of fineness: 'hero' | 'near' | 'mid' | 'far' | 'mirror-hero' | 'mirror-near' | 'mirror-mid'. */
export function makeBowlGeometry(level = 'near') {
  const o = { pos: [], nor: [], uv: [], kind: [], idx: [] };
  for (const [part, sides, pick] of LEVELS[level] || LEVELS.near) lathe(o, PARTS[part][1], sides, PARTS[part][0], pick || null);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(o.kind, 1));
  g.setIndex(o.idx);
  g.userData.triangles = o.idx.length / 3;
  return g;
}

/**
 * A lid nobody sees. The water is one flat sheet, and a bowl that a ring pushes down would show that sheet inside it.
 * So each bowl carries an invisible disc just under its rim that writes depth only: the sheet is hidden behind it.
 */
export const LID_Y = 0.026;
export function makeLidGeometry(segs = 16) {
  const g = new THREE.CircleGeometry(0.1088, segs); g.rotateX(-Math.PI / 2); g.translate(0, LID_Y, 0);
  return g;
}
export function makeLidMaterial() {
  const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, fog: false }); m.name = 'candle-lid';
  return m;
}

/** The bowl-and-candle material. u: { uTime, uGlow } shared uniform objects. */
export function makeBowlMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.35 });
  m.name = 'candle-bowl';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aKind;
attribute vec4 aState;      // burning 0..1, ember 0..1, how tall the candle still is, seed
attribute vec4 aLook;       // tone of the brass, the wick's height in the bowl's space, -, -
varying float vKind;
varying vec4 vState;
varying vec4 vLook;
varying vec3 vLocalP;
varying vec3 vLocalN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	if ( aKind > 1.5 ) transformed.y = ${BOWL.floor.toFixed(4)} + ( transformed.y - ( ${BOWL.floor.toFixed(4)} ) ) * aState.z;
	vKind = aKind; vState = aState; vLook = aLook; vLocalP = transformed; vLocalN = objectNormal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec3 uGlow;         // inside glow, wax glow, ember
varying float vKind;
varying vec4 vState;
varying vec4 vLook;
varying vec3 vLocalP;
varying vec3 vLocalN;
${FLICK}
float cHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float cNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( cHash( i ), cHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( cHash( i + vec2( 0.0, 1.0 ) ), cHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// height of the surface's small relief, in metres: hammer marks all over the bowl, a chased band under the rim
float cRelief( vec3 p, float kind ) {
  float ang = atan( p.z, p.x ), rad = length( p.xz );
  vec2 q = vec2( ang * 9.0, rad * 110.0 + p.y * 140.0 );
  float hammer = cNoise( q * 1.7 + vState.w * 40.0 ) * 0.6 + cNoise( q * 4.3 ) * 0.4;
  float band = smoothstep( 0.012, 0.016, p.y ) * ( 1.0 - smoothstep( 0.026, 0.030, p.y ) ) * step( kind, 0.5 );
  float chase = abs( sin( ang * 14.0 ) ) * abs( sin( ang * 14.0 + ( p.y - 0.021 ) * 520.0 ) );
  return hammer * 0.00045 - band * ( 0.0004 + 0.0007 * chase );
}
vec3 cBump( vec3 n, vec3 vp, float h ) {
  vec3 dpdx = dFdx( vp ), dpdy = dFdy( vp );
  float dhdx = dFdx( h ), dhdy = dFdy( h );
  vec3 r1 = cross( dpdy, n ), r2 = cross( n, dpdx );
  float det = dot( dpdx, r1 );
  return normalize( abs( det ) * n - sign( det ) * ( dhdx * r1 + dhdy * r2 ) );
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	float cBowl = step( vKind, 1.5 ), cWax = step( 1.5, vKind ) * step( vKind, 2.5 ), cWick = step( 2.5, vKind );
	float cTarnish = cNoise( vec2( atan( vLocalP.z, vLocalP.x ) * 3.0 + vState.w * 17.0, vLocalP.y * 90.0 + length( vLocalP.xz ) * 30.0 ) );
	vec3 cBrass = mix( vec3( 0.83, 0.61, 0.30 ), vec3( 0.55, 0.42, 0.24 ), clamp( vLook.x * 0.7 + cTarnish * 0.45, 0.0, 1.0 ) );
	diffuseColor.rgb = cBowl * cBrass + cWax * vec3( 0.84, 0.78, 0.64 ) + cWick * vec3( 0.03, 0.025, 0.02 );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor = cBowl;
	roughnessFactor = cBowl * ( 0.26 + 0.3 * cTarnish ) + cWax * 0.48 + cWick * 0.95;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
	if ( cBowl > 0.5 ) normal = cBump( normal, - vViewPosition, cRelief( vLocalP, vKind ) );`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	{
		// the bowl's own flame: a small warm light at the wick, worked out in the bowl's own space
		vec3 cL = vec3( 0.0, vLook.y + 0.012, 0.0 ) - vLocalP;
		float cD2 = dot( cL, cL );
		float cNdl = max( dot( normalize( vLocalN ), cL * inversesqrt( cD2 ) ), 0.0 );
		float cBurn = vState.x * flick( uTime, vState.w );
		float cFall = 1.0 / ( 1.0 + cD2 * 420.0 );
		vec3 cWarm = vec3( 1.0, 0.55, 0.19 );
		totalEmissiveRadiance += cWarm * ( cBurn * cNdl * cFall * uGlow.x ) * ( cBowl * cBrass * 1.25 + cWax * vec3( 0.62, 0.52, 0.36 ) );
		// wax lets the flame's light through near the top
		totalEmissiveRadiance += cWax * vec3( 1.0, 0.5, 0.17 ) * ( cBurn * uGlow.y * ( exp( - max( vLook.y - 0.004 - vLocalP.y, 0.0 ) * 60.0 ) + 0.12 ) );
		// the wick: white hot in the flame, a dying ember after it
		totalEmissiveRadiance += cWick * ( vec3( 1.0, 0.62, 0.3 ) * cBurn * 2.5 + vec3( 1.0, 0.22, 0.03 ) * vState.y * uGlow.z );
	}`);
  };
  m.customProgramCacheKey = () => 'evensong-candle-bowl-2';
  return m;
}

// ---------------------------------------------------------------------------------------------------- the flame

// How much of a light the air between it and the eye lets through. Flames are added to the picture, so they must be
// dimmed by the air but not have its colour added: three's fog chunk (whatever the renderer has made of it) is run
// on black and on white, and the difference is what gets through. Leaves the answer in `airThrough`.
const AIR_THROUGH = /* glsl */`
  vec3 airThrough = vec3( 1.0 );
  #ifdef USE_FOG
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    {
      #include <fog_fragment>
    }
    vec3 airAdds = gl_FragColor.rgb;
    gl_FragColor = vec4( 1.0 );
    {
      #include <fog_fragment>
    }
    airThrough = clamp( gl_FragColor.rgb - airAdds, 0.0, 1.0 );
  #endif
`;

const FLAME_VERT = /* glsl */`
attribute vec3 aPos;        // the wick's tip, in the world
attribute vec4 aFlame;      // burning 0..1, flare 0..1 (just relit), ember 0..1, seed
attribute vec4 aLean;       // the tip's lean in the world (x, z, in flame heights), size, gust 0..1
uniform float uTime;
uniform float uViewH;       // height of the picture being drawn, in pixels
uniform vec2 uSize;         // a flame's width and height (metres)
uniform float uGlowR;       // radius of the soft light round a flame (metres)
varying vec2 vP;            // metres from the wick, in the flame's own plane
varying vec4 vDim;          // width, height, lean (metres at the tip), brightness
varying vec4 vF;
#include <fog_pars_vertex>
${FLICK}
void main() {
  float burn = aFlame.x, seed = aFlame.w;
  float f = flick( uTime, seed );
  float gust = aLean.w;
  // a gust flattens and shakes the flame before it goes
  float shake = gust * ( sin( uTime * 47.0 + seed * 80.0 ) * 0.5 + sin( uTime * 71.0 + seed * 33.0 ) * 0.5 );
  float h = uSize.y * aLean.z * ( 0.3 + 0.7 * burn ) * ( 1.0 + 0.55 * aFlame.y ) * ( 1.0 + ( f - 1.0 ) * 1.6 ) * ( 1.0 - 0.3 * gust );
  float w = uSize.x * aLean.z * ( 0.55 + 0.45 * burn ) * ( 1.0 + 0.3 * aFlame.y ) * ( 1.0 + 0.25 * gust );
  float glow = uGlowR * aLean.z * ( 1.0 + 0.4 * aFlame.y );
  vec3 toCam = normalize( cameraPosition - aPos );
  vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) + vec3( 1e-5, 0.0, 0.0 ) );
  // a flame stands upright; seen from above the quad turns to face the eye instead of vanishing edge-on
  vec3 up = normalize( mix( vec3( 0.0, 1.0, 0.0 ), cross( toCam, right ), smoothstep( 0.55, 0.95, abs( toCam.y ) ) ) );
  // far away a flame is smaller than a pixel: hold it at a couple of pixels and dim it to match, so it does not sparkle
  vec4 clipC = projectionMatrix * viewMatrix * vec4( aPos, 1.0 );
  float px = h * projectionMatrix[1][1] * 0.5 * uViewH / max( clipC.w, 1e-3 );
  float boost = clamp( 2.6 / max( px, 1e-3 ), 1.0, 8.0 );
  h *= boost; w *= boost; glow *= mix( 1.0, boost, 0.5 );
  float lean = dot( vec3( aLean.x, 0.0, aLean.y ), right ) * h + shake * 0.25 * h;
  // the quad covers the flame and its soft light
  float reach = max( glow, max( h, abs( lean ) + w ) ) * 1.05;
  vec2 q = position.xy * reach + vec2( 0.0, h * 0.4 );
  vP = q;
  vDim = vec4( w, h, lean, ( 0.75 + 0.25 * f ) / ( boost * boost ) );
  vF = aFlame;
  vec4 mvPosition = viewMatrix * vec4( aPos + right * q.x + up * q.y, 1.0 );
  #include <fog_vertex>
  float show = step( 0.004, burn ) + step( 0.004, aFlame.z );
  gl_Position = show > 0.0 ? projectionMatrix * mvPosition : vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

const FLAME_FRAG = /* glsl */`
uniform vec3 uPower;        // brightness of the flame's body, of its soft light, of the ember
uniform float uGlowR;
varying vec2 vP;
varying vec4 vDim;
varying vec4 vF;
#include <fog_pars_fragment>
void main() {
  float w = vDim.x, h = vDim.y, burn = vF.x;
  float y = vP.y / max( h, 1e-4 );                                    // 0 at the wick, 1 at the tip
  float yy = clamp( y, 0.0, 1.0 );
  float x = ( vP.x - vDim.z * yy * yy ) / ( w * 0.5 );
  // the flame's outline: a teardrop, widest a third of the way up
  float r = 1.92 * pow( yy, 0.42 ) * pow( 1.0 - yy, 0.78 ) + 1e-4;
  float d = abs( x ) / r;
  float inside = step( 0.0, y ) * step( y, 1.0 );
  float body = ( 1.0 - smoothstep( 0.5, 1.0, d ) ) * inside;
  float core = ( 1.0 - smoothstep( 0.0, 0.8, d ) ) * inside;
  // colour: a dim blue cup at the wick, white-gold through the middle, deep orange at the edge and the tip
  vec3 col = mix( vec3( 1.0, 0.42, 0.09 ), vec3( 1.0, 0.80, 0.50 ), core * ( 1.0 - 0.55 * yy ) );
  float cup = 1.0 - smoothstep( 0.02, 0.24, yy );
  col = mix( col, vec3( 0.10, 0.22, 0.85 ), cup * 0.9 );
  float lum = body * mix( 0.45, 1.0, core ) * mix( 1.0, 0.16, cup ) * ( 1.0 - 0.35 * smoothstep( 0.6, 1.0, yy ) );
  vec3 c = col * ( lum * uPower.x * burn );
  // the soft light round it
  vec2 g = vP - vec2( vDim.z * 0.3, h * 0.42 );
  float halo = exp( - dot( g, g ) / ( uGlowR * uGlowR * 0.16 ) );
  c += vec3( 1.0, 0.52, 0.2 ) * ( halo * uPower.y * burn );
  // the ember left on the wick
  float e = exp( - dot( vP, vP ) / ( 0.0035 * 0.0035 * 4.0 ) );
  c += vec3( 1.0, 0.24, 0.04 ) * ( e * uPower.z * vF.z * ( 1.0 - burn ) );
${AIR_THROUGH}
  gl_FragColor = vec4( c * vDim.w * airThrough, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The uniforms three's fog needs (and whatever the renderer added to them), beside our own shared ones. */
const withFog = (u) => Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), u);

/** u: { uTime, uViewH, uSize, uGlowR, uPower } */
export function makeFlameMaterial(u) {
  return new THREE.ShaderMaterial({
    name: 'candle-flame', uniforms: withFog(u), vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, fog: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  });
}

/** One quad per candle, [-1,1] x [-1,1], with the per-candle attributes the flame and the smoke read. */
export function makeQuads(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = count;
  return g;
}

/**
 * One strip per candle for its streak on the water: [-1,1] across, [-1,1] along in `parts` pieces. The streak's
 * sheet widens along its length; in pieces, what is laid across it (the fade toward its sides) stays straight.
 */
export function makeStrips(count, parts = 4) {
  const g = new THREE.InstancedBufferGeometry(), pos = [], idx = [];
  for (let k = 0; k <= parts; k++) { const y = -1 + (2 * k) / parts; pos.push(-1, y, 0, 1, y, 0); }
  for (let k = 0; k < parts; k++) { const a = k * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = count;
  return g;
}

// ------------------------------------------------------------------------------------------- the flame on the water

// The mirror shows each flame's image, exact and small. Water is never quite that smooth: round the image lies a
// streak of the flame's light, drawn out toward the eye. It is the flame's highlight on slightly rough water, worked
// out for one light at a time on a small sheet laid on the surface where that highlight falls: for every point of
// it, the tilt a facet there would need to send the flame to the eye, against the tilt the ripple field really has
// (so a ring passing through breaks the streak) and the fine roughness nobody draws.
const GLITTER_VERT = /* glsl */`
attribute vec3 aPos;
attribute vec4 aFlame;
attribute vec4 aLean;
uniform float uTime;
uniform float uWaterY;
uniform vec4 uGlitter;      // strength, roughness (slope), a flame's radiant power, 1 = sheets as wide as they used to be (dev)
varying vec3 vWorld;
varying vec4 vSrc;          // the flame's middle, and its power
varying vec4 vWin;          // across (-1..1), along (0..1), size of the bowl, how much the streak fades in from the flame's end
#include <fog_pars_vertex>
${FLICK}
void main() {
  float burn = aFlame.x, size = aLean.z;
  vec3 S = aPos + vec3( 0.0, 0.03 * size, 0.0 );
  float hs = max( S.y - uWaterY, 0.01 ), H = cameraPosition.y - uWaterY;
  vec2 d = cameraPosition.xz - S.xz;
  float L = max( length( d ), 1e-3 );
  vec2 dir = d / L;
  // where a flat mirror would show the flame, measured from under it toward the eye; the streak lies along that line
  float xs = L * hs / ( max( H, 0.05 ) + hs );
  float t0 = max( 0.1 * size, xs * 0.3 ), t1 = min( xs * 5.0 + 0.4, L * 0.9 );
  float along = position.y * 0.5 + 0.5;
  float t = mix( t0, t1, along );
  // How wide the streak can be there. A facet this far to the side of the line would have to lean sideways by its
  // offset over 'lat' to send the flame to the eye; a few times the water's roughness beyond that (and what a ring
  // can add) nothing comes back, so the sheet ends there. Seen at a glance along the water that is a fraction of
  // the distance from the flame: the sheet is a third to a sixth as wide as one sized by that distance, and these
  // sheets, hundreds of them overlapping, were most of what the candles cost to draw.
  float ds = length( vec2( t, hs ) ), dc = length( vec2( L - t, H ) );
  float lat = ( hs * dc + max( H, 0.05 ) * ds ) / ( dc + ds );
  float wide = 0.02 + ( 3.6 * uGlitter.y + 0.2 ) * lat;                // (0.2: a ring's slope moves the highlight sideways by that share of 'lat' and it must still be on the sheet)
  if ( uGlitter.w > 0.5 ) wide = 0.03 + 4.5 * uGlitter.y * t;         // dev (&candles=wide:1): as wide as they used to be, to measure what the narrowing saves
  vec3 world = vec3( S.x + dir.x * t - dir.y * position.x * wide, uWaterY + 0.004, S.z + dir.y * t + dir.x * position.x * wide );
  vWorld = world;
  vSrc = vec4( S, burn * flick( uTime, aFlame.w ) * uGlitter.z * size * size );
  // (The streak has always faded in from the flame's end: when the sheet was a wide fan, the fade across it, laid
  // over its two triangles, came out as this fade along its middle. It is part of the look, so it is kept, exactly.)
  vWin = vec4( position.x, along, size, 1.0 - ( 0.03 + 4.5 * uGlitter.y * t0 ) / ( 0.03 + 4.5 * uGlitter.y * t1 ) );
  vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
  #include <fog_vertex>
  gl_Position = ( burn > 0.004 && H > 0.05 && t1 > t0 ) ? projectionMatrix * mvPosition : vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;
const GLITTER_FRAG = /* glsl */`
uniform sampler2D tRipple;
uniform vec4 uField;        // the ripple field: x0, z0, 1/width, 1/depth
uniform vec4 uOptics;       // the water's: mirror head-on, Fresnel power, -, -
uniform vec4 uGlitter;
uniform float uRings;
varying vec3 vWorld;
varying vec4 vSrc;
varying vec4 vWin;
#include <fog_pars_fragment>
void main() {
  vec3 toS = vSrc.xyz - vWorld, toC = cameraPosition - vWorld;
  float ds = length( toS ), dc = length( toC );
  vec3 hv = normalize( toS / ds + toC / dc );
  vec2 need = - hv.xz / max( hv.y, 1e-3 );                              // the slope a facet here must have
  vec2 uv = ( vWorld.xz - uField.xy ) * uField.zw;
  vec2 inField = step( vec2( 0.0 ), uv ) * step( uv, vec2( 1.0 ) );
  vec2 have = texture2D( tRipple, uv ).xy * ( inField.x * inField.y * uRings );
  vec2 e = need - have;
  float r = uGlitter.y;
  float facets = exp( - dot( e, e ) / ( 2.0 * r * r ) ) / ( 6.2832 * r * r );
  float cosV = clamp( dot( hv, toC / dc ), 0.0, 1.0 );
  float fres = uOptics.x + ( 1.0 - uOptics.x ) * pow( 1.0 - cosV, uOptics.y );
  float rim = smoothstep( 0.15, 0.27, length( toS.xz ) / vWin.z );         // the bowl's own rim hides the flame from the water beside it
  float fadeIn = vWin.w * ( 1.0 - vWin.y );
  float window = ( 1.0 - vWin.x * vWin.x * vWin.x * vWin.x ) * ( 1.0 - fadeIn * fadeIn ) * smoothstep( 0.0, 0.08, vWin.y ) * ( 1.0 - smoothstep( 0.75, 1.0, vWin.y ) );
  float radiance = fres * facets * vSrc.w / ( 4.0 * max( toC.y / dc, 0.04 ) * ds * ds ) * rim * window * uGlitter.x;
${AIR_THROUGH}
  gl_FragColor = vec4( vec3( 1.0, 0.62, 0.28 ) * min( radiance, 6.0 ) * airThrough, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** u: { uTime, uWaterY, uGlitter, tRipple, uField, uOptics, uRings } */
export function makeGlitterMaterial(u) {
  return new THREE.ShaderMaterial({
    name: 'candle-glitter', uniforms: withFog(u), vertexShader: GLITTER_VERT, fragmentShader: GLITTER_FRAG, fog: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  });
}

// ---------------------------------------------------------------------------------------------------- the smoke

const SMOKE_VERT = /* glsl */`
attribute vec3 aPos;
attribute vec4 aSmoke;      // age in seconds (negative: none), seed, lean x, lean z (metres at the top)
uniform vec2 uSmokeSize;    // width, height (metres)
varying vec2 vUv;
varying vec2 vAge;
#include <fog_pars_vertex>
void main() {
  float age = aSmoke.x;
  vec3 toCam = normalize( cameraPosition - aPos );
  vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) + vec3( 1e-5, 0.0, 0.0 ) );
  vec2 q = vec2( position.x, position.y * 0.5 + 0.5 );                // x -1..1, y 0..1
  float tall = uSmokeSize.y * ( 0.75 + 0.5 * aSmoke.y );
  vec3 world = aPos + right * ( q.x * uSmokeSize.x ) + vec3( 0.0, q.y * tall, 0.0 ) + vec3( aSmoke.z, 0.0, aSmoke.w ) * ( q.y * q.y );
  vUv = q; vAge = vec2( age, aSmoke.y );
  vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
  #include <fog_vertex>
  gl_Position = age >= 0.0 ? projectionMatrix * mvPosition : vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;
const SMOKE_FRAG = /* glsl */`
uniform vec3 uSmokeColor;
uniform float uSmokeLife;
varying vec2 vUv;
varying vec2 vAge;
#include <fog_pars_fragment>
void main() {
  float age = vAge.x, seed = vAge.y, y = vUv.y;
  // a thread that climbs, wavers more the higher it gets, spreads and thins out
  float rise = age * ( 0.34 + 0.2 * seed );                            // how high the head of the thread has climbed (0..1 of the quad)
  float wav = sin( y * 7.0 - age * 2.6 + seed * 40.0 ) * 0.34 + sin( y * 17.0 - age * 4.7 + seed * 13.0 ) * 0.13 + sin( y * 2.9 + age * 1.3 + seed * 7.0 ) * 0.3;
  float cx = wav * y * ( 0.35 + y );
  float width = 0.018 + 0.2 * y * y + 0.04 * age * y;
  float thread = 1.0 - smoothstep( width * 0.2, width, abs( vUv.x - cx ) );
  float head = 1.0 - smoothstep( rise - 0.25, rise, y );
  float tail = smoothstep( 0.0, 0.04, y ) * ( 1.0 - 0.8 * y );
  float fade = ( 1.0 - smoothstep( uSmokeLife * 0.35, uSmokeLife, age ) ) * smoothstep( 0.0, 0.15, age );
  float a = thread * thread * head * tail * fade * 0.4;
  gl_FragColor = vec4( uSmokeColor, a );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** u: { uSmokeSize, uSmokeColor, uSmokeLife } */
export function makeSmokeMaterial(u) {
  return new THREE.ShaderMaterial({
    name: 'candle-smoke', uniforms: withFog(u), vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, fog: true,
    blending: THREE.NormalBlending, depthWrite: false, depthTest: true, transparent: true,
  });
}
