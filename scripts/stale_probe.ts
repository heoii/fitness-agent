/**
 * 荒废入口自检：`npm run w7:stale`
 *
 * 「哪些动作我很久没练了」是**集合差 + 日期**：对每个动作取 `max(date)` 再排序。
 * 任何一段文字里都没有这个结果，所以检索给不了、模型也算不了——
 * 它得先记住一百多个动作各自的最近日期。
 *
 * 判据分两类：
 *   ① 结构性（永不过期）：降序、daysAgo 与日期自洽、limit 生效
 *   ② 已知真值（**语料一变就会红，红了就重算**）：最久没练的是谁
 */
import { kbDir } from "./kb-dir";
import { staleExercises } from "../src/lib/tools";

kbDir();

const REF = new Date(2026, 10, 15); // 固定 2026-11-15，判据才可复现
const cases: Array<{ name: string; ok: boolean; got: string; want: string }> = [];
const push = (name: string, ok: boolean, got: unknown, want: unknown) =>
  cases.push({ name, ok, got: String(got), want: String(want) });

const r = staleExercises({ limit: 5, refDate: REF });
push("ok", r.ok, r.ok, true);
push("refDate", r.refDate === "2026-11-15", r.refDate, "2026-11-15");

/* ── ① 结构性 ── */
const desc = r.items.every((x, i) => i === 0 || r.items[i - 1].daysAgo >= x.daysAgo);
push("按 daysAgo 降序", desc, desc, true);

// daysAgo 必须和 lastDate 自洽：这两处分别算的话，一个改了另一个没改会静默错
const consistent = r.items.every(
  (x) => Math.round((REF.getTime() - Date.parse(x.lastDate)) / 86_400_000) === x.daysAgo
);
push("daysAgo 与 lastDate 自洽", consistent, consistent, true);

const few = staleExercises({ limit: 2, refDate: REF });
push("limit 生效", few.items.length === 2, few.items.length, 2);

const wide = staleExercises({ limit: 5, minDays: 365, refDate: REF });
push("minDays 生效（365 天比 30 天少）", wide.staleCount < r.staleCount, `${wide.staleCount} < ${r.staleCount}`, true);

// 每个带 docName 的条目都能构成一条合法引用
const cited = r.items.filter((x) => x.docName).length;
push("条目带 docName（可做引用）", cited === r.items.length, cited, r.items.length);

/* ── ② 已知真值（2026-11-15 人工核过）──
 * 「悍马上斜推胸」只在 2025-08-05 那篇出现过一次：
 *   01 每日记录/2025-08-05-训练-01-周二_胸部训练.md
 * 动作总数 135 是**工具解析**的结果（人工 grep 会得到 141，
 * 多出来的 6 个是「五、今天」这类章节标题，不算动作）。
 *
 * 这两条会随语料增长而过期 —— 红了不是代码坏了，是语料变了，重算真值。 */
push("动作总数", r.total === 135, r.total, 135);
push("最久没练的第一个", r.items[0]?.name === "悍马上斜推胸", r.items[0]?.name, "悍马上斜推胸");
push("它的最近日期", r.items[0]?.lastDate === "2025-08-05", r.items[0]?.lastDate, "2025-08-05");
push("它的距今天数", r.items[0]?.daysAgo === 467, r.items[0]?.daysAgo, 467);

/* ── ③ 全局统计不能为空 ── */
push("30 天以上没练的数量 > 80", r.staleCount > 80, r.staleCount, ">80");

let bad = 0;
for (const c of cases) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(26)} got=${c.got}  want=${c.want}`);
}
console.log(`\n${bad === 0 ? "✓ 全过" : "✗ 有偏差"}：${cases.length - bad}/${cases.length}`);
if (bad) process.exitCode = 1;
