# 本地运行 · Evensong

《Evensong》——"One duel in a drowned cathedral. A souls-like demo that plays in the browser."
一座淹水的教堂里的一场单挑，浏览器里跑的类魂 demo。线上 <https://evensong-phi.vercel.app/>。

## 运行

```bash
cd evensong
bun server.js 8081      # 或 python -m http.server 8081
```

浏览器打开 <http://localhost:8081/>。`server.js` 已绑 `0.0.0.0`，启动时会把局域网地址一起打出来，手机横屏可玩。
必须走 HTTP：`index.html` 用 importmap + ES module，`file://` 打不开。

## 来源

线上是 Vercel 静态部署，纯前端、无后端。没找到对应的开源仓库（搜 "evensong phi" 只翻出一堆 phigros 音游相关项目，
与本作无关），所以这份副本和黑神话那个一样，是**整站镜像**下来的，不是 git clone。

抓取脚本在工作目录的 `_mirror/`：

- `mirror.py <站点根地址> <目标目录>`：从 `index.html` 起 BFS，解析 ES module 的 `import`、CSS 的 `url()`、
  importmap 裸名、JSON / `.webmanifest` 里的资源路径。已下载的文件复用，可反复重跑补缺。
- `fromlog.py <站点根地址> <目标目录> <服务日志>`：读 `server.js` 打出的 `404 <路径>` 行，把缺的资源补下来。

## 为什么需要 fromlog 这一步

本作的资源路径**几乎全是代码里拼出来的**，静态 BFS 推不出来：

| 位置 | 写法 |
| --- | --- |
| `src/world/arena.js` | `const M = 'assets/models/arena/'` + `M + 'bay.glb'` |
| `src/world/materials.js` | `` `${T}${file}.webp` ``，`file` 来自同文件的纹理名表，还有 `_n` / `_orm` 变体 |
| `src/ui/style.js` | `` new URL('../../assets/fonts/', import.meta.url) `` 拼 `@font-face` 的 woff2 |
| `src/audio/audio.js` | `DIR.sfx / DIR.voice / DIR.music` + `src/audio/manifest.js` 生成的文件名表 |

好在 `src/core/assets.js` 开局就把整张 ASSETS 表整个 fetch 一遍，缺了非 optional 项还会直接抛错
（第一次载入时页面标题就变成 `error: could not load "arena.bay" (assets/models/arena/bay.glb)`）。
所以补法很直接：**本地跑一遍，`server.js` 的 404 日志就是缺资源清单**，`fromlog.py` 照着下载即可。
本项目这样补了 166 个文件、31.2 MiB（音频 121、模型 26、贴图 14、字体 3，加 favicon）。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `index.html` | 入口，importmap 把 `three` / `three/addons/` 指向 `vendor/` |
| `src/` | 78 个模块，按 `core` `gfx` `chars` `cam` `cine` `ui` `world` `audio` 分层 |
| `vendor/three/` | three.js 运行时与 addons |
| `assets/` | 175 个资源：18 个 .glb 模型、27 张 .webp 贴图、121 段 .ogg 音频、3 个 .woff2 字体、PWA 图标与分享图 |

## 已验证

`bun server.js 8081` 起服务后完整载入，**404 计数 0**；标题页（EVENSONG / Begin / Options、教堂与带管风琴翅膀的
Boss、水面倒影、蜡烛）与开场 CG 都正常渲染，`@font-face` 的本地字体生效。整站 264 个镜像文件、54.0 MiB。

## 已知无关项

抓取日志里约 185 个 404（`duck.gltf`、`diffuse.png`、`fish.gltf`、`models/json/pressure.json` 等），
来自 three.js 示例代码和游戏模块注释里的路径字符串，不是游戏真正请求的东西，缺了不影响运行。
判定标准以**运行时日志**为准：`server.js` 打出的 404 才是真缺。
