/**
 * W5：召回评测 —— 4 种方案 × 14 道题，先冻结判据再跑。
 *
 * 为什么是 4 种而不是 1 种：
 * 只报「向量 top5 命中 11/14」什么也证明不了——没跑过的方案里可能有个更便宜的
 * 打赢它。这里跑的是一个 2×2：
 *
 *              标题层级切           固定 512 字切
 *   向量        vec_title（本方案）   vec_fixed
 *   BM25        bm25_title           bm25_fixed
 *
 * 行对比 = 检索器的贡献，列对比 = 切法的贡献。少了任何一格，都分不清进步是从
 * 哪来的——W3 已经证明了切片本身就有巨大的质量差，不控制这个变量的话，向量
 * 的功劳会被算到切法头上。
 *
 * 两个指标，含义不同，都要报：
 *   Doc@k  正确**文档**出现在前 k 条。公平比较两个检索器（固定切没有章节概念，
 *          但它确实能找到那篇文档）。
 *   Sec@k  正确**章节**出现在前 k 条。这才是用户要的——一篇训练记录有 8 个动作
 *          块，翻对页但指错动作等于答错。
 * 主指标取 Sec@5，因为下游是「把原文摘给用户看」，摘错节就是答错。
 *
 * 用法:
 *   npm run w5:eval -- --verify   # 只做标注可行性检查（答案是否真的在库里）
 *   npm run w5:eval               # 跑全部
 *   npm run w5:eval -- --json     # 机器可读
 *   npm run w5:eval -- --no-fixed # 跳过固定切（省一次嵌入）
 */
import { chunkDoc, flatText, type Chunk } from "../src/lib/chunk";
import { loadDoc, walkMarkdown, type Doc } from "../src/lib/corpus";
import { embedBatch, EMBED_MODEL } from "../src/lib/embed";
import { loadStore, saveStore, storePath, type EmbedStore } from "../src/lib/embed-store";
import { cosine, normalize } from "../src/lib/vector";
import { BM25Index } from "../src/lib/bm25";
import { kbDir } from "./kb-dir";
import { QUESTIONS, type Question } from "./w5_questions";

/** 评测用的最小结构：不管是哪种切法，只要能回答「哪篇、哪节、什么字」即可。 */
interface Live {
  docName: string;
  docRel: string;
  headingPath: string[];
  text: string;
}

const K = 10; // 取深一点，算 MRR@10；展示看 @1/@5

function docHit(c: Live, q: Question): boolean {
  return q.docs.includes(c.docName);
}

function secHit(c: Live, q: Question): boolean {
  if (!docHit(c, q)) return false;
  if (!q.section.length) return true;
  return q.section.some(
    (s) => c.headingPath.some((h) => h.includes(s)) || c.text.includes(s)
  );
}

interface Row {
  doc1: boolean;
  doc5: boolean;
  sec1: boolean;
  sec5: boolean;
  rr: number; // 第一个 sec 命中的倒数排名，未命中 0
}

function scoreRanking(ranked: Live[], q: Question): Row {
  const top5 = ranked.slice(0, 5);
  let rr = 0;
  for (let i = 0; i < Math.min(K, ranked.length); i++) {
    if (secHit(ranked[i], q)) {
      rr = 1 / (i + 1);
      break;
    }
  }
  return {
    doc1: docHit(ranked[0], q),
    doc5: top5.some((c) => docHit(c, q)),
    sec1: secHit(ranked[0], q),
    sec5: top5.some((c) => secHit(c, q)),
    rr,
  };
}

interface Scheme {
  name: string;
  label: string;
  run: (q: Question) => Live[];
}

function pct(n: number, d: number): string {
  return `${((n / d) * 100).toFixed(0)}%`;
}

function table(label: string, rows: Row[]): string[] {
  const n = rows.length;
  const s = (f: (r: Row) => boolean) => rows.filter(f).length;
  const mrr = rows.reduce((a, r) => a + r.rr, 0) / n;
  return [
    `${label.padEnd(10)} Doc@1 ${pct(s((r) => r.doc1), n).padStart(4)}   ` +
      `Doc@5 ${pct(s((r) => r.doc5), n).padStart(4)}   ` +
      `Sec@1 ${pct(s((r) => r.sec1), n).padStart(4)}   ` +
      `Sec@5 ${pct(s((r) => r.sec5), n).padStart(4)}   ` +
      `MRR ${mrr.toFixed(3)}`,
  ];
}

