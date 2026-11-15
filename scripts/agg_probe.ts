/**
 * 聚合与对比的**确定性**判据：`npm run w7:agg`
 *
 * 为什么不放在 w6:ask 里：那一组（G1–G3）用的是「今天」算出来的真值
 * （2026-11 共 10 篇、10 月共 26 篇）。**跨月之后全部会红**——
 * 红了不是坏事，是提醒你重算真值；但一个会过期的判据不能当回归基线。
 *
 * 所以这里用**固定参考日 2026-11-15**，判据永不过期：
 * 区间边界、perWeek 的分母、频率都没有「今天」参与。
 */
import { kbDir } from "./kb-dir";
import { countTraining, resolveCompare, resolvePeriod } from "../src/lib/tools";

kbDir();

const REF = new Date(2026, 10, 15); // 2026-11-15，固定
const cases: Array<{ name: string; ok: boolean; got: string; want: string }> = [];
const push = (name: string, ok: boolean, got: unknown, want: unknown) =>
  cases.push({ name, ok, got: String(got), want: String(want) });

/* ── ① 全部训练课数（真值人工 ls 数过语料）── */
const nov = countTraining({ period: resolvePeriod("这个月", REF) }, { refDate: REF });
push("2026-11 总课数", nov.withSecondary === 10, nov.withSecondary, 10);

const oct = countTraining({ period: resolvePeriod("上个月", REF) }, { refDate: REF });
push("2026-10 总课数", oct.withSecondary === 26, oct.withSecondary, 26);

/* ── ② perWeek 的分母必须是「已过天数」 ──
 * 11-15 问本月，若拿整月 30 天当分母，10 次会算成每周 2.3 —— 直接砍半。
 * 这是最容易写错、且完全看不出来的一处。 */
push("本月 perWeek.days", nov.perWeek.days === 15, nov.perWeek.days, 15);
push("上月 perWeek.days（已过完，取整月）", oct.perWeek.days === 31, oct.perWeek.days, 31);

const rateNov = nov.perWeek.count / (nov.perWeek.days / 7);
push("本月每周频率", Math.abs(rateNov - 4.7) < 0.05, rateNov.toFixed(2), "4.67");

/* ── ③ 区间对比的两个边界 ── */
const mon = resolveCompare("和上个月比这个月练得更多吗", REF);
push("月对比 cur.from", mon?.cur.from === "2026-11-01", mon?.cur.from, "2026-11-01");
push("月对比 cur.to（整月末，不是今天）", mon?.cur.to === "2026-11-30", mon?.cur.to, "2026-11-30");
push("月对比 prev.from", mon?.prev.from === "2026-10-01", mon?.prev.from, "2026-10-01");
push("月对比 prev.to", mon?.prev.to === "2026-10-31", mon?.prev.to, "2026-10-31");

// 周一是 2026-11-09（11-15 是周日）
const wk = resolveCompare("这周比上周练得多吗", REF);
push("周对比本周一", wk?.cur.from === "2026-11-09", wk?.cur.from, "2026-11-09");
push("周对比本周日", wk?.cur.to === "2026-11-15", wk?.cur.to, "2026-11-15");
push("周对比上周一", wk?.prev.from === "2026-11-02", wk?.prev.from, "2026-11-02");

/* ── ④ 不该被当成对比的 ── */
push("「上个月练了几次」不是对比", resolveCompare("上个月练了几次", REF) === null, !!resolveCompare("上个月练了几次", REF), false);
push("「这个月比上个月」缺「比」也判对比", resolveCompare("这个月比上个月练了几次", REF) !== null, !!resolveCompare("这个月比上个月练了几次", REF), true);

/* ── ⑤ 空区间不冒充 0 次 ── */
const empty = countTraining({ period: resolvePeriod("2024 年 3 月", REF) }, { refDate: REF });
push("空区间 ok=false（不冒充 0 次）", empty.ok === false, empty.ok, false);

let bad = 0;
for (const c of cases) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(30)} got=${c.got}  want=${c.want}`);
}
console.log(`\n${bad === 0 ? "✓ 全过" : "✗ 有偏差"}：${cases.length - bad}/${cases.length}`);
if (bad) process.exitCode = 1;
