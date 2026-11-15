/**
 * 数值入口（W7）：**算数不交给模型**。
 *
 * 为什么要单独一层：实测让 7B 从原始组次里判断「深蹲在涨还是跌」时，它把健康记录里的
 * 1RM 82kg 当成「最近一次深蹲重量」，跟 60kg 一比，得出「在涨」——而真实数据是
 * 含热身 +4.9%、剔除热身 −12.8%，两个口径结论相反。这不是模型笨，是**这件事不该让它做**。
 *
 * 所以工具层的契约是：
 *   ① 返回**已经算好的**字段，模型只负责组织语言；
 *   ② 每个数字都带 `caliber`（口径）说明，尤其是「含不含热身组」这种
 *      一改就能把结论翻过来的东西；
 *   ③ 两个合理口径结论相反时**同时返回**，让模型没法挑一个好看的报。
 *
 * 第 ③ 条是 N6 那个坑的产品化：报告里发过一版「在涨」，后来发现是被热身组污染的。
 */
import { walkMarkdown, loadDoc, type Doc } from "./corpus";
import { parseTraining, type TrainingRecord } from "./training-parse";

export interface TrendPoint {
  date: string;
  session: string;
  /** 来源文档，给引用用 */
  docName: string;
  docPath: string;
  /** 正式组里的最大重量（已排除热身组），自重动作是 null */
  topWeight: number | null;
  /** 剔除热身组的容量 Σ(重量×次数)；自重动作退化为总次数 */
  workVolume: number;
  /** 练练 App 写入的容量，**含热身组** */
  appVolume: number | null;
  /** 热身组占 App 容量的比例，0–1 */
  warmupShare: number;
  /** 正式组数 */
  workSets: number;
  /** 末组比首组掉力的百分比，无掉力为 null */
  dropOffPct: number | null;
  /**
   * 自重动作。这很关键：练练对自重动作的 capacity 是**按体重折算**的
   * （实测双杠臂屈伸：工作容量 31、App 容量 1918.9），两个口径不同量纲，
   * 并列报出来会得出「在跌 72%」这种既对又没意义的结论。
   */
  bodyweight: boolean;
}

export interface CaliberResult {
  /** 口径名，必须能独立看懂 */
  caliber: string;
  note: string;
  beforeAvg: number;
  recentAvg: number;
  deltaPct: number;
  verdict: "在涨" | "在跌" | "基本持平";
}

export interface TrendResult {
  ok: boolean;
  exercise: string;
  /** 语料里同名的其他动作（比如问「深蹲」时可能匹配到好几个），帮调用方判断歧义 */
  alternatives: string[];
  totalSessions: number;
  /** 最近几次（正常档） */
  recent: TrendPoint[];
  /** 此前几次（正常档） */
  before: TrendPoint[];
  /** 被排除的降级课（试探档 / 复训），混进来会把趋势拉成「在跌」 */
  excluded: TrendPoint[];
  calibers: CaliberResult[];
  /** 给模型看的一句话：事实 + 为什么不能只报一个数 */
  summary: string;
  reason?: string;
}

/** 涨跌阈值 ±5%：低于这个数说「基本持平」，别把噪声说成趋势 */
const FLAT = 0.05;

function verdictOf(recent: number, before: number): CaliberResult["verdict"] {
  if (!before) return "基本持平";
  const d = recent / before - 1;
  return d > FLAT ? "在涨" : d < -FLAT ? "在跌" : "基本持平";
}

interface Loaded {
  /** 动作名 → 每次训练的该动作记录 */
  byExercise: Map<string, Array<{ doc: Doc; rec: TrainingRecord; exIdx: number }>>;
  names: string[];
  ms: number;
}

const g = globalThis as unknown as { __exIndex?: Loaded };

/** 降级课的标记只写在文件名里（「试探档」「降级」「复训」），正文里没有可靠字段 */
function isDegraded(doc: Doc): boolean {
  return /试探档|降级|复训/.test(doc.name);
}

/**
 * 训练语料的根目录。
 *
 * 这里**必须**和 `retrieve.ts` 的 `kbDirs()` 用同一套优先级（KB_DIRS 优先），
 * 否则只配 KB_DIRS 的人会看到「检索能跑、问趋势报『缺少 KB_DIR』」——
 * 同一个仓库里两层对不同环境变量负责，是最难查的那种不一致。
 * 训练记录只在每日记录目录下，多扫几层不会重复（`-训练` 文件名只在那里出现），
 * 但代价是 walk 更多文件，所以两个索引各自缓存、互不依赖。
 */
function kbDirs(): string[] {
  const multi = process.env.KB_DIRS;
  if (multi) {
    const dirs = multi.split(",").map((s) => s.trim()).filter(Boolean);
    if (dirs.length) return dirs;
  }
  const dir = process.env.KB_DIR;
  if (!dir) throw new Error("缺少环境变量 KB_DIR 或 KB_DIRS");
  return [dir];
}

