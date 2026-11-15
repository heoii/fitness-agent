# fitness-agent

**打一句话，问自己的训练记录。**

问「上次练腿是哪天、做了多少组」，它翻记录给你答案，并标出这话出自哪一天哪一节。
问「深蹲这三个月涨了没」，它算出涨跌，并且给两个数（含热身组 / 剔除热身组）。
问「哪些动作我很久没练了」，它把 60 多个动作各算一次最后日期，排出最久的几个。

**只回答记录里写过的东西**——没写过的它说没有，不编。

`npm run dev` 后打开 http://localhost:3000 。

## 它能回答什么

| 你问 | 它做什么 | 要多久* |
|---|---|---|
| 我上次练腿是哪天？ | **找**：翻到那天，列出动作与组数 | 1–4 s |
| 深蹲这三个月涨了没？ | **算**：比两个日期，给「含热身 / 剔除热身」两个结论 | 4–6 s |
| 哪些动作我最久没练了？ | **排**：每个动作取最后一次日期排序，报最久的 5 个 + 全局统计 | **1 ms** |
| 这周比上周练得多还是少？ | **算**：两边分别加总再相减，整条答案由代码算、不过模型 | **1 ms** |
| 这个月一周练几次？ | **算**：分母只算已过天数，不会把未来的日子算成没练 | 1–4 s |
| 我练胸为什么脖子会酸？ | **找**：从当天记录那一节取「归因」那段，并标出它是「本节 5 个小问的第 1 个」 | 2–5 s |
| 库里根本没写的事 | 明说「资料里没有」，不猜、不拿相近的段子凑 | 1–4 s |

*2026-11-15 实测（本机 7B，模型热态；冷启动首问另加约 1.5 s）。**1 ms 的那两行是
整条答案由代码算、不经过模型**——这也是「数字不交给模型」的直接收益。

**它不干什么**：不改记录（要改去练练 App）、不排今天练什么（那是 `training-plan-engine`，
另一套东西）、不算不该算的数（所有数字由工具算，模型只负责组织语言）。

> 里面提到的「11-02 那篇」等，都是把真实记录脱敏后的示例说法；本仓不带任何真实健康数据。

---

## 另一个视角：这是个工程练手项目

从个人训练记录里抽取结构化数据的练手项目。目标不是「做个健身 App」，是把 AI 应用从
「模型能回话」到「能查、能算、能验」这条链路自己走一遍。

上面那节是「用户视角」。每一步怎么做、判据为什么这么设、踩过哪些坑，
都写在知识库的《fitness-agent 工程实现记录》和「我的案例」里，不堆在这个说明上。

**实测报告（可直接看）：https://heoii.github.io/fitness-agent/**

---

## 当前进度

十五个阶段（W1–W15）全部做完，判据全绿。

| 阶段 | 做成了什么 | 状态 |
|---|---|---|
| ① 接口打通 | 本机 7B 能稳定返回中文 | 已完成 |
| ② 结构化输出 | 20 篇力量记录字段全合规 | 20/20 |
| ③ 切片与召回 | 记录按标题切块、向量入库、召回评测 | 已测完，结论是向量没赢过 BM25；数据见报告页 |
| ④ 问答入口 | 打一句话就问，答案带出处；没写过的说没有 | 26 题全过 |
| ⑤ 数值入口 | 涨跌、次数、最近一次、每周频率、比上周多少，全部由代码算 | 已接 |
| ⑥ 荒废与父子节 | 哪些动作很久没练；命中一小问时标出属于哪一节 | 已接 |
| ⑦ 流式与取消 | 字逐个显示、出处先到；点停连模型一起停 | 已完成 |
| ⑧ 控制循环 | 一个问题里有几个对象，就查几次再合并 | 第一层已做 |
| ⑨ 评测与部署 | 评测集、报告页、生产模式、回环绑定、自启配置 | 已验证；登录自启未当场验证，见 `docs/deploy.md` |

## 它是怎么工作的

两件事，都用本机那个 7B 模型。

**① 把记录变成规整数据**：读训练记录 → 只留「动作明细 / 训练摘要」→ 模型按固定字段输出 JSON
→ 两道校验（能不能读、字段对不对）→ 不合格也返回能处理的结果，不报 500。

**② 打一句话问**：把你原话里的废话词剥掉 → 翻出最相关的 5 段 → 模型按这 5 段组织语言
→ 校验答案里的引用编号没越界 → 算数一律走代码，不让模型自己算 → 没找到就说「资料里没有」。

每一步为什么这么设、判据怎么定，写在知识库《fitness-agent 工程实现记录》里。

## 命令

**结构化输出（要跑模型）**

