/**
 * W6 验收：10 道题跑通 `/api/ask` 的同一套逻辑（复用 `src/lib/answer.ts`，不走 HTTP，
 * 因为本机沙箱起不了 dev server；这和 W2 用 `scripts/compliance.ts` 验 extract 是同一手法）。
 *
 * 判据（全部可机器检查，不靠"看起来还行"）：
 *   A. **引用合法**：答案里每个 [n] 都落在 citations 范围内（`check.invalid` 必须为空）
 *   B. **引用可定位**：每条 citation 的 label 形如 `文件.md > 标题 > 子标题`
 *   C. **有答案的题必须真的引用**：不允许空引用 + 通篇"我觉得"
 *   D. **库里没有的必须承认**：`check.noAnswer` 为 true，不许编数字
 *   E. **要算数的走工具**：计数题须报对数、趋势题须报双口径，做不到才允许拒答
 *      ——绝不能从检索到的几段里数，那 5 段是最相关的 5 条，不是全部 5 条
 *
 * 用法: npm run w6:ask
 */
import { kbDir } from "./kb-dir";
import { ask, type AskResult } from "../src/lib/answer";
import { indexMeta } from "../src/lib/retrieve";

type Kind = "answerable" | "absent" | "needs-math" | "reframe" | "aggregate" | "stale";

interface Q {
  id: string;
  q: string;
  kind: Kind;
  /** answerable 时，答案该落在哪些文档（用于人工核对，脚本不强制） */
  expectDoc?: string;
  note?: string;
  /**
   * needs-math 且有确定答案时，答案里必须出现这个数。
   * 只能是**人工核过语料**的值（2026-11 的腿课：11-07、11-14 两节），
   * 不许从工具输出里抄——否则工具算错，判据跟着一起错，等于没判。
   */
  expectCount?: number;
  /**
   * reframe 时，答案里必须出现的词。
   * 这些是**资料里的关键区分点**（比如「恢复是 2–4 周的被动中断」），
   * 只说「不是一回事」但没答到具体内容，也算没答。
   */
  mustMention?: string[];
  /**
   * aggregate 时答案里必须出现的数。
   * 全部是**人工数语料核过的**（2026-11 共 10 篇训练记录、2026-10 共 26 篇），
   * 不从工具输出抄——工具算错时判据要能跟着红。
   */
  expectNums?: number[];
  /** stale 时，期望走哪条入口（用来抓「意图过宽」：问具体动作却答了全局排行） */
  expectRoute?: "retrieve" | "trend" | "count" | "latest" | "compare" | "stale";
  /**
   * 必须引到标题里含这些串的段落（判据 I）。
   *
   * 为什么不看措辞只看引用：模型换个说法把同一件事说对，是正常的；
   * 而**引到哪一小问**是结构事实，措辞变了也不会变。
   * A1 的正确答案在「归因：三个动作同一个机制」，而同节还有
   * 「下次课的三处改动」「明天（11-03 拉日）怎么办」——后两条也在 top5 里，
   * 拿它们答「为什么」会得到一段读起来很顺、但答的是另一个问题的答案。
   */
  mustCiteLabel?: string[];
}

