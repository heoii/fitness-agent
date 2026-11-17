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
import { retrieve, type Hit, type SectionSlot } from "./retrieve";
import {
  countTraining,
  latestSession,
  resolveCompare,
  staleExercises,
  getExerciseTrend,
  matchExercise,
  entitiesIn,
  resolveMuscle,
  resolvePeriod,
  type CountResult,
  type Entity,
  type LatestResult,
  type TrendResult,
} from "./tools";
import { OLLAMA_MODEL, OLLAMA_URL } from "./extract";
import { tryPlanSession } from "./plan-session";

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
  /** 命中的是某节下的小问时，标出「第 i/N 个」；数值入口的引用来没有这个字段 */
  section?: SectionSlot;
}

export interface AskResult {
  ok: boolean;
  answer: string;
  citations: Citation[];
  check: CitationCheck;
  /** 排计划时才有：结构化三档，供小程序画表格；其余情况为 null/缺省 */
  plan?: PlanData | null;
  /** 出错时的原因，ok=false 才有 */
  reason?: string;
  meta: {
    model: string;
    ms: { retrieve: number; generate: number; total: number };
    k: number;
    /** 走了哪条入口：retrieve = 语义检索；trend = 数值工具（算好的字段，模型只表述）；
     *  count = 计数工具（遍历全语料数出来的次数）
     *  latest = 定位工具（遍历全语料取的最晚一条）
     *  compare = 区间对比（两个区间的次数与每周频率，答案全部由代码算出）
     *  stale = 最久没练（对每个动作取最晚日期再排序，答案由代码算出）
     *  plan = 排计划（调本机排课引擎出三档，答案全部由代码算出、不过模型） */
    route: Route;
  };
}

export type Route = "retrieve" | "trend" | "count" | "latest" | "compare" | "stale" | "plan";

/**
 * 「这次问答该怎么答」的决策结果。
 *
 * 拆出这一层是为了让**同步（脚本评测）和流式（页面）共用同一份路由逻辑**。
 * 上一版把路由写在 `tryTrend/tryCount` 里、生成紧跟着发生，于是流式要么复制一遍
 * 判断（两份必然漂移），要么把流式硬塞进同步函数。路由和生成是两件事，分开。
 */
/**
 * 排计划的结构化结果（2026-11-17）。
 *
 * 为什么不再只给一段长文本：手机上那串「动作 组×次 @ 重量，组间 120s…」堆在一起
 * 根本读不动，用户要的是表格。数字仍然全部由引擎算，这个结构只是把同一份结果
 * 按行列摆好，**不新增任何计算**。
 */
export interface PlanRow {
  name: string;
  sets: number;
  reps: string;
  weight: string;
  rest: string;
  fail: boolean;
  warmup: string;
}

export interface PlanTierData {
  tier: string;
  isDefault: boolean;
  desc: string;
  totalSets: number;
  rows: PlanRow[];
}

export interface PlanData {
  date: string;
  judge: string;
  statusLine: string;
  parts: string;
  dims: { name: string; level: string; detail: string }[];
  tiers: PlanTierData[];
  note: string;
}

export interface Plan {
  route: Route;
  citations: Citation[];
  /** 结构化计划；只有 route=plan 时存在。文本版 fixedAnswer 仍保留，给网页端与降级用 */
  planData?: PlanData;
  /** 引用条数上界，`checkAnswer` 用它判越界 */
  k: number;
  /** null = 不需要模型（结果已经确定，比如区间内一条记录都没有） */
  prompt: string | null;
  fixedAnswer?: string;
  retrieveMs: number;
  numPredict: number;
  /**
   * 生成之后由**代码**追加的一段，不进 prompt。
   *
   * 用它是因为有些事实必须说、但不能交给模型说：歧义提示里带着「罗马尼亚硬拉 08-22」
   * 这种日期，而这些日期没有引用编号（引用是给主答案准备的），
   * 让 7B 复述并列日期它一定会选错——A8 那次把「更早一次 11-07」当成答案报出来了。
   * 凡是模型不该碰的数字，都由代码写。
   */
  trailer?: string;
}

/**
 * 一条资料的定位行（W12）。
 *
 * 命中子节时补一行「本节 N 小问的第 i 个」，并把同节其他小问的标题列出来。
 * 这不是排版美化：`[6] … > 明天（11-03 拉日）怎么办` 和 `[3] … > 归因：三个动作同一个机制`
 * 在模型眼里是同一层级的两段话，而问的是「为什么」——不标出层级，7B 必然拿「怎么办」答「为什么」。
 */
function hitHeader(h: Hit): string {
  const head = `[${h.n}] ${h.label}`;
  if (!h.section) return head;
  const s = h.section;
  const others = s.siblings.filter((x) => x !== s.siblings[s.index - 1]);
  const short = (t: string) => (t.length > 16 ? `${t.slice(0, 16)}…` : t);
  const rest = others.length ? `本节还有：${others.map(short).join("｜")}` : "";
  return `${head}\n    § 本节 ${s.total} 个小问的第 ${s.index} 个${rest ? `。${rest}` : ""}`;
}

