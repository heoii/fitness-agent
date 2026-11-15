/**
 * 检索层的**唯一入口**（W6）。
 *
 * 和 `src/lib/bm25.ts` 的分工，别混：
 *   · `bm25.ts` 是**评测基线**，一个纯函数式的经典实现，刻意不加任何预处理。
 *     W5 的所有对比数字都是基于它，改它等于让历史结论失去可比性。
 *   · 本文件是**产品检索器**，在 BM25 之上做三件基线不该做的事：
 *     ① 时间重排（用户问「最近」，日期是唯一能区分同模板记录的信号）
 *     ② 模板词降权（「容量 / 组 / 休息」这类每个动作标题都带的词，DF 48%，
 *        让所有深蹲记录退化成 16.44 平票 —— 实测见 `npm run w6:debug`）
 *     ③ 引用编号与定位串（前端角标要能点回 `文件 > 标题路径`）
 *
 * 为什么必须有一个「产品检索器」：W5 测的是**检索器之间的相对强弱**，
 * 用的是设计过的 query；线上拿到的是用户原话。第一次跑 `w6:llm` 就撞上了：
 * 问「深蹲最近在涨还是跌」，top5 里没有 11-07 和 11-14（分别排 #17 #24），
 * 模型只好拿健康记录里的 1RM 82kg 去比 60kg，得出「在涨」。**不是模型算错，是喂错资料。**
 */
import { walkMarkdown, loadDoc } from "./corpus";
import { chunkDoc, flatText, chunkLabel, type Chunk } from "./chunk";
import { BM25Index } from "./bm25";

export interface Hit {
  /** 引用编号，从 1 开始；prompt 里的 [n] 与之一一对应 */
  n: number;
  doc: string;
  docPath: string;
  date: string;
  headingPath: string[];
  /** 人类可读定位：`2026-11-07-训练-01-腿A.md > 动作明细 > 史密斯深蹲` */
  label: string;
  /** 正文，已按用途截断 */
  text: string;
  /** 重排后的最终分数（BM25 分 × 时间因子） */
  score: number;
  /** 原始 BM25 分，用来解释「为什么它上来了」 */
  bm25: number;
  /** 时间因子，1 = 刚刚，越小越旧 */
  recency: number;
  /**
   * 这条是某节下的**第几个小问**（W12）。只有 `headingPath.length >= 2`
   * 且同父节的小问数 `>= 2` 时才有值。
   *
   * 为什么必须有这个字段：问「练胸为什么脖子酸」时，top5 里 4 条来自同一个父节
   * （`## 颈部反应：为什么这节胸课会把脖子练酸`），其中「归因」才是答案，
   * 而「明天（11-03 拉日）怎么办」排第 6 —— 对模型来说它们长得一模一样，
   * 都是「颈部反应 > 某个子标题」。7B 看到「怎么办」就答了怎么办。
   * 摆在前面的资料没有错，**错的是没有告诉模型这几条是同一节的并列小问**。
   */
  section?: SectionSlot;
}

/** 一条资料在它所属小节里的位置。全部由代码算，不进 prompt 的推理。 */
export interface SectionSlot {
  /** 父节标题（headingPath 的倒数第二段） */
  parent: string;
  /** 本节共几个小问 */
  total: number;
  /** 本条是第几个（从 1 起，按原文顺序） */
  index: number;
  /** 本节所有小问的标题，按原文顺序；用来告诉模型「还有哪些角度，而你手上没有」 */
  siblings: string[];
}

export interface IndexMeta {
  chunks: number;
  docs: number;
  builtMs: number;
  dir: string;
  builtAt: string;
}

/** 查询改写诊断：原句被清洗成了什么、有没有时间线索。给 `w6:debug` 用。 */
export function inspectQuery(q: string): { raw: string; cleaned: string; timeHint: boolean } {
  return { raw: q, cleaned: cleanQuery(q) || q, timeHint: TIME_WORDS.test(q) };
}

interface Built {
  bm25: BM25Index;
  chunks: Chunk[];
  /** `docPath\0父路径` → 该父节下所有小问标题（有序、去重） */
  sections: Map<string, string[]>;
  builtMs: number;
  docs: number;
  dir: string;
  builtAt: string;
}

// 模块级缓存。用 globalThis 而不是普通模块变量：Next dev 会热重载模块，
// 普通变量每次改代码都会被重置，等于每改一行就重建 221ms 的索引。
// 生产环境单进程只建一次。
const g = globalThis as unknown as { __kbIndex?: Built };

