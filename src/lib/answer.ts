/**
 * 问答的**唯一一份** prompt 与引用校验（W6）。
 *
 * 和 `extract.ts` 同一个原则：route（HTTP）与脚本（评测）都从这里取，
 * 不许各写一份 prompt —— 否则「线上答得烂、脚本跑得好」这种漂移永远查不出来。
 *
 * 这份 prompt 里的第 4 条是拿实测换来的，不是凭直觉写的：
 * 让模型「自己从组次里判断涨跌」时，它会把健康记录里的 1RM 82kg 当成
 * 「最近一次深蹲重量」，跟 60kg 一比，得出「在涨」——而真实数据是持平或微跌。
 * 所以干脆禁止它算：算数走结构化入口（W7 的工具层），它只负责把数字说成人话。
 */
import { retrieve, type Hit } from "./retrieve";
import {
  countTraining,
  getExerciseTrend,
  listExercises,
  resolveMuscle,
  resolvePeriod,
  type CountResult,
  type TrendResult,
} from "./tools";
import { OLLAMA_MODEL, OLLAMA_URL } from "./extract";

export const ASK_NUM_PREDICT = 260;
export const ASK_TIMEOUT_MS = 90_000;
/** 检索几条。5 条是 prompt 长度与召回的经验平衡点，别随手加，token 会线性涨。 */
export const ASK_K = 5;

export interface CitationCheck {
  /** 答案里出现的所有引用编号（去重、按出现顺序） */
  refs: number[];
  /** 越界引用：答案引了 [7] 但只给了 5 条资料 —— 这是编造引用，必须报出来 */
  invalid: number[];
  /** 给了但没被用到的条目 */
  unused: number[];
  /** 模型自己判定「资料里没有」 */
  noAnswer: boolean;
}

export interface Citation {
  n: number;
  doc: string;
  date: string;
  label: string;
  headingPath: string[];
  snippet: string;
  score: number;
}

export interface AskResult {
  ok: boolean;
  answer: string;
  citations: Citation[];
  check: CitationCheck;
  /** 出错时的原因，ok=false 才有 */
  reason?: string;
  meta: {
    model: string;
    ms: { retrieve: number; generate: number; total: number };
    k: number;
    /** 走了哪条入口：retrieve = 语义检索；trend = 数值工具（算好的字段，模型只表述）；
     *  count = 计数工具（遍历全语料数出来的次数） */
    route: "retrieve" | "trend" | "count";
  };
}

export function buildAskPrompt(hits: Hit[], question: string): string {
  const ctx = hits
    .map((h) => `[${h.n}] ${h.label}\n${h.text}`)
    .join("\n\n");
  return `你是个人健身与健康记录的问答助手。严格按顺序遵守下面的规则：

1. 只依据「资料」回答，不许用你自己知道的知识补充。
2. 每条结论后面标出处，格式 [1]、[2]，编号对应资料段落。
3. 资料里没有足够信息时，只回答「资料里没有找到相关内容」，不要猜测、不要编造数字。
4. 资料里的组次和重量按原样引用，**不要自己推算总和、平均或趋势**。
   只有当问题本身就在问「涨了还是跌了」「一共几次」「平均多少」这类需要统计的东西时，
   才回答「这需要结构化统计，我从检索到的组次片段里算不准」，并列出相关的原始数据。
   **其他问题不要附加这句话** —— 把它挂到每个回答后面会变成噪声。
5. 用中文回答，不超过 200 字。

资料：
${ctx}

问题：${question}`;
}

/* ─────────── 数值入口路由（W7） ─────────── */

/** 问趋势的意图。命中后不进检索——这类问题的答案不在任何一段文字里，得靠算。 */
const TREND_INTENT = /涨|跌|进步|退步|趋势|提升|变强|变弱/;

/** 动作名去掉括注和破折号后缀：「腿举(倒蹬)」→「腿举」，「绳索高位下拉-窄距」→「绳索高位下拉」 */
function coreOf(name: string): string {
  return name.replace(/[（(].*?[)）]/g, "").replace(/[-—].*$/, "");
}

