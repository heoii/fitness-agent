# 部署：它能放到哪儿，不能放到哪儿

这份文档只写**验证过的东西**，和**明确没验证的东西**。两者分开写，
是因为部署文档最容易变成一段「理论上应该能跑」的愿望。

验证日期 2026-11-15，本机 macOS + Node 22 + Ollama 本地 7B。

---

## 一、形态：只能自托管，不能放 Serverless

这个应用的三个依赖把它锁死在「一台能跑 Ollama 的机器上」：

| 依赖 | 为什么不能外移 |
|---|---|
| `KB_DIRS` 指向的知识库目录 | 索引在**进程内**首次请求时构建（实测 349 ms / 5389 块），不走外部检索服务 |
| Ollama（`OLLAMA_URL`） | 答案由本地 7B 生成，没有用任何云端 API |
| 知识库的实时性 | 每天记录会变，重启即重建索引，不需要额外同步管道 |

所以 Vercel / 云函数这条路不用考虑：没有持久磁盘放知识库，也连不到家里那台 Ollama。

---

## 二、已验证（可复现）

```bash
npx next build          # ✓ 5 s（Turbopack），/ 静态预渲染，两个 /api/* 动态
npx next start -p 3010  # ✓ Ready in 101 ms
```

| 检查项 | 结果 |
|---|---|
| `GET /` | 200 |
| `GET /api/ask` | 返回索引规模与构建耗时（**不回 `dir`**，那个字段带本机绝对路径） |
| `POST /api/ask` | 正常出答案 + citations，`section` 字段随引用一起返回 |
| `POST /api/ask?stream=1` | SSE 正常，`cites` 先于任何 token 发出 |
| 构建产物泄漏扫描 | `.next/static` 里 **0 处**本机绝对路径 / 云盘账号 |
| `next start -H 127.0.0.1` | 回环 200、局域网 **000**（连不上） |

最后一条不是可有可无的。见下一节。

---

## 三、硬风险：接口没有鉴权，而 `next start` 默认监听到局域网

实测（不加 `-H`）：

```
▲ Next.js 16.4.6
- Local:    http://localhost:3010
- Network:  http://192.168.0.177:3010
```

`Network` 那一行不是装饰：**同一 Wi-Fi 下任何人打开这个地址，就能问你「我的体脂率是多少」**，
而 `/api/ask` 没有任何 token、没有登录、没有限流。这个仓是公开的，那里面的知识库
是真实健康记录。

**W15 起这条已经是默认行为，不再依赖「记得加 `-H`」**：`npm run dev` 和
`npm run start` 都写死了 `-H 127.0.0.1`。实测生产模式下 `lsof` 显示
`127.0.0.1:3000`，本机 200、局域网 `000`。

两条路，按你在不在意手机访问来选：

```bash
# A. 只在本机用（默认，已实测有效）
npm run start -- -p 3000

# B. 要手机/别的设备访问 → 前置一层反向代理做 Basic Auth 或 token 校验，
#    应用本身仍然只听回环：npm run start -- -p 3000，再让 nginx/caddy 反代
```

**不要**用「把端口暴露到公网 + 靠 URL 猜不到」当保护——路径可以扫，也可以从 Referer 拿到。

应用层鉴权（`ASK_TOKEN` 之类）目前**没做**：它需要一个明确的产品决定
（谁能看、token 怎么发、要不要区分只读/可问），不该在部署这一步顺手塞一个。

### 一个会骗人的验证结果：502 不是服务

W15 实测时，绕过代理前 `curl http://<内网IP>:3000/` 返回 **502**，看起来像
「局域网还能访问」。其实是环境里的 `HTTP_PROXY` 把连不上的请求接过去、由代理回了个 502。
加 `--noproxy '*'` 之后是 `000`（真的连不上）。`service.sh status` 已固定绕过代理。

**判断「服务有没有暴露」要看 `lsof` 的监听地址，不能只看 HTTP 状态码。**

---

## 三·五、常驻服务（W15）

```bash
./scripts/service.sh status      # 在不在、听在哪、本机/局域网可达性
./scripts/service.sh logs        # stdout / stderr 最近 40 行
./scripts/service.sh install     # 写 launchd plist，登录自启 + KeepAlive 崩溃拉起
./scripts/service.sh restart     # 改完代码 / 知识库变了，重读索引
./scripts/service.sh uninstall   # 停掉并移除自启
./scripts/service.sh start-once  # 没装 launchd 时前台临时起一个
```

