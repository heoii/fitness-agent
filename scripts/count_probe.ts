/**
 * 计数入口自检：`countTraining` 的输出对不对。
 *
 * 这一层比趋势层更需要硬判据：C2「这个月练了几次腿」被 7B 答成 1 次，
 * 依据是检索片段里「11 月 4 日腿日被取消」——引用真实、推理成立、结论错。
 * 模型不会质疑喂给它的数字，所以**数错了没人能发现**，只能靠这个探针。
 *
 * 真值来源：直接 grep 语料 frontmatter 的 `muscle_focus` / `muscle_groups`，
 * 逐条人工核对后硬编码在下表。改了语料这张表就要跟着改，否则会红——
 * 这是故意的：静默过期比报错危险。
 *
 * 判据：
 *   A. 数与真值一致（重点次数、命中日期）
 *   B. 区间不串月：跨月结果里不许出现区间外的日期
 *   C. 兼带 ≥ 重点（muscle_groups 是 focus 的超集，反过来就是 filter 写反了）
 *   D. 降级课被认出来（10-30「试探档」）
 *   E. 空区间必须 ok=false 并说明，不许返回「0 次」冒充结论
 *
 * 用法: npm run w7:count
 */
import { kbDir } from "./kb-dir";
import {
  countTraining,
  resolveMuscle,
  resolvePeriod,
  exerciseIndexMeta,
  type CountResult,
} from "../src/lib/tools";

/** 基准日固定成 2026-11-15，否则「这个月」会随真实日期漂移，判据天天变 */
const REF = new Date(2026, 10, 15);

interface Case {
  q: string;
  /** 人工核对过的重点次数；null = 这一问应该没有记录 */
  expectFocus: number | null;
  expectDates?: string[];
  expectDegraded?: number;
}

const CASES: Case[] = [
  // 2026-11：11-07 腿A（含臀）、11-14 腿A（正常档）——就这两节
  { q: "我这个月一共练了几次腿？", expectFocus: 2, expectDates: ["11-07", "11-14"] },
  // 2026-11 胸：11-02（正常档回归）、11-09（推·28组）
  { q: "这个月练了几次胸", expectFocus: 2, expectDates: ["11-02", "11-09"] },
  // 2026-11 有氧：11-01、11-08、11-15 三次游泳
  { q: "这个月有氧几次", expectFocus: 3, expectDates: ["11-01", "11-08", "11-15"] },
  // 2026-10 腿：10-09、10-17、10-22、10-30，其中 10-30 是试探档
  { q: "上个月练了几次腿", expectFocus: 4, expectDates: ["10-09", "10-17", "10-22", "10-30"], expectDegraded: 1 },
  // 空区间：2024 年整年都没有记录
  { q: "2024 年练了几次腿", expectFocus: null },
];

interface Row {
  c: Case;
  r: CountResult;
  muscle: string | null;
}

function run(c: Case): Row {
  const muscle = resolveMuscle(c.q);
  const period = resolvePeriod(c.q, REF);
  const r = countTraining({ muscle, exercise: muscle ? null : "深蹲", period });
  return { c, r, muscle };
}

function main() {
  kbDir();
  const meta = exerciseIndexMeta();
  console.log(`动作词典：${meta.names} 个动作 / ${meta.records} 条记录（基准日 2026-11-15）`);
  console.log("=".repeat(76));

  const rows = CASES.map(run);
  for (const { c, r, muscle } of rows) {
    console.log(`\n【${c.q}】部位=${muscle ?? "（无）"}　区间=${r.periodLabel}（${r.from} ~ ${r.to}）`);
    if (!r.ok) {
      console.log(`  ✗ ${r.reason}`);
      continue;
    }
    console.log(`  重点 ${r.focusCount} 次 / 含兼带 ${r.withSecondary} 次 / 降级 ${r.degradedCount} 次`);
    for (const s of r.rows) {
      console.log(
        `    ${s.date}${s.focus ? " ●" : " ○"} ${s.session || "—"}　focus=${s.muscleFocus.join("/") || "—"}` +
          `${s.degraded ? "　[降级课]" : ""}`
      );
    }
    console.log(`  口径 → ${r.caliber}`);
  }

  // ——— 判据 ———
  console.log(`\n${"=".repeat(76)}\n判据`);
  let A = 0;
  let B = 0;
  let C = 0;
  let D = 0;
  let E = 0;
  for (const { c, r } of rows) {
    // E：期望「没记录」的，必须 ok=false 且带原因
    if (c.expectFocus === null) {
      E += !r.ok && !!r.reason ? 1 : 0;
      if (r.ok) console.log(`  ⚠ 「${c.q}」应该没有记录，却返回了 ${r.focusCount} 次`);
      continue;
    }
    if (!r.ok) {
      console.log(`  ⚠ 「${c.q}」期望 ${c.expectFocus} 次，工具报错：${r.reason}`);
      continue;
    }
    // A：次数与日期都对上
    const dates = r.rows.filter((s) => s.focus).map((s) => s.date.slice(5));
    const dateOk = c.expectDates ? JSON.stringify(dates) === JSON.stringify(c.expectDates) : true;
    A += r.focusCount === c.expectFocus && dateOk ? 1 : 0;
    if (r.focusCount !== c.expectFocus || !dateOk)
      console.log(`  ⚠ 「${c.q}」期望 ${c.expectFocus} 次 ${c.expectDates?.join(",") ?? ""}，实得 ${r.focusCount} 次 ${dates.join(",")}`);

    // B：区间不串月
    const outside = r.rows.filter((s) => s.date < r.from || s.date > r.to);
    B += outside.length === 0 ? 1 : 0;
    if (outside.length) console.log(`  ⚠ 「${c.q}」混入区间外日期：${outside.map((s) => s.date).join("、")}`);

    // C：兼带 ≥ 重点
    C += r.withSecondary >= r.focusCount ? 1 : 0;
    if (r.withSecondary < r.focusCount)
      console.log(`  ⚠ 「${c.q}」兼带 ${r.withSecondary} < 重点 ${r.focusCount}，filter 写反了`);

    // D：降级课
    if (c.expectDegraded !== undefined) {
      D += r.degradedCount === c.expectDegraded ? 1 : 0;
      if (r.degradedCount !== c.expectDegraded)
        console.log(`  ⚠ 「${c.q}」期望 ${c.expectDegraded} 次降级课，实得 ${r.degradedCount}`);
    }
  }

  const withTruth = rows.filter((x) => x.c.expectFocus !== null).length;
  const withDegraded = rows.filter((x) => x.c.expectDegraded !== undefined).length;
  console.log(`A 次数与日期对上人工核对真值        ${A}/${withTruth}`);
  console.log(`B 区间不串月                       ${B}/${withTruth}`);
  console.log(`C 兼带 ≥ 重点                      ${C}/${withTruth}`);
  console.log(`D 降级课识别                       ${D}/${withDegraded}`);
  console.log(`E 空区间明确说没有、不冒充 0 次      ${E}/${rows.length - withTruth}`);

  const pass = A === withTruth && B === withTruth && C === withTruth && D === withDegraded && E === rows.length - withTruth;
  console.log(`\n${pass ? "✓ 计数层输出可用" : "✗ 有判据未过"}`);
  if (!pass) process.exitCode = 1;
}

main();