const QUESTIONS: Q[] = [
  { id: "A1", q: "为什么我练胸的时候脖子会酸？", kind: "answerable", expectDoc: "2026-11-02-健康记录" },
  {
    id: "A8",
    q: "练胸为什么脖子会酸",
    kind: "answerable",
    expectDoc: "2026-11-02-健康记录",
    mustCiteLabel: ["归因"],
    /*
     * A8 和 A1 是**同一意图的两种问法**，必须分开看，别合并：
     *
     *   A8「练胸为什么脖子会酸」（短句）→ top5 是父节 + 归因/下次课等子节，对的。
     *   A1「为什么我练胸的时候脖子会酸？」（原话）→ top5 混进
     *      「fitness-agent 上手说明」「双机协作约定」「RAG」，归因压根不在里面。
     *
     * 原因不是清洗不够，是语料里的词表冲突：「练胸」在动作名里是后缀
     * （`双杠臂屈伸-练胸（kg）`，10 块），短块靠这一个稀有词就能压过
     * 命中「脖子+酸」两个词的长块；而「归因」那段正文写的是「胸椎伸展 / 枕下肌群」，
     * **既没有「练胸」也没有「脖子」**，它进 top5 全靠标题路径里带着这几个字。
     *
     * 所以 A8 测的是「父子节标注管不管用」，A1 测的是「检索对措辞有多敏感」——
     * 后者是 README 里记了很久的已知缺口，不在 W12 范围内，也别让它的红
     * 去污染父子节这条判据。两件事分开记，才不会互相掩护。
     */
  },
  {
    id: "A2",
    q: "减载期、恢复期、增长期的门槛分别是什么",
    kind: "reframe",
    mustMention: ["恢复"],
    // 问题把两套分类混着问：减载/增长是 ACWR 的三个区间，而「恢复」是另一套
    // （被动、被外力打断、2–4 周）。2026-10-31 那篇里有一整节叫
    // 「最容易混的一对：减载 ≠ 恢复」。模型原来顺着错的框架答，还把恢复期跳过了。
    note: "前提混淆：减载/增长是 ACWR 区间，恢复是另一套划分",
  },
  { id: "A3", q: "苹果健康数据多久导入一次", kind: "answerable" },
  { id: "A4", q: "卧推用 8×8 还是 5×5 怎么看", kind: "answerable", expectDoc: "2026-10-31-健康记录" },
  { id: "A5", q: "自由泳高肘抱水怎么练", kind: "answerable" },
  { id: "A6", q: "布拉德福德推举是在哪次训练里做的", kind: "answerable" },
  { id: "A7", q: "HRV 现在用的是哪一套口径", kind: "answerable" },
  // ——— 库里没有：语料从 2025 年开始 ———
  { id: "B1", q: "我 2019 年的体脂率是多少？", kind: "absent" },
  { id: "B2", q: "我上一次马拉松的成绩是多少？", kind: "absent" },
  // ——— 需要算数：正确行为是拒绝下结论，并列出原始数据 ———
  { id: "C1", q: "我深蹲的重量最近在涨还是在跌？", kind: "needs-math", note: "正确做法：说明需要结构化统计" },
  {
    id: "C2",
    q: "我这个月一共练了几次腿？",
    kind: "needs-math",
    // 人工核对：11-07 腿A、11-14 腿A（正常档），共 2 节
    expectCount: 2,
    note: "需要计数；第一版答「1 次」，依据是片段里「11-04 腿日被取消」",
  },
  { id: "C3", q: "上个月练了几次腿", kind: "needs-math", expectCount: 4, note: "2026-10：10-09 / 10-17 / 10-22 / 10-30（末次是试探档）" },
  { id: "C4", q: "这个月有氧几次", kind: "needs-math", expectCount: 3, note: "游泳课没有动作明细，是计数层第一个静默 bug 的来源" },
  {
    id: "C5",
    q: "史密斯深蹲最近是在涨还是在跌",
    kind: "needs-math",
    note: "必须报双口径（含热身 +4.9% / 剔除 −12.8%）",
  },

  // ——— W7·5 扩的 8 题：覆盖时间定位、跨目录、以及更多拒答 ———
  { id: "A8", q: "上一次腿课是哪天", kind: "answerable", expectDoc: "2026-11-14", note: "定位型：要给日期，不是给建议" },
  { id: "A9", q: "最近一次游泳是什么时候", kind: "answerable", expectDoc: "2026-11-15" },
  {
    id: "A10",
    q: "蛋白粉一天最多喝几勺",
    kind: "answerable",
    expectDoc: "食材库存",
    // 这条答案只写在 `05 计划与复盘/食材库存.md`，不扩语料到整个知识库就找不到——
    // 它是 KB_DIRS 那条改动的验收题，不是凑数的
    note: "答案在 05 计划与复盘，只索引每日记录时查不到",
  },
  // ——— 聚合：没有部位/动作，问的是总量 ———
  {
    id: "G1",
    q: "我平均每周练几次",
    kind: "aggregate",
    expectNums: [10],
    note: "旧版走检索，「10 月平均间隔 1.5 天」换算成「每周 4-5 次」——引用真实、算术也对，答的却是另一个问题",
  },
  {
    id: "G2",
    q: "和上个月比这个月练得更多吗",
    kind: "aggregate",
    expectNums: [10, 26],
    note: "两个区间的次数：11 月 10 篇、10 月 26 篇（人工 ls 核过）；必须同时给总次数和每周频率",
  },
  {
    id: "G3",
    q: "上个月练了几次",
    kind: "aggregate",
    expectNums: [26],
    note: "单区间、无实体；旧版因为没有部位/动作直接不走工具",
  },
  // ——— 荒废：集合差 + 日期 ———
  {
    id: "H1",
    q: "哪些动作我很久没练了",
    kind: "stale",
    expectRoute: "stale",
    // 真值 2026-11-15：悍马上斜推胸只在 2025-08-05 那篇出现过一次
    mustMention: ["悍马上斜推胸"],
    note: "对每个动作取 max(date) 再排序，任何一段文字里都没有这个结果",
  },
  {
    id: "H2",
    q: "哪些动作我从来没练过",
    kind: "stale",
    expectRoute: "stale",
    mustMention: ["动作库"],
    note: "语料只有练过的 135 个动作，没有全集——必须明说列不出来，不能拿「很久没练」冒充",
  },
  {
    id: "H3",
    q: "硬拉多久没练了",
    kind: "stale",
    expectRoute: "latest",
    note: "指定了动作就走 latest；第一版意图过宽，答的是「悍马上斜推胸 467 天」",
  },
  { id: "B3", q: "我第一次跑全马的完赛成绩是多少", kind: "absent" },
  { id: "B4", q: "2020 年我的深蹲最大重量是多少", kind: "absent", note: "语料从 2025 年开始" },
];

