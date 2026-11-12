// The mirror: the scene drawn once more from the camera's reflection in the water, into an HDR target that the
// surface shader reads.
//
//   - It follows the game's camera exactly (position, turn, field of view, any jitter in its projection): whatever
//     ctx.camera is when the hook runs is what gets mirrored.
//   - It sees layer 0 (docs/engine.md, "Layers"): the water itself and anything else on layer 2 is not in it. It
//     also sees layer 3, which no other camera does: the water owner's own stand-ins, drawn only in the mirror (the
//     plain shapes that stand for the candles' bowls there: src/world/candles.js). MIRROR_ONLY below.
//   - Its near plane is tilted to lie in the water's surface (an oblique projection), so nothing under the water
//     shows up in the reflection.
//   - It keeps a depth texture: the surface shader works out how far away the reflected thing is, which lets a
//     reflection stay attached to the foot of the thing that casts it while ripples bend the rest.
//   - It does not touch the shadow map: the renderer has refreshed it already.
import * as THREE from 'three';

const _plane = new THREE.Vector4(), _q = new THREE.Vector4(), _size = new THREE.Vector2();
export const MIRROR_ONLY = 3;        // the layer of things that are drawn in the mirror and nowhere else

export class Mirror {
  /** @param o { y: height of the surface, sink: how far under the surface the clip plane lies (metres) } */
  constructor(renderer, o = {}) {
    this.renderer = renderer; this.y = o.y || 0; this.sink = o.sink !== undefined ? o.sink : 0.012;
    this.scale = 1; this.maxLines = 1200; this.samples = 0;
    const cam = this.cam = new THREE.PerspectiveCamera();
    cam.layers.set(0); cam.layers.enable(MIRROR_ONLY); cam.matrixAutoUpdate = false; cam.matrixWorldAutoUpdate = false;
    this.vp = new THREE.Matrix4(); this.invVp = new THREE.Matrix4();   // world -> the mirror's clip space, and back
    this.reversed = renderer.capabilities.reversedDepthBuffer === true;   // the renderer was made with a reversed depth buffer
    this.depthMap = this.reversed ? new THREE.Vector2(1, 0) : new THREE.Vector2(2, -1);   // depth texel -> clip-space z
    this.target = null; this.w = 0; this.h = 0; this.ready = false; this.enabled = true; this.skipped = 0;      // skipped: frames with no water in view
    this.texture = null; this.depthTexture = null;
    this.onResize = null;                                               // called with (texture, depthTexture) when they are replaced
    this.fit();
  }

  /**
   * How sharp the mirror is: a share of the picture's height, capped, and its multisampling. The cathedral is so
   * finely modelled that drawing it costs about the same at any size, so the mirror is kept large and plain (no
   * multisampling below 'ultra'); the surface shader reads it through its mipmaps, which smooths its edges.
   */
  setQuality(q, o = {}) {
    const t = { low: [0.5, 720, 0], medium: [0.75, 900, 0], high: [1, 1200, 0], ultra: [1, 1440, 4] }[q] || [1, 1200, 0];
    this.scale = o.scale > 0 ? o.scale : t[0]; this.maxLines = t[1];
    const samples = o.samples >= 0 ? o.samples : t[2];
    if (this.samples !== samples) { this.samples = samples; this.w = 0; }
  }

