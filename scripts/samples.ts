/**
 * 「样本」的**唯一出处**。
 *
 * 为什么单独抽出来：compliance.ts（跑模型统计合规）和 profile_inputs.ts（只算
 * 输入规模、不跑模型）必须看同一批文件，否则两边说的「20 篇」不是同一批，
 * 拿统计结果互相印证时会对不上。
 *
 * 口径（2026-11-15 收紧）：**只取力量训练**。
 * 原先混着 cardio（游泳/步行/跑步）一起算，但 cardio 结构极简（只有
 * `## 训练摘要` 一段、输出 60 tok 就够），天然合规 —— 它在分母里属于送分。
 * 当时「19/20」有近一半是这种样本，指标看着稳，实际没考到抽取能力。
 * 现在分母只剩力量记录，每一篇都要过「按 ### 分动作、按组读重量」这一关。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 读 frontmatter 判断是不是力量记录；没有 record_type 时退化为「有没有动作明细段」。 */
export function isStrength(dir: string, file: string): boolean {
  const head = readFileSync(join(dir, file), "utf8").slice(0, 1500);
  if (/^record_type:\s*"?cardio/m.test(head)) return false;
  if (/^record_type:\s*"?strength/m.test(head)) return true;
  return head.includes("## 动作明细");
}

/** 文件名含 `-训练-`、按日期降序、**只留力量记录**、取前 N 篇。 */
export function pickSamples(dir: string, n: number): string[] {
  return readdirSync(dir)
    .filter((f) => f.includes("-训练-") && f.endsWith(".md"))
    .sort()
    .reverse()
    .filter((f) => isStrength(dir, f))
    .slice(0, n);
}

export function samplePath(dir: string, file: string): string {
  return join(dir, file);
}