```bash
npm run dev        # 开发服务器
npm run test:5     # 冒烟测试（5 篇力量记录，约 3 分钟）
npm run test:20    # 完整测试（20 篇力量记录，约 15 分钟）
npm run profile    # 只看输入规模，不跑模型（1 秒）
```

**语料 / 切片 / 结构抽取（不调模型，秒级）**

```bash
npm run w3:stats   # 遍历 804 篇 → 条目数 + type/年份分布 + 5 条判据（含递归自洽）
npm run w3:chunk   # 切 3045 个 chunk + 4 条层级判据
npm run w3:parse   # 抽 1214 个动作 + 3 条抽取判据（含容量交叉校验）

# 单篇细看
npx tsx scripts/chunk_dump.ts --doc 2026-11-07-训练-01-腿A        # chunk 树
npx tsx scripts/parse_training.ts --doc 2026-11-07-训练-01-腿A    # 逐组打印
npx tsx scripts/parse_training.ts --json 2026-11-07-训练-01-腿A   # 原始 JSON
```

**向量入库（需要 Ollama + `bge-m3`）**

```bash
ollama pull bge-m3          # 1.2 GB，1024 维；首次要下
npm run w4:embed           # 100 条 → private/embeddings/sample100.json + 3 条判据
npm run w4:embed -- --query "深蹲 掉力"   # 换问题看 top5（可重复传）
npm run w4:embed -- --force              # 语料变了之后重算（默认复用，不重嵌入）
```

**检索评测（需要 Ollama + `bge-m3`）**

```bash
npm run w5:index                        # 全量 3029 chunk → private/embeddings/full.json（约 76s）
npm run w5:eval -- --verify             # 只查标注：15 题的答案是否真能在库里定位（不跑分）
npm run w5:eval                         # 6 种方案 × 15 题，输出 Doc@k / Sec@k / MRR
npm run w5:eval -- --explain S8         # 单题归因：四个方案的 top5 各是什么
npm run w5:eval -- --no-fixed --no-h2   # 只跑标题切那一行（省两次嵌入）
npm run w5:qa                           # 6 道数值题的独立入口（不走向量）
```

向量文件**只落 `private/`**（已 gitignore，且 `git_sync.py` 有一道闸）：chunk 正文是真实训练记录，
这个仓是公开的。

**问答链路（要跑模型）**

```bash
npm run dev                                    # localhost:3000 就是问答页；也支持 /?q=问题
npm run w6:ask                                 # 26 题验收：引用合法 / 可定位 / 承认没找到 / 算数走工具 + 分类准确率
npm run w6:ask -- --only=C                     # 只跑需要算数的那组（改 prompt 时用，全量要 1.5 分钟）
npm run w6:debug -- --q "深蹲最近在涨还是在跌"   # 基线与产品各排一遍，看该命中的排第几
npm run w6:debug -- --q "史密斯深蹲 容量" --expect 2026-11-07 2026-11-14
npm run w6:latency                             # 三段延迟：冷启动 / 加载索引 / 单次查询
npm run w6:llm                                 # 本地 7B 能力边界：拒答 / 表述 / 算数（冷热分离）
```

**数值入口（不调模型，秒级）**

```bash
npm run w7:trend                                # 趋势工具：双口径 + 降级课 + 歧义候选
npm run w7:trend -- 腿举(倒蹬)                  # 换动作看
npm run w7:count                                # 计数工具：次数对人工核过的真值
npm run w7:scope                                # 语料范围实验：只索引每日记录 vs 整个知识库
npm run w7:latest                               # 定位工具：最近一次是那天，对不对
npm run w7:multi                                # 多实体展开：一个问题里有几个对象，是不是都答了
npm run w7:entity                               # 实体识别：并列问句切出来的对象对不对
npm run w7:agg                                  # 聚合与对比：区间边界、每周频率的分母
npm run w7:stale                                # 荒废：每个动作的最晚日期，按天数排序
npm run w7:stream                               # 流式与取消：事件顺序 / token 拼接 / 取消耗时
npm run w7:section                              # 父子节：本节共几问、本条是第几问、兄弟小问列全没
npm run w8:cache                                # 索引缓存：注入旧版本/缺字段/换目录的坏缓存，必须自动重建不崩
npm run w8:service                              # 常驻服务配置：回环绑定 / plist / 日志 / 不谎报安装成功
```

需要本机跑着 Ollama 并已拉取 `qwen2.5:7b-instruct`（只有结构化输出那几个命令需要）：

```bash
ollama list                       # 确认模型在
ollama serve                      # 没在跑就起一下
```

## 目录

