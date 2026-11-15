/**
 * W5 前置：把**全量** chunk 嵌入落盘，作为召回的检索底库。
 *
 * 为什么必须全量、不能沿用 W4 的 100 条：
 * W4 那份样本的用途是「探通链路」——证明嵌入能算、能存、能读回、能排序。
 * 它**不能**用来测召回，因为「top5 全是无关文档」在 100 条样本里无法区分
 * 两种原因：检索真的坏了，还是答案根本不在那 100 条里。后者占绝大多数。
 * 召回率的分母必须是完整库，否则数字没有意义。
 *
 * 全量代价（实测）：3045 条 × 1024 维，bge-m3 批量 16，约 1 分钟；
 * 落盘 JSON 约 60 MB，全部在 `private/`（公开仓不许带真实记录正文的向量）。
 *
 * 用法:
 *   npm run w5:index             # 有则复用
 *   npm run w5:index -- --force  # 重建
 */
import { chunkDoc, flatText, type Chunk } from "../src/lib/chunk";
import { loadDoc, walkMarkdown, type Doc } from "../src/lib/corpus";
import { embedBatch, EMBED_MODEL } from "../src/lib/embed";
import { saveStore, storePath, storeSize, type StoredItem } from "../src/lib/embed-store";
import { norm, normalize } from "../src/lib/vector";
import { kbDir } from "./kb-dir";
import { existsSync } from "node:fs";

export interface IndexResult {
  count: number;
  dim: number;
  ms: number;
  docs: number;
  path: string;
  size: string;
}

function main(): Promise<void> {
  return run();
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const FORCE = args.includes("--force");
  const DIR = (args.indexOf("--dir") !== -1 ? args[args.indexOf("--dir") + 1] : null) || kbDir();
  const NAME = (args.indexOf("--name") !== -1 ? args[args.indexOf("--name") + 1] : null) || "full";

  const path = storePath(NAME);
  if (!FORCE && existsSync(path)) {
    console.log(`已存在：${path}（${storeSize(path)}），复用。--force 可重建`);
    return;
  }

  const files = walkMarkdown(DIR);
  const docs: Doc[] = [];
  const chunks: Chunk[] = [];
  for (const f of files) {
    const doc = loadDoc(f, DIR);
    docs.push(doc);
    // stub（正文 < 20 字）不进库：它们在 W3 已被单独标出，检索时只会贡献噪声。
    // 但**过滤发生在入库这一步**，所以「入库率」本身要报出来，不能悄悄丢。
    for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
  }

  console.log(`语料 : ${docs.length} 篇 → ${chunks.length} 个可用 chunk（已剔除 stub）`);
  const texts = chunks.map(flatText);
  console.log(`嵌入 : 模型 ${EMBED_MODEL}，批量 16 …`);

  const r = await embedBatch(texts);
  const rawNorms = r.vectors.map(norm);

  const items: StoredItem[] = chunks.map((c, i) => ({
    key: `${c.doc.rel}#${c.headingPath.join(" > ")}#${c.part ?? 0}`,
    docRel: c.doc.rel,
    docName: c.doc.name,
    headingPath: c.headingPath,
    part: c.part,
    chars: c.chars,
    vec: normalize(r.vectors[i]),
  }));

  const saved = saveStore(
    {
      model: r.model,
      dim: r.dim,
      createdAt: new Date().toISOString(),
      corpusRoot: DIR,
      count: items.length,
      items,
    },
    path
  );

  const chars = items.map((i) => i.chars).sort((a, b) => a - b);
  const lo = Math.min(...rawNorms);
  const hi = Math.max(...rawNorms);
  console.log("");
  console.log(`文件   : ${saved}（${storeSize(saved)}）`);
  console.log(`规模   : ${items.length} 条 × ${r.dim} 维，覆盖 ${new Set(items.map((i) => i.docRel)).size} 篇`);
  console.log(`字符数 : 中位 ${chars[Math.floor(chars.length / 2)]}，P90 ${chars[Math.floor(chars.length * 0.9)]}，max ${chars[chars.length - 1]}`);
  console.log(`原始范数: ${lo.toFixed(4)} – ${hi.toFixed(4)}（显式归一化后再用）`);
  console.log(`耗时   : ${(r.ms / 1000).toFixed(1)}s（${(r.ms / items.length).toFixed(1)} ms/条）`);
  console.log(`入库率 : ${((items.length / chunks.length) * 100).toFixed(1)}%（stub 已剔除）`);

  const res: IndexResult = {
    count: items.length,
    dim: r.dim,
    ms: r.ms,
    docs: docs.length,
    path: saved,
    size: storeSize(saved),
  };
  if (args.includes("--json")) console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
