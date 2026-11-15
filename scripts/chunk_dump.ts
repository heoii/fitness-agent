/**
 * W3 判据②：按 `##` 层级切 chunk，带 headingPath；抽查层级正确。
 *
 * 判据原意：「随机抽一篇 chunk 层级正确」。这里把它做成三条能自动判的：
 *   1. 所有 chunk 的 headingPath 每一级都真出现在该文档的标题行里
 *      （防「层级拼错/串门」这类只能靠肉眼发现的问题）
 *   2. chunk 总数 > 文档数（说明确实切开了，不是整篇一个块）
 *   3. 指定的那篇（默认 2026-11-07 腿A）切出 8 个动作块，每块三层路径，
 *      正文都以「组1：」开头 —— 这是计划里点名要还原的那篇
 *
 * 用法:
 *   npm run w3:chunk                          # 全库统计 + 三条判据
 *   npx tsx scripts/chunk_dump.ts --doc 2026-11-07-训练-01-腿A   # 打印某篇的 chunk 树
 *   npx tsx scripts/chunk_dump.ts --top 5     # 顺带打印最长的 5 个 chunk
 */
import { chunkDoc, chunkLabel } from "../src/lib/chunk";
import { loadDoc, walkMarkdown } from "../src/lib/corpus";
import { kbDir } from "./kb-dir";

const args = process.argv.slice(2);
const DIR = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : kbDir();
const DOC = args.includes("--doc") ? args[args.indexOf("--doc") + 1] : null;
const TOP = args.includes("--top") ? Number(args[args.indexOf("--top") + 1]) : 0;

const files = walkMarkdown(DIR);
const docs = files.map((f) => loadDoc(f, DIR));

if (DOC) {
  const hit = docs.filter((d) => d.name.includes(DOC));
  if (hit.length === 0) {
    console.error(`没找到文件名含「${DOC}」的文档（语料根：${DIR}）`);
    process.exit(2);
  }
  for (const d of hit) {
    const chunks = chunkDoc(d);
    console.log(`\n=== ${d.name}　${chunks.length} 个 chunk ===`);
    for (const c of chunks) {
      const head = c.text.split("\n")[0].slice(0, 60);
      console.log(`  [${String(c.chars).padStart(4)}字] ${chunkLabel(c)}`);
      console.log(`           ${head}`);
    }
  }
  process.exit(0);
}

// —— 全库切分 ——
let total = 0;
let stub = 0;
let parts = 0;
let maxChars = 0;
const sizes: number[] = [];
let pathBroken = 0;
const brokenSample: string[] = [];
const all: Array<{ label: string; chars: number }> = [];

for (const d of docs) {
  const headingSet = new Set(
    d.body
      .split("\n")
      .map((l) => l.match(/^(#{1,6})\s+(.*)$/)?.[2]?.trim())
      .filter((x): x is string => Boolean(x))
  );
  for (const c of chunkDoc(d)) {
    total++;
    sizes.push(c.chars);
    if (c.chars > maxChars) maxChars = c.chars;
    if (c.stub) stub++;
    if (c.part) parts++;
    if (TOP) all.push({ label: chunkLabel(c), chars: c.chars });
    // 判据 1：路径每一级都要真出现在本文档标题行里
    const bad = c.headingPath.filter((h) => !headingSet.has(h));
    if (bad.length) {
      pathBroken++;
      if (brokenSample.length < 3) brokenSample.push(`${chunkLabel(c)} ← 伪标题 ${bad.join("/")}`);
    }
  }
}

sizes.sort((a, b) => a - b);
const pct = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];

console.log(`语料根 : ${DIR}`);
console.log(`文档 ${docs.length} 篇 → chunk ${total} 个（平均 ${(total / docs.length).toFixed(1)} 个/篇）`);
console.log(`长度   : 中位 ${pct(0.5)} 字　p90 ${pct(0.9)} 字　最长 ${maxChars} 字`);
console.log(`短块（<20 字）${stub} 个　超长硬切 ${parts} 块`);

if (TOP && all.length) {
  console.log(`\n最长的 ${TOP} 个 chunk:`);
  for (const x of [...all].sort((a, b) => b.chars - a.chars).slice(0, TOP)) {
    console.log(`  ${String(x.chars).padStart(5)} 字  ${x.label}`);
  }
}

// —— 判据 3：计划里点名的那篇 ——
const target = docs.find((d) => d.name.includes("2026-11-07-训练-01-腿A"));
let legOk = false;
let legDetail = "没找到 2026-11-07-训练-01-腿A";
if (target) {
  const cs = chunkDoc(target);
  const three = cs.filter((c) => c.headingPath.length === 3);
  const startsWithSet = three.filter((c) => /^-\s*组1[：:]/.test(c.text.trim()));
  // 8 个动作块（三层路径）+ 1 个文档级块（课程/时长/消耗那几行）= 9
  legOk = cs.length === 9 && three.length === 8 && startsWithSet.length === 8;
  legDetail = `${cs.length} 个 chunk（含 1 个文档级），其中三层路径 ${three.length} 个、首行是「组1」${startsWithSet.length} 个`;
}

// —— 判据 4 的数据：有标题的文档却切出「空路径」块 ——
// 这一条必须**不依赖**上面那个标题正则，否则会自指：用同一个正则核对它自己，
// 两边同时失败就会互相印证成「正确」。用 `m` 标志的独立正则探一下就算。
const headingLoss: string[] = [];
let lossChars = 0;
for (const d of docs) {
  if (!/^#{1,6}\s+\S/m.test(d.body)) continue;
  const empty = chunkDoc(d).filter((c) => c.headingPath.length === 0);
  if (!empty.length) continue;
  for (const c of empty) lossChars += c.chars;
  if (headingLoss.length < 3) {
    headingLoss.push(`${d.name}（${empty.length} 块 / ${empty.reduce((a, c) => a + c.chars, 0)} 字）`);
  }
}
const lossDocs = docs.filter((d) => /^#{1,6}\s+\S/m.test(d.body) && chunkDoc(d).some((c) => c.headingPath.length === 0)).length;

const checks: Array<[string, boolean, string]> = [
  [
    "headingPath 每一级都真出现在本文档标题行里",
    pathBroken === 0,
    pathBroken === 0 ? "全部正确" : `${pathBroken} 处可疑；例：${brokenSample.join("；")}`,
  ],
  ["chunk 数 > 文档数（确实切开了，不是整篇一块）", total > docs.length, `${total} vs ${docs.length}`],
  ["11-07 腿A 切出 8 个动作块，路径三层，正文以组1 开头", legOk, legDetail],
  [
    "有标题的文档不许切出空路径块（换行符/正则回归）",
    lossDocs === 0,
    lossDocs === 0 ? "全部有路径" : `${lossDocs} 篇丢失标题结构，共 ${lossChars} 字无路径；例：${headingLoss.join("；")}`,
  ],
];

console.log("\n判据:");
let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}　→ ${detail}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 项通过`);
process.exit(pass === checks.length ? 0 : 1);
