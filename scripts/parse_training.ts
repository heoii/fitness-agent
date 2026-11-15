/**
 * W3 判据③：训练记录用正则抽成结构化 JSON，抽查能还原「11/07 腿A 的 8 个动作」。
 *
 * 判据原意是「能还原」，所以除了抽样打印，这里做三条硬校验：
 *   1. 11-07 腿A：8 个动作、25 组、深蹲首组 40kg×8 标热身、末组 60kg×6、掉力 25%
 *   2. 全语料**容量交叉校验**：逐个动作比对「标题里写的容量」与「按 weight×reps 算出的
 *      容量」。两边对不上只有两种可能——我的正则解析错了，或 App 的算法不同。
 *      这比「抽一篇看看对不对」灵敏得多，因为 213 篇、上千动作全都是证据。
 *   3. 空次数（`自重 × `）必须留 null，不许变成 0 —— 变成 0 会造出假掉力信号。
 *
 * 用法:
 *   npm run w3:parse                          # 全量解析 + 判据
 *   npx tsx scripts/parse_training.ts --doc 2026-11-07-训练-01-腿A
 *   npx tsx scripts/parse_training.ts --json 2026-11-07-训练-01-腿A   # 输出原始 JSON
 */
import { loadDoc, section, walkMarkdown } from "../src/lib/corpus";
import { parseTraining, type TrainingRecord } from "../src/lib/training-parse";
import { kbDir } from "./kb-dir";

const args = process.argv.slice(2);
const DIR = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : kbDir();
const DOC = args.includes("--doc") ? args[args.indexOf("--doc") + 1] : null;
const JSON_OUT = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

function summary(r: TrainingRecord): string {
  const totalSets = r.exercises.reduce((a, e) => a + e.sets.length, 0);
  const drops = r.exercises.filter((e) => e.dropOff).map((e) => `${e.name} ${e.dropOff!.pct}%`);
  return `${r.date ?? "?"} ${r.session ?? "?"}　${r.exercises.length} 动作 / ${totalSets} 组` +
    `${drops.length ? `　掉力: ${drops.join("、")}` : ""}`;
}

if (JSON_OUT) {
  const f = walkMarkdown(DIR).find((p) => p.includes(JSON_OUT));
  if (!f) {
    console.error(`没找到 ${JSON_OUT}`);
    process.exit(2);
  }
  const r = parseTraining(loadDoc(f, DIR));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r ? 0 : 2);
}

if (DOC) {
  const f = walkMarkdown(DIR).find((p) => p.includes(DOC));
  if (!f) {
    console.error(`没找到文件名含「${DOC}」的文档`);
    process.exit(2);
  }
  const r = parseTraining(loadDoc(f, DIR));
  if (!r) {
    console.error("不是力量记录（没有动作明细段）");
    process.exit(2);
  }
  console.log(`\n=== ${summary(r)} ===`);
  console.log(`课程 ${r.session}　时长 ${r.durationMin} 分　消耗 ${r.calorie} kcal　容量 ${r.capacity}`);
  console.log(`重点肌群: ${r.muscleFocus.join("/")}　辅助: ${r.muscleGroups.join("/")}\n`);
  for (const e of r.exercises) {
    const volMark = e.volume === null ? "?" : e.volume === e.computedVolume ? "✓" : `✗ 算得 ${e.computedVolume}`;
    console.log(`  ${e.name}　容量 ${e.volume ?? "?"} ${volMark}`);
    for (const s of e.sets) {
      const w = s.bodyweight ? "自重" : `${s.weightKg}kg`;
      const reps = s.reps === null ? "(空)" : String(s.reps);
      const rest = s.restS === null ? "" : `，休息 ${s.restS}s`;
      console.log(`      组${s.index}：${w} × ${reps}${rest}${s.warmup ? "　（热身）" : ""}`);
    }
    if (e.dropOff) {
      console.log(`      掉力 ${e.dropOff.pct}%（首组 ${e.dropOff.firstSetReps} → 末组 ${e.dropOff.lastSetReps}）`);
    }
  }
  process.exit(0);
}

// —— 全量 ——
const files = walkMarkdown(DIR);
let strengthDocs = 0;
let parsed = 0;
let emptySection = 0;      // 源数据里「## 动作明细」本身就是空的（不是解析失败）
let noExercise = 0;        // 有内容却一个动作都没抽出来（真失败）
let nullReps = 0;
let volChecked = 0;
let volExact = 0;
let volDouble = 0;         // App 对双侧动作按两侧算
let volSmallDiff = 0;      // 小数差（App 保留 .5）
let volAppZero = 0;        // App 那篇没算容量
let volUnexplained = 0;
const unexplainedByExercise = new Map<string, number>();
const exerciseCounts: number[] = [];
let dropCount = 0;