```
src/types/training.ts          78 行   记录长什么样（Zod schema）
src/lib/extract.ts            119 行   prompt + 输入清洗 + 两道校验，唯一出处
src/app/api/extract/route.ts   69 行   HTTP 接口
src/lib/corpus.ts             151 行   语料遍历 + frontmatter + 换行符归一，唯一出处（W3）
src/lib/chunk.ts              116 行   按标题层级切片，带 headingPath（W3）
src/lib/training-parse.ts     169 行   训练记录 → 结构化 JSON 的正则，唯一出处（W3）
src/lib/embed.ts              102 行   Ollama 嵌入客户端，模型名走环境变量（W4）
src/lib/vector.ts              77 行   归一化 / 余弦 / top-k，纯函数，不碰网络（W4）
src/lib/embed-store.ts         64 行   向量落盘与读回，默认路径锁在 private/（W4）
src/lib/bm25.ts                96 行   BM25（中文 bigram），评测基线，不是产品代码（W5）
src/lib/retrieve.ts           194 行   产品检索器：BM25 + 查询清洗 + 时间重排 + 引用编号（W6）
src/lib/answer.ts             179 行   W6 prompt 唯一出处 + 引用校验 + 一次完整问答
src/app/api/ask/route.ts       59 行   POST /api/ask（同步）；GET 只回规模不回路径
scripts/compliance.ts         167 行   合规统计
scripts/samples.ts             37 行   样本口径（只取力量记录），统计脚本共用
scripts/profile_inputs.ts     155 行   输入规模画像，不跑模型
scripts/corpus_stats.ts       136 行   W3① 条目数与递归自洽判据
scripts/chunk_dump.ts         145 行   W3② 切片统计与四条层级判据
scripts/parse_training.ts     190 行   W3③ 结构抽取统计与容量交叉校验
scripts/embed_sample.ts       275 行   W4 取样 → 嵌入 → 存盘 → 余弦 + top-k 四条判据
scripts/build_index.ts        108 行   W5 全量入库（3029 chunk → private/）
scripts/w5_questions.ts       248 行   W5 题目与标准答案，冻结的评测契约
scripts/eval_retrieval.ts     330 行   W5 6 方案 × 15 题，含 --verify 与 --explain
scripts/structured_qa.ts      228 行   W5 数值/聚合入口（6 题，不走向量）
scripts/latency_probe.ts      194 行   W6 三段延迟：冷启动 / 加载索引 / 单次查询
scripts/llm_probe.ts          133 行   W6 本地 7B 能力边界：拒答 / 表述 / 算数，冷热分离计量
scripts/query_debug.ts        107 行   W6 检索诊断：基线 vs 产品各排一遍 + 该命中的排第几 + 查询词 DF
scripts/ask_eval.ts           129 行   W6 10 题验收：引用合法 / 可定位 / 承认没找到 / 拒绝算数
src/app/page.tsx              198 行   W6 问答页（角标可点、引用卡片、引用校验徽章）
docs/w2-structured-output.html       验收报告页（结构化输出）
docs/retrieval.html                  验收报告页（W3–W5 检索评测）
docs/index.html                      GitHub Pages 入口
```

---

## 过程记录在哪

这个仓只放「能干嘛、怎么用」。每一步怎么做、判据为什么这么设、踩过哪些坑、
还有哪些没做，都写在知识库（个人云盘，不在这个公开仓里）：

| 内容 | 位置 |
|---|---|
| W3–W15 完整实现记录（失败归因、判据设计、还没做清单） | `03 知识笔记/学习/fitness-agent-工程实现记录.md` |
| W1–W15 台账 | `05 计划与复盘/跟踪/转型学习跟踪.md` |
| 7 篇踩坑案例 | `03 知识笔记/学习/我的案例/` |
| 部署已验证 / 未验证 | 本仓 `docs/deploy.md` |
| 实测报告页 | https://heoii.github.io/fitness-agent/ |

## 部署

**只能自己托管**：要本机 Ollama、要本地知识库目录、索引在进程内建，放不了 Serverless。

```bash
npm run build
npm run start        # 生产模式，写死只听 127.0.0.1:3000
```

- 已验证：构建、同步 / 流式接口、回环 200、局域网 000、产物里 0 处本机路径。
- 未验证：登录自启 / 崩溃拉起（当前会话没有图形登录上下文，`launchctl` 注册不了）。
  在自己的终端跑 `./scripts/service.sh install` 再 `./scripts/service.sh status`，
  看到 `state = running` 才算数，别当成已上线。
- **接口没有登录鉴权**，不要把端口直接暴露到局域网或公网；要手机访问就前置一层带密码的反代。
- 常驻服务：`./scripts/service.sh`（status / logs / install / restart / uninstall）。

完整清单见 `docs/deploy.md`。

## 环境备注

如果 `next dev` 起不来，可以直接用测试脚本打 Ollama：它们和接口共用同一份 prompt 与校验，
验的是同一件事，只是不走 HTTP 那一层。
