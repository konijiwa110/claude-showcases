// The look of the water's surface: three's physical material with its inside replaced.
//
// It stays a built-in material so the renderer's fog, lights and shadows reach it like everything else; what it
// computes is its own:
//   - the surface's tilt: the ripple field's slope, plus a slow slight swell and a faint fine ripple made here;
//   - the reflection: the mirror's picture, looked up where the tilted surface would see it. The mirror's depth says
//     how far away the reflected thing is, so a reflection stays attached at the foot of whatever casts it;
//   - a dark mirror by Fresnel: head-on the water lets a share of the floor through (ordinary blending with what is
//     already drawn underneath), at a glancing angle it is all mirror;
//   - a darker line where water meets stone, a boot or a candle's bowl;
//   - every light's gleam on tilted water: for each light the renderer feeds this material (the moon with its
//     shadow, the candle lights, the lantern, her light, flashes), the difference between what the tilted surface and
//     the flat one would catch. Flat water adds nothing (the mirror already shows it), rings catch the moon.
import * as THREE from 'three';

// The still water's own motion: [direction in degrees, wavelength m, period s, weight]. The first four are the
// swell ("breathing"), the rest a fine ripple that comes and goes in patches and fades out with distance.
const SWELL = [[37, 6.8, 19, 1.0], [118, 4.6, 15, 0.85], [163, 3.1, 12, 0.7], [74, 2.15, 9.5, 0.55]];
const FINE = [[21, 1.31, 7.1, 0.9], [97, 0.83, 5.6, 0.8], [149, 0.52, 4.3, 0.6], [58, 0.33, 3.4, 0.35], [128, 0.21, 2.7, 0.2]];
const f = (x) => { const s = (+x).toFixed(5); return s.includes('.') ? s : s + '.0'; };
function waveLines(list, amp, fade) {
  return list.map(([deg, len, period, weight], i) => {
    const a = (deg * Math.PI) / 180, k = (2 * Math.PI) / len, dx = Math.cos(a), dz = Math.sin(a);
    const fadeBy = fade ? ` * (1.0 - smoothstep(0.18, 0.6, fp / ${f(len)}))` : '';
    return `  s += vec2(${f(dx)}, ${f(dz)}) * (${amp} * ${f(weight)}${fadeBy}) * cos(dot(q, vec2(${f(dx * k)}, ${f(dz * k)})) - t * ${f((2 * Math.PI) / period)} + ${f(i * 1.7 + (fade ? 0.6 : 0))});`;
  }).join('\n');
}

const PARS = /* glsl */`
uniform sampler2D tMirror;
uniform highp sampler2D tMirrorDepth;
uniform sampler2D tRipple;
uniform mat4 uMirrorVP;
uniform mat4 uMirrorInvVP;
uniform vec2 uDepthMap;       // depth texel -> clip-space z
uniform vec4 uField;          // the ripple field: x0, z0, 1/width, 1/depth
uniform float uTime;
uniform vec4 uOptics;         // mirror head-on, Fresnel power, share of the floor let through, contact line
uniform vec4 uStill;          // swell slope, fine ripple slope, gleam, rings
uniform vec4 uGloss;          // gleam: tight power, tight weight, wide power, wide weight
uniform vec3 uDeep;           // the water's own colour
uniform vec2 uContact;        // width of the contact line (m), width of the soft shade beyond it (m)
uniform vec4 uRing;           // rings: how little lean shows fully, how much of the far glow a leaning facet mirrors, and adds on top; how much the air's colour counts as that glow
varying vec3 vWaterPos;
vec3 wSheen;
vec3 wFlatNV;

// The still water's slope (dh/dx, dh/dz) at p: a swell too slow and slight to see as waves, and a fine ripple in
// drifting patches. fp is the size of this pixel on the water: detail finer than that is left out.
vec2 wStill( vec2 p, float t, float fp ) {
  vec2 q = p + 0.55 * vec2( sin( 0.19 * p.y + 0.043 * t ), sin( 0.16 * p.x - 0.037 * t + 1.7 ) );
  vec2 s = vec2( 0.0 );
${waveLines(SWELL, 'uStill.x', false)}
  float patches = 0.35 + 0.65 * smoothstep( -0.3, 0.6, sin( 0.131 * p.x + 0.07 * t ) * sin( 0.113 * p.y - 0.05 * t + 1.3 ) + 0.4 * sin( 0.047 * ( p.x + p.y ) + 0.021 * t ) );
  float fine = uStill.y * patches;
${waveLines(FINE, 'fine', true)}
  return s;
}

// One light on the water: what the tilted surface catches of it beyond what flat water would (the mirror has that).
void RE_Direct_Water( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 wH = normalize( directLight.direction + geometryViewDir );
  float a = max( dot( geometryNormal, wH ), 0.0 ), b = max( dot( wFlatNV, wH ), 0.0 );
  wSheen += directLight.color * ( max( pow( a, uGloss.x ) - pow( b, uGloss.x ), 0.0 ) * uGloss.y + max( pow( a, uGloss.z ) - pow( b, uGloss.z ), 0.0 ) * uGloss.w );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Water
#undef RE_IndirectDiffuse
#undef RE_IndirectSpecular
`;

