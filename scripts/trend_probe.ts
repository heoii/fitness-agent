/**
 * 数值入口自检：`getExerciseTrend` 的输出对不对。
 *
 * 为什么必须单独验：这一层的输出会**直接进模型上下文**，模型不会质疑它。
 * 算错一个数，模型就会用一个"看起来有据可查"的错误答案把用户说服。
 * 所以工具自己的判据要比模型的判据更硬。
 *
 * 判据：
 *   A. 双口径都在，且都带 verdict 和 deltaPct
 *   B. 「含热身」与「剔除热身」的差，应该能由 warmupShare 解释（差太大说明算错）
 *   C. 降级课必须被排除，且列出来
 *   D. 动作名歧义时要给出 alternatives，不能悄悄挑一个
 *
 * 用法: npm run w7:trend            # 跑内置样例
 *       npm run w7:trend -- 史密斯深蹲
 */
import { kbDir } from "./kb-dir";
import { getExerciseTrend, listExercises, exerciseIndexMeta } from "../src/lib/tools";

const CASES = ["史密斯深蹲", "深蹲", "布拉德福德推举", "腿举(倒蹬)", "双杠臂屈伸"];

function show(name: string) {
  const r = getExerciseTrend(name);
  console.log(`\n${"=".repeat(74)}\n【${name}】`);
  if (!r.ok) {
    console.log(`  ✗ ${r.reason}${r.alternatives.length ? `　候选：${r.alternatives.join(" / ")}` : ""}`);
    return;
  }
  console.log(`  匹配到「${r.exercise}」　共 ${r.totalSessions} 次记录`);
  if (r.alternatives.length) console.log(`  ⚠ 同名候选：${r.alternatives.join(" / ")}`);
  console.log(`  最近 ${r.recent.length} 次：`);
  for (const p of r.recent) {
    console.log(
      `    ${p.date}  最重 ${p.topWeight === null ? "自重" : `${p.topWeight}kg`}　正式组 ${p.workSets}　` +
        `工作容量 ${p.workVolume}　App容量 ${p.appVolume ?? "—"}　热身 ${(p.warmupShare * 100).toFixed(0)}%` +
        `${p.dropOffPct !== null ? `　掉力 ${p.dropOffPct}%` : ""}`
    );
  }
  console.log(`  两个口径：`);
  for (const c of r.calibers) {
    console.log(`    ${c.caliber.padEnd(28)} ${String(c.beforeAvg).padStart(7)} → ${String(c.recentAvg).padStart(7)}  ${c.verdict}（${c.deltaPct}%）`);
  }
  if (r.excluded.length) console.log(`  已排除降级课：${r.excluded.map((e) => `${e.date.slice(5)}(App容量${e.appVolume})`).join("、")}`);
  console.log(`  summary → ${r.summary}`);
  return r;
}

function main() {
  kbDir();
  const meta = exerciseIndexMeta();
  console.log(`动作词典：${meta.names} 个动作 / ${meta.records} 条记录（建索引 ${meta.ms.toFixed(0)} ms）`);

  const passed = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const names = passed.length ? passed : CASES;
  const results = names.map(show);

  // ——— 判据 ———
  console.log(`\n${"=".repeat(74)}\n判据`);
  const ok = results.filter((r): r is NonNullable<typeof r> => !!r && r.ok);
  let A = 0;
  let B = 0;
  for (const r of ok) {
    if (r.calibers.length === 2 && r.calibers.every((c) => c.verdict && Number.isFinite(c.deltaPct))) A++;
    // 自重动作只有单口径（App 容量按体重折算，不同量纲），这条判据不适用
    if (r.calibers.length < 2) continue;
    // 含热身 ≥ 剔除热身（热身只会让容量变大），且差额与热身占比同量级
    const [app, work] = r.calibers;
    const gap = app.recentAvg ? (app.recentAvg - work.recentAvg) / app.recentAvg : 0;
    const share = r.recent.reduce((s, p) => s + p.warmupShare, 0) / (r.recent.length || 1);
    B += gap >= -0.02 && Math.abs(gap - share) < 0.25 ? 1 : 0;
  }
  const excludedTotal = ok.reduce((s, r) => s + r.excluded.length, 0);
  const withAlt = results.filter((r) => r && r.alternatives.length > 0).length;

  console.log(`A 双口径完整（含 verdict 与 deltaPct）   ${A}/${ok.length}`);
  const dual = ok.filter((r) => r.calibers.length === 2).length;
  console.log(`B 两口径差额能被热身占比解释           ${B}/${dual}（单口径 ${ok.length - dual} 个自重动作不适用）`);
  console.log(`C 降级课被排除并列出                   ${excludedTotal} 次`);
  console.log(`D 歧义动作给出候选                     ${withAlt} 个用例`);
  console.log(`\n词典样例（前 8 个）：${listExercises().slice(0, 8).join(" / ")}`);
  const pass = A === ok.length && B === dual;
  console.log(`\n${pass ? "✓ 工具层输出可用" : "✗ 有判据未过"}`);
  if (!pass) process.exitCode = 1;
}

main();
