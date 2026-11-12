// The shared physically based materials (reached by everyone as ctx.gfx.materials):
//
//   stone(opts)  metal(opts)  cloth(opts)     three's standard / physical materials with sensible numbers; every
//                                             option of the three.js material passes through (color, map, normalMap,
//                                             roughness, ...). Extras: detail, wet (see each function).
//   emissive(color, power)                    something that only glows (a flame's core, lit glass): HDR colour
//   wet(material, amount, opts)               make a standard material wet near the water (darker, glossier)
//   character(root, { who })                  prepare a fighter: reflections that read, a rim of light, the Cantor's
//                                             own light and her gold, wet legs. Returns the fighter's "look".
//
// Everything stays a built-in material (patched with onBeforeCompile), so the moon, the candle lights, shadows, the
// image-based light and the air reach it like everything else.
import * as THREE from 'three';
import { AIR } from './shaders/chunks.js';
const WATER_Y = 0.07;            // the water's surface (docs/engine.md). Kept here so that these files import nothing outside their folder.

const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const isStandard = (m) => m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial);

// ------------------------------------------------------------------------------------------------ shader pieces
const WORLD_GLSL = /* glsl */`
vec3 evWorldPos() { return ( - vViewPosition - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix ); }
vec3 evWorldDir( vec3 v ) { return normalize( v * mat3( viewMatrix ) ); }
float evHash3( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
float evNoise3( vec3 p ) {
	vec3 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( evHash3( i ), evHash3( i + vec3( 1, 0, 0 ) ), f.x ), mix( evHash3( i + vec3( 0, 1, 0 ) ), evHash3( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( evHash3( i + vec3( 0, 0, 1 ) ), evHash3( i + vec3( 1, 0, 1 ) ), f.x ), mix( evHash3( i + vec3( 0, 1, 1 ) ), evHash3( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
`;

// wet near the water: uEvWet = amount, height where it is fully wet up to, fade above that (m), how dark
const WET_PARS = /* glsl */`uniform vec4 uEvWet;`;
const WET_CODE = /* glsl */`
	{
		vec3 evP = evWorldPos();
		float evLine = evP.y + 0.07 * sin( evP.x * 2.3 + evP.z * 1.7 ) + 0.05 * sin( evP.z * 5.1 - evP.x * 3.3 );
		float evK = uEvWet.x * ( 1.0 - smoothstep( uEvWet.y, uEvWet.y + uEvWet.z, evLine ) );
		diffuseColor.rgb *= mix( 1.0, uEvWet.w, evK );
		roughnessFactor = mix( roughnessFactor, min( roughnessFactor, 0.3 ), evK );
	}`;

// surface detail from one tiling noise texture laid along the world's axes: uEvDetail = 1 / size (m), bump, albedo
// variation, roughness variation
const DETAIL_PARS = /* glsl */`
uniform sampler2D tEvNoise;
uniform vec4 uEvDetail;
vec4 evTri( vec3 p, vec3 w ) { return texture2D( tEvNoise, p.zy ) * w.x + texture2D( tEvNoise, p.xz ) * w.y + texture2D( tEvNoise, p.xy ) * w.z; }
vec3 evBump( vec3 pos, vec3 n, float h, float face ) {
	vec3 sx = dFdx( pos ), sy = dFdy( pos );
	vec3 r1 = cross( sy, n ), r2 = cross( n, sx );
	float det = dot( sx, r1 ) * face;
	vec3 grad = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 );
	return normalize( abs( det ) * n - grad );
}`;
const DETAIL_COLOR = /* glsl */`
	vec3 evDP = evWorldPos() * uEvDetail.x;
	#ifdef FLAT_SHADED
		vec3 evDN = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
	#else
		vec3 evDN = normalize( vNormal );
	#endif
	vec3 evDW = abs( evWorldDir( evDN ) ); evDW = pow( evDW, vec3( 4.0 ) ); evDW /= evDW.x + evDW.y + evDW.z;
	vec4 evD = evTri( evDP, evDW ), evD2 = evTri( evDP * 0.173 + 0.37, evDW );
	diffuseColor.rgb *= 1.0 + uEvDetail.z * ( ( evD.b - 0.5 ) * 0.9 + ( evD2.r - 0.5 ) * 1.4 );
	roughnessFactor = clamp( roughnessFactor + uEvDetail.w * ( evD.a - 0.5 + ( evD2.g - 0.5 ) * 0.8 ), 0.045, 1.0 );`;
