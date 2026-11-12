// 本地静态服务器：上游仓库的 server.js 随 GitHub 404 拿不到，这里用 Bun.serve 做等价替代。
// 用法：bun server.js [端口]，默认 8080。ES 模块要求 .js 必须是 text/javascript，故显式给 Content-Type。
import os from "node:os";

const ROOT = import.meta.dir;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".bin": "application/octet-stream",
};

Bun.serve({
  hostname: "0.0.0.0", // 绑所有网卡，局域网设备（手机横屏）可直接访问
  port: PORT,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const rel = path.endsWith("/") ? path + "index.html" : path; // 扩展名必须取自真正命中的文件，否则 / 会退化成 octet-stream
    const file = Bun.file(ROOT + rel);
    if (!(await file.exists())) return new Response("404 " + path, { status: 404 });
    const dot = rel.lastIndexOf(".");
    return new Response(file, {
      headers: { "Content-Type": MIME[rel.slice(dot)] ?? "application/octet-stream", "Cache-Control": "no-store" },
    });
  },
});

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i.family === "IPv4" && !i.internal)
  .map((i) => i.address);
console.log(`虎先锋 http://localhost:${PORT}/`);
for (const ip of lan) console.log(`局域网  http://${ip}:${PORT}/`);