export function buildAskPrompt(hits: Hit[], question: string): string {
  const ctx = hits
    .map((h) => `${hitHeader(h)}\n${h.text}`)
    .join("\n\n");
  // **不要给「这一小问对不对题」的判断指令**。试过两版，都撞墙：
  //   第一版给了出口「命中的都是别的小问就说资料里没有」→ A5 拿它当开场白，
  //     明明命中「关键技术要点」就是答案，却说「资料里没有直接回答这个的段落」；
  //     A2 更是用这个出口替掉了规则 4 要的「两者不是一回事」。
  //   第二版改成「先判断它是不是你问的那一问」→ 一样保守，A5 仍然以「没找到」开场。
  //   A/B 对照（同一批资料、只删标注）证实差异来自这条规则本身。
  // 根子在于：让 7B 判断「这一小问对不对题」，它判不准，判不准就退回拒答。
  // 所以只给**事实标注**（本节共 5 问、本条是第 5 个、同节还有哪几问），不给判断权——
  // 它读得懂并列结构，但别指望它做取舍。这跟「数字由代码算、模型只表述」是同一条纪律。
  return `你是个人健身与健康记录的问答助手。严格按顺序遵守下面的规则：

1. 只依据「资料」回答，不许用你自己知道的知识补充。
2. 每条结论后面标出处，格式 [1]、[2]，编号对应资料段落。
3. 资料里没有足够信息时，只回答「资料里没有找到相关内容」，不要猜测、不要编造数字。
4. **如果问题的前提本身就被资料纠正了，先说纠正，再回答。**
   典型：问「减载期、恢复期、增长期的门槛」——资料里「减载期/增长区」是 ACWR 的三个区间，
   而「恢复」是另一套划分（被动、2–4 周），两者不在同一层。
   这种情况先指出「这两个不是一回事」，再各自回答。顺着错的框架答，
   用户会以为自己的理解没问题——那比答不出更糟。
   **资料里没有这种纠正时不要硬找**，正常回答即可。
5. 资料里的组次和重量按原样引用，**不要自己推算总和、平均或趋势**。
   只有当问题本身就在问「涨了还是跌了」「一共几次」「平均多少」这类需要统计的东西时，
   才回答「这需要结构化统计，我从检索到的组次片段里算不准」，并列出相关的原始数据。
   **其他问题不要附加这句话** —— 把它挂到每个回答后面会变成噪声。
6. 用中文回答，不超过 200 字。

资料：
${ctx}

问题：${question}`;
}

/* ─────────── 数值入口路由（W7） ─────────── */

/** 问趋势的意图。命中后不进检索——这类问题的答案不在任何一段文字里，得靠算。 */
const TREND_INTENT = /涨|跌|进步|退步|趋势|提升|变强|变弱/;

/** 一次训练的点位描述，趋势 prompt 里每个明细行都用它 */
function trendPointLine(p: { date: string; topWeight: number | null; workVolume: number; warmupShare: number }): string {
  return (
    `${p.date} 最重${p.topWeight === null ? "自重" : `${p.topWeight}kg`}，工作容量 ${p.workVolume}，` +
    `热身占 ${(p.warmupShare * 100).toFixed(0)}%`
  );
}

/** 一个动作的各口径结论 */
function trendCaliberLines(t: TrendResult): string {
  return t.calibers
    .map(
      (c) => `- 口径「${c.caliber}」：此前 ${c.beforeAvg} → 最近 ${c.recentAvg}，${c.verdict}（${c.deltaPct}%）
  口径说明：${c.note}`
    )
    .join("\n");
}

const trendBeforeAvg = (t: TrendResult) =>
  Math.round(t.before.reduce((s, p) => s + p.workVolume, 0) / (t.before.length || 1));

/**
 * 趋势 prompt。单动作时输出**和加多实体之前一字不差**（19 题验收过的是这条路）。
 *
 * 多动作是大模型最容易被绕晕的地方：2 个动作 × 2 个口径 = 4 个百分比，
 * 只要 prompt 不给每个动作划出清晰的边界，它就会把深蹲的跌幅安到卧推头上。
 * 所以用 `━━ 对象 N ━━` 硬分块，并且要求「每个对象分开报，不要横向比较」——
 * 「哪个涨得多」这种比较由用户自己看，不让模型做（它算不准，也不许算）。
 */
