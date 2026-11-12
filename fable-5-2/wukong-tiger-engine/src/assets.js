// Contract asset loading with byte-level progress. Assets come over HTTP (bun server.js serves web/assets) or, when
// the host has none (the public Pages build ships no game files), from a folder the player picks on their own machine.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

/** Contract files: key -> path under web/. Parsed by extension (.glb -> glTF, .json -> object, else bytes) into
 * loadAll().files[key]. Skill modules add their bundles here (+ a LABELS entry) and read them from game.assets.files. */
export const ASSETS = {
  arenaJson: "assets/arena/arena.json",
  arenaGlb: "assets/arena/arena.glb",
  collision: "assets/arena/collision.bin",
  tigerGlb: "assets/tiger/tiger.glb",
  tigerAnims: "assets/tiger/tiger.anims.json",
  stoneDecoyGlb: "assets/tiger/stone_decoy.glb",
  playerGlb: "assets/player/wukong.glb",
  playerAnims: "assets/player/wukong.anims.json",
  tigerData: "assets/data/tiger.json",
  playerData: "assets/data/player.json",
  vfx: "assets/vfx/vfx.json",
  spellsGlb: "assets/player/spells.glb",
  spellsAnims: "assets/player/spells.anims.json",
  spellsData: "assets/data/spells.json",
  audio: "assets/audio/audio.json",
  stancesGlb: "assets/player/stances.glb",
  stancesAnims: "assets/player/stances.anims.json",
  stancesData: "assets/data/stances.json",
  bianhuaGlb: "assets/player/bianhua.glb",
  bianhuaAnims: "assets/player/bianhua.anims.json",
  bianhuaData: "assets/data/bianhua.json",
  langGlb: "assets/transform/gycy_lang.glb",
  langAnims: "assets/transform/gycy_lang.anims.json",
  sheGlb: "assets/spirit/gycy_she.glb",
  sheAnims: "assets/spirit/gycy_she.anims.json",
  snakeGlb: "assets/spirit/gycy_shebang.glb",
  snakeAnims: "assets/spirit/gycy_shebang.anims.json",
};

const LABELS = {
  arenaJson: "场景信息", arenaGlb: "卧虎寺", collision: "碰撞", tigerGlb: "虎先锋", tigerAnims: "虎先锋动作", stoneDecoyGlb: "石像分身",
  playerGlb: "天命人", playerAnims: "天命人动作", tigerData: "虎先锋数值", playerData: "天命人数值", vfx: "特效",
  spellsGlb: "法术动作", spellsAnims: "法术动作表", spellsData: "法术数值", audio: "音效",
  stancesGlb: "棍法动作", stancesAnims: "棍法动作表", stancesData: "棍法数值",
  bianhuaGlb: "变身动作", bianhuaAnims: "变身动作表", bianhuaData: "变身数值", langGlb: "广智", langAnims: "广智动作",
  sheGlb: "广谋", sheAnims: "广谋动作", snakeGlb: "毒蛇", snakeAnims: "毒蛇动作",
};

/** "assets/<dir>/<file>" -> File once useLocalFolder() accepted a pick; null = fetch over HTTP */
let localFiles = null;

/** True when the page's own host serves web/assets (local bun server.js); false on the asset-free Pages build. */
export async function hasServerAssets() {
  try { return (await fetch(ASSETS.arenaJson, { cache: "no-store" })).ok; } catch { return false; }
}

/**
 * Load from the files of an <input webkitdirectory> pick: the assets folder itself or any folder above it (e.g. web/).
 * Returns the contract paths that are missing; the source switches only when none are.
 */
export function useLocalFolder(fileList) {
  const named = new Map(), loose = new Map();
  for (const f of fileList) {
    const parts = f.webkitRelativePath.split("/");
    const i = parts.indexOf("assets");
    if (i >= 0 && i < parts.length - 1) named.set(["assets", ...parts.slice(i + 1)].join("/"), f);
    else loose.set(["assets", ...parts.slice(1)].join("/"), f); // picked folder is the assets folder, renamed
  }
  const files = named.size ? named : loose;
  const missing = Object.values(ASSETS).filter((p) => !files.has(p));
  if (missing.length) return missing;
  localFiles = files;
  // vfx.js loads its textures by URL through three's loaders: point those URLs at the picked files
  const urls = new Map();
  THREE.DefaultLoadingManager.setURLModifier((url) => {
    const f = files.get(url);
    if (!f) return url;
    if (!urls.has(url)) urls.set(url, URL.createObjectURL(f));
    return urls.get(url);
  });
  return [];
}

/** Bytes of a non-contract file under web/ (e.g. audio packs listed in audio.json): the picked local folder after
 * useLocalFolder(), else HTTP. Throws when the file is missing. */
