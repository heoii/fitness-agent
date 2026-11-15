/**
 * 检索诊断：同一个 query，**基线（裸 BM25）** 和 **产品（加时间重排）** 各排一遍，
 * 并告诉你「该命中的文档排第几」。
 *
 * 为什么要有这个脚本：W5 的 Sec@5 100% 是拿**设计过的 query** 测的（出题时知道该搜什么词），
 * 线上拿到的永远是**用户原话**。第一次跑 `w6:llm` 就撞上了：问「深蹲最近在涨还是跌」，
 * 裸 BM25 的 top5 里连 11-07 / 11-14 这两次最近的深蹲记录都没有（排 #17 / #24），
 * 模型只好拿健康记录里的 1RM 82kg 去比 60kg，推出「在涨」。**不是模型算错，是喂错资料。**
 *
 * 用法:
 *   npm run w6:debug -- --q "史密斯深蹲 容量" --expect 2026-11-07 2026-11-14
 *   npm run w6:debug -- --q "..." --mode baseline     # 只看基线
 */
import { walkMarkdown, loadDoc } from "../src/lib/corpus";
import { chunkDoc, flatText, chunkLabel, type Chunk } from "../src/lib/chunk";
import { BM25Index, tokenize } from "../src/lib/bm25";
import { retrieve, getIndex, indexMeta, inspectQuery } from "../src/lib/retrieve";
import { kbDir } from "./kb-dir";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const Q = arg("--q") ?? "史密斯深蹲 容量";
const MODE = arg("--mode") ?? "both";
const EXPECT = (() => {
  const out: string[] = [];
  const i = process.argv.indexOf("--expect");
  if (i === -1) return out;
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) out.push(process.argv[j]);
  return out;
})();

function main() {
  const insp = inspectQuery(Q);
  console.log(`query：「${Q}」`);
  console.log(`  清洗后：「${insp.cleaned}」　时间线索：${insp.timeHint ? "有（强衰减）" : "无（温和衰减）"}`);
  console.log("=".repeat(76));

  if (MODE !== "product") {
    // 基线：自己建一份裸 BM25（和 eval_retrieval 同口径，不碰 retrieve.ts 的增强）
    const t0 = performance.now();
    const DIR = kbDir();
    const chunks: Chunk[] = [];
    for (const f of walkMarkdown(DIR)) {
      const doc = loadDoc(f, DIR);
      for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
    }
    const bm25 = new BM25Index(chunks.map((c) => ({ text: flatText(c) })));
    const ms = performance.now() - t0;
    const ranked = bm25.topK(Q, chunks.length);

    console.log(`\n【基线 · 裸 BM25】（建库 ${ms.toFixed(0)} ms，${chunks.length} 块）`);
    ranked.slice(0, 8).forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${r.score.toFixed(2).padStart(6)}  ${chunkLabel(chunks[r.i]).slice(0, 70)}`
      );
    });
    if (EXPECT.length) {
      console.log("  该命中的：");
      for (const e of EXPECT) {
        const pos = ranked.findIndex((r) => chunks[r.i].doc.path.includes(e));
        console.log(`    ${e}  ${pos === -1 ? "✗ 不在库" : `#${pos + 1}`}`);
      }
    }
    console.log("  查询词 DF（越高越没区分度）：");
    for (const t of new Set(tokenize(Q))) {
      const n = chunks.filter((c) => flatText(c).includes(t)).length;
      const flag = n / chunks.length > 0.3 ? "  ← 模板词" : "";
      console.log(`    ${t.padEnd(6)} ${String(n).padStart(5)} 块 ${((n / chunks.length) * 100).toFixed(1)}%${flag}`);
    }
  }

  if (MODE !== "baseline") {
    const meta = indexMeta();
    const hits = retrieve(Q, { k: 8, pool: 400 });
    console.log(`\n【产品 · BM25 + 时间重排】（索引 ${meta.chunks} 块 / ${meta.docs} 篇，建库 ${meta.builtMs.toFixed(0)} ms）`);
    hits.forEach((h, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${h.score.toFixed(2).padStart(6)}  ` +
          `(bm25 ${h.bm25.toFixed(1)} × 时间 ${h.recency.toFixed(2)})  ${h.label.slice(0, 58)}`
      );
    });
    if (EXPECT.length) {
      // 用大池子看真实排名，避免 k 截断带来的假「没命中」
      const deep = retrieve(Q, { k: 400, pool: 400 });
      console.log("  该命中的：");
      for (const e of EXPECT) {
        const pos = deep.findIndex((h) => h.docPath.includes(e));
        console.log(
          `    ${e}  ${
            pos === -1
              ? "✗ 不在候选池"
              : `#${pos + 1}（bm25 ${deep[pos].bm25.toFixed(1)} × 时间 ${deep[pos].recency.toFixed(2)}）`
          }`
        );
      }
    }
  }

  // 索引冷启动开销：第一次调用会把 221ms 付掉，第二次起走缓存
  const warm = performance.now();
  getIndex();
  console.log(`\n索引缓存后重取：${(performance.now() - warm).toFixed(2)} ms`);
}

main();
