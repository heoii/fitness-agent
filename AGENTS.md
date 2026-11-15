<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## git 协作契约（2026-11-15 立 · 对应知识库规则主表 P22）

这个仓是**单机 + 只此一份**，没推就等于没备份——11-15 就有 3 个提交在本机挂了 16 小时。
下面四条是硬规矩，不是建议：

1. **开工前 `git pull --rebase`**；**收工前必须 `push`**。**不许带未推送的提交过夜。**
2. **一次改完、验证通过就提交**（`npm run build` / 脚本跑通），不攒成一个大提交；
   但提交信息要能读懂——写清「改了什么、为什么」，不写 `update` / `fix` 这种空话。
3. **收工一条命令**：`python3 scripts/git_sync.py`（pull --rebase → commit → push）。
   只想看状态：`python3 scripts/git_sync.py --check`（不动任何东西）。
4. **永不进仓**：`node_modules/`、`.next/`、`.env*`、`*.pem`、`.notes/`（私人学习笔记）。
   已在 `.gitignore` 里，别用 `git add -f` 硬来；脚本发现密钥类文件会直接回滚暂存。

跨仓巡检（看两个仓有没有东西没推）：`python3 ~/dev/sync_status.py`。
**自动化档（无人值守的定时任务）不碰 git**——遇到冲突会卡住，push 只在人工会话的收工点做。

## 这个仓是公开作品库：什么能进、什么不能进（2026-11-15 立）

GitHub 上 `heoii/fitness-agent` 是 **PUBLIC**（对 `heoii/personal-system` 是 PRIVATE）。
这里放的是「能给别人看的工程记录」，不是个人数据仓库。

**能进**：源码、脚本、prompt、README、报告页（去个人语境的）、配置**示例**（`KB_DIR=/你的/训练记录目录` 这种占位符）。

**绝对不能进**（真实的东西留在本机知识库或 `private/`）：

| 类别 | 例子 | 放哪儿 |
|---|---|---|
| 真实训练/健康数据 | 训练记录 md、体重体脂、心率、围度 | 个人知识库（本机同步盘），不放仓 |
| 私人笔记、求职材料 | 复盘、面试 Q&A、学习笔记 | `.notes/`（已忽略） |
| 身份信息 | 真实姓名、私人邮箱、手机号 | 哪都别写 |
| 本机路径 | `/Users/<你的用户名>/...`（含用户名就泄露身份） | 用 `~` 或环境变量 |
| 密钥 | API key、`.env*`、`.pem` | 本机 `.env.local`（已忽略） |
| 工作语境 | 公司名、同事姓名、内部项目名 | 改成「某公司/某项目」 |

**灰色地带：示例数据。** 要举例就**虚构**（「某次深蹲 60kg×5」），不要贴真实记录片段；
结论和数字可以留（「20 篇里 2 篇超 2000 tok」），可定位到人的信息不行。

`scripts/git_sync.py` 会做三条闸，命中就拦下 commit 并告诉你第几行：
① `private/` `*.local.json` `.notes/` `.env*` 一旦进暂存区就回滚；
② 扫正文里的姓名/邮箱/本机路径/手机号/凭据形态（`ghp_`、`sk-`、AWS、Google key）；
③ **账本与健康数据特征**（`"ledger":`、`account/merchant/amount`、`垫付/人一/人二`、
`fasting_weight/body_fat/sleep_hours/resting_hr`、`date,…,weight/fat/sleep` 表头）——
这条专防「从私有仓拷一份 `plan.json` 或健康 csv 过来」，前两条对这类文件完全无感。
第 ③ 条只查 `.json` / `.csv`，所以文档里正常讨论「体重」「支付宝」不会误报。

## 计划与判据不在这个仓（规则 P24）

这个仓是**作品**，不是台账。W1–W12 计划、硬目标、判据、卡点都只在个人知识库的
`05 计划与复盘/跟踪/转型学习跟踪.md`；复盘与面试口径在 `03 知识笔记/学习/我的案例/`。
仓里只留**可公开的结论**（README 当前进度、报告页）。

`.notes/` 是**草稿区**，被 gitignore —— 所以**正式内容必须落知识库**，否则等于没有备份。
整仓历史快照在知识库 `代码仓快照/fitness-agent-YYYYMMDD.bundle`（`git bundle create --all`），
丢了本地仓可以 `git clone` 那个 bundle 恢复。



