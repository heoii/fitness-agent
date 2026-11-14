# fitness-agent

从个人训练记录里抽取结构化数据的 Agent 项目。目标不是"做个健身 App"，是把 LLM 应用的工程链路跑通：
结构化输出 → 检索 → 流式 → 控制循环 → 评测。

**第一次打开？先读 [START-HERE.md](./START-HERE.md)。**那里有阅读路线、五个动手实验、和怎么一键跑测试。

---

## 当前进度

| 阶段 | 目标 | 状态 |
|---|---|---|
| W1 | 环境跑通，接口能返回中文 | 已完成 |
| **W2** | **结构化输出：20 次调用 ≥18 次合规** | **19/20 通过**（2026-11-14） |
| W3 | 知识库 md 按标题层级切片 | 未开始 |
| W4–W7 | 向量入库 → 召回 ≥70% → 流式 → 中断 | 未开始 |
| W8–W9 | 控制循环骨架 → 循环可停 | 未开始 |
| W10–W12 | 评测集 → 基线表 → 部署上线 | 未开始 |

## 它是怎么工作的

```
训练记录 md
  → prompt（字段口径固定，禁止新增/改名）
  → qwen2.5:7b-instruct（temperature=0, format=json）
  → 闸一 JSON.parse      能不能读
  → 闸二 Zod             字段对不对
  → 闸三 字段比对         内容对不对（测试脚本独有）
  → ok / 兜底（永不 500）
```

## 三条命令

```bash
npm run dev        # 开发服务器
npm run test:5     # 冒烟测试（5 篇，约 2 分钟）
npm run test:20    # 完整测试（20 篇，约 12 分钟）
```

需要本机跑着 Ollama 并已拉取 `qwen2.5:7b-instruct`：

```bash
ollama list                       # 确认模型在
ollama serve                      # 没在跑就起一下
```

## 目录

```
src/types/training.ts        65 行   记录长什么样（Zod schema）
src/lib/extract.ts           83 行   prompt + 两道校验，唯一出处
src/app/api/extract/route.ts 69 行   HTTP 接口
scripts/compliance.ts       169 行   20 次合规统计
docs/w2-structured-output.html       验收报告页（给人看）
START-HERE.md                        给人看的入口
```

## 已知未解决

- **长记录跑偏**：14 个动作的 `2026-10-22-腿A（股四主导）+腹.md`，模型整篇放弃 schema，
  自造 `trainingSession / workoutPlan / HRV` 等字段，`date` 编成 2023 年。语法合法，只有 Zod 拦得住。
  修法待定（只喂动作明细 / 按 5 动作分块 / 加 few-shot 反例）——先量输入长度与失败率的相关性再决定。
- **HTTP 层未实测**：完整测试是直接请求 Ollama 的，`/api/extract` 那条 route 还没 curl 过。

## 三个设计取舍

1. **单一出处**：prompt 和校验只在 `src/lib/extract.ts` 写一份，接口和测试都 import 它。
   两份实现必然漂移，改了接口那份忘了测试那份，测试会一直绿着而线上已错。
2. **按最坏情况给 token 预算**（2000 而非 900）：代价是中位延迟从 28.3s 升到 39.8s，
   换来截断概率归零。短记录不受影响——预算是上限不是固定开销。
3. **校验失败不抛异常**：返回 `{ok:false, raw, issues}`。接口永远不 500，调用方永远拿得到能处理的东西。

## 环境备注

macOS 沙箱不允许 `next dev` 写 `~/Library/Preferences/nextjs-nodejs/config.json`，
所以有些环境里开发服务器起不来。此时用测试脚本直接打 Ollama 也能验同一件事（共用同一份 prompt 与校验）。
