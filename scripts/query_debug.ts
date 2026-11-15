/**
 * 检索诊断：看一个 query 的完整排名，以及「该命中却没命中」的文档排在第几。
 *
 * 为什么需要它：W5 的 Sec@5 100% 是拿**设计过的 query** 测的（出题时知道该搜什么词），
 * 但线上拿到的永远是**用户原话**。第一次跑 w6:llm 就撞上了：问「深蹲最近在涨还是跌」，
 * 检索 top5 里连 11-07 / 11-14 这两次最近的深蹲记录都没有，模型只好拿 1RM 的 82kg 去比
 * 60kg，推出「在涨」。**这不是模型算错，是喂错了资料。**
 *
 * 用法:
 *   npm run w6:debug -- --q "史密斯深蹲 容量"
 *   npm run w6:debug -- --q "史密斯深蹲 容量" --expect 2026-11-07 2026-11-14
 */
import { walkMarkdown, loadDoc } from "../src/lib/corpus";
import { chunkDoc, flatText, chunkLabel, type Chunk } from "../src/lib/chunk";
import { BM25Index, tokenize } from "../src/lib/bm25";
import { kbDir } from "./kb-dir";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const Q = arg("--q") ?? "史密斯深蹲 容量";
const EXPECT = (() => {
  const out: string[] = [];
  const i = process.argv.indexOf("--expect");
  if (i === -1) return out;
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) out.push(process.argv[j]);
  return out;
})();

function main() {
  const DIR = kbDir();
  const chunks: Chunk[] = [];
  for (const f of walkMarkdown(DIR)) {
    const doc = loadDoc(f, DIR);
    for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
  }
  const bm25 = new BM25Index(chunks.map((c) => ({ text: flatText(c) })));
  const ranked = bm25.topK(Q, chunks.length);

  console.log(`query：「${Q}」　库 ${chunks.length} 块\n` + "=".repeat(76));
  console.log("Top 12：");
  ranked.slice(0, 12).forEach((r, i) => {
    const c = chunks[r.i];
    console.log(`  ${String(i + 1).padStart(2)}. ${r.score.toFixed(2).padStart(6)}  ${chunkLabel(c).slice(0, 72)}`);
  });

  if (EXPECT.length) {
    console.log("\n该命中的排第几：");
    for (const e of EXPECT) {
      const pos = ranked.findIndex((r) => chunks[r.i].doc.path.includes(e));
      if (pos === -1) console.log(`  ${e}  ✗ 完全不在库`);
      else {
        const c = chunks[ranked[pos].i];
        console.log(`  ${e}  #${pos + 1}（${ranked[pos].score.toFixed(2)}）${chunkLabel(c).slice(0, 60)}`);
      }
    }
  }

  // 词频诊断：query 里的词在全库出现多少次 —— 太常见的词不提供区分度
  console.log("\nquery 词在全库的文档频率（DF 越高越没区分度）：");
  for (const t of new Set(tokenize(Q))) {
    const n = chunks.filter((c) => flatText(c).includes(t)).length;
    console.log(`  ${t.padEnd(6)} ${String(n).padStart(5)} 块  ${((n / chunks.length) * 100).toFixed(1)}%`);
  }
}

main();