const DETAIL_NORMAL = /* glsl */`
	normal = evBump( - vViewPosition, normal, ( evD.r + evD2.b * 2.0 ) * uEvDetail.y / uEvDetail.x, faceDirection );`;

// The pilgrim's ghost. When the play camera is pushed close to him (a wall behind it) he must fade out plainly
// rather than be cut open by the near plane. "Plainly" is a fine fixed screen pattern that lets more and more of
// what is behind him through (no blending, so nothing has to be sorted and he still writes depth where he is drawn).
// It takes everything inside his column that is made of this file's materials and lies near the lens: his body, and
// through the factories below his cloak, weapons, shield and lantern (the wardrobe makes them with stone / metal /
// cloth / emissive), with no work on their owner's side. evAir[14].w is how far gone he is (look.fade on the pilgrim).
const GHOST = /* glsl */`
	#ifdef USE_FOG
	if ( evAir[ 14 ].w > 0.003 ) {
		vec2 evGd = vFogWorld.xz - evAir[ 8 ].xy;
		float evGy = vFogWorld.y - evAir[ 8 ].z;
		if ( dot( evGd, evGd ) < evAir[ 15 ].x && evGy > - 0.4 && evGy < evAir[ 8 ].w + 1.3 && distance( vFogWorld, cameraPosition ) < evAir[ 15 ].y ) {
			// (interleaved gradient noise: an even, fine pattern with no visible tiles)
			if ( fract( 52.9829189 * fract( dot( floor( gl_FragCoord.xy ), vec2( 0.06711056, 0.00583715 ) ) ) ) < evAir[ 14 ].w * 1.02 ) discard;
		}
	}
	#endif`;
/** Let any built-in material take part in the pilgrim's ghost (see GHOST). Keeps whatever was hooked before and is hooked after. */
function ghostable(material) {
  if (!material || material.userData.evGhost) return material;
  material.userData.evGhost = true;
  const before = material.onBeforeCompile, key = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    if (before) before.call(this, shader, renderer);
    const tag = '#include <clipping_planes_fragment>';
    if (shader.fragmentShader.includes(tag)) shader.fragmentShader = shader.fragmentShader.replace(tag, tag + GHOST);
  };
  material.customProgramCacheKey = function () { return (key ? key.call(this) : '') + '|ev:ghost'; };
  material.needsUpdate = true;
  return material;
}

// a fighter. uEvChar0 = rim strength, rim power, own light, gold (0..1, already risen by the mood)
//            uEvChar1 = wet line (world y), wet fade (m), wet amount, the fighter's height (m)
//            uEvChar2 = flash, fade (dissolve), roughness scale, roughness bias
//            uEvChar3 = metal map: value that counts as no metal, value that counts as all metal; feet (world y); gold trim by colour (0 | 1)
//            uEvTone  = how far the plain (not metal) surface goes toward neutral, its gain, roughness of gold trim,
//                       how much of her gold the plain surface takes (the trim takes all of it)
//            uEvTint  = what the metal's colour is multiplied by
const CHAR_PARS = /* glsl */`
uniform vec4 uEvChar0; uniform vec4 uEvChar1; uniform vec4 uEvChar2; uniform vec4 uEvChar3; uniform vec4 uEvTone;
uniform vec3 uEvRim; uniform vec3 uEvSelf; uniform vec3 uEvGold; uniform vec3 uEvFlash; uniform vec3 uEvTint;
float evGoldTrim = 0.0;
float evDissolveEdge = 0.0;
vec3 evCharPos;`;
const CHAR_DISCARD = /* glsl */`
	evCharPos = evWorldPos();
	if ( uEvChar2.y > 0.002 ) {
		float evN = evNoise3( evCharPos * 9.0 ) * 0.7 + evNoise3( evCharPos * 31.0 ) * 0.3;
		float evCut = uEvChar2.y * 1.12 - 0.06 + 0.25 * uEvChar2.y * clamp( ( evCharPos.y - uEvChar3.z ) / max( uEvChar1.w, 0.1 ), 0.0, 1.0 );
		if ( evN < evCut ) discard;
		evDissolveEdge = 1.0 - smoothstep( 0.0, 0.09, evN - evCut );
	}`;