**为什么常驻用生产模式而不是 `npm run dev`**：dev 会热重载模块，而检索索引挂在
`globalThis` 上跨热更新存活。W12 给索引加了 `sections` 字段，旧服务内存里那个对象
没有它，新代码一读就 `Cannot read properties of undefined`，整页报错（见第七节）。
常驻服务要的是「不自己变」：改完代码显式 `restart` 一次。

### 装自启时撞到的环境限制（**这一条没验证完**）

`launchctl bootstrap` / `load` / `asuser` / `user` 域**全部**报
`Bootstrap failed: 5: Input/output error`，连一个只 `/bin/echo hello` 的最小 plist 也一样——
当前会话没有 GUI 登录上下文，不是配置写错。

配置本身静态验过（`npm run w8:service`，24/24）：plist 语法合法、
`RunAtLoad` / `KeepAlive` / `ThrottleInterval=10` 都在、走生产 start、
日志落盘、plist 不在公开仓里。它已经落在 `~/Library/LaunchAgents/`，
**下次登录 launchd 会自动加载**；但「登录后真的起来了」「kill 之后真的被拉起」
这两条**当场没验证过**。

在你自己的终端（有 GUI 登录上下文）里跑一次就能补上：

```bash
~/dev/fitness-agent/scripts/service.sh install
~/dev/fitness-agent/scripts/service.sh status   # 应看到 state = running
```

`install` 在注册失败时**不会打印「已安装」**，会明确提示待验证，不会骗人。

---

## 四、环境变量

`.env.local` 里最小集：

```bash
# 语料根：优先 KB_DIRS（可多个，逗号分隔），否则退回 KB_DIR
KB_DIRS=/path/to/知识库

# 本地模型
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b-instruct
```

`.env.example` 里有完整说明。**`.env.local` 不进仓**，`git_sync.py` 有一道闸盯着。

---

## 五、数据边界（这个仓是公开的）

- 知识库**不进仓**，靠运行时挂载 / 配置路径。
- `private/` 已 gitignore：向量库、嵌入落盘都在里面。
- 构建产物里不含知识库正文——索引是运行时在服务端内存里构建的，
  客户端拿到的只有本次回答的 snippet。
- 因此**不要在容器镜像里 COPY 知识库**。真要打包镜像，用卷挂载：

```
-v /path/to/知识库:/kb:ro
-e KB_DIRS=/kb
```

---

## 六、没做、也没验证的

按「影响面」排序，别把下面这些当成已完成：

1. **Dockerfile 没写**。本机没有 docker，写了也验证不了，就不写一份「看起来能跑」的。
   有了 docker 之后要补的验证：多阶段构建、`node:22-alpine` 下 `next start` 起得来、
   卷挂载后索引能建、镜像里 `private/` 和 `.env.local` 都在 `.dockerignore` 里。
2. **没有 TLS**。走反向代理时在那一层解决。
3. ~~没有进程守护~~ **配置已写，但未验证生效**（W15）：`launchd` plist 就位、
   `KeepAlive` 开着，但本会话注册不了（见第三节·五）。**别把它当成已上线。**
4. **首次请求会慢**：索引 349 ms + 模型冷加载 ~1.5 s，之后单题热态 1.1–1.6 s。
   想压掉冷启动就在启动时预热一次 `GET /api/ask`。
5. **容器的内存**自己量：5389 块索引 + 7B 模型，没在本机做过 cgroup 限制下的测试。
6. **索引缓存的跨版本兼容已修**（W15，见下节），但只验了「旧缓存自动重建」这一条；
   真上线后的滚动更新顺序（先停旧进程再起新进程）还没跑过。

---

## 七、索引缓存跨版本兼容（W15 修掉的那次宕机）

**症状**：dev 服务在 W12 之前启动，`globalThis.__kbIndex` 里躺着一个没有
`sections` 字段的旧索引。W12 代码热更新后执行 `idx.sections.get(...)`，
直接抛 `Cannot read properties of undefined`，网页整页报错，重启才愈。

**根因**：为了「改一行代码不重建 221 ms 索引」把索引挂在了 `globalThis` 上跨热更新存活。
缓存本身没错，错在 `getIndex()` 只判断了「对象在不在」，没判断「对象是不是这一版代码要的」。

**修法**：`Built` 加 `schema` 版本号；`isCurrent()` 同时检查版本、关键字段真的存在、
语料目录没变。旧缓存**存在但缺字段**时自动重建，第一个请求就正常回答。
以后往 `Built` 加必需字段必须 `INDEX_SCHEMA + 1` 并补检查。

判据 `npm run w8:cache`（16/16，不调模型）：手工注入「没有 schema / sections 的旧对象」
「版本号对但字段为空」「空块」「目录变了」四种坏缓存，验证 `getIndex()` 与 `retrieve()`
都不抛、都重建、答案仍带节位标注。
