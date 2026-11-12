# 本地运行 · 黑神话：悟空 虎先锋

## 运行

```bash
cd wukong-tiger-engine
bun server.js 8080      # 或 python -m http.server 8080
```

浏览器打开 <http://localhost:8080/>，等载入条走到「就绪 / 点击开始」，点一下进入游戏。
必须走 HTTP，不能直接双击 `index.html`：页面用 importmap + ES module，`file://` 下会被浏览器拦掉。

## 来源与抓取方式

线上地址 <https://www.anxiangsir.com/wukong-tiger-engine/>，是纯静态站点（无后端）。
上游仓库 `github.com/anxiangsir/wukong-tiger-engine` 目前 404（该账号 37 个公开仓库里没有它），
所以本目录是**从线上整站镜像**下来的，不是 git clone。抓取脚本在工作目录的 `_mirror/`：

- `mirror.py <目标目录>`：从 `index.html` 出发做 BFS，解析 ES module 的 `import`、CSS 的 `url()`、
  importmap 的裸名映射、以及 JSON 清单里的资源路径，逐层下载。已下载的文件会复用，可反复重跑补缺。
- `extra.py <目标目录>`：补 `audio.json` / `vfx.json` 里只写了裸文件名的那批资源
  （`sfx.bin`、4 段 BGM、26 张特效贴图），目录前缀是代码里拼的，BFS 推不出来。
- `verify.py <目标目录>`：拿 `src/assets.js` 的 `ASSETS` 契约清单逐项核对本地是否齐备。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `index.html` | 入口，importmap 把 `three` 等裸名指向 `vendor/` |
| `src/` | 26 个游戏模块（渲染、战斗、Boss、法术、变身、精魄、特效、音频、HUD、触屏） |
| `vendor/three/` | three.js 运行时 + GLTFLoader/meshopt + WebGPU/TSL 构建 |
| `vendor/three-mesh-bvh/` | 碰撞用的 BVH 库 |
| `assets/` | 约 78 MiB 游戏资源：模型（.glb）、动作表与数值表（.json）、碰撞（.bin）、音频、特效贴图 |

`server.js` 是本目录补的：上游的 `server.js` 随仓库 404 拿不到，这里用 `Bun.serve` 做等价静态服务，
显式给 `.js` 打 `text/javascript`（ES module 的 MIME 校验），`/` 落到 `index.html`。
`fetchBytes` 认 `X-Raw-Length`，没有该头时回落到 `Content-Length`，所以不压缩也能正确显示载入进度。

## 已验证

`bun server.js 8080` 起服务后，浏览器载入到「就绪」，进游戏 92 fps，卧虎寺场景、天命人、
虎先锋血条、葫芦与技能栏（定身/聚形/劈/赤潮/棍花/广谋）都正常，点击移动与攻击有响应。
`ASSETS` 契约 27 个资源文件全部在位，整站 117 个文件、约 84 MiB。

## 已知无关项

抓取日志里有一批 404（`textures/sprite.png`、`models/gltf/duck/duck.gltf`、`extract/B1Character/specs/*.json` 等），
它们来自 three.js 示例代码和游戏模块注释里的路径字符串，不是游戏真正请求的资源，缺了不影响运行。
importmap 声明的 `three/webgpu` 与 `three/tsl` 没有任何模块 import；为「全量」仍一并抓了下来。