interface Row {
  q: Q;
  r: AskResult;
  labelOk: boolean;
  refused: boolean;
}

/** 引用能不能定位：label 至少要有 `文件.md > 一级标题` 两段 */
function labelParsable(label: string): boolean {
  const parts = label.split(" > ");
  return parts.length >= 2 && /\.md$/.test(parts[0]);
}

/**
 * 有没有拒绝「从片段里直接推结论」。
 *
 * 第一版只匹配「这需要结构化统计」，结果 C1 明明答了
 * 「没有信息表明这些变化是持续的趋势，因此**无法判断**」——行为完全正确，
 * 却因为措辞不在词表里被判成失败。判据比实现更容易出错，这里放宽到
 * 「表达不确定 / 明确拒答 / 说没找到」三类。
 */
function isRefusal(answer: string): boolean {
  return /需要结构化统计|算不准|不能从|无法从|无法判断|不能判断|不能确定|无从判断|没有找到|未找到/.test(answer);
}

/**
 * 「要算数」类题的正确行为有**三种**，判据必须都认：
 *   ① 走计数入口（route=count）：答案里必须出现**人工核对过的**那个数；
 *   ② 走数值入口（route=trend）：答案里必须出现**两个口径**的百分比；
 *   ③ 都没走：必须拒绝下结论。
 * 前两版只认 ③，于是 C1 走向量入口时明明答了「无法判断…是涨是跌」被判失败，
 * 后来接了工具路由、答出双口径，又判失败一次。**判据跟不上实现，就会把对的判成错的。**
 */
function numbersIn(answer: string): number[] {
  // 模型会把引用编号当数字用：「以「有氧」为重点的课 [3] 次」——它想说的是 3 次。
  // 不认这种写法会把**答对的判成答错**，而错的其实是表达方式。
  const norm = answer.replace(/\[(\d+)\]\s*(次|节|回)/g, "$1 $2");
  const arabic = [...norm.matchAll(/(\d+)\s*(?:次|节|回)/g)].map((m) => Number(m[1]));
  const cn: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const chinese = [...norm.matchAll(/([一两二三四五六七八九十])\s*(?:次|节|回)/g)].map((m) => cn[m[1]]);
  return [...arabic, ...chinese];
}

