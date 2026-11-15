/**
 * 父子节标注自检：`npm run w7:section`（不调模型）
 *
 * 要防的错很具体：问「练胸为什么脖子会酸」，top5 里 4 条来自同一个父节
 * （`## 颈部反应：为什么这节胸课会把脖子练酸`），其中「归因」是答案，
 * 而「明天（11-03 拉日）怎么办」也进来了。**这些资料没有一条是错的**，
 * 错的是它们在 prompt 里长得一样——7B 看到「怎么办」就答了怎么办。
 *
 * 判据分三类：
 *   ① 结构自洽（永不过期）：index/total/siblings 三者互相咬合
 *   ② 已知真值（**语料一变就会红，红了重算**）：颈部反应那节的 5 个小问与顺序
 *   ③ 负例（这次最容易漏）：没命中子节的问题不该被节位标注干扰；
 *      以及「不许再往 prompt 里塞判断小问的指令」——这个错误犯过两次，见 answer.ts 的注释
 *
 * 一条弱判据说明：`siblings[index-1] === 该块最后一段标题` 是构造出来的恒等式
 * （index 本来就来自 indexOf），它抓不到算法错，只能抓「section 与 label
 * 用了不同字段」这种漂移。不当主判据用，但仍然留着——它便宜。
 */
import { kbDir } from "./kb-dir";
import { retrieve, getIndex } from "../src/lib/retrieve";
import { buildAskPrompt } from "../src/lib/answer";

kbDir();

const cases: Array<{ name: string; ok: boolean; got: string; want: string }> = [];
const push = (name: string, ok: boolean, got: unknown, want: unknown) =>
  cases.push({ name, ok, got: String(got), want: String(want) });

/** 那个真实失败案例的原句 */
const Q = "练胸为什么脖子会酸";
const hits = retrieve(Q, { k: 5 });
const prompt = buildAskPrompt(hits, Q);

/* ── ① 结构自洽：全库扫一遍，不能只看这一题 ── */

// 每一块里的 section 都必须满足 index ≤ total 且 siblings 不重复
const idx = getIndex();
let slotChecked = 0;
let slotBad = 0;
for (const q of ["练胸为什么脖子会酸", "自由泳高肘抱水怎么练", "睡眠不足对训练有什么影响", "拉伸要拉多久"]) {
  for (const h of retrieve(q, { k: 8 })) {
    const s = h.section;
    if (!s) continue;
    slotChecked++;
    const ok =
      s.total >= 2 &&
      s.index >= 1 &&
      s.index <= s.total &&
      s.siblings.length === s.total &&
      new Set(s.siblings).size === s.total &&
      s.siblings[s.index - 1] === h.headingPath[h.headingPath.length - 1] &&
      s.parent === h.headingPath[h.headingPath.length - 2];
    if (!ok) slotBad++;
  }
}
push("section 结构自洽", slotBad === 0, `${slotBad} 处不合规`, 0);
// 弱判据：得真的测到了东西，否则「全过」等于没测
push("确实测到了 section（>0 条）", slotChecked > 0, slotChecked, ">0");

// 顶层块（## 摘要 这种）不该有 section——它自己就是节，没有「第几个小问」
const topHasSection = retrieve("睡眠不足对训练有什么影响", { k: 8 }).some(
  (h) => h.headingPath.length === 1 && h.section
);
push("顶层块无 section", !topHasSection, topHasSection, false);

// 同一父节的两条命中，siblings 必须是同一个数组内容（不同块各算一遍会漂移）
const byParent = new Map<string, string[]>();
let siblingDrift = 0;
for (const h of retrieve(Q, { k: 8 })) {
  if (!h.section) continue;
  const key = `${h.doc} > ${h.section.parent}`;
  const prev = byParent.get(key);
  if (prev && prev.join("|") !== h.section.siblings.join("|")) siblingDrift++;
  byParent.set(key, h.section.siblings);
}
push("同父节的 siblings 一致", siblingDrift === 0, siblingDrift, 0);

/* ── ② 已知真值（人工核过 2026-11-02 那篇的标题顺序）── */

const neck = hits.filter((h) => h.section && h.section.parent.includes("颈部反应"));
push("命中颈部反应那节", neck.length > 0, neck.length, ">0");

