// Loads everything the game needs, with progress, and hands it out by name.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Assets {
  constructor() { this.map = new Map(); this.gltfLoader = new GLTFLoader(); this.texLoader = new THREE.TextureLoader(); }
  /**
   * manifest: { name: 'path.glb' | 'path.webp' | 'path.json' | 'path.m4a' | { url, type: 'gltf'|'texture'|'json'|'buffer', srgb?, repeat?, optional? } }
   * onProgress(fraction, name)
   */
  async load(manifest, onProgress = () => {}) {
    const entries = Object.entries(manifest).map(([name, v]) => [name, typeof v === 'string' ? { url: v } : v]);
    let done = 0;
    await Promise.all(entries.map(async ([name, e]) => {
      const type = e.type || (/\.(glb|gltf)$/i.test(e.url) ? 'gltf' : /\.(png|jpe?g|webp)$/i.test(e.url) ? 'texture' : /\.json$/i.test(e.url) ? 'json' : 'buffer');
      try {
        let value;
        if (type === 'gltf') value = await this.gltfLoader.loadAsync(e.url);
        else if (type === 'texture') {
          value = await this.texLoader.loadAsync(e.url);
          if (e.srgb !== false) value.colorSpace = THREE.SRGBColorSpace;
          if (e.repeat) { value.wrapS = value.wrapT = THREE.RepeatWrapping; }
          value.anisotropy = 8;
        } else if (type === 'json') value = await fetch(e.url).then((r) => { if (!r.ok) throw new Error(r.status + ' ' + e.url); return r.json(); });
        else value = await fetch(e.url).then((r) => { if (!r.ok) throw new Error(r.status + ' ' + e.url); return r.arrayBuffer(); });
        this.map.set(name, value);
      } catch (err) {
        if (!e.optional) throw new Error(`could not load "${name}" (${e.url}): ${err.message || err}`);
        console.warn(`optional asset "${name}" is missing (${e.url})`);
      }
      onProgress(++done / entries.length, name);
    }));
  }
  has(name) { return this.map.has(name); }
  get(name) { const v = this.map.get(name); if (v === undefined) throw new Error(`no asset named "${name}"`); return v; }
  gltf(name) { return this.get(name); }
  texture(name) { return this.get(name); }
  json(name) { return this.get(name); }
  buffer(name) { return this.get(name); }
}
