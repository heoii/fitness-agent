/**
 * 定位入口自检：`latestSession` 取的是不是真的「最晚一条」。
 *
 * 这一层的错法只有一个，但很难发现：**取到次新的一条**。它看起来完全正常——
 * 是个日期、来自训练记录、还带着引用——只是不是最近的那次。界面上没有信号。
 * 所以判据只能拿人工核对过的日期硬比。
 *
 * 真值来源：`ls 2026-*-训练*.md | sort -r` + 逐篇 grep 动作名/部位，人工核对后写死。
 *
 * 判据：
 *   A. 日期对上真值
 *   B. daysAgo 与「基准日 − 日期」一致（算错天数会让「多久没练」答错）
 *   C. previous 必须严格早于 date（否则「更早一次」比「最近一次」还新，纯 bug）
 *   D. 语料里没有的目标必须 ok=false，不许编一个日期出来
 *
 * 用法: npm run w7:latest
 */
import { kbDir } from "./kb-dir";
import { latestSession, resolveMuscle, type LatestResult } from "../src/lib/tools";

/** 基准日固定，否则 daysAgo 每天在变，判据没法写死 */
const REF = new Date(2026, 10, 15);

interface Case {
  q: string;
  expect: string | null;
}

const CASES: Case[] = [
  // 2026-11-14 腿A（正常档）是最后一次腿课；11-07 是上一次
  { q: "腿", expect: "2026-11-14" },
  // 游泳 → 有氧；11-15 那节
  { q: "游泳", expect: "2026-11-15" },
  // 胸：11-09「推·正常档28组」
  { q: "胸", expect: "2026-11-09" },
  // 动作口径：史密斯深蹲最后一次也是 11-14
  { q: "史密斯深蹲", expect: "2026-11-14" },
  // 语料里没有的动作，必须报错而不是给日期。
  // 注意别用含部位字的负例：第一版写「保加利亚单腿蹲-不存在」，
  // 结果被 resolveMuscle 的「腿」先认成腿课，返回了 11-14 —— 那是**探针写错**，
  // 不是工具错。负例必须挑一个不含任何部位别名的词，否则验的是别名表。
  { q: "泽奇深蹲", expect: null },
];

function run(c: Case): { c: Case; r: LatestResult } {
  const muscle = resolveMuscle(c.q);
  const r = latestSession({ muscle, exercise: muscle ? null : c.q }, { refDate: REF });
  return { c, r };
}

function main() {
  kbDir();
  const rows = CASES.map(run);

  for (const { c, r } of rows) {
    if (!r.ok) {
      console.log(`\n【${c.q}】✗ ${r.reason}`);
      continue;
    }
    console.log(`\n【${c.q}】→ ${r.date}${r.session ? `（${r.session}）` : ""}　距今 ${r.daysAgo} 天`);
    console.log(`  动作：${r.exercises.join("、") || "无"}`);
    console.log(`  更早一次：${r.previous ? `${r.previous.date}` : "无"}`);
  }

  console.log(`\n${"=".repeat(74)}\n判据`);
  const positive = rows.filter((x) => x.c.expect !== null);
  const negative = rows.filter((x) => x.c.expect === null);

  const A = positive.filter((x) => x.r.ok && x.r.date === x.c.expect).length;

  // daysAgo 必须等于基准日与日期的实际差
  const B = positive.filter((x) => {
    if (!x.r.ok) return false;
    const expectDays = Math.round((REF.getTime() - Date.parse(x.r.date)) / 86_400_000);
    return x.r.daysAgo === expectDays;
  }).length;

  // previous 必须更早；没有 previous 也算过（语料里只有一次）
  const C = positive.filter((x) => x.r.ok && (!x.r.previous || x.r.previous.date < x.r.date)).length;

  const D = negative.filter((x) => !x.r.ok && !!x.r.reason).length;

  console.log(`A 日期对上人工核对真值        ${A}/${positive.length}`);
  console.log(`B daysAgo 与基准日一致        ${B}/${positive.length}`);
  console.log(`C previous 严格更早           ${C}/${positive.length}`);
  console.log(`D 没有的目标报错、不编日期     ${D}/${negative.length}`);

  const pass = A === positive.length && B === positive.length && C === positive.length && D === negative.length;
  console.log(`\n${pass ? "✓ 定位层输出可用" : "✗ 有判据未过"}`);
  if (!pass) process.exitCode = 1;

  for (const { c, r } of positive) {
    if (r.ok && r.date !== c.expect) console.log(`  ⚠ 「${c.q}」期望 ${c.expect}，实得 ${r.date}`);
    if (!r.ok) console.log(`  ⚠ 「${c.q}」期望 ${c.expect}，工具报错：${r.reason}`);
  }
}

main();
