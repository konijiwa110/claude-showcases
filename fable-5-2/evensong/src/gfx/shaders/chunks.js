// Changes to three's own shader chunks, made once for the whole page, so that EVERY built-in material (the
// cathedral, the water, the fighters, particles drawn with built-in materials) gets them without doing anything:
//
//   1. The air. three's fog becomes a height fog: a thin haze everywhere, thicker toward the water, and a low mist
//      lying on the water; it brightens toward the moon. Its numbers live in ONE typed array (AIR) that every
//      material shares (three copies uniform values that are typed arrays by reference when it clones a material's
//      uniforms, so writing the array once a frame moves every material together).
//   2. Shadows. three r186's PCF filter is five noisy taps; here it is a smooth nine-tap tent (hardware 2x2
//      comparisons, after Castano's "optimized PCF") with a receiver-plane depth bias, so the long shadows of a low
//      moon lie on the floor without noise or acne.
//   3. Point lights that do not reach a pixel are skipped (twelve lights, most of them out of range of most pixels):
//      a light that is off or out of reach costs a subtraction and a comparison, not its whole falloff, and its
//      shading is not worked out at all.
//   4. The candles' own light. Eight point lights cannot stand in for hundreds of flames, so every lit material also
//      gets a warm light from low down that is strongest at the water inside the nave and gone a few metres up: it is
//      what warms the pier bases, the fallen stones and the fighters' legs wherever candles float.
//   5. The fighters' key. The moon stands behind the Cantor and the hall's shadow lies over most of the floor, so the
//      side of a fighter that the player sees would live on ambient light alone. Whatever stands inside a fighter's
//      column (the body, and everything the wardrobe hangs on it, with no work on its owner's side) is also lit by
//      one soft light from over the camera's shoulder: the Cantor strongly (she is the lightest large shape in the
//      picture), the pilgrim a little (steel needs something to reflect). The floor and the water take none of it.
//   6. A point light is not a point: its falloff is 1 / (d^2 + r^2), so that a lantern a hand away from a cloak does
//      not bleach it, and her light (which stands for a fan of pipes eight metres across) does not bleach the pipes
//      it hangs among. r^2 is POINT_SIZE2 plus four hundred times the fraction of the light's `decay` (lights.js
//      gives each kind of light its size that way: 2.00175 is a light whose r^2 is 0.7 larger); the falloff itself
//      is always the inverse square.
//   7. The image-based light counts in full for reflections and only in part as diffuse light. Its picture of the
//      hall has no place in it (the same candle-lit floor is "seen" from the top of a wall as from a pier's base), so
//      what it adds as diffuse light is kept low and the light that does know where it is (the ambient with a
//      direction, the candles' light, the lamps) does the work; polished things still mirror the whole of it.
//
// scene.fog must be set for materials to compile with fog (Gfx sets a FogExp2 whose colour and density summarise
// the air for code that wants one number). A ShaderMaterial gets the air by having `fog: true`, merging
// THREE.UniformsLib.fog into its uniforms and including the four fog chunks; or see AIR_GLSL below to call the
// function itself.
import * as THREE from 'three';

/** How many vec4 the air takes. */
export const AIR_N = 16;
/**
 * The air, shared by every material and by the post chain (uniform vec4 evAir[AIR_N]):
 *   [0] haze colour rgb, haze density at the water (per metre)
 *   [1] mist colour rgb, mist density at the water
 *   [2] direction toward the moon xyz (world), height of the water
 *   [3] glow toward the moon rgb, density of the haze that is everywhere
 *   [4] 1 / haze height, 1 / mist height, the most the air may hide (0..1), time (s)
 *   [5] mood.candle, mood.gold, the distance from the eye at which the air begins to count (m), and at which it counts in full
 *   [6] the candles' light at the water rgb (already times the mood), 1 / the height over which it dies away (m)
 *   [7] half width and half length of where the candles float (m), how softly that ends (m), spare
 *   [8] the pilgrim's column: x, z of his axis (world), the height of his feet, his height (m)
 *   [9] the pilgrim's column: radius (m), strength of his key, spare, spare
 *   [10], [11] the same for the Cantor
 *   [12] the direction toward the fighters' key (world) xyz, spare
 *   [13] the colour of the Cantor's key rgb, how much of the image-based light's DIFFUSE part is left out (0..1)
 *   [14] the colour of the pilgrim's key rgb (he stays cool when her light turns gold), the pilgrim's ghost 0..1
 *        (the lens is too near him: he and all he wears fade plainly, see materials.js)
 *   [15] the ghost's column: the square of its radius round the pilgrim's axis (m2), how far from the lens it reaches (m), spare, spare
 * [2].xyz is the moon as SEEN (the disc's direction from the camera); the light and its shadows come along gfx.lights.moonDir.
 */
