/** 打一条样本的原始输出，看模型到底给了什么键 */
import { readFileSync } from "node:fs";
import { OLLAMA_MODEL, OLLAMA_URL, NUM_PREDICT, buildPrompt, validateRaw } from "../src/lib/extract";
import { kbDir } from "./kb-dir";

const KB = kbDir();
const f = process.argv[2];

async function main() {
  const md = readFileSync(`${KB}/${f}`, "utf8");
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
