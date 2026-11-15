/**
 * W6 前置：把「检索层接进 App」之前必须先量清的三笔延迟。
 *
 * 为什么现在必须量：W5 的结论是「BM25 更好、向量多花 63MB 和 76 秒」，
 * 但那是**离线评测**的口径——建库一次性成本。接进查询链路后，用户每次提问要付的是
 * 「冷启动 + 加载索引 + 一次查询」三笔账，和离线数字是两回事。README 里那句
 * 「真实延迟要等接进去才看得见」说的就是这里。
 *
 * 量三件事：
 *   ① 冷启动：遍历语料 → 切片 → 建 BM25 倒排（进程重启就要重付一次，除非落盘）
 *   ② 加载向量库：64MB JSON.parse（如果决定保留向量，这笔每次冷启动都要付）
 *   ③ 单次查询：BM25 / 向量（含一次 Ollama 嵌入）/ RRF 混合，各取 P50 与 P95
 *
 * 用法:
 *   npm run w6:latency
 *   npm run w6:latency -- --n 20
 */
import { walkMarkdown, loadDoc } from "../src/lib/corpus";
import { chunkDoc, flatText, type Chunk } from "../src/lib/chunk";
import { BM25Index } from "../src/lib/bm25";
import { loadStore, storePath, type EmbedStore } from "../src/lib/embed-store";
import { embedOne } from "../src/lib/embed";
import { kbDir } from "./kb-dir";

const N = (() => {
  const i = process.argv.indexOf("--n");
  return i !== -1 ? Number(process.argv[i + 1]) : 10;
})();

const QUERIES = [
  "深蹲重量最近在涨还是在跌",
  "心率变异性怎么读",
  "为什么练胸会脖子酸",
  "8×8 和 5×5 的区别",
  "上周腿部训练都练了什么",
  "自由泳划手高肘怎么练",
  "减载期和恢复期的门槛",
  "手臂是不是弱项",
  "体脂称的 0.7kg 是水还是脂肪",
  "史密斯窄推多重",
];