/** 固定 512 字切：按行累加，不切断行。**故意不带标题** —— 这是朴素做法的真实样子。 */
function fixedSplit(doc: Doc, size = 512): Live[] {
  const out: Live[] = [];
  const lines = doc.body.split("\n");
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    len = 0;
    if (!text) return;
    out.push({ docName: doc.name, docRel: doc.rel, headingPath: [], text });
  };
  for (const line of lines) {
    if (len + line.length > size && buf.length) flush();
    buf.push(line);
    len += line.length + 1;
  }
  flush();
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const VERIFY = args.includes("--verify");
  const JSON_OUT = args.includes("--json");
  const NO_FIXED = args.includes("--no-fixed");
  const DIR = (args.indexOf("--dir") !== -1 ? args[args.indexOf("--dir") + 1] : null) || kbDir();

  // ——— 标题切（与 build_index.ts 完全同一路径，顺序必须一致） ———
  const files = walkMarkdown(DIR);
  const titleChunks: Chunk[] = [];
  for (const f of files) {
    const doc = loadDoc(f, DIR);
    for (const c of chunkDoc(doc)) if (!c.stub) titleChunks.push(c);
  }
  const titleLive: Live[] = titleChunks.map((c) => ({
    docName: c.doc.name,
    docRel: c.doc.rel,
    headingPath: c.headingPath,
    text: c.text,
  }));

  const store = loadStore(storePath("full"));
  const keyOf = (c: Chunk) => `${c.doc.rel}#${c.headingPath.join(" > ")}#${c.part ?? 0}`;
  const mismatch = titleChunks.filter((c, i) => store.items[i]?.key !== keyOf(c)).length;
  if (mismatch) {
    // 语料是**活的**：知识库每天在写，索引建完几分钟就可能差一两条。
    // 差 1/3039 条不影响任何统计结论，但会让人无法评测；差多了才是真的过期。
    // 所以给一个 1% 的容忍度，并且**每次运行都把这个数打出来**——
    // 悄悄放行和直接退出都不对：前者会让"索引过期"变成隐形错误，后者让评测跑不起来。
    const ratio = mismatch / titleChunks.length;
    if (ratio > 0.01) {
      console.error(
        `✗ 向量库与当前切分不一致（${mismatch}/${titleChunks.length} 条 key 不同，${(ratio * 100).toFixed(1)}%）。\n` +
          `  语料或切分逻辑改过了，先跑 npm run w5:index -- --force`
      );
      process.exitCode = 1;
      return;
    }
    console.warn(
      `⚠ 向量库与当前切分有 ${mismatch}/${titleChunks.length} 条不一致（${(ratio * 100).toFixed(2)}%，` +
        `在建库之后新写入的记录），低于 1% 容忍度，继续。下面的数字按 ${store.count} 条索引算。`
    );
  }

  // ——— 标注可行性检查：答案是不是真的在库里 ———
  if (VERIFY) {
    console.log(`标注检查（${QUESTIONS.length} 题 / 库内 ${titleLive.length} chunk）`);
    let bad = 0;
    for (const q of QUESTIONS) {
      const inDocs = titleLive.filter((c) => q.docs.includes(c.docName));
      const hits = inDocs.filter((c) => secHit(c, q));
      const ok = inDocs.length > 0 && hits.length > 0;
      if (!ok) bad++;
      console.log(
        `  ${ok ? "✓" : "✗"} ${q.id.padEnd(3)} ${q.group}  ` +
          `文档内 chunk ${String(inDocs.length).padStart(3)} / 命中节 chunk ${String(hits.length).padStart(2)}  ` +
          `${q.q}`
      );
    }
    console.log(bad === 0 ? `\n全部 ${QUESTIONS.length} 题都能在库里定位，可以评测` : `\n${bad} 题标注有问题，先修`);
    if (bad) process.exitCode = 1;
    return;
  }

  // ——— 四套方案 ———
  const schemes: Scheme[] = [];

  // ① 向量 + 标题切
  const qvecCache = new Map<string, number[]>();
  const qvec = async (q: string) => {
    if (!qvecCache.has(q)) qvecCache.set(q, normalize((await embedBatch([q])).vectors[0]));
    return qvecCache.get(q)!;
  };
  schemes.push({
    name: "vec_title",
    label: "向量·标题切",
    run: (q) => {
      const v = qvecCache.get(q.q)!;
      return titleLive
        .map((c, i) => ({ c, s: cosine(v, store.items[i].vec) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, K)
        .map((x) => x.c);
    },
  });

  // ② BM25 + 标题切（文本口径与向量一致：标题路径 + 正文）
  const bm25Title = new BM25Index(titleChunks.map((c) => ({ text: flatText(c) })));
  schemes.push({
    name: "bm25_title",
    label: "BM25·标题切",
    run: (q) => bm25Title.topK(q.q, K).map((h) => titleLive[h.i]),
  });

  // ③④ 固定 512 字切
  if (!NO_FIXED) {
    const fixed: Live[] = [];
    for (const f of files) fixed.push(...fixedSplit(loadDoc(f, DIR)));

    const fixedStore = storePath("fixed512");
    let fstore: EmbedStore | null = null;
    try {
      const prev = loadStore(fixedStore);
      if (prev.count === fixed.length && prev.model === EMBED_MODEL) fstore = prev;
    } catch {
      /* 没有就现算 */
    }
    if (!fstore) {
      console.log(`嵌入固定切语料 ${fixed.length} 条…`);
      const r = await embedBatch(fixed.map((c) => c.text));
      fstore = {
        model: r.model,
        dim: r.dim,
        createdAt: new Date().toISOString(),
        corpusRoot: DIR,
        count: fixed.length,
        items: fixed.map((c, i) => ({
          key: `${c.docRel}#${i}`,
          docRel: c.docRel,
          docName: c.docName,
          headingPath: [],
          part: null,
          chars: c.text.length,
          vec: normalize(r.vectors[i]),
        })),
      };
      saveStore(fstore, fixedStore);
    }
    const fs2: EmbedStore = fstore;

    schemes.push({
      name: "vec_fixed",
      label: "向量·固定切",
      run: (q) => {
        const v = qvecCache.get(q.q)!;
        return fixed
          .map((c, i) => ({ c, s: cosine(v, fs2.items[i].vec) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, K)
          .map((x) => x.c);
      },
    });

    const bm25Fixed = new BM25Index(fixed.map((c) => ({ text: c.text })));
    schemes.push({
      name: "bm25_fixed",
      label: "BM25·固定切",
      run: (q) => bm25Fixed.topK(q.q, K).map((h) => fixed[h.i]),
    });
  }

  // ③④⑤⑥ 粒度消融：只按 `##` 切（H3 降级成粗体行，块变大但仍带标题路径）。
  // 为什么要单独做这一个：vec_title 与 vec_fixed 的差异里混了两个变量——块大小、
  // 有没有标题路径。不控制就只能说「固定切更差」，说不出是哪个原因。
  // 这一格把块调大到 H2 级、标题路径照留，于是「块大小」被单独隔离出来。
  // 它同时是对 W3 结论的反向检验：W3 为了引用精确切到 H3，代价可能正是语义召回。
  if (!args.includes("--no-h2")) {
    const h2Live: Live[] = [];
    for (const f of files) {
      const doc = loadDoc(f, DIR);
      // H3 变粗体行：chunkDoc 就不再在这里断块，动作被合进父节
      const collapsed: Doc = { ...doc, body: doc.body.replace(/^### (.+)$/gm, "**$1**") };
      for (const c of chunkDoc(collapsed)) {
        if (!c.stub) h2Live.push({ docName: c.doc.name, docRel: c.doc.rel, headingPath: c.headingPath, text: c.text });
      }
    }
    const h2Path = storePath("h2only");
    let h2Store: EmbedStore | null = null;
    try {
      const prev = loadStore(h2Path);
      if (prev.count === h2Live.length && prev.model === EMBED_MODEL) h2Store = prev;
    } catch {
      /* 现算 */
    }
    if (!h2Store) {
      console.log(`嵌入 H2 级语料 ${h2Live.length} 条…`);
      const r = await embedBatch(h2Live.map((c) => [...c.headingPath, c.text].join("\n")));
      h2Store = {
        model: r.model,
        dim: r.dim,
        createdAt: new Date().toISOString(),
        corpusRoot: DIR,
        count: h2Live.length,
        items: h2Live.map((c, i) => ({
          key: `${c.docRel}#${c.headingPath.join(" > ")}`,
          docRel: c.docRel,
          docName: c.docName,
          headingPath: c.headingPath,
          part: null,
          chars: c.text.length,
          vec: normalize(r.vectors[i]),
        })),
      };
      saveStore(h2Store, h2Path);
    }
    const hs: EmbedStore = h2Store;
    schemes.push({
      name: "vec_h2",
      label: "向量·H2级",
      run: (q) => {
        const v = qvecCache.get(q.q)!;
        return h2Live
          .map((c, i) => ({ c, s: cosine(v, hs.items[i].vec) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, K)
          .map((x) => x.c);
      },
    });
    const bm25H2 = new BM25Index(h2Live.map((c) => ({ text: [...c.headingPath, c.text].join("\n") })));
    schemes.push({
      name: "bm25_h2",
      label: "BM25·H2级",
      run: (q) => bm25H2.topK(q.q, K).map((h) => h2Live[h.i]),
    });
  }

  // 预计算所有 query 向量
  for (const q of QUESTIONS) await qvec(q.q);

  // ——— 跑 ———
  const perScheme = new Map<string, Map<string, Row>>();
  for (const s of schemes) {
    const m = new Map<string, Row>();
    for (const q of QUESTIONS) m.set(q.id, scoreRanking(s.run(q), q));
    perScheme.set(s.name, m);
  }

  // ——— 单题归因：这个数字为什么是这样 ———
  // 有 --explain 就只打印这一题的四个方案 top5。归因必须先看证据，
  // 否则就会像 W2 那次一样，先编一个「14 个动作太长」的理由再去量。
  const explainIdx = args.indexOf("--explain");
  if (explainIdx !== -1) {
    const want = args[explainIdx + 1]?.toUpperCase();
    const q = QUESTIONS.find((x) => x.id === want);
    if (!q) {
      console.log(`找不到题 ${want}，可选：${QUESTIONS.map((x) => x.id).join(" ")}`);
      return;
    }
    console.log(`题 ${q.id}（${q.group}）：${q.q}`);
    console.log(`标准答案：${q.docs.join(" / ")} § ${q.section.join(" | ")}`);
    console.log("");
    for (const s of schemes) {
      const ranked = s.run(q);
      console.log(`【${s.label}】`);
      ranked.slice(0, 5).forEach((c, i) => {
        const mark = secHit(c, q) ? "✔" : docHit(c, q) ? "△" : " ";
        const path = c.headingPath.length ? c.headingPath.join(" > ") : "（无标题）";
        console.log(`  ${mark} ${i + 1}. ${c.docName}`);
        console.log(`       ${path}`);
        console.log(`       ${c.text.replace(/\n/g, " ").slice(0, 80)}`);
      });
      console.log("");
    }
    return;
  }

  const nS = QUESTIONS.filter((q) => q.group === "S").length;
  const nK = QUESTIONS.filter((q) => q.group === "K").length;

  const out: string[] = [];
  out.push(`W5 召回评测 · ${QUESTIONS.length} 题（S 语义 ${nS} / K 实体 ${nK}）· 库内 ${titleLive.length} / ${fixedLen(schemes)} chunk`);
  out.push(`模型 ${EMBED_MODEL} · 判据 Sec@5 为主（章节级），Doc@5 为参考（文档级）`);
  out.push("");
  for (const s of schemes) {
    const rows = QUESTIONS.map((q) => perScheme.get(s.name)!.get(q.id)!);
    out.push(...table(s.label, rows));
  }

  out.push("");
  out.push("— 分组（Sec@5）—");
  for (const s of schemes) {
    const all = perScheme.get(s.name)!;
    const g = (grp: string) => {
      const qs = QUESTIONS.filter((q) => q.group === grp);
      const hit = qs.filter((q) => all.get(q.id)!.sec5).length;
      return `${hit}/${qs.length}`;
    };
    out.push(`${s.label.padEnd(10)} S 语义 ${g("S").padStart(5)}    K 实体 ${g("K").padStart(5)}`);
  }

  out.push("");
  out.push("— 逐题（Sec 命中排名，× 表示前 10 未命中）—");
  const head = ["题号", "组", ...schemes.map((s) => s.label.padEnd(12))].join("  ");
  out.push(head);
  for (const q of QUESTIONS) {
    const cells = schemes.map((s) => {
      const r = perScheme.get(s.name)!.get(q.id)!;
      return (r.rr === 0 ? "  ×  " : `#${Math.round(1 / r.rr)}`.padEnd(5)).padEnd(12);
    });
    out.push(`${q.id.padEnd(4)}  ${q.group}   ${cells.join("  ")}`);
  }

  console.log(out.join("\n"));

  if (JSON_OUT) {
    const payload = {
      questions: QUESTIONS.length,
      corpus: { title: titleLive.length, fixed: fixedLen(schemes) },
      schemes: schemes.map((s) => {
        const rows = QUESTIONS.map((q) => perScheme.get(s.name)!.get(q.id)!);
        const n = rows.length;
        return {
          name: s.name,
          doc1: rows.filter((r) => r.doc1).length,
          doc5: rows.filter((r) => r.doc5).length,
          sec1: rows.filter((r) => r.sec1).length,
          sec5: rows.filter((r) => r.sec5).length,
          mrr: rows.reduce((a, r) => a + r.rr, 0) / n,
          perQ: Object.fromEntries(
            QUESTIONS.map((q) => [q.id, Math.round(1 / (perScheme.get(s.name)!.get(q.id)!.rr || Infinity))])
          ),
        };
      }),
    };
    console.log("\n" + JSON.stringify(payload, null, 2));
  }
}

function fixedLen(schemes: Scheme[]): number | string {
  return schemes.some((s) => s.name === "vec_fixed") ? "fixed512" : "—";
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