/**
 * 从用户原话里认出动作名。
 *
 * 三层尝试，全按**频次降序**（listExercises 已排好），先命中的就是练得最多的那个：
 *   ① 原话里含完整动作名：「史密斯深蹲」
 *   ② 原话里含动作主体：「腿举(倒蹬)」→ 用户说「腿举」
 *   ③ 原话里含动作主体的末两字：用户说「深蹲」，语料里叫「史密斯深蹲」
 *      —— 这一层是必须的，因为日常说法就是短的
 */
function matchExercise(q: string): string | null {
  const names = listExercises();
  for (const n of names) if (q.includes(n)) return n;
  for (const n of names) {
    const c = coreOf(n);
    if (c.length >= 2 && q.includes(c)) return n;
  }
  for (const n of names) {
    const c = coreOf(n);
    if (c.length >= 2 && q.includes(c.slice(-2))) return n;
  }
  return null;
}

function buildTrendPrompt(t: TrendResult, question: string): string {
  const fmt = (p: { date: string; topWeight: number | null; workVolume: number; warmupShare: number }) =>
    `${p.date} 最重${p.topWeight === null ? "自重" : `${p.topWeight}kg`}，工作容量 ${p.workVolume}，` +
    `热身占 ${(p.warmupShare * 100).toFixed(0)}%`;
  const cal = t.calibers
    .map((c) => `- 口径「${c.caliber}」：此前 ${c.beforeAvg} → 最近 ${c.recentAvg}，${c.verdict}（${c.deltaPct}%）
  口径说明：${c.note}`)
    .join("\n");

  return `下面这些数字是系统**已经算好**的，准确，直接用，不要重新计算，也不要引入别的数字。

动作：${t.exercise}（全库 ${t.totalSessions} 次记录）
最近 ${t.recent.length} 次（编号与下面的引用一致）：
${t.recent.map((p, i) => `[${i + 1}] ${fmt(p)}`).join("\n")}
此前 ${t.before.length} 次平均：工作容量 ${Math.round(t.before.reduce((s, p) => s + p.workVolume, 0) / (t.before.length || 1))}

${cal}

系统结论：${t.summary}

要求：
1. 直接用上面的数字回答，**不要自己计算**，也不要引入上面的数字里没有的数。
2. 下面的口径**全都要报**。如果两个口径结论相反，必须把两个都写出来，并说明差异来自热身组占比。
3. 不许只挑一个好看的结论。
4. 至少用 [n] 引用一条明细，编号对应上面方括号里的数字。
5. 用中文，不超过 150 字。

问题：${question}`;
}

export function checkAnswer(answer: string, k: number): CitationCheck {
  const refs: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (!refs.includes(n)) refs.push(n);
  }
  const all = Array.from({ length: k }, (_, i) => i + 1);
  return {
    refs,
    invalid: refs.filter((n) => n < 1 || n > k),
    unused: all.filter((n) => !refs.includes(n)),
    noAnswer: /没有找到|没找到|无相关|资料中没有/.test(answer),
  };
}

/** 调一次本机 Ollama，只要纯文本。失败就抛，由调用方决定兜底方式。 */
async function generateOnce(prompt: string, numPredict = ASK_NUM_PREDICT): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0, num_predict: numPredict },
      }),
    });
    if (!res.ok) throw new Error(`Ollama 返回 ${res.status}`);
    const json = (await res.json()) as { response?: string };
    const text = (json.response ?? "").trim();
    if (!text) throw new Error("模型返回空");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 趋势结果转引用：用的是哪几次训练，就引哪几篇 */
function trendCitations(t: TrendResult): Citation[] {
  return t.recent.map((p, i) => ({
    n: i + 1,
    doc: p.docName,
    date: p.date,
    label: `${p.docName} > ${p.session || "训练"} > 动作明细`,
    headingPath: [p.session || "训练", "动作明细"],
    snippet: `${p.date} 最重 ${p.topWeight === null ? "自重" : `${p.topWeight}kg`}，正式组 ${p.workSets}，工作容量 ${p.workVolume}`,
    score: 0,
  }));
}

/**
 * 数值入口：趋势题不进检索。
 *
 * 这里用**预取式**而不是让模型自己决定调哪个工具——理由是控制权：
 * 是否走这条路先由规则判定，模型只负责把算好的字段说成人话。
 * 真正的「模型自己决定再查一次」留到控制循环（M3），那是另一层能力。
 * 工具失败就返回 null，让检索兜底，宁可退化也不要在这条路上硬答。
 */