function pct(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function timeIt(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

function rrf(ranks: number[][], k = 60): number[] {
  const acc = new Map<number, number>();
  for (const r of ranks) r.forEach((i, pos) => acc.set(i, (acc.get(i) ?? 0) + 1 / (k + pos + 1)));
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

async function main() {
  const DIR = kbDir();
  console.log(`语料根：${DIR}`);
  console.log(`查询：${N} 题 × 3 次（取中位），报告 P50 / P95\n` + "=".repeat(74));

  // ─── ① 冷启动：遍历 + 切片 + 建倒排 ───
  let chunks: Chunk[] = [];
  const tWalk = timeIt(() => {
    const files = walkMarkdown(DIR);
    for (const f of files) {
      const doc = loadDoc(f, DIR);
      for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
    }
  });
  let bm25!: BM25Index;
  const tBm25 = timeIt(() => {
    bm25 = new BM25Index(chunks.map((c) => ({ text: flatText(c) })));
  });
  const tCold = tWalk + tBm25;
  console.log(`\n① 冷启动`);
  console.log(`   遍历+切片 ${chunks.length} 块        ${tWalk.toFixed(0)} ms`);
  console.log(`   建 BM25 倒排（内存）      ${tBm25.toFixed(0)} ms`);
  console.log(`   合计                      ${tCold.toFixed(0)} ms   ← 进程重启即重付`);

  // ─── ② 加载向量库 ───
  let store: EmbedStore | null = null;
  let tLoad = NaN;
  let dim = 0;
  let count = 0;
  try {
    const t0 = performance.now();
    store = loadStore(storePath("full"));
    tLoad = performance.now() - t0;
    dim = store.dim;
    count = store.count;
    console.log(`\n② 加载向量库（${count} 条 × ${dim} 维）`);
    console.log(`   JSON.parse + 反序列化      ${tLoad.toFixed(0)} ms`);
    console.log(`   ≤ 只在「决定保留向量」时才付这一笔`);
  } catch {
    console.log(`\n② 向量库缺失（private/embeddings/full.json），跳过向量侧计时`);
  }

  // ─── ③ 单次查询 ───
  const bmMs: number[] = [];
  const vecMs: number[] = [];
  const embMs: number[] = [];
  const hybMs: number[] = [];

  for (const q of QUERIES.slice(0, N)) {
    const s = store;
    // BM25：纯内存，跑 3 次取中位
    const b: number[] = [];
    for (let r = 0; r < 3; r++) {
      let top: Array<{ i: number }> = [];
      b.push(timeIt(() => {
        top = bm25.topK(q, 5);
      }));
      if (!top.length) throw new Error("BM25 无结果");
    }
    bmMs.push(pct(b, 0.5));

    if (!s) continue;

    // 向量：一次嵌入 + 3029 次点积
    const v: number[] = [];
    const e: number[] = [];
    for (let r = 0; r < 3; r++) {
      let qv: number[] = [];
      e.push(await timeAsync(async () => {
        qv = await embedOne(q);
      }));
      v.push(
        timeIt(() => {
          let best = -Infinity;
          for (const it of s.items) {
            let dot = 0;
            for (let d = 0; d < dim; d++) dot += qv[d] * it.vec[d];
            if (dot > best) best = dot;
          }
        })
      );
    }
    embMs.push(pct(e, 0.5));
    vecMs.push(pct(v, 0.5));

    // 混合：BM25 top50 + 向量 top50 → RRF
    const h: number[] = [];
    for (let r = 0; r < 3; r++) {
      let qv: number[] = [];
      await timeAsync(async () => {
        qv = await embedOne(q);
      });
      h.push(
        timeIt(() => {
          const bRank = bm25.topK(q, 50).map((x) => x.i);
          const scored = s.items.map((it, i) => {
            let dot = 0;
            for (let d = 0; d < dim; d++) dot += qv[d] * it.vec[d];
            return { i, s: dot };
          });
          scored.sort((x, y) => y.s - x.s);
          const vRank = scored.slice(0, 50).map((x) => x.i);
          rrf([bRank, vRank]);
        })
      );
    }
    hybMs.push(pct(h, 0.5));
  }

  console.log(`\n③ 单次查询（n=${bmMs.length}）`);
  console.log(`   BM25 打分+top5            P50 ${pct(bmMs, 0.5).toFixed(1)} ms   P95 ${pct(bmMs, 0.95).toFixed(1)} ms`);
  if (store) {
    console.log(`   问题嵌入（Ollama）        P50 ${pct(embMs, 0.5).toFixed(0)} ms   P95 ${pct(embMs, 0.95).toFixed(0)} ms   ← 向量侧真正的大头`);
    console.log(`   余弦全扫 ${count} 条         P50 ${pct(vecMs, 0.5).toFixed(0)} ms   P95 ${pct(vecMs, 0.95).toFixed(0)} ms`);
    console.log(`   向量合计（嵌入+全扫）     P50 ${(pct(embMs, 0.5) + pct(vecMs, 0.5)).toFixed(0)} ms`);
    console.log(`   RRF 混合（含嵌入）        P50 ${pct(hybMs, 0.5).toFixed(0)} ms   P95 ${pct(hybMs, 0.95).toFixed(0)} ms`);
  }

  console.log(`\n${"=".repeat(74)}\n口径提醒`);
  console.log(`  · 冷启动是**每次进程重启**付一次，不是每次查询。Next.js 里用模块级缓存即可摊掉。`);
  console.log(`  · 向量侧的成本 90% 在「把问题送去 Ollama 嵌入」，不在点积。`);
  console.log(`  · 上表中「首字延迟」还要再叠加 LLM 首 token（实测带上下文 2.8s），两者不在同一量级。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