export const AIR = new Float32Array(AIR_N * 4);

/** GLSL: the air between two points. Needs `uniform vec4 evAir[AIR_N]`. Returns rgb = light the air adds, a = how much of what lies behind is left. */
export const AIR_GLSL = /* glsl */`
float evAirG( float y, float k ) { return sign( y ) * ( 1.0 - exp( - k * abs( y ) ) ) / k; }
// the optical depth of a layer whose density falls off as exp( -k * |height above the water| ), along a straight
// path of length dist from height y1 to height y2 (the mirror image under the water counts the same, so the
// water's reflection is fogged like the thing itself)
float evAirLayer( float k, float y1, float y2, float dist ) {
	float dy = y2 - y1;
	float m = abs( dy ) > 1e-3 ? ( evAirG( y2, k ) - evAirG( y1, k ) ) / dy : exp( - k * abs( 0.5 * ( y1 + y2 ) ) );
	return dist * m;
}
// x: optical depth of the haze, y: of the mist
vec2 evAirDepth( vec3 from, vec3 to ) {
	float dist = distance( from, to );
	float y1 = from.y - evAir[ 2 ].w, y2 = to.y - evAir[ 2 ].w;
	float haze = evAir[ 0 ].w * evAirLayer( max( evAir[ 4 ].x, 1e-4 ), y1, y2, dist ) + evAir[ 3 ].w * dist;
	float mist = evAir[ 1 ].w * evAirLayer( max( evAir[ 4 ].y, 1e-4 ), y1, y2, dist );
	return vec2( haze, mist );
}
vec4 evAirBetween( vec3 cam, vec3 world ) {
	vec2 tau = evAirDepth( cam, world );
	// the air close to the eye hardly counts: the near picture stays deep, the far one sinks into haze
	if ( evAir[ 5 ].w > 0.0 ) tau *= smoothstep( evAir[ 5 ].z, evAir[ 5 ].w, distance( cam, world ) );
	float sum = tau.x + tau.y;
	float amount = ( 1.0 - exp( - sum ) ) * evAir[ 4 ].z;
	vec3 col = ( evAir[ 0 ].rgb * tau.x + evAir[ 1 ].rgb * tau.y ) / max( sum, 1e-6 );
	vec3 dir = ( world - cam ) / max( distance( world, cam ), 1e-4 );
	float mu = max( dot( dir, evAir[ 2 ].xyz ), 0.0 );
	float mu2 = mu * mu, mu8 = mu2 * mu2 * mu2 * mu2;
	col += evAir[ 3 ].rgb * ( mu8 * 0.5 + mu8 * mu8 * mu8 * mu8 );
	return vec4( col * amount, 1.0 - amount );
}
`;

/**
 * GLSL to paste into a shader that wants the air: the uniform and the functions, each declared once however many
 * times this is pasted (three's fog and light chunks paste it too).
 */
export const AIR_DECL = /* glsl */`
#ifndef EV_AIR_DECLARED
	#define EV_AIR_DECLARED
	uniform vec4 evAir[ ${AIR_N} ];
#endif
#ifndef EV_AIR_FUNCTIONS
	#define EV_AIR_FUNCTIONS
	${AIR_GLSL}
#endif
`;

const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
#endif`;

// world position from the view position: right for any camera, the water's mirrored one included
const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif`;

const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${AIR_DECL}
#endif`;

const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	vec4 evAirHere = evAirBetween( ( - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix ), vFogWorld );
	gl_FragColor.rgb = gl_FragColor.rgb * evAirHere.a + evAirHere.rgb;
#endif`;