function loadAll(): Loaded {
  if (g.__exIndex) return g.__exIndex;
  const t0 = performance.now();
  const byExercise = new Map<string, Array<{ doc: Doc; rec: TrainingRecord; exIdx: number }>>();
  for (const dir of kbDirs()) {
    for (const f of walkMarkdown(dir)) {
      const doc = loadDoc(f, dir);
      if (!/-训练/.test(doc.name)) continue;
      const rec = parseTraining(doc);
      if (!rec) continue;
      rec.exercises.forEach((ex, exIdx) => {
        const arr = byExercise.get(ex.name) ?? [];
        arr.push({ doc, rec, exIdx });
        byExercise.set(ex.name, arr);
      });
    }
  }
  const loaded: Loaded = { byExercise, names: [...byExercise.keys()], ms: performance.now() - t0 };
  g.__exIndex = loaded;
  return loaded;
}

export function listExercises(): string[] {
  // 按出现次数降序：用户问「深蹲」时最该命中的是练得最多的那个
  const l = loadAll();
  return [...l.names].sort(
    (a, b) => (l.byExercise.get(b)?.length ?? 0) - (l.byExercise.get(a)?.length ?? 0)
  );
}

/** 动作名去掉括注和破折号后缀：「腿举(倒蹬)」→「腿举」，「绳索高位下拉-窄距」→「绳索高位下拉」 */
export function coreOf(name: string): string {
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
 *
 * 从 answer.ts 搬到这儿是因为它属于**实体识别**，不是生成逻辑；
 * 而且 entitiesIn 要用它，放两处会各调一份、慢慢漂移。
 */
export type MatchLayer = "full" | "core" | "tail";

export interface ExerciseMatch {
  name: string;
  /** 靠哪一层命中的，决定「要不要报歧义」——见 exerciseSiblings */
  layer: MatchLayer;
}

export function matchExerciseEx(q: string): ExerciseMatch | null {
  const names = listExercises();
  for (const n of names) if (q.includes(n)) return { name: n, layer: "full" };
  for (const n of names) {
    const c = coreOf(n);
    if (c.length >= 2 && q.includes(c)) return { name: n, layer: "core" };
  }
  for (const n of names) {
    const c = coreOf(n);
    if (c.length >= 2 && q.includes(c.slice(-2))) return { name: n, layer: "tail" };
  }
  return null;
}

export function matchExercise(q: string): string | null {
  return matchExerciseEx(q)?.name ?? null;
}

/**
 * 同名后缀的**其他**动作。
 *
 * 为什么要有：用户说「硬拉」，语料里有杠铃硬拉 / 罗马尼亚硬拉 / 哑铃硬拉 /
 * 史密斯硬拉 / 哑铃单腿硬拉五种；`matchExercise` 按频次选了「杠铃硬拉」，
 * 报「最近一次 07-31」。可最近练的那次是**罗马尼亚硬拉（08-22）**。
 * 两边都有据可查，用户看到的却是个错的答案，而且没有任何迹象提示他选错了。
 *
 * 只有走 tail 层（用户只说了末两字）才算歧义：
 *   「史密斯深蹲」走 full 层，明确；
 *   「深蹲」走 tail 层，可能就是高脚杯深蹲 —— 该提一句。
 * 提法是**给默认答案 + 列出其他候选**，不是拒绝回答：
 * 拒绝会把「深蹲最近涨没涨」这种正常问题也挡掉。
 */
export function exerciseSiblings(match: ExerciseMatch, limit = 4): string[] {
  if (match.layer === "full") return [];
  const tail = coreOf(match.name).slice(-2);
  if (tail.length < 2) return [];
  return listExercises()
    .filter((n) => n !== match.name && coreOf(n).endsWith(tail))
    .slice(0, limit);
}

/**
 * 把用户嘴里的动作名对上语料里的动作名。
 * 精确 → 全长包含 → 用户词是动作名的一部分（取出现次数最多的那个）。
 */
function resolveName(q: string): { name: string | null; alternatives: string[] } {
  const { byExercise, names } = loadAll();
  if (byExercise.has(q)) return { name: q, alternatives: [] };

  // 用户给的是完整动作名的一部分（如「布拉德福德推举」足够具体）
  const contained = names.filter((n) => n.includes(q));
  if (contained.length === 1) return { name: contained[0], alternatives: [] };
  if (contained.length > 1) {
    // 按出现次数排序，「深蹲」会命中史密斯深蹲/高脚杯深蹲/保加利亚分腿蹲…
    const sorted = contained.sort((a, b) => (byExercise.get(b)?.length ?? 0) - (byExercise.get(a)?.length ?? 0));
    return { name: sorted[0], alternatives: sorted.slice(1, 5) };
  }

  // 用户给的是超集（「史密斯深蹲」在语料里被记成「史密斯深蹲」时不会走到这里）
  const longer = names.filter((n) => q.includes(n));
  if (longer.length >= 1) {
    const sorted = longer.sort((a, b) => (byExercise.get(b)?.length ?? 0) - (byExercise.get(a)?.length ?? 0));
    return { name: sorted[0], alternatives: sorted.slice(1, 5) };
  }
  return { name: null, alternatives: [] };
}

function pointOf(doc: Doc, rec: TrainingRecord, exIdx: number): TrendPoint & { degraded: boolean } {
  const ex = rec.exercises[exIdx];
  const work = ex.sets.filter((s) => !s.warmup);
  const workVolume = work.reduce((sum, s) => sum + (s.weightKg ?? 0) * (s.reps ?? 0), 0);
  const weights = work.map((s) => s.weightKg).filter((w): w is number => typeof w === "number");
  const allReps = work.reduce((sum, s) => sum + (s.reps ?? 0), 0);
  const appVolume = ex.volume;
  return {
    date: doc.date ?? doc.name.slice(0, 10),
    session: rec.session ?? "",
    docName: doc.name,
    docPath: doc.path,
    topWeight: weights.length ? Math.max(...weights) : null,
    bodyweight: weights.length === 0,
    // 自重动作没有重量，容量退化为总次数，否则永远是 0
    workVolume: workVolume || allReps,
    appVolume,
    warmupShare: appVolume ? Math.max(0, (appVolume - workVolume) / appVolume) : 0,
    workSets: work.length,
    dropOffPct: ex.dropOff?.pct ?? null,
    degraded: isDegraded(doc),
  };
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface TrendOptions {
  /** 最近几次，默认 3 */
  recent?: number;
  /** 此前几次，默认 5 */
  before?: number;
  /** 是否排除降级课，默认 true。false 只用于诊断，不该给模型用 */
  excludeDegraded?: boolean;
}

export function getExerciseTrend(exercise: string, opts: TrendOptions = {}): TrendResult {
  const { recent: nR = 3, before: nB = 5, excludeDegraded = true } = opts;
  const empty = (reason: string, alternatives: string[] = []): TrendResult => ({
    ok: false,
    exercise,
    alternatives,
    totalSessions: 0,
    recent: [],
    before: [],
    excluded: [],
    calibers: [],
    summary: "",
    reason,
  });

  let loaded: Loaded;
  try {
    loaded = loadAll();
  } catch (e) {
    return empty(e instanceof Error ? e.message : "语料不可读");
  }

  const { name, alternatives } = resolveName(exercise);
  if (!name) return empty(`语料里没有含「${exercise}」的动作`);
  const rows = loaded.byExercise.get(name) ?? [];
  if (!rows.length) return empty(`「${name}」没有任何训练记录`);

  const pts = rows
    .map((r) => pointOf(r.doc, r.rec, r.exIdx))
    .sort((a, b) => a.date.localeCompare(b.date));

  /*
   * 硬拒：同一动作既有负重组、又有自重记录时，两种容量口径**不可比**。
   * 实测双杠臂屈伸：09-07 是 10kg 负重（App 容量 400）、08-23 是纯自重
   * （App 容量 1918.9，按体重折算）。硬算会得出「在跌 92.4%」——
   * 数字来自单位换算，不是能力变化。这种时候给结论比不给更糟。
   */
  const hasBw = pts.some((p) => p.bodyweight);
  const hasLoaded = pts.some((p) => !p.bodyweight);
  if (hasBw && hasLoaded)
    return empty(
      `「${name}」既有负重组也有纯自重记录（${pts.filter((p) => p.bodyweight).map((p) => p.date.slice(5)).join("、")} 是自重）。` +
        `自重动作的容量按体重折算，与负重组不同量纲，**不能放在一起比趋势**；需要分口径看`,
      alternatives
    );

  const normal = excludeDegraded ? pts.filter((p) => !p.degraded) : pts;
  const excluded = excludeDegraded ? pts.filter((p) => p.degraded) : [];
  if (normal.length < 3)
    return empty(
      `「${name}」正常档只有 ${normal.length} 次（全库共 ${pts.length} 次），不够看趋势；` +
        `单次数据可以直接查那一天的训练记录`,
      alternatives
    );

  const takeR = Math.min(nR, Math.max(1, normal.length - 1));
  const takeB = Math.min(nB, Math.max(1, normal.length - takeR));
  const recentPts = normal.slice(-takeR);
  const beforePts = normal.slice(-takeR - takeB, -takeR);

  const appRecent = avg(recentPts.map((p) => p.appVolume ?? 0).filter((x) => x > 0));
  const appBefore = avg(beforePts.map((p) => p.appVolume ?? 0).filter((x) => x > 0));
  const workRecent = avg(recentPts.map((p) => p.workVolume));
  const workBefore = avg(beforePts.map((p) => p.workVolume));

  /*
   * 自重动作走**单口径**。
   * 实测双杠臂屈伸：工作容量 31（自重无重量可乘，退化成总次数）、App 容量 1918.9
   * （练练按体重折算）。两个数不同量纲，并列报出来会得出「在跌 72%」这种
   * 既"正确"又完全没有意义的结果 —— 那是把两种单位放在一起比。
   */
  const allBodyweight = [...recentPts, ...beforePts].every((p) => p.bodyweight);

  const calibers: CaliberResult[] = allBodyweight
    ? [
        {
          caliber: "总次数（自重动作 · 正式组）",
          note:
            "自重动作没有重量可乘。练练写入的 capacity 是**按体重折算**的，" +
            "与负重动作不同量纲，不能并列比较，所以这里只看正式组总次数。",
          beforeAvg: r1(workBefore),
          recentAvg: r1(workRecent),
          deltaPct: workBefore ? r1((workRecent / workBefore - 1) * 100) : 0,
          verdict: verdictOf(workRecent, workBefore),
        },
      ]
    : [
        {
          caliber: "含热身（App 写入的 capacity 字段）",
          note: "练练 App 把热身组也算进容量。加一组热身就会让这个数变大，但那不是能力涨。",
          beforeAvg: r1(appBefore),
          recentAvg: r1(appRecent),
          deltaPct: appBefore ? r1((appRecent / appBefore - 1) * 100) : 0,
          verdict: verdictOf(appRecent, appBefore),
        },
        {
          caliber: "剔除热身（只算正式组）",
          note: "Σ(重量×次数)，只统计未标「热身」的组。",
          beforeAvg: r1(workBefore),
          recentAvg: r1(workRecent),
          deltaPct: workBefore ? r1((workRecent / workBefore - 1) * 100) : 0,
          verdict: verdictOf(workRecent, workBefore),
        },
      ];

  const warmupShares = recentPts.map((p) => `${p.date.slice(5)} ${(p.warmupShare * 100).toFixed(0)}%`).join("、");

  let summary: string;
  if (allBodyweight) {
    const c = calibers[0];
    summary =
      `「${name}」是自重动作，只报一个口径：正式组总次数 ${c.beforeAvg} → ${c.recentAvg}，` +
      `${c.verdict}（${c.deltaPct}%）。注意不能用 App 的容量数，它按体重折算，和负重动作不同量纲。`;
  } else {
    const v0 = calibers[0].verdict;
    const v1 = calibers[1].verdict;
    const conflict = v0 !== v1;
    summary = conflict
      ? `「${name}」两个口径结论相反：含热身是「${v0}」（${calibers[0].deltaPct}%），` +
        `剔除热身是「${v1}」（${calibers[1].deltaPct}%）。差异来自热身组占比（最近几次：${warmupShares}）。`
      : `「${name}」两个口径一致：都是「${v1}」（含热身 ${calibers[0].deltaPct}%，剔除热身 ${calibers[1].deltaPct}%）。` +
        `最近几次热身占比：${warmupShares}。`;
  }

  return {
    ok: true,
    exercise: name,
    alternatives,
    totalSessions: pts.length,
    recent: recentPts.map(({ degraded: _d, ...p }) => p),
    before: beforePts.map(({ degraded: _d, ...p }) => p),
    excluded: excluded.map(({ degraded: _d, ...p }) => p),
    calibers,
    summary: excluded.length
      ? `${summary} 已排除 ${excluded.length} 次降级课（${excluded.map((e) => e.date.slice(5)).join("、")}），不计入趋势。`
      : summary,
  };
}

/** 诊断用：语料里总共多少个动作、建索引花了多久 */
export function exerciseIndexMeta(): { names: number; records: number; ms: number } {
  const l = loadAll();
  let records = 0;
  for (const arr of l.byExercise.values()) records += arr.length;
  return { names: l.names.length, records, ms: l.ms };
}

/* ─────────── 计数入口：区间内到底练了几次 ───────────
 *
 * 为什么要它：W6 验收里 C2「我这个月一共练了几次腿」答了「1 次」，
 * 依据是检索到的片段里「11 月 4 日腿日被取消」。这是**同类错误里最危险的一种**：
 * 它看起来有引用、有推理，实际上把一个局部片段当成了全集。
 * 检索的 5 条是「最相关的 5 条」，不是「全部 5 条」——从前者数出来的计数，
 * 只在碰巧全都在 top5 时才对，而且错的时候没有任何信号。
 *
 * 所以计数必须走全语料遍历。这个函数不返回「大概」，只返回**数出来的**。
 */

export interface SessionRow {
  date: string;
  session: string;
  docName: string;
  docPath: string;
  /** 该部位是不是这节的**重点** */
  focus: boolean;
  muscleFocus: string[];
  muscleGroups: string[];
  /** 这节里的动作名，最多 5 个，作为「凭什么说它练了腿」的证据 */
  exercises: string[];
  degraded: boolean;
}

export interface CountResult {
  ok: boolean;
  /** 部位或动作名 */
  target: string;
  periodLabel: string;
  from: string;
  to: string;
  rows: SessionRow[];
  /** 只数重点部位 */
  focusCount: number;
  /** 重点 + 作为辅助参与（`muscle_groups` 口径） */
  withSecondary: number;
  /** 其中降级课（试探档/复训）几次 */
  degradedCount: number;
  /**
   * 「平均每周几次」需要的比值。
   *
   * 为什么不交给模型算：它会把「10 月平均间隔 1.5 天」换算成「每周 4-5 次」，
   * 而那是 10 月的数据，用它回答「我平均每周练几次」——引用真实、算术也对、
   * 结论答的是另一个问题。这类错比算错更难发现。
   *
   * **区间还没过完时按已过天数算**：11-15 问「本月平均每周几次」，
   * 用整月 30 天会把未来 15 天也算进分母，频率直接砍半。
   */
  perWeek: { count: number; weeks: number; days: number };
  caliber: string;
  summary: string;
  reason?: string;
}

/**
 * 部位别名。
 *
 * 语料里 `muscle_focus` 是**受控词表**，实测只有 9 个值：
 * 有氧 361、背 91、手臂 88、胸 74、腹/核心 72、肩 58、腿 48、臀 43、其他 6。
 * 所以不做模糊匹配，只把口语说法映到这几个词上——开放式匹配会自己造词。
 */
const MUSCLE_ALIAS: Array<{ re: RegExp; canon: string }> = [
  { re: /腹|核心/, canon: "腹/核心" },
  { re: /臀|屁股/, canon: "臀" },
  { re: /腿|下肢/, canon: "腿" },
  { re: /胸|卧推日/, canon: "胸" },
  { re: /背|拉日/, canon: "背" },
  { re: /肩|三角肌/, canon: "肩" },
  { re: /手臂|胳膊|二头|三头|肱/, canon: "手臂" },
  { re: /有氧|游泳|跑步|划船|单车|羽毛球/, canon: "有氧" },
];

export function resolveMuscle(q: string): string | null {
  for (const { re, canon } of MUSCLE_ALIAS) if (re.test(q)) return canon;
  return null;
}

export interface Entity {
  kind: "muscle" | "exercise";
  name: string;
  /**
   * 同名后缀的其他动作（「硬拉」→ 罗马尼亚硬拉/哑铃硬拉…）。
   * 非空说明用户说的词不够具体，答案里**必须提一句**，否则他会以为是另一个动作。
   */
  siblings: string[];
}

/**
 * 问句里的所有并列实体。
 *
 * 为什么要这个：工具层是**单实体**的。问「上次腿课和上次胸课分别是什么时候」，
 * `latestSession` 只拿到「腿」，胸直接消失——不报错、也不承认漏了，
 * 界面上看起来是个完整答案。这比答错更难发现：答错你会去查，答一半你不会。
 *
 * 实现是**先按连接词切、再逐段认实体**，不是全串扫描。理由：
 * 全串扫描要处理「史密斯深蹲」里含「深蹲」、「腿举」里含「腿」这类重叠，
 * 切分之后每段只有一个实体，重叠问题自然消失；认不出实体的段直接丢。
 * 所以像「热量和脂肪怎么分配」这种会被切开，但两段都认不出实体，返回空——
 * 宁可不认，也不要把非实体当成实体去调工具。
 */
const ENTITY_SPLIT = /和|跟|与|、|还有|以及|对比|比较|哪个更|哪一个|分别/g;

export function entitiesIn(q: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const part of q.split(ENTITY_SPLIT)) {
    if (!part.trim()) continue;
    // 动作优先：一段里既有动作名又含部位字时（「腿举」含「腿」），动作更具体
    const ex = matchExerciseEx(part);
    if (ex) {
      const key = `e:${ex.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "exercise", name: ex.name, siblings: exerciseSiblings(ex) });
      }
      continue;
    }
    const mu = resolveMuscle(part);
    if (mu) {
      const key = `m:${mu}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "muscle", name: mu, siblings: [] });
      }
    }
  }
  return out;
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface Period {
  label: string;
  from: string;
  to: string;
}

