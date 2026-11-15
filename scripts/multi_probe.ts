/**
 * 多实体扩展开关自检：`npm run w7:multi`
 *
 * 为什么要有这一层：问「上次腿课和上次胸课分别是什么时候」时，旧实现只答了腿，
 * 胸**完全不出现**——不报错、不承认漏了，界面上看起来是个完整答案。
 * 这类错最难发现：答错你会去核，答一半你不会。
 *
 * 所以判据必须是**结构性的**，不靠模型行为：
 *   ① 引用条数 == 各实体条数之和（少一条就是漏了一个实体）
 *   ② prompt 里每个实体都有自己的块（「对象 N」/「[n] 名称」）
 *   ③ 每个实体的引用指向**不同的文档**（同一条引用被两个实体共用 = 后一个没查）
 *   ④ 单实体的题不受影响（k 与改造前一致）
 *
 * 不调模型：这一层测的是「路由和工具」，模型稳不稳定是 w6:ask 的事。
 * 混在一起测，模型抖一下会让人以为是路由坏了。
 */
import { kbDir } from "./kb-dir";
import { pick } from "../src/lib/answer";

kbDir(); // 触发 .env.local 加载

interface Case {
  q: string;
  route: "latest" | "count" | "trend" | "retrieve";
  /** 期望的引用条数；多实体时就是各实体之和 */
  k: number;
  /** 这些名字都必须出现在 prompt 里 */
  mustInclude: string[];
  /** trailer 里必须提到的（歧义提示） */
  trailerHas?: string[];
  note?: string;
}

const CASES: Case[] = [
  // ── 单实体：改造前后必须一模一样 ──
  { q: "最近一次游泳是什么时候", route: "latest", k: 1, mustInclude: ["游泳"] },
  { q: "这个月练了几次腿", route: "count", k: 2, mustInclude: ["腿"] },
  { q: "史密斯深蹲最近在涨还是在跌", route: "trend", k: 3, mustInclude: ["史密斯深蹲"] },

  // ── 两个部位：定位 ──
  {
    q: "我上次腿课和上次胸课分别是什么时候",
    route: "latest",
    k: 2,
    mustInclude: ["腿", "胸"],
    note: "旧版只答腿，胸静默消失",
  },

  // ── 两个部位：计数（腿 2 次 + 胸 2 次）──
  {
    q: "这个月腿和胸分别练了几次",
    route: "count",
    k: 4,
    mustInclude: ["腿", "胸"],
    note: "两个对象的明细编号必须连续，不能都从 [1] 开始",
  },

  // ── 两个动作：趋势（各 3 次明细）──
  {
    q: "史密斯深蹲和杠铃卧推最近分别涨了还是跌了",
    route: "trend",
    k: 6,
    mustInclude: ["史密斯深蹲", "杠铃卧推"],
  },

  // ── 歧义：只说「硬拉」，语料里有五种 ──
  {
    q: "上次硬拉是什么时候",
    route: "latest",
    k: 1,
    mustInclude: ["硬拉"],
    trailerHas: ["罗马尼亚硬拉", "史密斯硬拉"],
    note: "杠铃硬拉 107 天前，罗马尼亚硬拉 16 天前——只报一个会误导",
  },
];

const rows: Array<{ c: Case; ok: boolean; why: string[] }> = [];

for (const c of CASES) {
  const p = pick(c.q, 5);
  const why: string[] = [];

  if ("error" in p) {
    rows.push({ c, ok: false, why: [`路由出错：${p.error}`] });
    continue;
  }

  if (p.route !== c.route) why.push(`路由 ${p.route} ≠ 期望 ${c.route}`);
  if (p.k !== c.k) why.push(`引用上界 ${p.k} ≠ 期望 ${c.k}`);
  if (p.citations.length !== c.k) why.push(`引用条数 ${p.citations.length} ≠ 期望 ${c.k}`);

  const prompt = p.prompt ?? p.fixedAnswer ?? "";
  for (const need of c.mustInclude) {
    if (!prompt.includes(need)) why.push(`prompt 里没有「${need}」`);
  }

  for (const t of c.trailerHas ?? []) {
    if (!(p.trailer ?? "").includes(t)) why.push(`trailer 里没有「${t}」`);
  }

  // ③ 引用不能重号也不能复用同一篇文档当两个实体
  const ns = p.citations.map((x) => x.n);
  if (new Set(ns).size !== ns.length) why.push(`引用编号重复：${ns.join(",")}`);
  const docs = p.citations.map((x) => x.doc);
  if (c.mustInclude.length > 1 && new Set(docs).size < c.mustInclude.length) {
    why.push(`只有 ${new Set(docs).size} 篇不同的文档，${c.mustInclude.length} 个实体不可能共用`);
  }

  rows.push({ c, ok: why.length === 0, why });
}

let bad = 0;
for (const { c, ok, why } of rows) {
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} [${c.route}] ${c.q}  →  k=${c.k}`);
  if (!ok) for (const w of why) console.log(`      ${w}`);
}

console.log(
  `\n${bad === 0 ? "✓ 全过" : "✗ 有偏差"}：${rows.length - bad}/${rows.length}` +
    `（单实体 ${rows.filter((r) => r.c.mustInclude.length === 1).length} 条 / ` +
    `多实体 ${rows.filter((r) => r.c.mustInclude.length > 1).length} 条）`
);
if (bad) process.exitCode = 1;