// A 5x5 tent from nine bilinear comparisons. evShadowSlope is the receiver's depth slope (d depth / d uv), so each
// tap compares against the depth the receiving surface would have there: a wide filter without acne on a floor the
// moon grazes.
const SHADOW_PCF = /* glsl */`
		vec2 evShadowSlope( vec3 sc ) {
			vec3 dx = dFdx( sc ), dy = dFdy( sc );
			float det = dx.x * dy.y - dx.y * dy.x;
			if ( abs( det ) < 1e-14 ) return vec2( 0.0 );
			return vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det;
		}
		float evShadowTap( sampler2DShadow map, vec2 base, vec2 off, float z, vec2 slope ) {
			return texture( map, vec3( base + off, z + clamp( dot( off, slope ), - 0.0025, 0.0025 ) ) );
		}
		float evShadowPCF( sampler2DShadow map, vec3 sc, vec2 size, float spread, vec2 slope ) {
			vec2 inv = 1.0 / size;
			vec2 uv = sc.xy * size;
			vec2 base = floor( uv + 0.5 );
			float s = uv.x + 0.5 - base.x, t = uv.y + 0.5 - base.y;
			base = ( base - 0.5 ) * inv;
			float uw0 = 4.0 - 3.0 * s, uw1 = 7.0, uw2 = 1.0 + 3.0 * s;
			float u0 = ( ( 3.0 - 2.0 * s ) / uw0 - 2.0 ) * spread, u1 = ( ( 3.0 + s ) / uw1 ) * spread, u2 = ( s / uw2 + 2.0 ) * spread;
			float vw0 = 4.0 - 3.0 * t, vw1 = 7.0, vw2 = 1.0 + 3.0 * t;
			float v0 = ( ( 3.0 - 2.0 * t ) / vw0 - 2.0 ) * spread, v1 = ( ( 3.0 + t ) / vw1 ) * spread, v2 = ( t / vw2 + 2.0 ) * spread;
			float sum = 0.0;
			sum += uw0 * vw0 * evShadowTap( map, base, vec2( u0, v0 ) * inv, sc.z, slope );
			sum += uw1 * vw0 * evShadowTap( map, base, vec2( u1, v0 ) * inv, sc.z, slope );
			sum += uw2 * vw0 * evShadowTap( map, base, vec2( u2, v0 ) * inv, sc.z, slope );
			sum += uw0 * vw1 * evShadowTap( map, base, vec2( u0, v1 ) * inv, sc.z, slope );
			sum += uw1 * vw1 * evShadowTap( map, base, vec2( u1, v1 ) * inv, sc.z, slope );
			sum += uw2 * vw1 * evShadowTap( map, base, vec2( u2, v1 ) * inv, sc.z, slope );
			sum += uw0 * vw2 * evShadowTap( map, base, vec2( u0, v2 ) * inv, sc.z, slope );
			sum += uw1 * vw2 * evShadowTap( map, base, vec2( u1, v2 ) * inv, sc.z, slope );
			sum += uw2 * vw2 * evShadowTap( map, base, vec2( u2, v2 ) * inv, sc.z, slope );
			return sum / 144.0;
		}
`;

const LIGHTS_DECL = /* glsl */`
#ifndef EV_AIR_DECLARED
	#define EV_AIR_DECLARED
	uniform vec4 evAir[ ${AIR_N} ];
#endif
`;
const LIGHTS_PARS = LIGHTS_DECL + /* glsl */`
// how much of a fighter's key reaches a point (world): all of it inside the fighter's column from the knee up to a
// little over the head, none at the water or outside the column
float evHeroWeight( vec3 p, vec4 a, vec4 b ) {
	vec2 d = p.xz - a.xy;
	float r = dot( d, d ) / max( b.x * b.x, 1e-4 );
	float y = p.y - a.z;
	return b.y * ( 1.0 - smoothstep( 0.56, 1.0, r ) ) * smoothstep( 0.1, 0.5, y ) * ( 1.0 - smoothstep( a.w * 1.12, a.w * 1.3 + 0.2, y ) );
}
`;
const HERO_KEY = /* glsl */`
#if defined( RE_Direct )
	{
		vec3 evHP = ( geometryPosition - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
		float evHW1 = evHeroWeight( evHP, evAir[ 8 ], evAir[ 9 ] ), evHW2 = evHeroWeight( evHP, evAir[ 10 ], evAir[ 11 ] );
		if ( evHW1 + evHW2 > 0.003 ) {
			directLight.color = evAir[ 14 ].rgb * evHW1 + evAir[ 13 ].rgb * evHW2;
			directLight.direction = normalize( mat3( viewMatrix ) * evAir[ 12 ].xyz );
			directLight.visible = true;
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
	}
#endif
`;
const CANDLE_GLOW = /* glsl */`
	{
		vec3 evGP = ( geometryPosition - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
		vec2 evGQ = max( abs( evGP.xz ) - evAir[ 7 ].xy, 0.0 );
		float evGIn = 1.0 - smoothstep( 0.0, max( evAir[ 7 ].z, 0.01 ), length( evGQ ) );
		float evGUp = dot( geometryNormal, viewMatrix[ 1 ].xyz );
		irradiance += evAir[ 6 ].rgb * ( exp( - max( evGP.y - evAir[ 2 ].w, 0.0 ) * evAir[ 6 ].w ) * evGIn * ( 0.66 - 0.34 * evGUp ) );
	}`;

/** The square of the smallest point light's size (m): the falloff is 1 / (d^2 + this + 400 * fract(decay)). */
export const POINT_SIZE2 = 0.2;
/** The `decay` to give a THREE.PointLight whose size squared is `size2` (m2, from POINT_SIZE2 to 40). */
export const decayFor = (size2) => 2 + Math.min(0.0995, Math.max(0, size2 - POINT_SIZE2) / 400);