const CHAR_SURFACE = /* glsl */`
	{
		// The models come with a mushy metal map (the knight is half metal everywhere, the Cantor's gold is not metal
		// at all). Decide here what is metal: the map stretched between two values, and gold trim found by its colour.
		vec3 evC = diffuseColor.rgb;
		float evMx = max( evC.r, max( evC.g, evC.b ) ), evMn = min( evC.r, min( evC.g, evC.b ) );
		float evLum = dot( evC, vec3( 0.2126, 0.7152, 0.0722 ) );
		evGoldTrim = uEvChar3.w * smoothstep( 0.42, 0.68, ( evMx - evMn ) / max( evMx, 1e-3 ) );
		metalnessFactor = clamp( ( metalnessFactor - uEvChar3.x ) / max( uEvChar3.y - uEvChar3.x, 1e-3 ), 0.0, 1.0 );
		roughnessFactor = clamp( roughnessFactor * uEvChar2.z + uEvChar2.w, 0.06, 1.0 );
		roughnessFactor = mix( roughnessFactor, uEvTone.z, evGoldTrim );
		vec3 evPlain = mix( evC, vec3( evLum ) * vec3( 1.0, 0.985, 0.955 ), uEvTone.x ) * uEvTone.y;
		vec3 evGoldC = vec3( 1.0, 0.76, 0.34 ) * ( 0.5 + 1.1 * evLum );
		diffuseColor.rgb = mix( mix( evPlain, evC * uEvTint, metalnessFactor ), evGoldC, evGoldTrim );
		metalnessFactor = max( metalnessFactor, evGoldTrim );
	}
	{
		float evLine = evCharPos.y + 0.05 * sin( evCharPos.x * 9.0 + evCharPos.z * 7.0 );
		float evK = uEvChar1.z * ( 1.0 - smoothstep( uEvChar1.x, uEvChar1.x + uEvChar1.y, evLine ) );
		diffuseColor.rgb *= 1.0 - 0.42 * evK;
		roughnessFactor = mix( roughnessFactor, min( roughnessFactor, 0.14 ), evK );
	}`;
const CHAR_LIGHT = /* glsl */`
	{
		vec3 evV = normalize( vViewPosition );
		float evFres = pow( 1.0 - saturate( dot( normal, evV ) ), uEvChar0.y );
		// light from behind and above the fighter as the camera sees him: there is always an edge of light
		float evBack = saturate( dot( normal, vec3( 0.0, 0.675, - 0.737 ) ) * 0.5 + 0.62 );
		float evOcc = 1.0;
		#ifdef USE_AOMAP
			evOcc = mix( 1.0, texture2D( aoMap, vAoMapUv ).r, 0.8 );
		#endif
		totalEmissiveRadiance += uEvRim * ( evFres * evBack * evOcc * uEvChar0.x );
		// her own light: the ivory holds a little light of its own, and gold rises through her from the feet
		vec3 evNW = evWorldDir( normal );
		totalEmissiveRadiance += diffuseColor.rgb * uEvSelf * ( uEvChar0.z * ( 0.62 + 0.38 * evNW.y ) * ( 1.0 - 0.75 * metalnessFactor ) * evOcc );
		float evH = clamp( ( evCharPos.y - uEvChar3.z ) / max( uEvChar1.w, 0.1 ), 0.0, 1.0 );
		float evRise = uEvChar0.w * smoothstep( 0.0, 0.3, uEvChar0.w * 1.3 - evH );
		// (gentler toward her head: the mask stays ivory, the skirt's filigree burns)
		totalEmissiveRadiance += uEvGold * evRise * ( 1.0 - 0.4 * evH ) * mix( uEvTone.w, 1.0, evGoldTrim ) * ( 0.55 + 0.45 * evFres ) * evOcc;
		totalEmissiveRadiance += uEvFlash * uEvChar2.x * ( 0.35 + 0.65 * evFres );
		totalEmissiveRadiance += uEvGold * evDissolveEdge * 8.0;
	}`;

