/**
 * 诊断 W2 那 3 条失败：是 num_predict 截断，还是模型输出跑偏？
 * 同一个文件跑两遍（900 / 2000 token），比长度和结尾，别靠猜。
 */
import { readFileSync } from "node:fs";
import { OLLAMA_MODEL, OLLAMA_URL, buildPrompt, validateRaw } from "../src/lib/extract";
import { kbDir } from "./kb-dir";

const KB = kbDir();
const files = process.argv.slice(2);

async function call(md: string, numPredict: number) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildPrompt(md),
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: numPredict },
    }),
  });
  const json: any = await res.json();
  return {
    raw: String(json?.response ?? ""),
    done: json?.done_reason,
    evalCount: json?.eval_count,
  };
}

async function main() {
  for (const f of files) {
    const md = readFileSync(`${KB}/${f}`, "utf8");
    const actions = (md.split("## 动作明细")[1] ?? "").split(/^### /m).length - 1;
    console.log(`\n=== ${f}（正文动作小节 ${actions} 个）===`);
    for (const n of [900, 2000]) {
      const t0 = Date.now();
      const r = await call(md, n);
      const v = validateRaw(r.raw);
      console.log(
        `num_predict=${n}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
          `输出 ${r.raw.length} 字符 / ${r.evalCount} tok  done_reason=${r.done}  ` +
          `合规=${v.ok}${v.ok ? "" : `  (${v.issues?.[0] ?? "非 JSON"})`}`
      );
      console.log(`  结尾: ...${r.raw.slice(-70).replace(/\n/g, " ")}`);
    }
  }
}

main();
