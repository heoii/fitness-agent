/**
 * W4：只 embed 100 个 chunk → 存 JSON → 余弦 + top-k。
 *
 * 判据三条（计划文档第 176 行）：
 *   ① 返回定长浮点数组 —— 维度实测，不写死 1024
 *   ② 100 条能读回 —— 存盘后再读，逐值比对
 *   ③ 给一个问题打印最相似 5 条标题
 *
 * 另外加了一条原文里没有、但必须有的检查：**自检索一致性**。重嵌 5 条原文，
 * 与存下来的向量做余弦，必须 ≥0.999。这条能抓住「向量与条目错位」——那种 bug
 * 会让 top-k 看起来完全正常（每条都有分数、排序也单调），只是整体错位一格，
 * 光看 top5 标题根本发现不了。
 *
 * 取样方式：**按文档轮转，且每篇从不同位置起取**。两个偏差都要避：
 *   1. 取前 100 条 → 语料按日期排序，全落在最早的几周，今年的记录一条不进；
 *   2. 只做朴素轮转 → 每篇都取到**第一个 chunk**，而训练记录的第一块永远是
 *      文档标题块（实测 98/100），`## 动作明细` 那种真正带动作数据的块一条不进，
 *      于是问「深蹲掉力」会返回一堆「引体专项」的标题块——分数正常、排序单调，
 *      看起来没坏，其实样本里根本没有答案。
 *
 * 向量落盘到 `private/embeddings/`（公开仓，真实训练记录不许进）。
 *
 * 用法:
 *   npm run w4:embed                        # 取 100 条，已有则复用
 *   npm run w4:embed -- --n 20 --force      # 换样本量并重算
 *   npm run w4:embed -- --query "深蹲掉力"   # 自定义检索问题（可重复）
 */
import { chunkDoc, flatText, type Chunk } from "../src/lib/chunk";
import { loadDoc, walkMarkdown } from "../src/lib/corpus";
import { embedBatch, EMBED_MODEL } from "../src/lib/embed";
import {
  loadStore,
  saveStore,
  storePath,
  storeSize,
  type EmbedStore,
  type StoredItem,
} from "../src/lib/embed-store";
import { cosine, norm, normalize, topK } from "../src/lib/vector";
import { kbDir } from "./kb-dir";

interface Check {
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argOf = (flag: string, dflt?: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? dflt : args[i + 1];
  };
  const N = Number(argOf("--n", "100"));
  const FORCE = args.includes("--force");
  const JSON_OUT = args.includes("--json");
  const DIR = argOf("--dir") || kbDir();

  const queries: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--query") queries.push(args[i + 1]);
  if (!queries.length) queries.push("史密斯深蹲 掉力", "这个动作我多久没练了");

  // ——— 1. 切分全库，按文档轮转取样 ———
  const files = walkMarkdown(DIR);
  const byDoc = new Map<string, Chunk[]>();
  for (const f of files) {
    const doc = loadDoc(f, DIR);
    const cs = chunkDoc(doc).filter((c) => !c.stub); // 过短块没有检索价值，不占 100 个名额
    if (!cs.length) continue;
    byDoc.set(doc.rel, cs);
  }

  const sample: Chunk[] = [];
  // 每篇文档按序号旋转换个起点，让样本同时覆盖「文档标题块」和「正文细节块」
  const queues = [...byDoc.values()].map((q, i) => {
    const off = q.length > 1 ? i % q.length : 0;
    return off ? q.slice(off).concat(q.slice(0, off)) : q;
  });
  for (let round = 0; sample.length < N; round++) {
    let added = 0;
    for (const q of queues) {
      if (round >= q.length) continue;
      sample.push(q[round]);
      added++;
      if (sample.length >= N) break;
    }
    if (!added) break;
  }
  const chunks = sample.slice(0, N);
  const texts = chunks.map(flatText);

  // ——— 2. 复用已有向量，或现算 ———
  let store: EmbedStore | null = null;
  let rawNorms: number[] | null = null;
  let embedMs = 0;
  const path = storePath();

  if (!FORCE) {
    try {
      const prev = loadStore(path);
      if (prev.model === EMBED_MODEL && prev.count === chunks.length) {
        store = prev;
        console.log(`复用已有向量：${path}（${storeSize(path)}，模型 ${prev.model}）`);
      } else {
        console.log(`已有向量不匹配（${prev.model} / ${prev.count} 条），重新生成`);
      }
    } catch {
      /* 不存在就现算 */
    }
  }

  if (!store) {
    console.log(`嵌入 ${texts.length} 条（模型 ${EMBED_MODEL}）…`);
    const r = await embedBatch(texts);
    embedMs = r.ms;
    // 原始范数在归一化之前量，用来回答「bge-m3 输出到底是不是单位长度」
    rawNorms = r.vectors.map(norm);
    const items: StoredItem[] = chunks.map((c, i) => ({
      key: `${c.doc.rel}#${c.headingPath.join(" > ")}#${c.part ?? 0}`,
      docRel: c.doc.rel,
      docName: c.doc.name,
      headingPath: c.headingPath,
      part: c.part,
      chars: c.chars,
      vec: normalize(r.vectors[i]),
    }));
    store = {
      model: r.model,
      dim: r.dim,
      createdAt: new Date().toISOString(),
      corpusRoot: DIR,
      count: items.length,
      items,
    };
    const saved = saveStore(store, path);
    console.log(`已写入 ${saved}（${storeSize(saved)}）`);
  }
  const st: EmbedStore = store;

  const checks: Check[] = [];