async function tryTrend(question: string, t0: number): Promise<AskResult | null> {
  if (!TREND_INTENT.test(question)) return null;
  const name = matchExercise(question);
  if (!name) return null;

  let trend: TrendResult;
  try {
    trend = getExerciseTrend(name);
  } catch {
    return null;
  }
  if (!trend.ok) return null;

  const tG = Date.now();
  let answer: string;
  try {
    answer = await generateOnce(buildTrendPrompt(trend, question), 200);
  } catch {
    return null;
  }

  const cites = trendCitations(trend);
  const k = Math.max(1, cites.length);
  return {
    ok: true,
    answer,
    citations: cites,
    check: checkAnswer(answer, k),
    meta: {
      model: OLLAMA_MODEL,
      ms: { retrieve: 0, generate: Date.now() - tG, total: Date.now() - t0 },
      k,
      route: "trend",
    },
  };
}

/* ─────────── 计数入口 ─────────── */

/**
 * 问次数的意图。
 *
 * 和趋势意图是两回事：趋势问「变化」，计数问「总数」。
 * 但两者有同一个陷阱——答案不在任何一段文字里，而在**全集**上。
 * C2「我这个月一共练了几次腿」曾经答成 1 次，依据是检索到的片段里
 * 有一句「11 月 4 日腿日被取消」。引用是真的，推理链也成立，
 * 唯独前提错了：top5 是最相关的 5 条，不是全部 5 条。
 */
const COUNT_INTENT = /几次|多少次|几回|几趟/;

function buildCountPrompt(c: CountResult, question: string): string {
  // 编号必须和 citations 的 n 对齐（countCitations 就是按 rows 顺序给 n），
  // 否则模型引 [2] 会指到别的课上——引用错了比不引更糟
  const rows = c.rows
    .map(
      (r, i) =>
        `[${i + 1}] ${r.date} ${r.session || "训练"}｜重点部位 ${r.muscleFocus.join("/") || "无"}｜` +
        `动作 ${r.exercises.join("、")}${r.degraded ? "｜降级课" : ""}`
    )
    .join("\n");

  return `下面的次数是系统**遍历全部训练记录数出来的**，准确，直接引用。

统计对象：${c.target}
区间：${c.periodLabel}（${c.from} ~ ${c.to}）
重点次数：${c.focusCount}
含兼带次数：${c.withSecondary}
命中明细：
${rows}

口径说明：${c.caliber}

系统结论：${c.summary}

要求：
1. 直接报上面的数字，**不要自己从明细里重新数**，也不要加减。
2. 两个数都要报：以它为**重点**的几次、把它**算上辅助**的几次。只报一个会误导。
3. 必须点明区间（${c.periodLabel}），否则「几次」没有意义。
4. 报次数时用 [n] 标出依据的是哪几条明细，编号对应上面方括号里的数字。
5. 不要提到「计划里取消的课」之类不在明细里的东西来推断次数。
6. 中文，不超过 120 字。

问题：${question}`;
}

/**
 * 计数入口。
 *
 * 工具明确说「区间内没有记录」时**不走模型**，直接回确定性句子——
 * 让 7B 去复述一个空结果，它有一定概率自己补一个数字出来，
 * 而这里根本没有需要润色的内容。
 */
async function tryCount(question: string, t0: number): Promise<AskResult | null> {
  if (!COUNT_INTENT.test(question)) return null;
  const muscle = resolveMuscle(question);
  const exercise = muscle ? null : matchExercise(question);
  if (!muscle && !exercise) return null;

  const period = resolvePeriod(question);
  let c: CountResult;
  try {
    c = countTraining({ muscle, exercise, period });
  } catch {
    return null;
  }

  const emptyCheck = { refs: [] as number[], invalid: [] as number[], unused: [] as number[], noAnswer: true };
  if (!c.ok) {
    // 空结果直接给，不过模型：这里是事实陈述，没有可润色的空间
    return {
      ok: true,
      answer: `${c.periodLabel}（${c.from} ~ ${c.to}）没有以「${c.target}」为参与部位的训练记录。` +
        `如果这个统计口径不对（比如你想问的是别的部位），告诉我具体名字我再数。`,
      citations: [],
      check: emptyCheck,
      meta: {
        model: OLLAMA_MODEL,
        ms: { retrieve: 0, generate: 0, total: Date.now() - t0 },
        k: 0,
        route: "count",
      },
    };
  }

  const cites = countCitations(c);
  const tG = Date.now();
  let answer: string;
  try {
    answer = await generateOnce(buildCountPrompt(c, question), 180);
  } catch {
    // 模型挂了就直接用工具的话说——数字是算好的，不依赖模型
    answer = c.summary.split("\n")[0];
  }

  return {
    ok: true,
    answer,
    citations: cites,
    check: checkAnswer(answer, Math.max(1, cites.length)),
    meta: {
      model: OLLAMA_MODEL,
      ms: { retrieve: 0, generate: Date.now() - tG, total: Date.now() - t0 },
      k: Math.max(1, cites.length),
      route: "count",
    },
  };
}