/**
 * 语料根，支持**多个目录**。
 *
 * 为什么需要多目录：只索引 `01 每日记录` 时，问「自由泳高肘抱水怎么练」的 top5
 * 全是「自动统计」块，含「高肘」的那块排 #11；扩到整个知识库后它排 **#1**
 * （分数 25.63，标题正是「四、关键技术要点」）—— 因为技术要领本来就写在
 * `05 计划与复盘/计划/` 里，不在每日记录里。**那不是检索器的问题，是范围问题。**
 *
 * 但默认仍只取 KB_DIR：W5 的 15 题基线是在单目录上测的，换范围历史数字就不可比。
 * 要扩范围就显式配 `KB_DIRS=/a,/b`，并重跑 `npm run w5:eval`。
 */
function kbDirs(): string[] {
  const multi = process.env.KB_DIRS;
  if (multi) {
    const dirs = multi.split(",").map((s) => s.trim()).filter(Boolean);
    if (dirs.length) return dirs;
  }
  const dir = process.env.KB_DIR;
  if (!dir) throw new Error("缺少环境变量 KB_DIR 或 KB_DIRS（在仓库根目录的 .env.local 里配）");
  return [dir];
}

function build(): Built {
  const t0 = performance.now();
  const dirs = kbDirs();
  const chunks: Chunk[] = [];
  let docs = 0;
  for (const dir of dirs) {
    const files = walkMarkdown(dir);
    docs += files.length;
    for (const f of files) {
      const doc = loadDoc(f, dir);
      // stub（正文 < 20 字）不进库，和 build_index 同一口径
      for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
    }
  }
  const bm25 = new BM25Index(chunks.map((c) => ({ text: flatText(c) })));
  return {
    bm25,
    chunks,
    sections: buildSections(chunks),
    builtMs: performance.now() - t0,
    docs,
    dir: dirs.join(","),
    builtAt: new Date().toISOString(),
  };
}

/** 父节 key：同一篇文档 + 同一父路径才算「同一节」，不同文档的同名标题不能混。 */
const SECTION_SEP = "\u0000";

function sectionKey(docPath: string, parent: string[]): string {
  return docPath + SECTION_SEP + parent.join(SECTION_SEP);
}

/**
 * 建库时一次性算出「每个父节下有哪几个小问」。
 *
 * 放在建库阶段而不是每次检索时现算：`5600+` 块 × 每个命中块都要扫全库，
 * 单次查询会多出几毫秒，而这张表跟语料一样是静态的。
 *
 * 只统计 `headingPath.length >= 2` 的块：`## 摘要` 这种顶层块自己就是节，
 * 没有「第几个小问」可言。父节自身的前置正文块（比子节少一段）也自然被排除。
 */
function buildSections(chunks: Chunk[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of chunks) {
    if (c.headingPath.length < 2) continue;
    const key = sectionKey(c.doc.path, c.headingPath.slice(0, -1));
    const leaf = c.headingPath[c.headingPath.length - 1];
    const arr = map.get(key);
    if (!arr) {
      map.set(key, [leaf]);
    } else if (!arr.includes(leaf)) {
      // 超长块被硬切成 part 1/2，两个 chunk 共用同一个 heading——只记一次
      arr.push(leaf);
    }
  }
  return map;
}

/** 命中块在它所属小节里的位置；只有一个小问或本身就是顶层节时返回 undefined。 */
function sectionOf(c: Chunk, sections: Map<string, string[]>): SectionSlot | undefined {
  if (c.headingPath.length < 2) return undefined;
  const parent = c.headingPath.slice(0, -1);
  const siblings = sections.get(sectionKey(c.doc.path, parent));
  if (!siblings || siblings.length < 2) return undefined;
  const index = siblings.indexOf(c.headingPath[c.headingPath.length - 1]) + 1;
  if (index < 1) return undefined;
  return { parent: parent[parent.length - 1], total: siblings.length, index, siblings };
}

export function getIndex(): Built {
  if (!g.__kbIndex) g.__kbIndex = build();
  return g.__kbIndex;
}

export function resetIndex(): void {
  g.__kbIndex = undefined;
}

export function indexMeta(): IndexMeta {
  const i = getIndex();
  return { chunks: i.chunks.length, docs: i.docs, builtMs: i.builtMs, dir: i.dir, builtAt: i.builtAt };
}