/**
 * 从问句里认出时间区间。
 *
 * 默认是「本月」而不是「全部」——问「练了几次」几乎都是在问眼前，
 * 答成三年 48 次属于答非所问。但区间**一定写进答案**，
 * 让用户能看出我按哪个窗口数的。
 */
export function resolvePeriod(q: string, ref = new Date()): Period {
  const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());

  const explicit = q.match(/(\d{4})\s*[-年]\s*(\d{1,2})/);
  if (explicit) {
    const y = Number(explicit[1]);
    const m = Number(explicit[2]) - 1;
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    return { label: `${y} 年 ${m + 1} 月`, from: ymd(first), to: ymd(last) };
  }

  /*
   * 裸年份：「2024 年练了几次腿」。
   * 第一版只认「YYYY-MM / YYYY 年 M 月」，裸年份掉到了默认分支，
   * 于是问 2024 年答的是本月 2 次——**区间错的时候答案看起来完全正常**，
   * 这是最难自查的一类错。所以年份单列一条，且必须排在默认之前。
   */
  const bareYear = q.match(/(\d{4})\s*年(?!\s*\d)/);
  if (bareYear) {
    const y = Number(bareYear[1]);
    return { label: `${y} 年`, from: `${y}-01-01`, to: `${y}-12-31` };
  }

  const monthOf = (offset: number): Period => {
    const first = new Date(day.getFullYear(), day.getMonth() + offset, 1);
    const last = new Date(day.getFullYear(), day.getMonth() + offset + 1, 0);
    return {
      label: `${first.getFullYear()} 年 ${first.getMonth() + 1} 月`,
      from: ymd(first),
      to: ymd(last),
    };
  };
  const weekOf = (offset: number): Period => {
    const dow = (day.getDay() + 6) % 7; // 0 = 周一
    const mon = new Date(day);
    mon.setDate(day.getDate() - dow + offset * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { label: `${ymd(mon)} ~ ${ymd(sun)}`, from: ymd(mon), to: ymd(sun) };
  };

  if (/上周/.test(q)) return weekOf(-1);
  if (/本周|这周|这个星期/.test(q)) return weekOf(0);
  if (/上个月|上月/.test(q)) return monthOf(-1);
  if (/今年/.test(q)) return { label: `${day.getFullYear()} 年`, from: `${day.getFullYear()}-01-01`, to: `${day.getFullYear()}-12-31` };
  if (/去年/.test(q)) {
    const y = day.getFullYear() - 1;
    return { label: `${y} 年`, from: `${y}-01-01`, to: `${y}-12-31` };
  }
  if (/最近\s*(\d+)\s*天/.test(q)) {
    const n = Number(q.match(/最近\s*(\d+)\s*天/)![1]);
    const from = new Date(day);
    from.setDate(day.getDate() - n + 1);
    return { label: `最近 ${n} 天`, from: ymd(from), to: ymd(day) };
  }
  return monthOf(0);
}