  /** Make the target fit the picture (size: a Vector2, the size the scene is drawn at). Cheap when nothing changed. */
  fit(size) {
    if (size) _size.copy(size); else this.renderer.getDrawingBufferSize(_size);
    // steps of 16 lines, so a render scale that creeps does not rebuild the target every time
    const h = Math.max(64, Math.round(Math.min(this.maxLines, _size.y * this.scale) / 16) * 16), w = Math.max(64, Math.round(h * _size.x / Math.max(1, _size.y) / 2) * 2);
    if (w === this.w && h === this.h && this.target) return;
    this.w = w; this.h = h;
    if (this.target) { this.target.depthTexture.dispose(); this.target.dispose(); }
    const depth = new THREE.DepthTexture(w, h); depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: true, depthBuffer: true, stencilBuffer: false, samples: this.samples, depthTexture: depth,
    });
    this.texture = this.target.texture; this.depthTexture = depth; this.ready = false;
    if (this.onResize) this.onResize(this.texture, this.depthTexture);
  }

  /** Draw the reflection for this camera. Call from gfx.onBeforeRender, after the camera has been placed. */
  render(scene, camera, size) {
    if (!this.enabled) return false;
    this.fit(size);
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements, cam = this.cam, e = cam.matrixWorld.elements, y0 = this.y;
    const height = m[13] - y0;
    if (height < 0.02) return false;                                    // the camera is in (or under) the water: keep the last picture
    // If no ray of the camera's view goes downward, there is no water in the picture and nothing to mirror (a
    // cutscene looking up at the rose window): the pass, the hall drawn once more, is saved for that frame.
    const P = camera.projectionMatrix.elements;
    let down = false;
    for (let k = 0; k < 4 && !down; k++) { const x = ((k & 1 ? 1 : -1) + P[8]) / P[0], y = ((k & 2 ? 1 : -1) + P[9]) / P[5]; down = m[1] * x + m[5] * y - m[9] < -1e-4; }
    if (!down) { this.skipped++; return false; }

    // The camera's reflection in the plane y = y0, kept right-handed by turning its x axis round. A point on the
    // plane then lands at the same height in both pictures and at the opposite side: the shader projects with `vp`.
    e[0] = -m[0]; e[1] = m[1]; e[2] = -m[2]; e[3] = 0;
    e[4] = m[4]; e[5] = -m[5]; e[6] = m[6]; e[7] = 0;
    e[8] = m[8]; e[9] = -m[9]; e[10] = m[10]; e[11] = 0;
    e[12] = m[12]; e[13] = 2 * y0 - m[13]; e[14] = m[14]; e[15] = 1;
    cam.matrix.copy(cam.matrixWorld); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.near = camera.near; cam.far = camera.far; cam.fov = camera.fov; cam.aspect = camera.aspect;
    cam.projectionMatrix.copy(camera.projectionMatrix);
    // the projection flips x with the camera (matters only when the projection is off-centre, e.g. jittered)
    cam.projectionMatrix.elements[8] = -cam.projectionMatrix.elements[8];

    // The clip plane (the water, a little below its surface) in the mirror camera's space: normal up, the camera
    // on its negative side. Then Lengyel's oblique near plane: the third row of the projection is rebuilt so that
    // depth 'near' is that plane, and the far corner of the frustum still fits.
    const v = cam.matrixWorldInverse.elements, py = y0 - this.sink;
    _plane.set(v[4], v[5], v[6], 0);                                    // the world's up, in view space
    const vx = v[4] * py + v[12], vy = v[5] * py + v[13], vz = v[6] * py + v[14];     // a point of the plane, in view space
    _plane.w = -(_plane.x * vx + _plane.y * vy + _plane.z * vz);
    const p = cam.projectionMatrix.elements, rev = this.reversed;
    cam._reversedDepth = rev;                                           // or the renderer would rebuild the projection
    _q.x = (Math.sign(_plane.x) + p[8]) / p[0]; _q.y = (Math.sign(_plane.y) + p[9]) / p[5]; _q.z = -1;
    if (rev) {                                                          // near is depth 1, far is depth 0
      _q.w = p[10] / p[14];
      const a = 1 / _plane.dot(_q);
      p[2] = -a * _plane.x; p[6] = -a * _plane.y; p[10] = -1 - a * _plane.z; p[14] = -a * _plane.w;
    } else {                                                            // near is -1, far is +1
      _q.w = (1 + p[10]) / p[14];
      const a = 2 / _plane.dot(_q);
      p[2] = a * _plane.x; p[6] = a * _plane.y; p[10] = a * _plane.z + 1; p[14] = a * _plane.w;
    }
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); this.invVp.copy(this.vp).invert();

    const r = this.renderer, prevTarget = r.getRenderTarget(), prevAuto = r.autoClear, prevXr = r.xr.enabled;
    const prevShadow = r.shadowMap.autoUpdate, prevNeeds = r.shadowMap.needsUpdate;
    r.xr.enabled = false; r.autoClear = true; r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    r.setRenderTarget(this.target);
    r.render(scene, cam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto; r.xr.enabled = prevXr; r.shadowMap.autoUpdate = prevShadow; r.shadowMap.needsUpdate = prevNeeds;
    this.ready = true;
    return true;
  }

  dispose() { if (this.target) { this.target.depthTexture.dispose(); this.target.dispose(); this.target = null; } }
}