/** 用户话里的时间线索。有这些词时，时间衰减要明显加强。 */
const TIME_WORDS = /最近|近期|上次|上回|这几次|这几天|现在|当前|今天|昨天|本周|这周|上周|上个?月|今年/;

/**
 * 查询里的噪声词：**必须在送进 BM25 之前剥掉**。
 *
 * 这一条是实测撞出来的，不是理论推导：问「深蹲最近在涨还是在跌」时，
 * `top1` 是「HRV 口径切换」这种完全无关的段落，而 11-07 / 11-14 两次深蹲记录
 * 排到 #49 / #65。原因很反直觉——**「最近」在这个语料里只出现在 11 块里**，
 * DF 低意味着 IDF 极高（比「深蹲」还高），于是「谁提过最近」压倒了「谁真的在讲深蹲」。
 *
 * BM25 的 IDF 假设是「稀有词=有信息量」，对实体词成立，对**时间副词和疑问词完全不成立**。
 * 所以剥掉它们，时间信息交给 recencyFactor 处理，不靠文本匹配。
 */
const QUERY_NOISE =
  /最近一次|上一次|上一次|最近|近期|近来|现在|当前|目前|今天|昨天|本周|这周|上周|上个?月|今年|去年|这次|上次|上回|前几次|这几次|这几天|什么时候|哪一天|哪天|多久|还是|是不是/g;

function cleanQuery(q: string): string {
  return q.replace(QUERY_NOISE, " ").replace(/\s+/g, " ").trim();
}

/** 一年前的记录该掉到多少。0.5 = 半衰期一年（温和），够把同模板的老记录压下去。 */
const HALF_LIFE_DAYS = 365;
/** 出现时间词时的半衰期：45 天。用户说「最近」时，两个月前的东西基本不该进 top5。 */
const HALF_LIFE_STRONG = 45;
/** 时间因子在最终分里的权重。1 = 完全按时间排（会丢掉文本相关性），0 = 完全不管时间。 */
const RECENCY_WEIGHT = 0.45;

function recencyFactor(dateStr: string, strong: boolean, now = Date.now()): number {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return 0.5; // 没日期的块按中间值处理，不奖不罚
  const days = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, days / (strong ? HALF_LIFE_STRONG : HALF_LIFE_DAYS));
}

export interface RetrieveOptions {
  /** 取几条，默认 5 */
  k?: number;
  /** 重排前先捞多少条候选，默认 50。太小会漏掉「BM25 排名靠后但很新」的块 */
  pool?: number;
  /** 给 prompt 用的正文长度上限 */
  textChars?: number;
  /** 强制开/关时间重排；不传则按 query 里的时间词自动判断 */
  recency?: boolean;
}

/**
 * 检索 + 时间重排。
 *
 * 两段式而不是直接改 BM25 打分，理由是可解释：返回里同时有 `bm25` 和 `recency`，
 * 任何一次「它凭什么排第一」都能拆开看，不用去猜一堆乘在一起的权重。
 */
export function retrieve(query: string, opts: RetrieveOptions = {}): Hit[] {
  const { k = 5, pool = 50, textChars = 420 } = opts;
  const idx = getIndex();
  const strong = opts.recency ?? TIME_WORDS.test(query);
  // 剥掉时间副词/疑问词再检索；全被剥光时退回原句，避免空查询
  const cleaned = cleanQuery(query) || query;

  const cands = idx.bm25.topK(cleaned, pool);
  const now = Date.now();
  const scored = cands.map((c) => {
    const chunk = idx.chunks[c.i];
    const rec = recencyFactor(chunk.doc.date ?? "", strong, now);
    // 相关性排第一，时间做加权而不是独占：0.45 权重 + 0.55 保底，
    // 保证「文本完全不相关的近期文档」不会挤掉「文本高度相关的老文档」。
    const score = c.score * (1 - RECENCY_WEIGHT + RECENCY_WEIGHT * rec);
    return { chunk, bm25: c.score, rec, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, k).map((s, i) => ({
    n: i + 1,
    doc: s.chunk.doc.name,
    docPath: s.chunk.doc.path,
    date: s.chunk.doc.date ?? "",
    headingPath: s.chunk.headingPath,
    label: chunkLabel(s.chunk),
    text: s.chunk.text.slice(0, textChars),
    score: s.score,
    bm25: s.bm25,
    recency: s.rec,
    section: sectionOf(s.chunk, idx.sections),
  }));
}