interface SessIdx {
  rows: Array<{ doc: Doc; rec: TrainingRecord | null }>;
  ms: number;
}

const gs = globalThis as unknown as { __sessIndex?: SessIdx };

function fmList(doc: Doc, key: string): string[] {
  const v = doc.fm[key];
  return Array.isArray(v) ? v : [];
}

/**
 * 全部训练记录（一篇 md = 一节）。和动作索引分开缓存：用途不同，别互相拖慢。
 *
 * 这里**不能**要求 `parseTraining` 成功。游泳、羽毛球这类有氧课没有「动作明细」，
 * `parseTraining` 返回 null ——第一版照它过滤，结果「这个月有氧几次」直接回
 * 「没有记录」。这是最坏的一种错：数不到的东西不会报警，只会少算。
 * 所以有氧按 frontmatter 的 `muscle_focus` 计入，`rec` 留 null。
 */
function loadSessions(): SessIdx {
  if (gs.__sessIndex) return gs.__sessIndex;
  const t0 = performance.now();
  const rows: Array<{ doc: Doc; rec: TrainingRecord | null }> = [];
  const seen = new Set<string>();
  for (const dir of kbDirs()) {
    for (const f of walkMarkdown(dir)) {
      if (seen.has(f)) continue;
      seen.add(f);
      const doc = loadDoc(f, dir);
      if (!/-训练/.test(doc.name)) continue;
      const rec = parseTraining(doc);
      // 没有动作明细时，至少要能按部位统计，否则这篇课等于不存在
      if (!rec && !fmList(doc, "muscle_focus").length && !fmList(doc, "muscle_groups").length) continue;
      rows.push({ doc, rec });
    }
  }
  const idx: SessIdx = { rows, ms: performance.now() - t0 };
  gs.__sessIndex = idx;
  return idx;
}

