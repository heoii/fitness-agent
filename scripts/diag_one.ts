/** 打一条样本的原始输出，看模型到底给了什么键
 *
 * 用法:
 *   npx tsx scripts/diag_one.ts "2026-10-22-训练-01-腿A（股四主导）+腹.md"
 *   npx tsx scripts/diag_one.ts "2026-10-22-..." --cut "## 教练复盘"
 *
 * --cut 会在喂给模型之前把正文从该标记处截断。用途：验证「失败是因为同一篇里
 * 还有第二个像训练记录的结构（复盘里的处方表）」，而不是因为长。
 * 20 篇里只有 2026-10-22 那篇带 `## 教练复盘`（4234 字、38 行表格），其余 19 篇为 0。
 */
import { readFileSync } from "node:fs";
import { OLLAMA_MODEL, OLLAMA_URL, NUM_PREDICT, buildPrompt, trimToRecord, validateRaw } from "../src/lib/extract";
import { kbDir } from "./kb-dir";

const KB = kbDir();
const f = process.argv[2];
const cutIdx = process.argv.indexOf("--cut");
const CUT = cutIdx === -1 ? "" : (process.argv[cutIdx + 1] ?? "");

async function main() {
  const full = readFileSync(`${KB}/${f}`, "utf8");
  const at = CUT ? full.indexOf(CUT) : -1;
  const md = at === -1 ? full : full.slice(0, at);
  if (CUT) {
    console.log(at === -1 ? `未找到截断标记「${CUT}」，按全文喂\n` : `--cut 截断于「${CUT}」：${full.length} → ${md.length} 字\n`);
  }
  // buildPrompt 现在会自己按「记录段」切（见 extract.ts trimToRecord），这里把差额打出来
  const fed = trimToRecord(md);
  console.log(`喂入：全文 ${md.length} 字 → ${fed.length} 字${fed.length < md.length ? "（已切掉记录段之后的内容）" : "（无多余段落）"}\n`);
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildPrompt(md),
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: NUM_PREDICT },
    }),
  });
  const json: any = await res.json();
  const raw = String(json?.response ?? "");
  console.log("顶层键:", Object.keys(JSON.parse(raw)).join(", "));
  console.log("校验:", JSON.stringify(validateRaw(raw).ok));
  console.log("\n--- raw（前 700 字）---\n" + raw.slice(0, 700));
  console.log("\n--- 正文里 session 出现的位置 ---");
  md.split("\n").forEach((l, i) => {
    if (/session|训练计划|恢复性/.test(l)) console.log(`${i + 1}: ${l.slice(0, 90)}`);
  });
}

main();