function buildTrendPrompt(
  got: TrendResult[],
  offsets: number[],
  question: string,
  empties: string[]
): string {
  if (got.length === 1) {
    const t = got[0];
    return `下面这些数字是系统**已经算好**的，准确，直接用，不要重新计算，也不要引入别的数字。

动作：${t.exercise}（全库 ${t.totalSessions} 次记录）
最近 ${t.recent.length} 次（编号与下面的引用一致）：
${t.recent.map((p, i) => `[${offsets[0] + i}] ${trendPointLine(p)}`).join("\n")}
此前 ${t.before.length} 次平均：工作容量 ${trendBeforeAvg(t)}

${trendCaliberLines(t)}

系统结论：${t.summary}

要求：
1. 直接用上面的数字回答，**不要自己计算**，也不要引入上面的数字里没有的数。
2. 下面的口径**全都要报**。如果两个口径结论相反，必须把两个都写出来，并说明差异来自热身组占比。
3. 不许只挑一个好看的结论。
4. 至少用 [n] 引用一条明细，编号对应上面方括号里的数字。
5. 用中文，不超过 150 字。

问题：${question}`;
  }

  // ── 多动作 ──
  const blocks = got
    .map((t, i) => {
      const rows = t.recent.map((p, j) => `[${offsets[i] + j}] ${trendPointLine(p)}`).join("\n");
      return `━━ 对象 ${i + 1}：${t.exercise}（全库 ${t.totalSessions} 次记录）━━
最近 ${t.recent.length} 次：
${rows}
此前 ${t.before.length} 次平均：工作容量 ${trendBeforeAvg(t)}
${trendCaliberLines(t)}`;
    })
    .join("\n\n");

  const missNote = empties.length ? `\n\n算不出来的：${empties.join("；")}——必须明说算不出，不要跳过不提。` : "";

  /*
   * 填空模板，不是「请把两个口径都报」这种嘱咐。
   *
   * 实测嘱咐没用：给两个动作各两个口径（4 个百分比，2 个方向相反）时，
   * 7B 只报了「基本持平」那两个 —— 正好是**好看的那个**，
   * 于是「不许只挑一个好看的结论」这条要求形同虚设。
   * 换成逐行模板后，它要吐的字数结构被固定住，漏一个字段一眼就能看出来，
   * 判据也才能逐行查「每个对象是不是真有两个百分比」。
   */
  const short = (caliber: string) => caliber.split("（")[0];
  const cols = got[0].calibers.map((c) => short(c.caliber));
  const template = got
    .map((t) => `- ${t.exercise}｜${cols.map((c) => `${c}：<涨跌幅>% <结论>`).join("｜")}`)
    .join("\n");

  return `下面这些数字是系统**已经算好**的，准确，直接用，不要重新计算，也不要引入别的数字。

${blocks}${missNote}

回答必须**逐行照下面这个模板填**，行数、顺序都不许变，每一行的每个口径都要填满：

${template}

要求：
1. 模板里每一行对应一个对象，共 ${got.length} 行，一行都不能少；漏一行答案就是错的。
2. 每行必须出现**该对象的全部 ${cols.length} 个口径**（${cols.join(" / ")}），一个都不许省。两个口径方向相反时，都必须写出来。
3. 只填模板里的数，不要加横向比较（谁涨得多需要跨动作归一化，系统没做，你也不许猜）。
4. 不许把一个对象的数字安到另一个对象头上。
5. 每行末尾用 [n] 标一条该对象自己的明细，编号就是上面方括号里的数字，不要错位。
6. 模板之后**不要写自由总结**。如果确实想说一句，只能说「哪些对象的两个口径方向不一致」，
   别的结论一律不许加——实测它会写「杠铃卧推在两个口径下均有所下降」，
   而表格里剔除热身明明是「基本持平」：总结和表格打架比没有总结更糟。
7. 中文，不超过 260 字。

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
    // 「没有…记录」也要算：计数入口的空结果说的是「没有以「腿」为参与部位的训练记录」，
    // 语义上就是没找到，但第一版正则只认「没有找到」，于是这个 badge 不亮——
    // 判定漏了比判定错了更难发现，因为界面上什么都不显示。
    noAnswer: /没有找到|没找到|无相关|资料中没有|没有.{0,30}记录/.test(answer),
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
    // 末尾必须是**动作名**而不是「动作明细」：同一天练两个动作时（11-14 既深蹲又腿举），
    // 两张卡片会一字不差，用户根本分不清哪张对应哪个动作——引用就白引了
    label: `${p.docName} > ${p.session || "训练"} > ${t.exercise}`,
    headingPath: [p.session || "训练", t.exercise],
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
 * 工具给不出结论（比如自重/负重混在一起、正常档不足 3 次）就返回 null，
 * 让检索兜底，宁可退化也不要在这条路上硬答。
 */
function planTrend(question: string): Plan | null {
  if (!TREND_INTENT.test(question)) return null;
  // 只有动作能算趋势：部位的趋势得先把不同动作归一化，那是另一件事，
  // 硬算会得出「练腿的容量涨了」这种把深蹲和腿举加在一起的假结论
  const ents = entitiesIn(question).filter((e) => e.kind === "exercise");
  if (!ents.length) return null;

  const got: TrendResult[] = [];
  const empties: string[] = [];
  const sibNotes: string[] = [];
  for (const ent of ents) {
    try {
      const t = getExerciseTrend(ent.name);
      if (t.ok) got.push(t);
      else empties.push(`「${ent.name}」${t.reason ?? "趋势算不出来"}`);
    } catch {
      empties.push(`「${ent.name}」查询失败`);
    }
    if (ent.siblings.length) {
      const tail = ent.name.slice(-2);
      sibNotes.push(`「${ent.name}」是按「${tail}」这一档里练得最多的一个算的，语料里还有：${ent.siblings.join("、")}。要换一个说一声。`);
    }
  }

  // 全部算不出就让检索兜底：宁可退化也不要在这条路上硬答
  if (!got.length) return null;

  const cites: Citation[] = [];
  const offsets: number[] = [];
  for (const t of got) {
    const base = cites.length;
    offsets.push(base + 1);
    for (const x of trendCitations(t)) cites.push({ ...x, n: base + x.n });
  }

  return {
    route: "trend",
    citations: cites,
    k: Math.max(1, cites.length),
    prompt: buildTrendPrompt(got, offsets, question, empties),
    retrieveMs: 0,
    numPredict: got.length > 1 ? 300 : 200,
    trailer: sibNotes.length ? sibNotes.join("\n") : undefined,
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

/** 一个统计对象的明细块。offset = 它在合并后引用列表里的起始编号减一 */
function countRowsBlock(c: CountResult, offset: number): string {
  return c.rows
    .map(
      (r, i) =>
        `[${offset + i + 1}] ${r.date} ${r.session || "训练"}｜重点部位 ${r.muscleFocus.join("/") || "无"}｜` +
        `动作 ${r.exercises.join("、")}${r.degraded ? "｜降级课" : ""}`
    )
    .join("\n");
}

/**
 * 计数 prompt。
 *
 * 单对象时输出**和加多实体之前一字不差**——19 题验收已经过了那条路，
 * 新功能不该顺手改动已验证的东西。多对象才走下面那个分支。
 */
function buildCountPrompt(
  got: CountResult[],
  offsets: number[],
  question: string,
  empties: string[],
  wantsRate: boolean
): string {
  // ── 全部训练（没有部位/动作）──
  // 「我练了几次」「平均每周几次」问的是总量，没有双口径可言。
  // 硬套「重点 / 算上辅助」会输出两个一模一样的数，模型还会把它们说成两件事。
  if (got.length === 1 && got[0].target === "全部训练") {
    const c = got[0];
    const w = c.perWeek;
    const rate = wantsRate
      // 用精确天数算，不用 weeks 字段——它是四舍五入过的（15 天 → 2.1 周），
      // 拿它做除法，10 次会算成每周 4.8，实际是 4.7
      ? `\n平均频率：${w.count} 次 / ${w.days} 天 = **每周 ${(w.count / (w.days / 7)).toFixed(1)} 次**（分母是已过的 ${w.days} 天，不是整月天数）`
      : "";
    return `下面的次数是系统**遍历全部训练记录数出来的**，准确，直接引用。

统计对象：全部训练课（不分部位）
区间：${c.periodLabel}（${c.from} ~ ${c.to}）
总课数：${c.withSecondary}${rate}
命中明细：
${countRowsBlock(c, offsets[0] - 1)}

口径说明：${c.caliber}

系统结论：${c.summary}

要求：
1. 直接报上面的数字，**不要自己从明细里重新数**，也不要拿别处的「平均间隔」去换算频率。
2. 只报一个总数，不要说成某个部位的次数。
${wantsRate ? `3. 必须报出「每周 X 次」，并说明分母是已过的 ${w.days} 天——不说分母，这个频率没法核对。\n` : ""}4. 必须点明区间（${c.periodLabel}）。
5. 中文，不超过 100 字。

问题：${question}`;
  }

  if (got.length === 1) {
    const c = got[0];
    return `下面的次数是系统**遍历全部训练记录数出来的**，准确，直接引用。

统计对象：${c.target}
区间：${c.periodLabel}（${c.from} ~ ${c.to}）
重点次数：${c.focusCount}
含兼带次数：${c.withSecondary}
命中明细：
${countRowsBlock(c, offsets[0] - 1)}

口径说明：${c.caliber}

系统结论：${c.summary}

要求：
1. 直接报上面的数字，**不要自己从明细里重新数**，也不要加减。
2. 两个数都要报：以它为**重点**的几次、把它**算上辅助**的几次。只报一个会误导。
   数字直接写在句子里（如「2 次」），**不要用引用编号代替数字**——写成「课 [3] 次」会被读成编号。
3. 必须点明区间（${c.periodLabel}），否则「几次」没有意义。
4. 报次数时用 [n] 标出依据的是哪几条明细，编号对应上面方括号里的数字。
5. 不要提到「计划里取消的课」之类不在明细里的东西来推断次数。
6. 中文，不超过 120 字。

问题：${question}`;
  }

  // ── 多对象 ──
  const blocks = got
    .map((c, i) => {
      const rows = countRowsBlock(c, offsets[i] - 1);
      return `━━ 对象 ${i + 1}：${c.target} ━━
重点次数：${c.focusCount}　含兼带次数：${c.withSecondary}
口径：${c.caliber}
命中明细：
${rows}`;
    })
    .join("\n\n");

  const missNote = empties.length
    ? `\n\n查不到的：${empties.join("；")}——必须在答案里明说没有，不要跳过不提。`
    : "";

  return `下面的次数是系统**遍历全部训练记录数出来的**，准确，直接引用。

统计区间：${got[0].periodLabel}（${got[0].from} ~ ${got[0].to}）

${blocks}${missNote}

要求：
1. 直接报上面的数字，**不要自己从明细里重新数**，也不要加减。
2. **每个对象都要报**：共 ${got.length} 个对象，就答 ${got.length} 个，漏一个答案就是错的。
3. 每个对象都报两个数：以它为**重点**的几次、把它**算上辅助**的几次。数字直接写（如「2 次」），不要用引用编号代替数字。
4. 必须点明区间（${got[0].periodLabel}）。
5. 报次数时用 [n] 标依据的明细，编号就是上面方括号里的数字，不要错位。
6. 不要提到「计划里取消的课」之类不在明细里的东西来推断次数。
7. 中文，不超过 220 字。

问题：${question}`;
}

/**
 * 计数入口。
 *
 * 工具明确说「区间内没有记录」时**不走模型**，直接回确定性句子——
 * 让 7B 去复述一个空结果，它有一定概率自己补一个数字出来，
 * 而这里根本没有需要润色的内容。
 */
/* ─────────── 定位入口：最近一次是什么时候 ─────────── */

/**
 * 「上次 / 最近一次 / 什么时候」。
 *
 * 这题检索答不出来——实测 top5 里明明有 11-15 的游泳记录，7B 仍回「资料里没有找到」。
 * 因为答案不在任何一段文字里，它是全库上的 max(date)，还要排除计划文档里
 * 「~~游泳自练②~~」这种写了但没做的事。和计数同一类，只是聚合函数不同。
 */
const LOCATE_INTENT = /上次|上回|上一次|最近一次|什么时候|哪一天|哪天|多久没/;

function planLatest(question: string): Plan | null {
  if (!LOCATE_INTENT.test(question)) return null;
  // 认不出「问的是哪个部位/动作」就不接：像「什么时候该减载」这种问的是规则，
  // 硬按「最近一次减载」去查会给出一个驴唇不对马嘴的日期
  const ents = entitiesIn(question);
  if (!ents.length) return null;

  // 逐实体查。问「上次腿课和上次胸课分别是什么时候」时，旧实现只拿第一个命中的部位，
  // 胸直接消失——不报错、也不承认漏了，界面上看起来是完整答案。
  const got: Array<{ ent: Entity; r: LatestResult }> = [];
  const misses: string[] = [];
  const sibNotes: string[] = [];
  for (const ent of ents) {
    try {
      const r = latestSession(ent.kind === "muscle" ? { muscle: ent.name } : { exercise: ent.name });
      if (r.ok) got.push({ ent, r });
      else misses.push(`${ent.name}：${r.reason}`);
    } catch {
      misses.push(`${ent.name}：查询失败`);
    }

    // 同名后缀的其他动作：用户说「硬拉」时语料里有五种，我们按频次选了「杠铃硬拉」，
    // 但最近练的是「罗马尼亚硬拉」。两边都查得出日期、都像对的，
    // 所以把日期一并给出，让用户自己认，别替他选。
    if (ent.kind === "exercise" && ent.siblings.length) {
      const parts: string[] = [];
      for (const n of ent.siblings) {
        try {
          const s2 = latestSession({ exercise: n });
          if (s2.ok) parts.push(`${n} ${s2.date}（距今 ${s2.daysAgo} 天）`);
        } catch {
          /* 单个候选查不到不影响主答案 */
        }
      }
      if (parts.length)
        sibNotes.push(
          `「${ent.name}」我按语料里练得最多的那个算。你说的也可能是：${parts.join("、")}。要哪个说一声，我按那个查。`
        );
    }
  }

  if (!got.length)
    return {
      route: "latest",
      citations: [],
      k: 0,
      prompt: null,
      fixedAnswer: `${misses.join("；")}。如果统计口径不对（比如你想问的是别的部位），告诉我具体名字我再查。`,
      retrieveMs: 0,
      numPredict: 0,
    };

  return {
    route: "latest",
    citations: got.map(({ r }, i) => ({
      n: i + 1,
      doc: r.docName,
      date: r.date,
      label: `${r.docName} > ${r.session || "训练"} > 动作明细`,
      headingPath: [r.session || "训练", "动作明细"],
      snippet: [r.muscleFocus.length ? `重点 ${r.muscleFocus.join("/")}` : "", r.exercises.join("、")]
        .filter(Boolean)
        .join("｜"),
      score: 0,
    })),
    k: got.length,
    prompt: buildLatestPrompt(got, question, misses),
    retrieveMs: 0,
    // 多实体回答要逐个报，字数上限得放开，否则会写到第二个就断
    numPredict: got.length > 1 ? 200 : 120,
    trailer: sibNotes.length ? sibNotes.join("\n") : undefined,
  };
}

function buildLatestPrompt(
  got: Array<{ ent: Entity; r: LatestResult }>,
  question: string,
  misses: string[]
): string {
  const blocks = got
    .map(({ ent, r }, i) => {
      const head = `[${i + 1}] ${ent.name}`;
      return `${head}
    最近一次：${r.date}${r.session ? `（${r.session}）` : ""}，距今天 ${r.daysAgo} 天
    那节课重点部位：${r.muscleFocus.join("/") || "无"}｜动作：${r.exercises.join("、") || "无"}
    更早一次（**不是答案**，只用来证明这不是唯一一次）：${r.previous ? r.previous.date : "无，语料里只有这一次"}`;
    })
    .join("\n");

  const missNote = misses.length
    ? `\n\n查不到的：${misses.join("；")}——这几项必须在答案里明说查不到，不要跳过不提。`
    : "";

  const askAll =
    got.length > 1
      ? `1. **每一条都要报**：用户问了 ${got.length} 个对象，就答 ${got.length} 个，一个都不能漏；漏一个答案就是错的。`
      : `1. 答案就是「最近一次」那个日期，**不要**报成「更早一次」的日期。`;

  return `下面 ${got.length} 条都是系统**遍历全部训练记录取出的最晚一条**，准确，直接引用，不要自己去比明细里的日期。

${blocks}${missNote}

要求：
${askAll}
2. 每条用**它自己的编号**标出处（第 1 条用 [1]，第 2 条用 [2]），编号不要错位。
3. **日期和天数都要报**（写成「2026-07-31，距今 107 天」）。只报天数用户没法核对日期，
   只报日期又答不上「多久」——这句话经常连着问两件事。
4. 计划里写了但没做的课不算——不要拿明细里没有的东西推断。
5. 中文，不超过 ${got.length > 1 ? "160" : "60"} 字。

问题：${question}`;
}

/* ─────────── 荒废入口：哪些动作我很久没练了 ─────────── */

const NEVER_INTENT = /从来没|从没|没练过|没做过|没试过/;
const STALE_INTENT = /多久没练|好久没练|多长时间没练|很久没练|哪些.{0,6}没练|一直没练|荒废|多久没做/;

/**
 * 「哪些动作我很久没练了」——集合差 + 日期，任何一段文字里都没有这个结果。
 *
 * 必须和「哪些动作我**从来**没练过」分开：
 *   - 「很久没练」= 语料里练过、但最近一次很久以前 → **能算**
 *   - 「从来没练过」= 需要一个完整动作库 → **算不了**
 *     语料里只有练过的 136 个动作（`action_muscles.json` 从训练记录反推，
 *     不是 free-exercise-db 的 876 条）。拿「很久没练」的结果冒充「没练过」，
 *     用户会以为那些动作自己真的没碰过——而它们只是没被记录。
 *
 * 两条都不过模型：答案全是结构化列表，让 7B 复述日期只会错。
 */
function planStale(question: string): Plan | null {
  const never = NEVER_INTENT.test(question);
  if (!never && !STALE_INTENT.test(question)) return null;

  // 指定了具体动作/部位就交给 latest：
  // 「硬拉多久没练了」问的是**那一个**动作的日期，不是全局最久没练排行榜。
  // 第一版没这层判断，问硬拉答的是「悍马上斜推胸 467 天」——答的是另一个问题，
  // 而且列表看起来很像正确答案。
  if (entitiesIn(question).length) return null;

  let r: ReturnType<typeof staleExercises>;
  try {
    r = staleExercises({ limit: 5 });
  } catch {
    return null;
  }
  if (!r.ok) return null;

  // 「从来没练过」：明说做不到，并给出相邻的能力，别让用户以为系统什么都不知道
  if (never)
    return {
      route: "stale",
      citations: [],
      k: 0,
      prompt: null,
      fixedAnswer:
        `列不出来：语料里只有你练过的动作（共 ${r.total} 个），没有完整动作库，` +
        `所以「从来没练过」这个名字集合不存在。\n` +
        `能算的是反过来的那个：**哪些动作很久没练**（练过但最近一次很久以前）——问我就行。`,
      retrieveMs: 0,
      numPredict: 0,
    };

  const lines = r.items
    .map((x, i) => `[${i + 1}] ${x.name}：最近一次 ${x.lastDate}，距今 ${x.daysAgo} 天，共练过 ${x.sessions} 次`)
    .join("\n");

  const cites: Citation[] = r.items
    .filter((x) => x.docName)
    .map((x, i) => ({
      n: i + 1,
      doc: x.docName,
      date: x.lastDate,
      label: `${x.docName} > ${x.name}`,
      headingPath: [x.name],
      snippet: `最近一次 ${x.lastDate}（${x.daysAgo} 天前），全库共 ${x.sessions} 次`,
      score: 0,
    }));

  return {
    route: "stale",
    citations: cites,
    k: cites.length,
    prompt: null,
    fixedAnswer:
      `按「距今天数」排，最久没练的 ${r.items.length} 个：\n${lines}\n\n` +
      `语料里共 ${r.total} 个动作，超过 30 天没练的有 **${r.staleCount}** 个（截至 ${r.refDate}）。\n` +
      `注：这是遍历全部训练记录、对每个动作取最晚一次日期排出来的，不是从检索到的几段里挑的。`,
    retrieveMs: 0,
    numPredict: 0,
  };
}

/* ─────────── 对比入口：这个月比上个月练得更多吗 ─────────── */

/**
 * 区间对比。
 *
 * 这题原来答「资料里没有找到内容」——它需要的是两个区间的课数相减，
 * 而任何一段文字里都没有这个减法结果。
 *
 * **整条答案由代码算出，不过模型。** 对比题的每个字都是模板化的
 * （两个月各几次、每周几次、差多少），让 7B 复述只会引入新的错法；
 * 而这里是纯算术，代码不可能算错。
 *
 * 关键设计：**同时报总次数和每周频率**。
 * 11-15 问「本月比上月多吗」，本月才过 15 天、10 次；上月整月 26 次。
 * 只看总次数会说「少了很多」，但按每周频率算才公平——月份长短不一样。
 * 这和容量那个「含热身 / 剔除热身」是同一个道理：一个数有两种读法，都得给。
 */
function planCompare(question: string): Plan | null {
  const pair = resolveCompare(question);
  if (!pair) return null;

  let cur: CountResult;
  let prev: CountResult;
  try {
    cur = countTraining({ period: pair.cur });
    prev = countTraining({ period: pair.prev });
  } catch {
    return null;
  }
  // 有一边完全没有记录就交给别的入口：只报一个月的数不叫对比
  if (!cur.ok || !prev.ok) return null;

  const rateOf = (c: CountResult) => c.perWeek.count / (c.perWeek.days / 7);
  const rc = rateOf(cur);
  const rp = rateOf(prev);
  const delta = rp > 0 ? ((rc - rp) / rp) * 100 : 0;
  const dir = Math.abs(delta) < 5 ? "持平" : delta > 0 ? "更多" : "更少";
  const pct = `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`;

  const line = (c: CountResult, r: number) =>
    `${c.periodLabel}（${c.from} ~ ${c.to}，已过 ${c.perWeek.days} 天）：${c.perWeek.count} 次，每周 ${r.toFixed(1)} 次`;

  const answer =
    `${line(cur, rc)}\n${line(prev, rp)}\n` +
    `按每周频率比：${pct}（${rc.toFixed(1)} vs ${rp.toFixed(1)} 次/周），${pair.unit === "周" ? "这周" : "这个月"}练得${dir}。\n` +
    `注：只比次数，不比训练量——容量跨动作不可相加。` +
    (cur.perWeek.days < 25 ? `当前区间还没过完（已过 ${cur.perWeek.days} 天），所以总次数那一行要配合频率看。` : "");

  return {
    route: "compare",
    citations: [],
    k: 0,
    prompt: null,
    fixedAnswer: answer,
    retrieveMs: 0,
    numPredict: 0,
  };
}

function planCount(question: string): Plan | null {
  if (!COUNT_INTENT.test(question)) return null;
  const ents = entitiesIn(question);
  // 认不出对象也能数：「我练了几次」「平均每周几次」问的是全部训练。
  // 旧实现直接 return null，这两道题就掉进检索，模型从一段文字里抄了个数就答了——
  // 问「平均每周练几次」它答「10 月平均间隔 1.5 天，所以每周 4-5 次」，
  // 引用是真的、算术也对，答的却是十月的事。
  const wantsRate = /平均|每周|一周|频率|多久一次/.test(question);

  const period = resolvePeriod(question);
  const got: CountResult[] = [];
  const empties: string[] = [];
  for (const ent of ents) {
    try {
      // 注意别把 muscle 和 exercise 一起传：countTraining 里 muscle 优先，
      // 传了 exercise 也不会被用，反而让人以为两个条件生效了
      const c = countTraining(ent.kind === "muscle" ? { muscle: ent.name, period } : { exercise: ent.name, period });
      if (c.ok) got.push(c);
      else empties.push(`${c.periodLabel} 没有以「${ent.name}」为参与部位的训练记录`);
    } catch {
      empties.push(`${ent.name} 查询失败`);
    }
  }

  if (!ents.length) {
    try {
      const c = countTraining({ period });
      if (c.ok) got.push(c);
      else empties.push(`${c.periodLabel} 没有训练记录`);
    } catch {
      empties.push("统计失败");
    }
  }

  if (!got.length) {
    // 空结果直接给，不过模型：这里是事实陈述，没有可润色的空间
    return {
      route: "count",
      citations: [],
      k: 0,
      prompt: null,
      fixedAnswer:
        (empties.join("；") || "没有数到记录") +
        `。如果这个统计口径不对（比如你想问的是别的部位），告诉我具体名字我再数。`,
      retrieveMs: 0,
      numPredict: 0,
    };
  }

  // 合并引用：编号必须连续且和明细一一对应，否则模型引 [2] 会指到别的对象上
  const cites: Citation[] = [];
  const offsets: number[] = [];
  for (const c of got) {
    const base = cites.length;
    offsets.push(base + 1);
    for (const x of countCitations(c)) cites.push({ ...x, n: base + x.n });
  }

  return {
    route: "count",
    citations: cites,
    k: Math.max(1, cites.length),
    prompt: buildCountPrompt(got, offsets, question, empties, wantsRate),
    retrieveMs: 0,
    numPredict: got.length > 1 ? 260 : 180,
  };
}

/** 命中明细转引用：数到几次就引几篇，用户能逐条核 */
function countCitations(c: CountResult): Citation[] {
  return c.rows.map((r, i) => ({
    n: i + 1,
    doc: r.docName,
    date: r.date,
    // 同样标出统计对象：一节「推」日既算胸也算手臂，两处明细会引用同一篇文档。
    // 不去重（那是两套证据，合并编号会把「每个对象几条明细」搅乱），
    // 但卡片必须让人看出这一条是「胸」那一条是「手臂」。
    label: `${r.docName} > ${r.session || "训练"} > ${c.target}`,
    headingPath: [r.session || "训练", c.target],
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
    section: h.section,
  };
}

/** 检索入口。失败返回原因而不是抛，调用方统一处理。 */
function planRetrieve(question: string, k: number): { ok: true; plan: Plan } | { ok: false; reason: string } {
  const tR = Date.now();
  let hits: Hit[];
  try {
    hits = retrieve(question, { k });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "检索失败" };
  }
  const retrieveMs = Date.now() - tR;

  if (!hits.length)
    return {
      ok: true,
      plan: {
        route: "retrieve",
        citations: [],
        k,
        prompt: null,
        fixedAnswer: "资料里没有找到相关内容。",
        retrieveMs,
        numPredict: 0,
      },
    };

  return {
    ok: true,
    plan: {
      route: "retrieve",
      citations: hits.map((h) => toCitation(h)),
      k: hits.length,
      prompt: buildAskPrompt(hits, question),
      retrieveMs,
      numPredict: ASK_NUM_PREDICT,
    },
  };
}

/**
 * 路由决策，**同步与流式共用这一份**。
 *
 * 顺序有讲究：计数先于趋势——「练了几次深蹲」同时含动作名，但问的是总数不是变化，
 * 先判趋势会被 8 次记录的空趋势干扰。两条数值入口都判不上，才走检索。
 *
 * `noTools` 只在一处用：数值入口生成失败时回落到检索，避免来回递归。
 */
export function pick(question: string, k: number, noTools?: boolean): Plan | { error: string } {
  if (!noTools) {
    // 对比先于计数：「这个月比上个月练了几次」同时含「几次」，
    // 先判计数会只数本月，用户要的对比就没了
    // 荒废先判：「哪些动作我从来没练过」含「没练」，但它和「很久没练」是两件事
    const st = planStale(question);
    if (st) return st;
    const cmp = planCompare(question);
    if (cmp) return cmp;
    const c = planCount(question);
    if (c) return c;
    // 定位先于趋势：「上次深蹲是什么时候」不含涨跌词，但若哪天含了就归定位——
    // 定位的答案是日期，趋势的答案是百分比，冲突时以「用户到底在问哪个」为准
    const l = planLatest(question);
    if (l) return l;
    const t = planTrend(question);
    if (t) return t;
  }
  const r = planRetrieve(question, k);
  return r.ok ? r.plan : { error: r.reason };
}

/**
 * 一次完整的问答：检索 → 组装 → 生成 → 校验。
 * 不抛异常，失败也返回结构化结果（和 /api/extract 的「永不 500」保持一致）。
 */
export async function ask(
  question: string,
  opts: { k?: number; noTools?: boolean } = {}
): Promise<AskResult> {
  const k = opts.k ?? ASK_K;
  const t0 = Date.now();

  // 排计划先判：它是异步的（调本机 Python 引擎），不能塞进同步的 pick()。
  // 命中就用引擎算好的答案（不过模型）；失败直接报错，绝不回落检索——
  // 回落会拿一段历史文字冒充计划，答非所问。
  if (!opts.noTools) {
    const session = await tryPlanSession(question);
    if (session) {
      if ("error" in session) {
        return {
          ok: false,
          answer: "",
          citations: [],
          check: { refs: [], invalid: [], unused: [], noAnswer: false },
          reason: session.error,
          meta: { model: OLLAMA_MODEL, ms: { retrieve: 0, generate: 0, total: Date.now() - t0 }, k, route: "plan" },
        };
      }
      const sp = session.plan;
      return {
        ok: true,
        answer: sp.fixedAnswer ?? "",
        citations: sp.citations,
        check: checkAnswer(sp.fixedAnswer ?? "", sp.k),
        // 结构化计划：小程序按表格渲染，网页端可继续用 answer 文本
        plan: sp.planData || null,
        meta: {
          model: OLLAMA_MODEL,
          ms: { retrieve: sp.retrieveMs, generate: 0, total: Date.now() - t0 },
          k: sp.k,
          route: sp.route,
        },
      };
    }
  }

  const picked = pick(question, k, opts.noTools);
  if ("error" in picked) {
    return {
      ok: false,
      answer: "",
      citations: [],
      check: { refs: [], invalid: [], unused: [], noAnswer: false },
      reason: picked.error,
      meta: { model: OLLAMA_MODEL, ms: { retrieve: 0, generate: 0, total: Date.now() - t0 }, k, route: "retrieve" },
    };
  }
  const plan = picked;

  if (plan.prompt === null) {
    const answer = plan.fixedAnswer ?? "";
    return {
      ok: true,
      answer,
      citations: plan.citations,
      check: checkAnswer(answer, plan.k),
      meta: {
        model: OLLAMA_MODEL,
        ms: { retrieve: plan.retrieveMs, generate: 0, total: Date.now() - t0 },
        k: plan.k,
        route: plan.route,
      },
    };
  }

  const tG = Date.now();
  let answer: string;
  try {
    answer = await generateOnce(plan.prompt, plan.numPredict);
    // trailer 是代码写的事实补充（歧义提示），模型没机会改它
    if (plan.trailer) answer = `${answer.trimEnd()}\n\n${plan.trailer}`;
  } catch (e) {
    // 数值入口生成失败就退化到检索：宁可答得保守，也不要在这条路上给半个数
    if (plan.route !== "retrieve") return ask(question, { k, noTools: true });
    const msg =
      e instanceof Error && e.name === "AbortError" ? "模型推理超时" : e instanceof Error ? e.message : "生成失败";
    return {
      ok: false,
      answer: "",
      citations: plan.citations,
      check: { refs: [], invalid: [], unused: plan.citations.map((c) => c.n), noAnswer: false },
      reason: msg,
      meta: {
        model: OLLAMA_MODEL,
        ms: { retrieve: plan.retrieveMs, generate: Date.now() - tG, total: Date.now() - t0 },
        k,
        route: "retrieve",
      },
    };
  }

  return {
    ok: true,
    answer,
    citations: plan.citations,
    check: checkAnswer(answer, plan.k),
    meta: {
      model: OLLAMA_MODEL,
      ms: { retrieve: plan.retrieveMs, generate: Date.now() - tG, total: Date.now() - t0 },
      k: plan.k,
      route: plan.route,
    },
  };
}

/* ─────────── 流式（W7·5） ─────────── */

/**
 * 流式事件。
 *
 * `cites` **先于**任何 token 发出：检索只要 14 ms，而生成要 2–8 s。
 * 先把「我用的是哪几段资料」摆出来，用户立刻知道系统找对了没有——
 * 这比首字快 2 ms 有用得多，也是流式真正的价值所在。
 */
export type AskEvent =
  | { type: "cites"; citations: Citation[]; route: Route; k: number; retrieveMs: number; model: string }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; check: CitationCheck; ms: AskResult["meta"]["ms"]; route: Route }
  | { type: "error"; reason: string }
  | { type: "aborted" };

/**
 * 流式调 Ollama。逐块 yield 文本增量。
 *
 * 取消靠 `signal`：客户端断开 → route 里 abort → 这里 fetch 的 signal 跟着中断，
 * **Ollama 那边也会停止生成**。不这么做的话，用户关掉页面，模型还在跑完那 260 token。
 */
async function* generateStream(
  prompt: string,
  numPredict: number,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: true,
        options: { temperature: 0, num_predict: numPredict },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama 返回 ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // NDJSON。整行才 parse——半行会被 JSON.parse 抛掉，那正好是「等下一块」的意思
        const j = JSON.parse(line) as { response?: string };
        if (j.response) yield j.response;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/**
 * 流式问答。和 `ask()` 共用 `pick()`，所以两条入口的题在页面上和脚本里表现一致。
 */
export async function* askStream(
  question: string,
  opts: { k?: number; noTools?: boolean; signal?: AbortSignal } = {}
): AsyncGenerator<AskEvent> {
  const k = opts.k ?? ASK_K;
  const t0 = Date.now();

  // 与 ask() 同一份判断（tryPlanSession），保证网页与脚本表现一致。
  if (!opts.noTools) {
    const session = await tryPlanSession(question);
    if (session) {
      if ("error" in session) {
        yield { type: "error", reason: session.error };
        return;
      }
      const sp = session.plan;
      const fixed = sp.fixedAnswer ?? "";
      yield { type: "cites", citations: sp.citations, route: sp.route, k: sp.k, retrieveMs: sp.retrieveMs, model: OLLAMA_MODEL };
      yield { type: "token", text: fixed };
      yield {
        type: "done",
        answer: fixed,
        check: checkAnswer(fixed, sp.k),
        ms: { retrieve: sp.retrieveMs, generate: 0, total: Date.now() - t0 },
        route: sp.route,
      };
      return;
    }
  }

  const picked = pick(question, k, opts.noTools);
  if ("error" in picked) {
    yield { type: "error", reason: picked.error };
    return;
  }
  const plan = picked;

  yield {
    type: "cites",
    citations: plan.citations,
    route: plan.route,
    k: plan.k,
    retrieveMs: plan.retrieveMs,
    model: OLLAMA_MODEL,
  };

  if (plan.prompt === null) {
    const fixed = plan.fixedAnswer ?? "";
    const answer = plan.trailer ? `${fixed}\n\n${plan.trailer}` : fixed;
    yield { type: "token", text: answer };
    yield {
      type: "done",
      answer,
      check: checkAnswer(answer, plan.k),
      ms: { retrieve: plan.retrieveMs, generate: 0, total: Date.now() - t0 },
      route: plan.route,
    };
    return;
  }

  const tG = Date.now();
  let acc = "";
  try {
    for await (const tok of generateStream(plan.prompt, plan.numPredict, opts.signal)) {
      acc += tok;
      yield { type: "token", text: tok };
    }
  } catch (e) {
    // 用户取消和模型出错要分开报：前者不是错误，页面上不该显示红色
    if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError" && opts.signal?.aborted)) {
      yield { type: "aborted" };
      return;
    }
    if (plan.route !== "retrieve") {
      yield* askStream(question, { ...opts, noTools: true });
      return;
    }
    yield { type: "error", reason: e instanceof Error ? e.message : "生成失败" };
    return;
  }

  const body = acc.trim();
  if (!body) {
    yield { type: "error", reason: "模型返回空" };
    return;
  }
  // trailer 必须以 token 形式发出，否则页面上看不到它——只塞进 done.answer 的话，
  // 用户看到的那段文字和校验的那段就不是同一份了
  const trailer = plan.trailer ? `\n\n${plan.trailer}` : "";
  if (trailer) yield { type: "token", text: trailer };
  const answer = body + trailer;
  yield {
    type: "done",
    answer,
    check: checkAnswer(answer, plan.k),
    ms: { retrieve: plan.retrieveMs, generate: Date.now() - tG, total: Date.now() - t0 },
    route: plan.route,
  };
}