/**
 * 「最近一次 X 是什么时候」。
 *
 * 实测这题检索答不出来：问「最近一次游泳是什么时候」，top5 里明明有 11-15 的游泳记录，
 * 7B 仍回「资料里没有找到」——因为**答案不在任何一段文字里**，它是全库上的 max(date)，
 * 而且要排除计划文档里「~~游泳自练②~~」这种没发生的事。
 * 这和计数是同一类问题，只是聚合函数不同（max 而不是 count），所以走同一层。
 */
export interface LatestResult {
  ok: boolean;
  target: string;
  date: string;
  session: string;
  docName: string;
  docPath: string;
  muscleFocus: string[];
  exercises: string[];
  daysAgo: number;
  /** 倒数第二次，用来支撑「这是最近一次」而不是「唯一一次」 */
  previous: { date: string; docName: string } | null;
  summary: string;
  reason?: string;
}

export function latestSession(
  args: { muscle?: string | null; exercise?: string | null },
  opts: { refDate?: Date } = {}
): LatestResult {
  const { muscle = null, exercise = null } = args;
  const target = muscle ?? exercise ?? "";
  const empty = (reason: string): LatestResult => ({
    ok: false,
    target,
    date: "",
    session: "",
    docName: "",
    docPath: "",
    muscleFocus: [],
    exercises: [],
    daysAgo: 0,
    previous: null,
    summary: "",
    reason,
  });

  let idx: SessIdx;
  try {
    idx = loadSessions();
  } catch (e) {
    return empty(e instanceof Error ? e.message : "语料不可读");
  }

  const hits = idx.rows
    .map(({ doc, rec }) => {
      const focusParts = rec ? rec.muscleFocus : fmList(doc, "muscle_focus");
      const groupParts = rec ? rec.muscleGroups : fmList(doc, "muscle_groups");
      const names = rec ? rec.exercises.map((x) => x.name) : [];
      const hit = muscle ? groupParts.includes(muscle) : names.some((n) => n.includes(exercise as string));
      return { doc, rec, focusParts, names, hit, date: doc.date ?? doc.name.slice(0, 10) };
    })
    .filter((x) => x.hit)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!hits.length) return empty(`语料里没有${muscle ? `以「${muscle}」` : `含「${exercise}」`}的训练记录`);

  const [top, second] = hits;
  const ref = opts.refDate ?? new Date();
  const daysAgo = Math.max(0, Math.round((ref.getTime() - Date.parse(top.date)) / 86_400_000));
  const sessionName =
    (top.rec?.session ?? (typeof top.doc.fm.session === "string" ? top.doc.fm.session : "")) || "";

  return {
    ok: true,
    target,
    date: top.date,
    session: sessionName,
    docName: top.doc.name,
    docPath: top.doc.path,
    muscleFocus: top.focusParts,
    exercises: top.names.slice(0, 5),
    daysAgo,
    previous: second ? { date: second.date, docName: second.doc.name } : null,
    summary:
      `最近一次${muscle ? `以「${muscle}」为参与部位` : `含「${exercise}」`}的训练是 ${top.date}` +
      `${sessionName ? `（${sessionName}）` : ""}，距今天 ${daysAgo} 天。` +
      (second
        ? `上一次是 ${second.date}，所以这不是唯一一次。`
        : `语料里只有这一次，别当成规律。`) +
      `\n这个日期是遍历全部训练记录取的最晚一条，不是从检索到的几段里挑的——片段里出现的计划文档（写了但没做的课）不算。`,
  };
}