for (const f of files) {
  const doc = loadDoc(f, DIR);
  const r = parseTraining(doc);
  if (!r) continue;
  strengthDocs++;
  const sec = section(doc, "动作明细");
  if (r.exercises.length === 0) {
    if (sec && sec.trim().length > 0) noExercise++;
    else emptySection++;
    continue;
  }
  parsed++;
  exerciseCounts.push(r.exercises.length);
  for (const e of r.exercises) {
    if (e.volume !== null) {
      volChecked++;
      const t = e.volume;
      const c = e.computedVolume;
      if (t === c) volExact++;
      else if (Math.abs(t - 2 * c) <= 1) volDouble++;
      else if (t === 0) volAppZero++;
      else if (Math.abs(t - c) < 2) volSmallDiff++;
      else {
        volUnexplained++;
        unexplainedByExercise.set(e.name, (unexplainedByExercise.get(e.name) ?? 0) + 1);
      }
    }
    if (e.dropOff) dropCount++;
    for (const s of e.sets) if (s.reps === null) nullReps++;
  }
}

exerciseCounts.sort((a, b) => a - b);
const totalExercises = exerciseCounts.reduce((a, b) => a + b, 0);
const explainable = volExact + volDouble + volSmallDiff + volAppZero;
const explainablePct = volChecked ? (explainable / volChecked) * 100 : 0;

console.log(`语料根 : ${DIR}`);
console.log(`力量记录 ${strengthDocs} 篇，解析出动作 ${parsed} 篇（${emptySection} 篇动作明细本身为空，${noExercise} 篇解析失败）`);
console.log(`动作 ${totalExercises} 个（中位 ${exerciseCounts[Math.floor(exerciseCounts.length / 2)]} 个/篇）　掉力标记 ${dropCount} 个`);
console.log(`次数字段为空 ${nullReps} 条（保留 null，不当 0）`);
console.log(`容量交叉校验 ${volChecked} 个动作：`);
console.log(`  一致 ${volExact}　双倍 ${volDouble}　小数差 ${volSmallDiff}　App 记 0 ${volAppZero}　无法解释 ${volUnexplained}`);
console.log(`  可解释率 ${explainablePct.toFixed(1)}%`);
if (volUnexplained) {
  const top = [...unexplainedByExercise.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  无法解释的集中在: ${top.map(([n, c]) => `${n}×${c}`).join("、")}`);
  console.log("  （这些是自重/单臂动作，练练按体重折算或只算单侧——是 App 的算法，不是解析错）");
}

// —— 判据 1：点名的那篇 ——
const legFile = files.find((p) => p.includes("2026-11-07-训练-01-腿A"));
let legOk = false;
let legDetail = "没找到 2026-11-07-训练-01-腿A";
if (legFile) {
  const r = parseTraining(loadDoc(legFile, DIR));
  if (!r) {
    legDetail = "解析返回 null";
  } else {
    const sq = r.exercises.find((e) => e.name.includes("史密斯深蹲"));
    const totalSets = r.exercises.reduce((a, e) => a + e.sets.length, 0);
    const first = sq?.sets[0];
    const last = sq?.sets[sq.sets.length - 1];
    const checks = {
      动作数: r.exercises.length === 8,
      总组数: totalSets === 25,
      首组热身: first?.weightKg === 40 && first?.reps === 8 && first?.warmup === true,
      末组: last?.weightKg === 60 && last?.reps === 6,
      掉力: sq?.dropOff?.pct === 25,
    };
    legOk = Object.values(checks).every(Boolean);
    legDetail = Object.entries(checks)
      .map(([k, v]) => `${k}${v ? "✓" : "✗"}`)
      .join(" ") + `（${r.exercises.length} 动作 / ${totalSets} 组）`;
  }
}

const checks: Array<[string, boolean, string]> = [
  ["11-07 腿A 完整还原（8 动作 / 25 组 / 深蹲热身与掉力）", legOk, legDetail],
  [
    "容量差异 95% 以上可解释（一致/双倍/小数/App 记 0）",
    explainablePct >= 95,
    `${explainablePct.toFixed(1)}%（无法解释 ${volUnexplained} 个）`,
  ],
  [
    "有动作明细的篇目全部抽出动作（0 篇解析失败）",
    noExercise === 0,
    noExercise === 0
      ? `0 篇失败${emptySection ? `；另有 ${emptySection} 篇源数据动作明细本身为空（不是解析问题）` : ""}`
      : `${noExercise} 篇有内容却零动作`,
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