const SURFACE = /* glsl */`
  wFlatNV = normal;
  wSheen = vec3( 0.0 );
  vec3 wPos = vWaterPos;
  vec3 wToCam = cameraPosition - wPos;
  float wDist = length( wToCam );
  vec3 wV = wToCam / wDist;
  float wFoot = max( length( dFdx( wPos.xz ) ), length( dFdy( wPos.xz ) ) );
  vec2 wUv = ( wPos.xz - uField.xy ) * uField.zw;
  vec2 wIn = smoothstep( vec2( 0.0 ), vec2( 0.015 ), wUv ) * smoothstep( vec2( 0.0 ), vec2( 0.015 ), 1.0 - wUv );
  vec2 wSlope = texture2D( tRipple, wUv ).xy * ( wIn.x * wIn.y * uStill.w ) + wStill( wPos.xz, uTime, wFoot );
  vec3 wN = normalize( vec3( - wSlope.x, 1.0, - wSlope.y ) );
  normal = normalize( ( viewMatrix * vec4( wN, 0.0 ) ).xyz );

  // the mirror: where this spot of water shows up in it, and how far beyond the water the reflected thing is
  vec4 wClip = uMirrorVP * vec4( wPos, 1.0 );
  vec2 wUv0 = wClip.xy / wClip.w * 0.5 + 0.5;
  float wDepth = texture2D( tMirrorDepth, wUv0 ).r;
  vec4 wHit = uMirrorInvVP * vec4( wUv0 * 2.0 - 1.0, wDepth * uDepthMap.x + uDepthMap.y, 1.0 );
  float wReach = min( distance( wHit.xyz / max( wHit.w, 1e-6 ), wPos ), 400.0 );
  // the tilted surface sees along a turned ray: find where that ray's far end sits in the mirror's picture
  vec3 wR = reflect( - wV, wN );
  wR.y = max( wR.y, 0.012 );
  vec4 wClip1 = uMirrorVP * vec4( wPos + normalize( wR ) * wReach, 1.0 );
  vec2 wUv1 = clamp( wClip1.xy / max( wClip1.w, 1e-6 ) * 0.5 + 0.5, vec2( 0.002 ), vec2( 0.998 ) );
  // read through the mirror's mipmaps: a little soft always (it smooths the mirror's edges), softer where the water is rough
  float wRough = min( length( wSlope ) * 9.0, 2.5 );
  vec3 wMirror = textureLod( tMirror, wUv1, 0.6 + wRough ).rgb;
  // The near side of a ring leans toward the eye and mirrors what lies low over the water far beyond it: the glow of
  // the mist and the candles there. That is what makes a ring readable on black water.
  vec2 wAway = - normalize( wV.xz );
  vec4 wClipL = uMirrorVP * vec4( wPos + vec3( wAway.x, 0.025, wAway.y ) * 40.0, 1.0 );
  vec3 wLow = textureLod( tMirror, clamp( wClipL.xy / max( wClipL.w, 1e-6 ) * 0.5 + 0.5, vec2( 0.02 ), vec2( 0.98 ) ), 5.0 ).rgb;
  // (looking steeply down, the far water is out of the mirror's picture: the colour of the air stands in for it)
  #ifdef USE_FOG
    wLow = max( wLow, fogColor * uRing.w );
  #else
    wLow = max( wLow, vec3( 0.02, 0.03, 0.055 ) * uRing.w );
  #endif
  float wLean = clamp( ( dot( wSlope, wAway ) - 0.012 ) * uRing.x, 0.0, 1.0 );
`;

const COMPOSE = /* glsl */`
  float wCos = clamp( dot( wN, wV ), 0.0, 1.0 );
  float wF = uOptics.x + ( 1.0 - uOptics.x ) * pow( 1.0 - wCos, uOptics.y );
  // where the water meets something, the thing it mirrors is right there
  float wShade = 1.0 - uOptics.w * ( 0.65 * ( 1.0 - smoothstep( 0.0, uContact.x, wReach ) ) + 0.35 * ( 1.0 - smoothstep( 0.0, uContact.y, wReach ) ) );
  vec3 wOut = max( mix( wMirror, max( wMirror, wLow * uRing.y ), wLean ) * wF * wShade + wSheen * ( uStill.z * mix( 0.3, 1.0, wF ) ) + wLow * ( wLean * uRing.z ) + uDeep * ( 1.0 - wF ), vec3( 0.0 ) );
  float wAlpha = 1.0 - uOptics.z * ( 1.0 - wF ) * ( 1.0 - wF ) * wShade;      // the floor shows under the eye, hardly at all at a glance
  outgoingLight = wOut / wAlpha;
  diffuseColor.a = wAlpha;
`;

/**
 * @param u the uniforms (shared objects: change their .value and the water follows)
 */
export function makeWaterMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.2, metalness: 0, transparent: true, premultipliedAlpha: true, depthWrite: false });
  m.envMapIntensity = 0; m.name = 'water';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvWaterPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + PARS)
      .replace('#include <normal_fragment_maps>', SURFACE)
      .replace('#include <opaque_fragment>', COMPOSE + '\n\t#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'evensong-water-6';
  return m;
}

export function waterUniforms() {
  return {
    tMirror: { value: null }, tMirrorDepth: { value: null }, tRipple: { value: null },
    uMirrorVP: { value: new THREE.Matrix4() }, uMirrorInvVP: { value: new THREE.Matrix4() }, uDepthMap: { value: new THREE.Vector2(2, -1) },
    uField: { value: new THREE.Vector4(0, 0, 1, 1) }, uTime: { value: 0 },
    uOptics: { value: new THREE.Vector4(0.12, 3.5, 0.07, 0.6) },
    uStill: { value: new THREE.Vector4(0.006, 0.004, 1.0, 1.0) },
    uGloss: { value: new THREE.Vector4(260, 0.9, 24, 0.12) },
    uDeep: { value: new THREE.Color(0.0028, 0.0046, 0.0085) },
    uContact: { value: new THREE.Vector2(0.05, 0.35) },
    uRing: { value: new THREE.Vector4(9, 1.6, 0.5, 2.0) },
  };
}