/**
 * 「这个月比上个月练得更多吗」需要**两个**区间，而 `resolvePeriod` 只给一个。
 *
 * 单独一个函数，而不是让调用方拼两次：月初/月末边界算错一次，整张对比表就全错，
 * 而且**看起来完全正常**——9 月有 30 天、10 月有 31 天，差一天不会有人察觉，
 * 但「每周几次」会差 3%。
 */
export function resolveCompare(
  q: string,
  ref = new Date()
): { cur: Period; prev: Period; unit: "月" | "周" } | null {
  const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());

  // 只有「比 / 对比 / 多还是少」才算比较；单说「上个月练了几次」是单区间查询
  if (!/比|对比|多还是少|哪个更多|哪个多/.test(q)) return null;

  const monthOf = (offset: number): Period => {
    const first = new Date(day.getFullYear(), day.getMonth() + offset, 1);
    const last = new Date(day.getFullYear(), day.getMonth() + offset + 1, 0);
    return {
      label: `${first.getFullYear()} 年 ${first.getMonth() + 1} 月`,
      from: ymd(first),
      to: ymd(last),
    };
  };

  const weekOf = (offset: number): Period => {
    // 周一为一周之首：中国习惯，而且训练日志本来就是按周排课的
    const dow = (day.getDay() + 6) % 7;
    const start = new Date(day);
    start.setDate(day.getDate() - dow + offset * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { label: `${start.getMonth() + 1} 月 ${start.getDate()} 日那周`, from: ymd(start), to: ymd(end) };
  };

  if (/周|星期/.test(q)) return { cur: weekOf(0), prev: weekOf(-1), unit: "周" };
  if (/月/.test(q)) return { cur: monthOf(0), prev: monthOf(-1), unit: "月" };
  return null;
}