let patched = false;
const problems = [];

/** Replace `find` in a chunk; remember it if three's text was not what this file expects (a different three version). */
function swap(name, find, put) {
  const src = THREE.ShaderChunk[name];
  const out = typeof find === 'string' ? (src.includes(find) ? src.replace(find, put) : null) : (find.test(src) ? src.replace(find, put) : null);
  if (out === null) { problems.push(name); return; }
  THREE.ShaderChunk[name] = out;
}

/** Apply the changes (once per page; safe to call again). Returns the names of chunks that could not be changed. */
export function patchChunks() {
  if (patched) return problems;
  patched = true;
  const C = THREE.ShaderChunk;

  // 1. the air
  C.fog_pars_vertex = FOG_PARS_VERTEX; C.fog_vertex = FOG_VERTEX; C.fog_pars_fragment = FOG_PARS_FRAGMENT; C.fog_fragment = FOG_FRAGMENT;
  THREE.UniformsLib.fog.evAir = { value: AIR };
  for (const k in THREE.ShaderLib) { const u = THREE.ShaderLib[k].uniforms; if (u && u.fogColor) u.evAir = { value: AIR }; }

  // 2. the shadow filter: the 2D PCF getShadow (directional and spot lights)
  swap('shadowmap_pars_fragment', 'float getShadow( sampler2DShadow shadowMap,', SHADOW_PCF + '\t\tfloat getShadow( sampler2DShadow shadowMap,');
  swap('shadowmap_pars_fragment', 'shadowCoord.xyz /= shadowCoord.w;\n\t\t\tshadowCoord.z += shadowBias;', 'shadowCoord.xyz /= shadowCoord.w;\n\t\t\tvec2 evSlope = evShadowSlope( shadowCoord.xyz );\n\t\t\tshadowCoord.z += shadowBias;');
  swap('shadowmap_pars_fragment', /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample[\s\S]*?\) \* 0\.2;/, 'shadow = evShadowPCF( shadowMap, shadowCoord.xyz, shadowMapSize, max( shadowRadius, 1.0 ), evSlope );');

  // 3. skip point lights that do not reach the pixel
  swap('lights_pars_begin',
    'vec3 lVector = pointLight.position - geometryPosition;\n\t\tlight.direction = normalize( lVector );\n\t\tfloat lightDistance = length( lVector );\n\t\tlight.color = pointLight.color;\n\t\tlight.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );\n\t\tlight.visible = ( light.color != vec3( 0.0 ) );',
    `vec3 lVector = pointLight.position - geometryPosition;
		float evD2 = dot( lVector, lVector );
		if ( pointLight.color.r + pointLight.color.g + pointLight.color.b <= 0.0 || ( pointLight.distance > 0.0 && evD2 >= pointLight.distance * pointLight.distance ) ) {
			light.color = vec3( 0.0 ); light.direction = vec3( 0.0, 0.0, 1.0 ); light.visible = false;
		} else {
			float lightDistance = sqrt( evD2 );
			light.direction = lVector / max( lightDistance, 1e-6 );
			light.color = pointLight.color * getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		}`);
  swap('lights_fragment_begin',
    'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
    'if ( directLight.visible ) { RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight ); }');

  // 4. the candles' light
  C.lights_pars_begin = LIGHTS_PARS + C.lights_pars_begin;
  swap('lights_fragment_begin', 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );', 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );' + CANDLE_GLOW);

  // 5. the fighters' key: after every light of the scene, before the ambient light
  swap('lights_fragment_begin', '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )', HERO_KEY + '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )');

  // 6. a point light has a size: no white-hot spot on what is a hand away from it
  swap('lights_pars_begin', 'float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );', 'float distanceFalloff = 1.0 / ( lightDistance * lightDistance + ' + POINT_SIZE2.toFixed(3) + ' + fract( decayExponent ) * 400.0 );');

  // 7. the image-based light's diffuse part
  swap('envmap_physical_pars_fragment', 'return PI * envMapColor.rgb * envMapIntensity;', 'return PI * envMapColor.rgb * envMapIntensity * ( 1.0 - evAir[ 13 ].w );');
  C.envmap_physical_pars_fragment = LIGHTS_DECL + C.envmap_physical_pars_fragment;

  if (problems.length) console.warn('gfx: three\'s shader chunks were not as expected, left unchanged: ' + problems.join(', '));
  return problems;
}

patchChunks();        // on import, before any other module builds a material or merges THREE.UniformsLib.fog