export async function fetchAsset(path) {
  const file = localFiles?.get(path);
  const res = file ? new Response(file) : await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchBytes(url, onProgress) {
  const file = localFiles?.get(url);
  const res = file ? new Response(file) : await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // compressed transfers (server.js gzip/br): Content-Length is the wire size, X-Raw-Length the decoded size we count
  const total = file ? file.size : Number(res.headers.get("X-Raw-Length") || res.headers.get("Content-Length")) || 0;
  if (!res.body) { const b = new Uint8Array(await res.arrayBuffer()); onProgress(b.length, b.length); return b; }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, Math.max(total, got));
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  onProgress(got, got);
  return out;
}

const WKC1 = 0x31434b57; // "WKC1": compact collision.bin written by extract/optimize (collision.mjs)

/**
 * collision.bin -> indexed BufferGeometry. Raw (B1Arena): u32 vertexCount, u32 triCount, f32 xyz[], u32 idx[].
 * Compact: "WKC1", u32 vertexCount, u32 triCount, u32 vertexBytes, u32 indexBytes, meshopt vertex stream (f32 xyz,
 * stride 12, lossless), meshopt index stream (u32 triangles). Compact needs `await MeshoptDecoder.ready` first.
 */
export function parseCollision(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos, idx;
  if (bytes.byteLength >= 20 && dv.getUint32(0, true) === WKC1) {
    const vc = dv.getUint32(4, true), tc = dv.getUint32(8, true), vb = dv.getUint32(12, true), ib = dv.getUint32(16, true);
    if (bytes.byteLength < 20 + vb + ib) throw new Error(`collision.bin truncated: ${bytes.byteLength} < ${20 + vb + ib}`);
    pos = new Float32Array(vc * 3); idx = new Uint32Array(tc * 3);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(pos.buffer), vc, 12, bytes.subarray(20, 20 + vb));
    MeshoptDecoder.decodeIndexBuffer(new Uint8Array(idx.buffer), tc * 3, 4, bytes.subarray(20 + vb, 20 + vb + ib));
  } else {
    const vc = dv.getUint32(0, true), tc = dv.getUint32(4, true);
    const need = 8 + vc * 12 + tc * 12;
    if (bytes.byteLength < need) throw new Error(`collision.bin truncated: ${bytes.byteLength} < ${need}`);
    // copy so the arrays are aligned regardless of source offset
    pos = new Float32Array(bytes.slice(8, 8 + vc * 12).buffer);
    idx = new Uint32Array(bytes.slice(8 + vc * 12, need).buffer);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/** Loads every contract asset. onProgress(fraction, text). Returns { arena, collisionGeometry, tiger, player, data }. */
export async function loadAll(onProgress) {
  const keys = Object.keys(ASSETS);
  const state = Object.fromEntries(keys.map((k) => [k, { got: 0, total: 0, done: false }]));
  const report = (cur) => {
    let got = 0, total = 0, done = 0;
    for (const k of keys) {
      const s = state[k];
      got += s.got; total += Math.max(s.total, s.got, 1);
      if (s.done) done++;
    }
    onProgress(got / total, `${LABELS[cur]}　${(got / 1048576).toFixed(1)} MB　(${done}/${keys.length})`);
  };
  const loader = createGltfLoader();
  const fetchOne = async (k) => {
    const bytes = await fetchBytes(ASSETS[k], (g, t) => { state[k].got = g; state[k].total = t; report(k); });
    state[k].done = true; report(k);
    return bytes;
  };
  const asJson = (b) => JSON.parse(new TextDecoder().decode(b));
  const asGltf = (b, url) => loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), url.replace(/[^/]+$/, ""));

  const [bytes] = await Promise.all([Promise.all(keys.map(fetchOne)), MeshoptDecoder.ready]);
  onProgress(1, "解析模型…");
  const parsed = await Promise.all(keys.map((k, i) => {
    const url = ASSETS[k];
    if (url.endsWith(".glb")) return asGltf(bytes[i], url);
    if (url.endsWith(".json")) return asJson(bytes[i]);
    return bytes[i];
  }));
  const files = Object.fromEntries(keys.map((k, i) => [k, parsed[i]]));
  return {
    files,
    arena: { json: files.arenaJson, gltf: files.arenaGlb },
    collisionGeometry: parseCollision(files.collision),
    tiger: { gltf: files.tigerGlb, anims: files.tigerAnims },
    player: { gltf: files.playerGlb, anims: files.playerAnims },
    data: { tiger: files.tigerData, player: files.playerData },
    vfx: files.vfx,
  };
}

/** one GLTFLoader for every contract glb: raw B1Character/B1Arena exports and extract/optimize output
 * (EXT_meshopt_compression + KHR_mesh_quantization + EXT_texture_webp) */
function createGltfLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