/**
 * 数区间内的训练节数。
 *
 * 双口径是必须的，理由和趋势那边一样：`muscle_focus` 只记重点部位，
 * `muscle_groups` 是重点+辅助的并集。深蹲日只把「腿」记进 focus，
 * 但臀是实打实参与了——只报 focus 会得出「你没练臀」这种假结论（项目里踩过）。
 * 所以两个数都给，让答案说「重点 3 次，算上兼带 5 次」，而不是挑一个。
 */
export function countTraining(
  args: { muscle?: string | null; exercise?: string | null; period: Period },
  opts: { refDate?: Date } = {}
): CountResult {
  const { muscle = null, exercise = null, period } = args;
  // 三个都不传 = 数**全部训练课**。问「我练了几次」「平均每周几次」时没有部位/动作，
  // 旧实现直接返回 null，于是这类题掉进检索、模型从一段文字里抄个数就答了。
  const all = !muscle && !exercise;
  const target = muscle ?? exercise ?? "全部训练";
  const empty = (reason: string): CountResult => ({
    ok: false,
    target,
    periodLabel: period.label,
    from: period.from,
    to: period.to,
    rows: [],
    focusCount: 0,
    withSecondary: 0,
    degradedCount: 0,
    perWeek: { count: 0, weeks: 0, days: 0 },
    caliber: "",
    summary: "",
    reason,
  });

  let idx: SessIdx;
  try {
    idx = loadSessions();
  } catch (e) {
    return empty(e instanceof Error ? e.message : "语料不可读");
  }

  const rows: SessionRow[] = idx.rows
    .map(({ doc, rec }) => {
      const date = doc.date ?? doc.name.slice(0, 10);
      // 有氧课没有动作明细，部位从 frontmatter 直接读
      const focusParts = rec ? rec.muscleFocus : fmList(doc, "muscle_focus");
      const groupParts = rec ? rec.muscleGroups : fmList(doc, "muscle_groups");
      const names = rec ? rec.exercises.map((x) => x.name) : [];
      // 命中判定：按部位走 frontmatter 词表；按动作走动作名包含；都没有就全算
      const focus = all
        ? true
        : muscle
          ? focusParts.includes(muscle)
          : names.some((n) => n.includes(exercise as string));
      const secondary = all ? true : muscle ? groupParts.includes(muscle) : focus;
      return {
        row: {
          date,
          session: rec?.session ?? (typeof doc.fm.session === "string" ? doc.fm.session : ""),
          docName: doc.name,
          docPath: doc.path,
          focus,
          muscleFocus: focusParts,
          muscleGroups: groupParts,
          exercises: names.slice(0, 5),
          degraded: isDegraded(doc),
        } as SessionRow,
        secondary,
      };
    })
    .filter((x) => x.secondary && x.row.date >= period.from && x.row.date <= period.to)
    .sort((a, b) => a.row.date.localeCompare(b.row.date))
    .map((x) => x.row);

  if (!rows.length)
    return empty(
      `${period.label}没有${all ? "训练" : muscle ? `以「${muscle}」为参与部位` : `含「${exercise}」`}记录`
    );

  const focusRows = rows.filter((r) => r.focus);
  const degradedCount = rows.filter((r) => r.degraded).length;
  const dates = (rs: SessionRow[]) => rs.map((r) => r.date.slice(5)).join("、");

  const caliber = all
    ? `一次 = 一篇训练记录（练练导入的一节课），不分部位。`
    : muscle
      ? `一次 = 一篇训练记录（练练导入的一节课）。` +
        `「重点 ${focusRows.length} 次」只数 frontmatter 的 muscle_focus（这节课主要练的部位）；` +
        `「含兼带 ${rows.length} 次」用 muscle_groups（重点+辅助的并集）——蹲腿日里臀是辅助，只算 focus 会漏。`
      : `一次 = 一篇训练记录，动作名包含「${exercise}」即计入。`;

  const summary =
    (all
      ? `${period.label}（${period.from} ~ ${period.to}）共 ${rows.length} 节课。`
      : muscle
        ? `${period.label}（${period.from} ~ ${period.to}）以「${muscle}」为重点的课 ${focusRows.length} 次` +
          `${focusRows.length ? `（${dates(focusRows)}）` : ""}；` +
          `把「${muscle}」作为辅助部位也算上，共 ${rows.length} 次` +
          `${rows.length > focusRows.length ? `（另含 ${dates(rows.filter((r) => !r.focus))}）` : ""}。`
        : `${period.label}（${period.from} ~ ${period.to}）含「${exercise}」的课 ${rows.length} 次（${dates(rows)}）。`) +
    (degradedCount ? `其中 ${degradedCount} 次是降级课（试探档/复训），按课时也属于练了。` : "") +
    `\n这个数是遍历全部训练记录数出来的，不是从检索到的几段里数的——那些片段只是最相关的几条，不是全集。` +
    `计划里写了但被取消的课不会出现在训练记录里，所以不计入；反过来，记录里没有的也不能当成没练。`;

  // 频率：分母用**已过天数**，不是区间总天数。11-15 问「本月平均每周几次」，
  // 拿 30 天当分母等于把还没到的半个月算成「没练」，频率直接砍半。
  const ref = opts.refDate ?? new Date();
  const endMs = Math.min(Date.parse(period.to), ref.getTime());
  const days = Math.max(1, Math.round((endMs - Date.parse(period.from)) / 86_400_000) + 1);
  const perWeek = { count: rows.length, weeks: Math.round((days / 7) * 10) / 10, days };

  return {
    ok: true,
    target,
    periodLabel: period.label,
    from: period.from,
    to: period.to,
    rows,
    focusCount: focusRows.length,
    withSecondary: rows.length,
    degradedCount,
    perWeek,
    caliber,
    summary,
  };
}
