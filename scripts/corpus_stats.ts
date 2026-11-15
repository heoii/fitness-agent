/**
 * W3 判据①：遍历全部 md 读 frontmatter，打印条目数。
 *
 * 判据原意不是「凑够 730 这个数」，而是**验证递归没漏子目录**——
 * `03 知识笔记/健康/` 下面还有三层（基本概念/我的案例/操作步骤），递归写错
 * 就只会读到 35 个文件，而总数看着还挺大，很难发现。
 *
 * 所以这里做两件比数字更硬的事：
 *   1. 用「非递归的顶层 + 各一级子目录分别递归」求和，与「整体递归」对比
 *      —— 两条路径必须相等，不等就是遍历写错了（这比阈值判断灵敏）
 *   2. 每个一级目录单独列出 md 数，漏读哪个目录一眼能看出来
 *
 * 用法:
 *   npm run w3:stats                 # 默认语料根 = KB_DIR
 *   npx tsx scripts/corpus_stats.ts --dir "/某个/目录"
 *   npx tsx scripts/corpus_stats.ts --quiet   # 只打印判据结论
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isStrengthDoc, loadDoc, walkMarkdown } from "../src/lib/corpus";
import { kbDir } from "./kb-dir";

const args = process.argv.slice(2);
const DIR = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : kbDir();
const QUIET = args.includes("--quiet");

/** 一级子目录清单（跳过隐藏目录） */
function topDirs(root: string): string[] {
  return readdirSync(root)
    .filter((n) => !n.startsWith(".") && n !== "node_modules")
    .filter((n) => {
      try {
        return statSync(join(root, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function topFiles(root: string): string[] {
  return readdirSync(root).filter((n) => {
    if (n.startsWith(".")) return false;
    try {
      return statSync(join(root, n)).isFile() && n.endsWith(".md");
    } catch {
      return false;
    }
  });
}

const all = walkMarkdown(DIR);

// —— 自洽性：整体递归 vs 逐层求和 ——
const direct = topFiles(DIR).length;
const perDir = topDirs(DIR).map((d) => ({ dir: d, n: walkMarkdown(join(DIR, d)).length }));
const summed = direct + perDir.reduce((a, b) => a + b.n, 0);

if (!QUIET) {
  console.log(`语料根 : ${DIR}`);
  console.log(`递归找到 md : ${all.length} 篇\n`);
  console.log("一级目录分布（md 数）:");
  console.log(`  根目录直属            ${String(direct).padStart(4)}`);
  for (const { dir, n } of perDir) {
    console.log(`  ${dir.padEnd(20)} ${String(n).padStart(4)}`);
  }
  console.log();
}

// —— 逐篇读 frontmatter ——
let noFm = 0;
let noDate = 0;
let strength = 0;
const byType = new Map<string, number>();
const byYear = new Map<string, number>();
const firstSec = new Map<string, number>();

for (const p of all) {
  const doc = loadDoc(p, DIR);
  if (Object.keys(doc.fm).length === 0) noFm++;
  if (!doc.date) noDate++;
  const t = doc.type ?? "(无 type)";
  byType.set(t, (byType.get(t) ?? 0) + 1);
  if (doc.date) {
    const y = doc.date.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  if (isStrengthDoc(doc)) strength++;
  const lead = doc.rel.split("/")[0];
  firstSec.set(lead, (firstSec.get(lead) ?? 0) + 1);
}

if (!QUIET) {
  console.log("type 分布:");
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(20)} ${String(n).padStart(4)}`);
  }
  console.log("\n年份分布（按 date）:");
  for (const [y, n] of [...byYear.entries()].sort()) {
    console.log(`  ${y}  ${String(n).padStart(4)}`);
  }
  console.log();
  console.log(`力量记录（record_type=strength 或有动作明细）: ${strength} 篇`);
  console.log(`frontmatter 读不出: ${noFm} 篇　date 缺失: ${noDate} 篇`);
  console.log();
}

// —— 判据 ——
const checks: Array<[string, boolean, string]> = [
  [
    "递归自洽（整体 = 顶层 + 各一级子目录之和）",
    summed === all.length,
    `${all.length} vs ${summed}`,
  ],
  [
    "覆盖全部一级目录（每个目录都有条目）",
    perDir.every((d) => d.n > 0),
    perDir.filter((d) => d.n === 0).map((d) => d.dir).join("、") || "全部有",
  ],
  ["frontmatter 全部可解析", noFm === 0, `${noFm} 篇读不出`],
  ["date 全部可定位", noDate === 0, `${noDate} 篇缺 date`],
  [
    "条目数 ≥ 800（2026-11-15 实测 01 每日记录 804 篇；11-10 计划里的 730 已过时）",
    all.length >= 800,
    `${all.length} 篇`,
  ],
];

console.log("判据:");
let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}　→ ${detail}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 项通过`);
process.exit(pass === checks.length ? 0 : 1);