function mathOk(r: AskResult, expectCount?: number): boolean {
  if (r.meta.route === "count") {
    if (expectCount === undefined) return true;
    return numbersIn(r.answer).includes(expectCount);
  }
  if (r.meta.route === "trend") {
    const hasTwoCalibers = (r.answer.match(/[+\-]?\d+(\.\d+)?%/g) ?? []).length >= 2;
    const mentionsWarmup = /热身/.test(r.answer);
    return hasTwoCalibers && mentionsWarmup;
  }
  return isRefusal(r.answer);
}

/**
 * 「问题前提有误」类：正确行为是**先纠正前提，再回答**。
 *
 * A2 原来只答了减载区和增长区，「恢复期」被跳过——因为用户把两套分类混着问：
 * 减载/增长是 ACWR 的三个区间，而「恢复」是另一套（被动、被外力打断、2–4 周）。
 * 模型顺着错的框架答、还漏了一个，看起来却像个完整回答。
 *
 * 判据只认「有没有指出这不是一回事」，不判措辞是否漂亮——那太脆。
 * 但 mustMention 是硬的：光说「不是一回事」却不讲恢复是什么，等于没回答。
 */
function reframeOk(r: AskResult, mustMention: string[] = []): boolean {
  if (!r.ok) return false;
  const corrected =
    /不是一回事|不是同一|不属于|另一套|两种划分|不同的划分|不在同一|不是这么分|不是同一个层面|要分开看/.test(
      r.answer
    );
  return corrected && mustMention.every((m) => r.answer.includes(m));
}

/**
 * 聚合类：问的是总量（几次 / 每周几次 / 比上月多不多），没有部位或动作。
 *
 * 这类题旧版全部掉进检索——因为工具层要求「必须有实体」，
 * 于是模型从一段文字里抄个数就答了。所以判据要看**路由**：
 * 走了 count/compare 还不够，数字还得对（真值人工数过语料）。
 */
function aggregateOk(r: AskResult, expectNums: number[] = []): boolean {
  if (!r.ok) return false;
  if (r.meta.route !== "count" && r.meta.route !== "compare") return false;
  const got = numbersIn(r.answer);
  return expectNums.every((n) => got.includes(n));
}

/**
 * 荒废类：集合差 + 日期。
 *
 * 两个判据缺一不可：
 *   - **路由**：问「硬拉多久没练了」必须走 latest，不能走全局排行。
 *     第一版没有这层判断，问硬拉答的是「悍马上斜推胸 467 天」——
 *     答的是另一个问题，而列表看起来很像正确答案。
 *   - **内容**：问「从来没练过」必须说清语料里没有动作全集。
 */
function staleOk(r: AskResult, q: Q): boolean {
  if (!r.ok) return false;
  if (q.expectRoute && r.meta.route !== q.expectRoute) return false;
  return (q.mustMention ?? []).every((m) => r.answer.includes(m));
}