const s0 = neck[0]?.section;
push("该节共 5 个小问", s0?.total === 5, s0?.total, 5);
push(
  "小问顺序（原文顺序）",
  s0?.siblings.join(" / ") ===
    [
      "归因：三个动作同一个机制",
      "⚠️ 归因修正（22:31 用户补充）：史密斯换成了杠铃",
      "立刻能做的：先分清是哪一段酸",
      "下次课的三处改动（已固化，不用重想）",
      "明天（11-03 拉日）怎么办",
    ].join(" / "),
  s0?.siblings.join(" / "),
  "归因 / 归因修正 / 立刻能做的 / 下次课 / 明天怎么办"
);

// 这正是那个 bug：答案在「归因」，而「明天怎么办」也在 top 里
push(
  "「归因」被标成第 1 个",
  neck.some((h) => h.section!.index === 1 && h.headingPath.at(-1)!.startsWith("归因")),
  neck.map((h) => `${h.section!.index}.${h.headingPath.at(-1)!.slice(0, 6)}`).join(","),
  "有 index=1 的归因"
);
push(
  "「明天怎么办」若命中则 index=5",
  neck.filter((h) => h.headingPath.at(-1)!.includes("明天")).every((h) => h.section!.index === 5),
  neck.filter((h) => h.headingPath.at(-1)!.includes("明天")).map((h) => h.section!.index).join(",") || "未命中",
  "5 或未命中"
);

/* ── ③ prompt 层：标注与规则都落到了盘上 ── */

push("prompt 含节位标注", prompt.includes("§ 本节 5 个小问的第"), /§ 本节 5 个小问的第 \d 个/.test(prompt), true);
push("兄弟小问标题被列出", prompt.includes("明天（11-03 拉日）怎么办"), prompt.includes("明天（11-03 拉日）怎么办"), true);

// 这条判据盯着一个**已经犯过的错**：曾经加过「第 7 条规则」，教模型自己判断
// 「这一小问对不对题」。两版都失败了——A5 拿它当拒答开场白、A2 用它替掉了
// 规则 4 的纠正。根子是让 7B 做取舍判断，它判不准就退回拒答。
// 现在的口径是**只给事实标注、不给判断权**，所以 prompt 里一旦又出现
// 「判断 / 是不是你问的那一问 / 这一小问」这类指令，说明有人（可能是我）又把它加回来了。
push(
  "prompt 无「自行判断小问」的指令",
  !/判断它是不是|是不是你问的那一问|第 7 条|7\. 标了/.test(prompt),
  /判断它是不是|是不是你问的那一问|7\. 标了/.test(prompt) ? "含指令" : "无",
  "无"
);

// 负例：用**手工构造**的无 section 资料验证分支。
// 原本想拿一道「命中不了子节」的真实问题当负例，选了两道都失败——
// 打开一看标注全是对的（自由泳方案本来就有 6 个小问）。语料里带子节的文档占比很高，
// 「找一道干净的题」这条路不通，改成直接构造输入，验的是 hasSection 这个分支本身。
const bareHits = retrieve("睡眠不足对训练有什么影响", { k: 5 }).map((h) => ({ ...h, section: undefined }));
const barePrompt = buildAskPrompt(bareHits, "睡眠不足对训练有什么影响");
push("无 section 时不加节位标注", !barePrompt.includes("§ 本节"), "含标注", "不含");

// 观测量（不算判据）：真实查询里带子节的比例。这个比例若接近常驻，
// README 里就不能写成「条件触发」——那是不诚实的说法。
const coverQs = ["自由泳高肘抱水怎么练", "睡眠不足对训练有什么影响", "拉伸要拉多久", "练胸为什么脖子会酸"];
let coverHit = 0;
let coverAll = 0;
for (const q of coverQs) {
  for (const h of retrieve(q, { k: 5 })) {
    coverAll++;
    if (h.section) coverHit++;
  }
}
console.log(`· 观测量：${coverQs.length} 题 × top5 里带子节的占 ${coverHit}/${coverAll}`);

/* ── ④ 建库没被拖慢、也没丢块 ── */
push("索引块数 > 5000", idx.chunks.length > 5000, idx.chunks.length, ">5000");
push("建库 < 900ms（含 sections 表）", idx.builtMs < 900, `${idx.builtMs.toFixed(0)}ms`, "<900ms");

let bad = 0;
for (const c of cases) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(28)} got=${c.got}  want=${c.want}`);
}
console.log(`\n${bad === 0 ? "✓ 全过" : "✗ 有偏差"}：${cases.length - bad}/${cases.length}`);
if (bad) process.exitCode = 1;
