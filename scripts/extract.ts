/**
 * 用真实训练记录验证 TrainingRecordSchema（W2 判据：字段和 frontmatter 对得上）
 *
 * 用法: npx tsx scripts/extract.ts "知识库路径/01 每日记录/2026-11-07-训练-01-腿A.md"
 *
 * 正则口径来自《2026-11-10-健身Agent项目定位与执行计划》第四节：
 *   组(\d+)：(\d+(\.\d+)?)kg × (\d+)      负重
 *   组(\d+)：自重 × (\d+)                 自重
 */
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { StrengthRecordSchema, TrainingRecordSchema } from "../src/types/training";

const file = process.argv[2];
if (!file) {
  console.error("用法: npx tsx scripts/extract.ts <训练记录.md>");
  process.exit(1);
}

const md = readFileSync(file, "utf8");

// ---- frontmatter ----
const fm = (key: string): string | undefined =>
  md.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim();

const date = fm("date") ?? "";
const session = fm("session") ?? "";
const recordType = fm("record_type") === "cardio" ? "cardio" : "strength";
const duration = fm("duration_min");
const calorie = fm("calorie");
const distance = fm("distance_km");

// ---- 动作明细（## 动作明细 区块）----
const body = md.split("## 动作明细")[1] ?? "";
const exercises: z.infer<typeof TrainingRecordSchema>["exercises"] = [];

const reSet = /组(\d+)：(?:(\d+(?:\.\d+)?)kg|自重)\s*×\s*(\d+)(?:，休息\s*(\d+)s)?/g;
for (const block of body.split(/^### /m).slice(1)) {
  const name = block.split("—")[0].trim().replace(/（kg）$/, "");
  const sets: { weight: number | null; reps: number; rest_s?: number }[] = [];
  for (const m of block.matchAll(reSet)) {
    sets.push({
      weight: m[2] !== undefined ? Number(m[2]) : null,
      reps: Number(m[3]),
      ...(m[4] !== undefined ? { rest_s: Number(m[4]) } : {}),
    });
  }
  const vol = block.match(/容量\s*(\d+)/);
  if (sets.length > 0) {
    exercises.push({ name, sets, ...(vol ? { volume: Number(vol[1]) } : {}) });
  }
}

const record = {
  date,
  session,
  record_type: recordType,
  ...(duration ? { duration_min: Number(duration) } : {}),
  ...(calorie ? { calorie: Number(calorie) } : {}),
  ...(distance ? { distance_km: Number(distance) } : {}),
  exercises,
};

const result = StrengthRecordSchema.safeParse(record);

if (!result.success) {
  console.error("❌ 校验失败:");
  for (const i of result.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}

const totalSets = exercises.reduce((n: number, e: { sets: unknown[] }) => n + e.sets.length, 0);
const meta = [
  duration ? `${duration} 分钟` : "",
  calorie ? `${calorie} kcal` : "",
  distance ? `${distance} km` : "",
]
  .filter(Boolean)
  .join(" / ");
console.log(`✅ 合规  date=${date}  session=${session}  ${recordType}  动作=${exercises.length}  总组数=${totalSets}${meta ? `  [${meta}]` : ""}`);
for (const e of exercises) {
  const last = e.sets[e.sets.length - 1];
  const first = e.sets[0];
  const drop = first.reps > 0 ? Math.round(((first.reps - last.reps) / first.reps) * 100) : 0;
  console.log(
    `   ${e.name}  ${e.sets.length} 组` +
      (drop >= 20 ? `  ⚠ 末组掉力 ${drop}%（${first.reps}→${last.reps}）` : "")
  );
}