async function main() {
  kbDir(); // 触发 .env.local 加载（scripts/kb-dir.ts 在模块顶层做）
  // --only C 只跑 id 以 C 开头的题。调参时跑全量要 1 分钟，改一句 prompt 等一分钟太久，
  // 人会开始「跑一次看看大差不差就算过」——判据就是这么松掉的。
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const list = only ? QUESTIONS.filter((q) => q.id.startsWith(only)) : QUESTIONS;
  if (!list.length) throw new Error(`--only=${only} 没有匹配的题`);
  const meta = indexMeta();
  console.log(`索引：${meta.chunks} 块 / ${meta.docs} 篇（建库 ${meta.builtMs.toFixed(0)} ms）`);
  console.log(`题量：${list.length}${only ? `（--only=${only}）` : ""}（有答案 ${list.filter((q) => q.kind === "answerable").length} / ` +
    `库里没有 ${list.filter((q) => q.kind === "absent").length} / ` +
    `要算数 ${list.filter((q) => q.kind === "needs-math").length}）`);
  console.log("=".repeat(78));

  const rows: Row[] = [];
  for (const q of list) {
    const r = await ask(q.q);
    const labelOk = r.citations.length > 0 && r.citations.every((c) => labelParsable(c.label));
    const refused = isRefusal(r.answer);
    rows.push({ q, r, labelOk, refused });
    console.log(`\n【${q.id}·${q.kind}】${q.q}`);
    console.log(
      `   ${r.ok ? "" : `✗ ${r.reason}  `}引用 [${r.check.refs.join(",") || "无"}]` +
        `${r.check.invalid.length ? `  ⚠ 越界 [${r.check.invalid.join(",")}]` : ""}` +
        `${r.citations[0] ? `  首位 ${r.citations[0].label.slice(0, 46)}` : ""}`
    );
    console.log(`   [${r.meta.route}] ${r.meta.ms.retrieve}ms 检索 + ${(r.meta.ms.generate / 1000).toFixed(1)}s 生成`);
    console.log(`   ${r.answer.replace(/\n+/g, " ").slice(0, 300)}`);
  }

  // ——— 汇总判据 ———
  const ok = rows.filter((x) => x.r.ok);
  const invalidFree = ok.filter((x) => x.r.check.invalid.length === 0).length;
  /*
   * 引用可定位只对「答案来自资料」的题有意义。
   *
   * aggregate（几次 / 每周几次 / 比上月多不多）的答案来自代码——
   * 「11 月 10 次」是遍历全部训练记录数出来的，不是从某一篇摘的。
   * 硬给它配两条引用，等于暗示答案出自那两篇，比不给更误导。
   *
   * 这不等于「空洞通过」：后者是判据压根没跑却报过（--only=C 那次），
   * 这里是**明确排除不适用的一类**，而且分母会跟着变小、看得见。
   */
  const needsCite = ok.filter((x) => x.q.kind !== "aggregate" && x.q.kind !== "stale");
  const labelOkN = needsCite.filter((x) => x.labelOk).length;
  const answerable = rows.filter((x) => x.q.kind === "answerable" && x.r.ok);
  const citedN = answerable.filter((x) => x.r.check.refs.length > 0 && !x.r.check.noAnswer).length;
  const absent = rows.filter((x) => x.q.kind === "absent" && x.r.ok);
  const absentN = absent.filter((x) => x.r.check.noAnswer).length;
  const math = rows.filter((x) => x.q.kind === "needs-math" && x.r.ok);
  const mathN = math.filter((x) => mathOk(x.r, x.q.expectCount)).length;
  const reframe = rows.filter((x) => x.q.kind === "reframe" && x.r.ok);
  const reframeN = reframe.filter((x) => reframeOk(x.r, x.q.mustMention)).length;
  const agg = rows.filter((x) => x.q.kind === "aggregate" && x.r.ok);
  const aggN = agg.filter((x) => aggregateOk(x.r, x.q.expectNums)).length;
  const stale = rows.filter((x) => x.q.kind === "stale" && x.r.ok);
  const staleN = stale.filter((x) => staleOk(x.r, x.q)).length;

  /*
   * I. 小节题必须引到对的那一小问（W12）。
   *    不判措辞，只判引用落在哪个子标题——「归因」被引到了，说明模型读的是原因；
   *    只引到「明天怎么办」的答案，读起来同样通顺，但那是在答另一个问题。
   */
  const secQ = rows.filter((x) => (x.q.mustCiteLabel?.length ?? 0) > 0 && x.r.ok);
  const secN = secQ.filter((x) =>
    (x.q.mustCiteLabel ?? []).every((m) => x.r.citations.some((c) => c.label.includes(m)))
  ).length;

  // 分母为 0 时写「未覆盖」而不是 0/0 然后算通过——--only=C 那次就是这么
  // 显示「✓ A–D 全过」的，实际上 A–D 一条都没跑。空洞通过比失败更危险。
  const frac = (n: number, d: number) => (d === 0 ? "未覆盖" : `${n}/${d}`);
  const A = frac(invalidFree, ok.length);
  const B = frac(labelOkN, needsCite.length);
  const C = frac(citedN, answerable.length);
  const D = frac(absentN, absent.length);
  const E = `${frac(mathN, math.length)}（count 须报对数 / trend 须报双口径 / 否则须拒答）`;
  const F = `${frac(reframeN, reframe.length)}（必须指出「不是一回事」，且答到具体内容）`;
  const G = `${frac(aggN, agg.length)}（count/compare 路由 + 数字对真值）`;
  const H = `${frac(staleN, stale.length)}（路由对 + 关键内容出现）`;
  const I = `${frac(secN, secQ.length)}（问原因须引到「归因」那一小问）`;
  const avg = (ok.reduce((s, x) => s + x.r.meta.ms.total, 0) / (ok.length || 1) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(78));
  console.log(`A 引用合法（无越界）      ${A}`);
  console.log(`B 引用可定位（有标题路径）  ${B}`);
  console.log(`C 有答案的题真的引用了     ${C}`);
  console.log(`D 库里没有的承认没找到     ${D}`);
  console.log(`E 要算数的走工具而非硬答    ${E}`);
  console.log(`F 前提有误时会纠正          ${F}`);
  console.log(`G 聚合类走工具且数对        ${G}`);
  console.log(`H 荒废类路由与内容都对      ${H}`);
  console.log(`I 小节题引到对的小问        ${I}`);
  console.log(`  平均端到端              ${avg} s（本机 7B，同步非流式）`);

  const groupOk = (n: number, d: number) => d === 0 || n === d;
  const pass = groupOk(invalidFree, ok.length) && groupOk(labelOkN, needsCite.length) &&
    groupOk(citedN, answerable.length) && groupOk(absentN, absent.length) && groupOk(mathN, math.length) &&
    groupOk(reframeN, reframe.length) && groupOk(aggN, agg.length) && groupOk(staleN, stale.length) &&
    groupOk(secN, secQ.length);
  const covered = [ok.length > 0, needsCite.length > 0, answerable.length > 0, absent.length > 0, math.length > 0, reframe.length > 0, agg.length > 0, stale.length > 0, secQ.length > 0].filter(Boolean).length;
  console.log(`\n${pass ? "✓ 全过" : "✗ 有判据未过"}（覆盖 ${covered}/9 组判据）`);

  /*
   * 分类准确率 + 未达标明细。
   *
   * 加这一段是因为「A–E 全过」会掩盖某一类全崩：E 只要 2/2 就算过，
   * 而它只考了 2 道算数题。把题库按「这题到底在考什么」拆开看，
   * 才能发现「拒答题好、计数题差」这种结构性缺口。
   * 未达标明细要带**题号和原因**，它就是这个项目的待办清单。
   */
  const good = (x: Row): boolean => {
    if (!x.r.ok) return false;
    // mustCiteLabel 是叠加条件：A1 除了「有引用」，还必须引到「归因」那一小问。
    // 写成先判后加，避免把它塞进某个 kind 分支里、换个 kind 就悄悄失效。
    const citeHit = (x.q.mustCiteLabel ?? []).every((m) => x.r.citations.some((c) => c.label.includes(m)));
    if (x.q.kind === "answerable")
      return x.r.check.refs.length > 0 && !x.r.check.noAnswer && x.labelOk && citeHit;
    if (x.q.kind === "absent") return x.r.check.noAnswer;
    if (x.q.kind === "reframe") return reframeOk(x.r, x.q.mustMention);
    if (x.q.kind === "aggregate") return aggregateOk(x.r, x.q.expectNums);
    if (x.q.kind === "stale") return staleOk(x.r, x.q);
    return mathOk(x.r, x.q.expectCount);
  };
  console.log("\n分类准确率");
  for (const k of ["answerable", "absent", "needs-math", "reframe", "aggregate", "stale"] as Kind[]) {
    const g = rows.filter((x) => x.q.kind === k);
    if (!g.length) continue;
    const hit = g.filter(good).length;
    console.log(`  ${k.padEnd(12)} ${hit}/${g.length}`);
  }

  const bad = rows.filter((x) => !good(x));
  if (bad.length) {
    console.log("\n未达标明细");
    for (const x of bad) {
      const why = !x.r.ok ? `出错：${x.r.reason}` : `不满足判据（route=${x.r.meta.route}）`;
      console.log(`  ${x.q.id}  ${x.q.q}\n      → ${why}`);
    }
  }

  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
