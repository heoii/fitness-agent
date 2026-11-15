/**
 * 语料范围探针：同一个 query，「只索引 01 每日记录」和「索引整个知识库」各能排到什么。
 *
 * 起因：问「自由泳高肘抱水怎么练」时，产品检索的 top5 全是「自动统计」块，答不出。
 * 一开始以为是检索器的问题，查了才发现——**「高肘」主要出现在 `05 计划与复盘/计划/`，
 * 那几个文件根本不在索引里**。索引只覆盖 `01 每日记录`。
 *
 * 这决定了下一步该往哪走：如果扩范围能解决，那就不该继续在 BM25 上调权重。
 *
 * 用法: npm run w7:scope -- --q "高肘抱水" --root /path/to/知识库
 */
import { walkMarkdown, loadDoc } from "../src/lib/corpus";
import { chunkDoc, flatText, chunkLabel, type Chunk } from "../src/lib/chunk";
import { BM25Index } from "../src/lib/bm25";
import { kbDir } from "./kb-dir";
import { resolve, dirname } from "node:path";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const Q = arg("--q") ?? "自由泳 高肘抱水 怎么练";
// 默认取 KB_DIR 的上级目录（01 每日记录 → 知识库根）
const ROOT = arg("--root") ?? resolve(kbDir(), "..");

function build(dir: string): { chunks: Chunk[]; ms: number } {
  const t0 = performance.now();
  const chunks: Chunk[] = [];
  for (const f of walkMarkdown(dir)) {
    const doc = loadDoc(f, dir);
    for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
  }
  return { chunks, ms: performance.now() - t0 };
}

function run(label: string, dir: string) {
  const { chunks, ms } = build(dir);
  const bm25 = new BM25Index(chunks.map((c) => ({ text: flatText(c) })));
  const top = bm25.topK(Q, 5);
  console.log(`\n【${label}】${chunks.length} 块（建索引 ${ms.toFixed(0)} ms）　${dirname(dir)}`);
  top.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.score.toFixed(2).padStart(6)}  ${chunkLabel(chunks[r.i]).slice(0, 70)}`);
  });
  // 命中「高肘」的块排第几
  const all = bm25.topK(Q, chunks.length);
  const pos = all.findIndex((r) => chunks[r.i].text.includes("高肘"));
  console.log(`  含「高肘」的最佳块：${pos === -1 ? "无" : `#${pos + 1}`}`);
}

function main() {
  console.log(`query：「${Q}」\n${"=".repeat(76)}`);
  run("范围 A：只 01 每日记录（当前索引）", kbDir());
  run("范围 B：整个知识库", ROOT);
  console.log(`\n${"=".repeat(76)}`);
  console.log("口径提醒：范围 B 的库大得多，冷启动和查询都会变慢，且「每日记录」的排名会被稀释。");
  console.log("      真扩范围之后要重跑 W5 的 15 题，否则历史数字不可比。");
}

main();