/** Put GLSL after an #include of a built-in shader; complain once if three's shader is not as expected. */
function after(src, include, code) {
  const tag = `#include <${include}>`;
  if (!src.includes(tag)) { console.warn(`gfx.materials: no ${tag} in this shader`); return src; }
  return src.replace(tag, tag + '\n' + code);
}

/** A tiling noise texture: r, g, b, a are four different soft patterns (fbm), 0..1 around 0.5. */
function noiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, s) => { let h = Math.imul(x * 374761393 + y * 668265263 + s * 2147483647, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, y, period, s) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = smooth(x - xi), fy = smooth(y - yi), w = (v) => ((v % period) + period) % period;
    const a = hash(w(xi), w(yi), s), b = hash(w(xi + 1), w(yi), s), c = hash(w(xi), w(yi + 1), s), d = hash(w(xi + 1), w(yi + 1), s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  for (let ch = 0; ch < 4; ch++) {
    let lo = 1e9, hi = -1e9; const tmp = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, period = ch === 0 ? 8 : ch === 3 ? 12 : 6;
      for (let o = 0; o < 5; o++) { v += amp * value((x / size) * period, (y / size) * period, period, ch * 17 + o * 5 + 1); amp *= ch === 0 ? 0.55 : 0.5; period *= 2; }
      tmp[y * size + x] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round(255 * (tmp[i] - lo) / (hi - lo));
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace; t.name = 'gfx.noise'; t.needsUpdate = true;
  return t;
}

// key: how strongly the fighters' key (shaders/chunks.js, 5) lights this fighter and all he or she wears; column: the
// radius (m) round the fighter's feet inside which it does.
const WHO = {
  // the pilgrim: dark blued steel that must reflect, a cool edge of light, wet to the shins
  player: { rim: 0.9, rimPower: 2.5, self: 0, rimColor: rgb(0.50, 0.66, 1.0), wetLine: 0.36, wetFade: 0.3, height: 1.8, rough: [0.72, 0.0], metal: [0.2, 0.62], goldTrim: 0, tone: [0, 1.3, 0.3, 0], tint: rgb(2.6, 3.0, 3.7), env: 1.9, normal: 1.0, key: 0.3, column: 1.3 },
  // the Cantor: ivory enamel that holds light, gold filigree, wet to the knee. In phase two (the ...Two numbers:
  // what each is multiplied by when gfx.mood.gold is 1) her wings are the light: the ivory holds LESS light of its
  // own, so the key and the rim model her (a figure that glows evenly is flat), and her edge of light is gold.
  boss: { rim: 0.45, rimPower: 3.2, self: 0.46, rimColor: rgb(0.78, 0.86, 1.0), wetLine: 0.95, wetFade: 0.9, height: 6.6, rough: [0.8, 0.0], metal: [0.5, 1.0], goldTrim: 1, tone: [0.3, 1.12, 0.3, 0.03], tint: rgb(1, 1, 1), env: 1.1, normal: 0.75, key: 1.15, column: 3.0,
    rimGold: rgb(1.0, 0.78, 0.44), rimTwo: 2.2, selfTwo: 0.85, keyTwo: 1.8, goldPower: 1.5 },
};
const _k = new THREE.Vector3(), _kc = new THREE.Color();

export class Materials {
  constructor(gfx) {
    this.gfx = gfx; this.looks = []; this.made = [];
    this.noise = noiseTexture(256);
    // (her gold is a deep gold: at 2.4 times a pale one, as it first was, the film curve made cream of it)
    this.colors = { self: rgb(0.9, 0.95, 1.0), selfGold: rgb(1.0, 0.88, 0.66), gold: rgb(1.0, 0.66, 0.25), flash: rgb(1.0, 0.93, 0.80) };
    // What the Cantor's look reports as `look.gold` while nobody has set it: the mood's gold times this. The wardrobe
    // reads that number for everything she wears and lays its own gold (2.4 on every metal thing, rising from her
    // feet) by it. At 1 that covered her pipes, halo and blade in one flat cream; at 0.87 the rise ends about her
    // shoulders, the pipes above keep a third of it, and their own light (hot mouths, darker bodies) shows.
    this.kitGold = 0.88;
    // the pilgrim's ghost (see GHOST): everything of his within `radius` of his axis (a sword at arm's length) and
    // within `reach` of the lens (so the Cantor's skirt two paces beyond him stays whole)
    this.ghost = { radius: 1.9, reach: 2.8 };
    // the fighters' key: its strength in scene units (the moon is 3), its colour by phase, where it comes from
    // relative to the camera (to the left, above, toward the camera), and the direction itself (world, toward the light)
    // (in phase two the Cantor's turns gold; the pilgrim's stays cool, a touch toward violet: he is the cool figure
    // in her gold light)
    this.key = { power: 1.5, cool: rgb(0.80, 0.88, 1.0), gold: rgb(1.0, 0.84, 0.58), coolTwo: rgb(0.78, 0.82, 1.0), from: new THREE.Vector3(-0.52, 0.72, 0.6), dir: new THREE.Vector3(0, 0.77, 0.64), at: new THREE.Vector3(), set: false };
  }

  /** Patch a standard material with any of: wet, detail, character. Safe to call again (it only adds what is missing). */
  _patch(material, add) {
    if (!isStandard(material)) return material;
    const ev = material.userData.ev || (material.userData.ev = { uniforms: {}, has: {} });
    let changed = false;
    for (const k in add) { if (!ev.has[k]) { ev.has[k] = true; changed = true; } Object.assign(ev.uniforms, add[k]); }
    if (!changed) return material;
    if (!ev.hooked) {
      ev.hooked = true;
      const before = material.onBeforeCompile, key = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        if (before) before.call(material, shader, renderer);
        const has = ev.has; Object.assign(shader.uniforms, ev.uniforms);
        let f = shader.fragmentShader;
        f = f.replace('void main() {', WORLD_GLSL + (has.wet ? WET_PARS : '') + (has.detail ? DETAIL_PARS : '') + (has.character ? CHAR_PARS : '') + '\nvoid main() {');
        if (has.character) f = after(f, 'clipping_planes_fragment', CHAR_DISCARD);
        f = after(f, 'metalnessmap_fragment', (has.character ? CHAR_SURFACE : '') + (has.detail ? DETAIL_COLOR : '') + (has.wet ? WET_CODE : ''));
        if (has.detail) f = after(f, 'normal_fragment_maps', DETAIL_NORMAL);
        // where the relief of a normal map is finer than a pixel its glints would flicker: turn that into roughness
        if (has.character) f = after(f, 'normal_fragment_maps', '\troughnessFactor = min( 1.0, roughnessFactor + 0.55 * length( fwidth( normal ) ) );');
        if (has.character) f = after(f, 'emissivemap_fragment', CHAR_LIGHT);
        // a fighter sinks into the air only half as much as the hall does: the two figures stay the clearest things in it
        if (has.character && f.includes('#include <fog_fragment>')) f = f.replace('#include <fog_fragment>', 'vec3 evClear = gl_FragColor.rgb;\n\t#include <fog_fragment>\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, evClear, 0.5 );');
        shader.fragmentShader = f;
      };
      material.customProgramCacheKey = () => (key ? key.call(material) : '') + '|ev:' + Object.keys(ev.has).sort().join(',');
    }
    material.needsUpdate = true;
    return material;
  }

  _std(Type, defaults, o) {
    const { detail, wet, wetLine, wetFade, wetDark, scale, ...rest } = o || {};
    const m = new Type(Object.assign({}, defaults, rest));
    this.made.push(m);
    return ghostable(m);
  }

  /**
   * Stone. opts: anything MeshStandardMaterial takes, and
   *   detail (0..1, default 1 without a normalMap, 0 with one): fine surface relief and mottling laid along the world's axes
   *   scale (metres, default 1.6): the size of that pattern
   *   wet (0..1, default 0): darker and glossier near the water; wetLine (m above the water, default 0.5), wetFade (m, default 0.9)
   */
  stone(o = {}) {
    const m = this._std(THREE.MeshStandardMaterial, { color: 0x8d94a3, roughness: 0.86, metalness: 0 }, o);
    const detail = o.detail !== undefined ? o.detail : (o.normalMap ? 0 : 1);
    if (detail > 0) this._patch(m, { detail: { tEvNoise: { value: this.noise }, uEvDetail: { value: new THREE.Vector4(1 / (o.scale || 1.6), 0.0035 * detail, 0.14 * detail, 0.16 * detail) } } });
    if (o.wet) this.wet(m, o.wet, o);
    return m;
  }

  /** Metal. opts: anything MeshStandardMaterial takes; detail (0..1, default 0.5): faint wear in the gloss. */
  metal(o = {}) {
    const m = this._std(THREE.MeshStandardMaterial, { color: 0xc9d0da, roughness: 0.3, metalness: 1 }, o);
    const detail = o.detail !== undefined ? o.detail : (o.roughnessMap ? 0 : 0.5);
    if (detail > 0) this._patch(m, { detail: { tEvNoise: { value: this.noise }, uEvDetail: { value: new THREE.Vector4(1 / (o.scale || 0.35), 0.0004 * detail, 0.08 * detail, 0.22 * detail) } } });
    if (o.wet) this.wet(m, o.wet, o);
    return m;
  }

  /** Cloth: matte, two-sided, with a soft sheen at grazing angles so dark cloth still has an edge. opts: MeshPhysicalMaterial's. */
  cloth(o = {}) {
    const color = new THREE.Color(o.color !== undefined ? o.color : 0x2a2c33);
    const sheen = o.sheenColor !== undefined ? new THREE.Color(o.sheenColor) : color.clone().lerp(rgb(0.45, 0.55, 0.8), 0.6);
    const m = this._std(THREE.MeshPhysicalMaterial, { color, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, sheen: 0.6, sheenRoughness: 0.5, sheenColor: sheen }, o);
    if (o.wet) this.wet(m, o.wet, o);
    return m;
  }

  /** Something that only glows. power is in scene units: 1 is white paper in full moonlight, 3 and up blooms. */
  emissive(color, power = 1) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), toneMapped: false });
    this.made.push(m);
    return ghostable(m);
  }

  /**
   * Make a standard material wet near the water: below `wetLine` metres above the water it is darker and glossy,
   * fading out over `wetFade` metres. amount 0..1. Returns the same material. Call again to change the numbers.
   */
  wet(material, amount = 1, o = {}) {
    if (!isStandard(material)) return material;
    const ev = material.userData.ev, u = ev && ev.uniforms.uEvWet;
    const line = WATER_Y + (o.wetLine !== undefined ? o.wetLine : 0.5), fade = o.wetFade !== undefined ? o.wetFade : 0.9, dark = o.wetDark !== undefined ? o.wetDark : 0.55;
    if (u) { u.value.set(amount, line, fade, dark); return material; }
    return this._patch(material, { wet: { uEvWet: { value: new THREE.Vector4(amount, line, fade, dark) } } });
  }

  /**
   * Prepare a fighter's body (the skinned meshes under `root`): each gets its own copy of its material, so the two
   * fighters can differ. who: 'player' | 'boss'. Returns the fighter's look (also at root.userData.look):
   *   look.rim (0..1+)     the edge of light                 look.glow (0..1+)   her own light (boss)
   *   look.gold (null | 0..1)  her gold; null follows gfx.mood.gold     look.wet (0..1)   wet legs
   *   look.flash (0..1+)   a white-hot flash over the whole body (a hit); set it and bring it back to 0 yourself
   *   look.fade (0..1)     dissolve into nothing with a burning edge (the ending)
   *   look.key (0..1+)     the fighters' key on this fighter and on all he or she wears (1 = as designed; 0 for a silhouette)
   *   look.materials       the materials in use
   */
  character(root, { who = 'player', ...o } = {}) {
    if (root.userData.look) return root.userData.look;
    const W = Object.assign({}, WHO[who] || WHO.player, o), C = this.colors;
    const u = {
      uEvChar0: { value: new THREE.Vector4(W.rim, W.rimPower, W.self, 0) },
      uEvChar1: { value: new THREE.Vector4(WATER_Y + W.wetLine, W.wetFade, 1, W.height) },
      uEvChar2: { value: new THREE.Vector4(0, 0, W.rough[0], W.rough[1]) },
      uEvChar3: { value: new THREE.Vector4(W.metal[0], W.metal[1], 0, W.goldTrim) },
      uEvTone: { value: new THREE.Vector4(W.tone[0], W.tone[1], W.tone[2], W.tone[3] || 0) }, uEvTint: { value: W.tint.clone() },
      uEvRim: { value: W.rimColor.clone() }, uEvSelf: { value: C.self.clone() }, uEvGold: { value: C.gold.clone().multiplyScalar(W.goldPower || 1.5) }, uEvFlash: { value: C.flash.clone().multiplyScalar(3) },
    };
    // gold: what anyone set (null = follow the mood); _goldNow: what is reported while it is null (see this.kitGold)
    const look = { who, root, materials: [], uniforms: u, base: W, _gold: who === 'boss' ? null : 0, _goldNow: 0, key: 1, _rim: 1, _glow: 1, ghost: 0 };
    Object.defineProperties(look, {
      gold: { get() { return this._gold === null ? this._goldNow : this._gold; }, set(v) { this._gold = v === undefined ? null : v; } },
      rim: { get() { return this._rim; }, set(v) { this._rim = v; } },
      glow: { get() { return this._glow; }, set(v) { this._glow = v; } },
      wet: { get() { return u.uEvChar1.value.z; }, set(v) { u.uEvChar1.value.z = v; } },
      flash: { get() { return u.uEvChar2.value.x; }, set(v) { u.uEvChar2.value.x = v; } },
      // fade: the Cantor is eaten away with a burning edge (the ending). The pilgrim has no such death: on him it is the
      // plain ghost (the play camera sets it when the lens comes within a metre of him), the same as look.ghost
      fade: who === 'player' ? { get() { return this.ghost; }, set(v) { this.ghost = v; } } : { get() { return u.uEvChar2.value.y; }, set(v) { u.uEvChar2.value.y = v; } },
    });
    const seen = new Map();
    root.traverse((n) => {
      if (!n.isSkinnedMesh) return;
      const one = (m) => {
        if (!isStandard(m)) return m;
        let c = seen.get(m);
        if (!c) {
          c = m.clone(); c.name = (m.name || 'body') + ':' + who; c.userData = {};
          c.envMapIntensity = W.env; if (c.normalScale) c.normalScale.multiplyScalar(W.normal);
          this._patch(c, { character: u }); ghostable(c); seen.set(m, c); look.materials.push(c);
        }
        return c;
      };
      n.material = Array.isArray(n.material) ? n.material.map(one) : one(n.material);
    });
    this.looks.push(look); root.userData.look = look;
    return look;
  }

  /** Once a frame: what follows the mood, the camera and the fighters' places. dt: seconds since the last frame. */
  update(mood, dt = 1 / 60) {
    const g = Math.min(1, Math.max(0, mood.gold)), A = AIR, K = this.key, C = this.colors;
    // The fighters' key comes from over the camera's left shoulder and above. It is a direction in the world (the
    // water's mirror must agree with it); it follows the camera softly, and at once when the camera cuts.
    const e = this.gfx.camera.matrixWorld.elements;
    let bx = e[8], bz = e[10]; const bl = Math.hypot(bx, bz); if (bl > 1e-4) { bx /= bl; bz /= bl; } else { bx = 0; bz = 1; }
    _k.set(bx * K.from.z + e[0] * K.from.x, K.from.y, bz * K.from.z + e[2] * K.from.x).normalize();
    const cut = !K.set || K.dir.dot(_k) < 0.7 || Math.abs(e[12] - K.at.x) + Math.abs(e[13] - K.at.y) + Math.abs(e[14] - K.at.z) > 1.5;      // the camera cut to another place
    K.at.set(e[12], e[13], e[14]);
    if (cut) { K.dir.copy(_k); K.set = true; } else K.dir.lerp(_k, 1 - Math.exp(-5 * Math.min(0.1, Math.max(0, dt)))).normalize();
    A[48] = K.dir.x; A[49] = K.dir.y; A[50] = K.dir.z;
    _kc.copy(K.cool).lerp(K.gold, g);
    A[52] = _kc.r * K.power; A[53] = _kc.g * K.power; A[54] = _kc.b * K.power;       // the Cantor's
    _kc.copy(K.cool).lerp(K.coolTwo, g);
    A[56] = _kc.r * K.power; A[57] = _kc.g * K.power; A[58] = _kc.b * K.power;       // the pilgrim's
    A[37] = 0; A[45] = 0;                                                // no fighter, no key
    A[59] = 0; A[60] = this.ghost.radius * this.ghost.radius; A[61] = this.ghost.reach;      // no pilgrim, no ghost
    for (let i = 0; i < this.looks.length; i++) {
      const l = this.looks[i], u = l.uniforms, W = l.base, m = l.root.matrixWorld.elements, gold = l._gold === null ? g : l._gold;
      l._goldNow = l._gold === null && l.who === 'boss' ? g * this.kitGold : 0;
      u.uEvChar0.value.w = gold;
      u.uEvChar3.value.z = m[13];                                        // the feet, in the world
      // the edge of light: hers turns gold and grows with her gold (the wings behind her are the light then)
      u.uEvChar0.value.x = W.rim * l._rim * (1 + ((W.rimTwo || 1) - 1) * gold);
      if (W.rimGold) u.uEvRim.value.copy(W.rimColor).lerp(W.rimGold, gold);
      if (W.self > 0) {                                                  // her own light warms with her gold, and gives way to the key
        u.uEvSelf.value.copy(C.self).lerp(C.selfGold, gold);
        u.uEvChar0.value.z = W.self * l._glow * (1 + ((W.selfTwo || 1) - 1) * gold);
      }
      const o = l.who === 'boss' ? 40 : 32;                              // this fighter's column (shaders/chunks.js: evAir[8..11])
      A[o] = m[12]; A[o + 1] = m[14]; A[o + 2] = m[13]; A[o + 3] = W.height;
      A[o + 4] = W.column; A[o + 5] = W.key * l.key * (1 + ((W.keyTwo || 1) - 1) * gold) * (1 - u.uEvChar2.value.y); A[o + 6] = 0; A[o + 7] = 0;
      if (l.who === 'player') {
        const ghost = A[59] = Math.min(1, Math.max(0, l.ghost || 0));
        // The play camera asks the wardrobe as well (kit.fade): that is the kit's dissolve into gold light, made for the
        // ending, and near the lens it reads as his cloak and sword burning. While his ghost is on, what he wears stays
        // whole and the ghost fades it with him: the kit's own fade is put back to nothing before the frame is drawn.
        // (Nothing happens here once the camera no longer sets kit.fade for the lens.)
        if (ghost > 0.003) { const p = this.gfx.ctx && this.gfx.ctx.player, kit = p && p.kit; if (kit && kit.fade > 0 && (!p.look || p.look === l)) kit.fade = 0; }
      }
    }
  }

  /** The look of the fighter an object belongs to (the object character() was given, or anything above or under it), or null. */
  lookOf(object) {
    for (let o = object; o; o = o.parent) if (o.userData && o.userData.look) return o.userData.look;
    let found = null;
    if (object && object.traverse) object.traverse((o) => { if (!found && o.userData && o.userData.look) found = o.userData.look; });
    return found;
  }

  /** Forget a fighter that has been disposed of. */
  release(root) {
    const l = root.userData.look; if (!l) return;
    for (const m of l.materials) m.dispose();
    const i = this.looks.indexOf(l); if (i >= 0) this.looks.splice(i, 1);
    delete root.userData.look;
  }

  dispose() {
    for (const l of this.looks) { for (const m of l.materials) m.dispose(); delete l.root.userData.look; }
    this.looks.length = 0;
    for (const m of this.made) m.dispose(); this.made.length = 0;
    this.noise.dispose();
  }
}