/** 命中明细转引用：数到几次就引几篇，用户能逐条核 */
function countCitations(c: CountResult): Citation[] {
  return c.rows.map((r, i) => ({
    n: i + 1,
    doc: r.docName,
    date: r.date,
    label: `${r.docName} > ${r.session || "训练"} > 动作明细`,
    headingPath: [r.session || "训练", "动作明细"],
    snippet: [r.muscleFocus.length ? `重点 ${r.muscleFocus.join("/")}` : "", r.exercises.join("、")]
      .filter(Boolean)
      .join("｜"),
    score: 0,
  }));
}

function toCitation(h: Hit, snippetChars = 180): Citation {
  return {
    n: h.n,
    doc: h.doc,
    date: h.date,
    label: h.label,
    headingPath: h.headingPath,
    snippet: h.text.slice(0, snippetChars),
    score: Number(h.score.toFixed(2)),
  };
}

/**
 * 一次完整的问答：检索 → 组装 → 生成 → 校验。
 * 不抛异常，失败也返回结构化结果（和 /api/extract 的「永不 500」保持一致）。
 */
export async function ask(question: string, opts: { k?: number } = {}): Promise<AskResult> {
  const k = opts.k ?? ASK_K;
  const t0 = Date.now();

  // 数值入口优先：这类题的答案不在任何一段文字里，检索给不了，模型也算不准。
  // 计数先判——「练了几次深蹲」同时含动作名，但问的是总数不是趋势。
  const viaCount = await tryCount(question, t0);
  if (viaCount) return viaCount;

  const viaTool = await tryTrend(question, t0);
  if (viaTool) return viaTool;

  let hits: Hit[];
  const tR = Date.now();
  try {
    hits = retrieve(question, { k });
  } catch (e) {
    return {
      ok: false,
      answer: "",
      citations: [],
      check: { refs: [], invalid: [], unused: [], noAnswer: false },
      reason: e instanceof Error ? e.message : "检索失败",
      meta: { model: OLLAMA_MODEL, ms: { retrieve: 0, generate: 0, total: Date.now() - t0 }, k, route: "retrieve" },
    };
  }
  const retrieveMs = Date.now() - tR;

  if (!hits.length) {
    return {
      ok: true,
      answer: "资料里没有找到相关内容。",
      citations: [],
      check: { refs: [], invalid: [], unused: [], noAnswer: true },
      meta: { model: OLLAMA_MODEL, ms: { retrieve: retrieveMs, generate: 0, total: Date.now() - t0 }, k, route: "retrieve" },
    };
  }

  const tG = Date.now();
  let answer: string;
  try {
    answer = await generateOnce(buildAskPrompt(hits, question));
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError" ? "模型推理超时" : e instanceof Error ? e.message : "生成失败";
    return {
      ok: false,
      answer: "",
      citations: hits.map((h) => toCitation(h)),
      check: { refs: [], invalid: [], unused: hits.map((h) => h.n), noAnswer: false },
      reason: msg,
      meta: { model: OLLAMA_MODEL, ms: { retrieve: retrieveMs, generate: Date.now() - tG, total: Date.now() - t0 }, k, route: "retrieve" },
    };
  }
  const generateMs = Date.now() - tG;

  return {
    ok: true,
    answer,
    citations: hits.map((h) => toCitation(h)),
    check: checkAnswer(answer, hits.length),
    meta: { model: OLLAMA_MODEL, ms: { retrieve: retrieveMs, generate: generateMs, total: Date.now() - t0 }, k, route: "retrieve" },
  };
}