  // ——— 判据① 定长浮点数组 ———
  const lens = new Set(st.items.map((it) => it.vec.length));
  const dim = st.items[0]?.vec.length ?? 0;
  const finite = st.items.every((it) => it.vec.every((x) => Number.isFinite(x)));
  const sameDim = lens.size === 1;
  checks.push({
    ok: sameDim && finite && dim > 0,
    detail:
      `① 定长浮点数组：${st.count} 条 × ${dim} 维（模型 ${st.model}）` +
      (sameDim ? "" : `，出现 ${lens.size} 种长度`) +
      (finite ? "" : "，含 NaN/Infinity"),
  });

  // ——— 判据② 存盘再读回，逐值比对 ———
  const reread = loadStore(path);
  let badComponents = 0;
  let maxDiff = 0;
  for (let i = 0; i < Math.min(reread.items.length, st.items.length); i++) {
    const a = reread.items[i].vec;
    const b = st.items[i].vec;
    if (a.length !== b.length) {
      badComponents++;
      continue;
    }
    for (let d = 0; d < a.length; d++) {
      const diff = Math.abs(a[d] - b[d]);
      if (diff > 0) badComponents++;
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  const roundTrip = reread.count === st.count && reread.dim === st.dim && badComponents === 0;
  checks.push({
    ok: roundTrip,
    detail:
      `② 100 条能读回：${reread.count} 条 / ${reread.dim} 维 / 模型 ${reread.model}；` +
      (badComponents === 0
        ? "所有分量完全相同"
        : `${badComponents} 个分量不一致（最大差 ${maxDiff}）`),
  });

  // ——— 判据③ 余弦 + top-k ———
  const labelOf = (it: StoredItem) => `${it.docName} > ${it.headingPath.join(" > ")}`;
  const results: Array<{
    q: string;
    hits: Array<{ label: string; score: number }>;
    worst: number;
  }> = [];

  for (const q of queries) {
    const qv = normalize((await embedBatch([q])).vectors[0]);
    const all = st.items.map((it) => cosine(qv, it.vec));
    const hits = topK(qv, st.items, (it) => it.vec, 5);
    results.push({
      q,
      hits: hits.map((h) => ({ label: labelOf(h.item), score: h.score })),
      worst: Math.min(...all),
    });
  }

  // 自检索一致性：重嵌 5 条原文，与存下来的向量比。抓「向量与条目错位」。
  const probeIdx = [
    0,
    Math.floor(st.count / 4),
    Math.floor(st.count / 2),
    Math.floor((st.count * 3) / 4),
    st.count - 1,
  ];
  const reprobe = await embedBatch(probeIdx.map((i) => texts[i]));
  let worstSelf = 1;
  probeIdx.forEach((idx, j) => {
    const c = cosine(normalize(reprobe.vectors[j]), st.items[idx].vec);
    if (c < worstSelf) worstSelf = c;
  });
  checks.push({
    ok: worstSelf >= 0.999,
    detail:
      `③ 余弦 + top-k 可用：重嵌 5 条原文与存下的向量余弦最低 ${worstSelf.toFixed(6)}` +
      (worstSelf >= 0.999 ? "" : "（<0.999：向量可能错位，或模型不确定）"),
  });

  // ——— 输出 ———
  const chars = st.items.map((i) => i.chars).sort((a, b) => a - b);
  if (JSON_OUT) {
    console.log(JSON.stringify({ checks, results, dim, count: st.count }, null, 2));
  } else {
    console.log("");
    console.log(`向量库 : ${path}（${storeSize(path)}，${st.count} 条，${st.dim} 维）`);
    console.log(
      `覆盖   : ${new Set(st.items.map((i) => i.docName)).size} 篇文档（共 ${byDoc.size} 篇有可用 chunk）`
    );
    // 结构分布：防止「样本全是标题块」这种偏差静默发生（踩过一次）
    // 注意 headingPath 保留完整父级，动作块的 [0] 也是文档 H1 —— 必须看第二级，
    // 否则「动作明细 40 条」会被算成「文档标题块」。
    const kind = (it: StoredItem) => (it.headingPath.length >= 2 ? it.headingPath[1] : "文档标题块");
    const kinds = new Map<string, number>();
    for (const it of st.items) kinds.set(kind(it), (kinds.get(kind(it)) ?? 0) + 1);
    const kindStr = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k} ${v}`)
      .join(" / ");
    console.log(`结构   : ${kindStr}${kinds.size > 6 ? ` / …共 ${kinds.size} 类` : ""}`);
    console.log(`字符数 : 中位 ${chars[Math.floor(st.count / 2)]}，区间 ${chars[0]}–${chars[chars.length - 1]}`);
    if (rawNorms) {
      const lo = Math.min(...rawNorms);
      const hi = Math.max(...rawNorms);
      const unit = lo > 0.98 && hi < 1.02;
      console.log(
        `原始范数: ${lo.toFixed(4)} – ${hi.toFixed(4)}` +
          (unit ? "（接近单位长度，但仍显式归一化后再用）" : "（明显不是单位长度 → 必须自己归一化）")
      );
    } else {
      console.log("原始范数: 复用已有向量，未重新测量（--force 可量）");
    }
    if (embedMs) console.log(`耗时   : ${(embedMs / 1000).toFixed(1)}s`);

    for (const r of results) {
      console.log("");
      console.log(`问：「${r.q}」`);
      r.hits.forEach((h, i) => console.log(`  ${i + 1}. ${h.score.toFixed(4)}  ${h.label}`));
      console.log(`     （最不相关的 ${r.worst.toFixed(4)}，看 1 与最末的差距判断有没有区分度）`);
    }

    console.log("");
    console.log("判据：");
    for (const c of checks) console.log(`  ${c.ok ? "✅" : "⛔"} ${c.detail}`);
  }

  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
