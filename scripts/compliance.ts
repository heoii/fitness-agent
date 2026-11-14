/**
 * W2 判据：跑 20 次真模型调用，统计结构化输出合规次数（≥18 算过）
 *
 * 用法:
 *   npx tsx scripts/compliance.ts                 # 默认 20 篇、按日期降序
 *   npx tsx scripts/compliance.ts --n 5           # 冒烟用
 *
 * 为什么直接打 Ollama 而不是打 /api/extract：
 *   本机沙箱不允许 next dev 写 ~/Library/Preferences，HTTP 层跑不起来。
 *   但「合规」的变量是**模型输出**，不是那条 route —— prompt 与 Zod 校验
 *   都取自 @/lib/extract（route 用的同一份），所以测的是同一件事。
 *   HTTP 层要等 dev server 能起的时候补一次（记在 NEXT 待办里）。
 *
 * 判「合规」两道：
 *   A. 语法层：opts.format="json" 下 JSON.parse 成功 + Zod 通过
 *   B. 字段层：返回的 date / session / 动作数 与文件 frontmatter+正文正则解析一致
 *      —— 只过 A 不过 B 说明「JSON 合法但内容错」，这比语法错更危险
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OLLAMA_MODEL, OLLAMA_URL, TIMEOUT_MS, NUM_PREDICT, buildPrompt, validateRaw } from "../src/lib/extract";
import { kbDir } from "./kb-dir";

const args = process.argv.slice(2);
const N = Number(args[args.indexOf("--n") + 1] || 20) || 20;
const DIR = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : kbDir();

/** 本地正则解析（口径同 scripts/extract.ts），作为字段层对照 */
function localParse(md: string) {
  const fm = (key: string) =>
    md.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim();
  const body = md.split("## 动作明细")[1] ?? "";
  const reSet = /组(\d+)：(?:(\d+(?:\.\d+)?)kg|自重)\s*×\s*(\d+)(?:，休息\s*(\d+)s)?/g;
  let actions = 0;
  for (const block of body.split(/^### /m).slice(1)) {
    if ([...block.matchAll(reSet)].length > 0) actions++;
  }
  return {
    date: fm("date") ?? "",
    session: fm("session") ?? "",
    record_type: fm("record_type") === "cardio" ? "cardio" : "strength",
    actions,
  };
}

type Row = {
  idx: number;
  file: string;
  ok: boolean;
  ms: number;
  reason: string;
  fieldsOk: boolean;
  fieldNote: string;
};

async function callModel(text: string): Promise<{ raw: string; err?: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildPrompt(text),
        stream: false,
        format: "json",
        options: { temperature: 0, num_predict: NUM_PREDICT },
      }),
    });
    if (!res.ok) return { raw: "", err: `Ollama ${res.status}` };
    const json: any = await res.json();
    const raw = typeof json?.response === "string" ? json.response : JSON.stringify(json?.response ?? "");
    return { raw };
  } catch (e) {
    return { raw: "", err: e instanceof Error ? e.message : "请求异常" };
  }
}

async function runOne(idx: number, file: string): Promise<Row> {
  const md = readFileSync(file, "utf8");
  const expect = localParse(md);
  const t0 = Date.now();
  const { raw, err } = await callModel(md);
  const ms = Date.now() - t0;

  if (err) {
    return { idx, file: file.split("/").pop() ?? file, ok: false, ms, reason: err.slice(0, 60), fieldsOk: false, fieldNote: "" };
  }

  const result = validateRaw(raw);
  if (!result.ok) {
    return {
      idx,
      file: file.split("/").pop() ?? file,
      ok: false,
      ms,
      reason: String(result.issues?.[0] ?? "JSON 解析失败").slice(0, 60),
      fieldsOk: false,
      fieldNote: "",
    };
  }

  const d: any = result.data;
  const diffs: string[] = [];
  if (d.date !== expect.date) diffs.push(`date ${d.date}≠${expect.date}`);
  if (d.session !== expect.session) diffs.push(`session ${d.session}≠${expect.session}`);
  const gotActions = Array.isArray(d.exercises) ? d.exercises.length : 0;
  if (expect.record_type === "strength" && gotActions !== expect.actions)
    diffs.push(`动作 ${gotActions}≠${expect.actions}`);

  return {
    idx,
    file: file.split("/").pop() ?? file,
    ok: true,
    ms,
    reason: "",
    fieldsOk: diffs.length === 0,
    fieldNote: diffs.join(" / "),
  };
}

async function main() {
  const files = readdirSync(DIR)
    .filter((f) => f.includes("-训练-") && f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, N);

  if (files.length === 0) {
    console.error(`没有找到训练记录：${DIR}`);
    process.exit(1);
  }

  console.log(`样本 ${files.length} 篇 · 模型 ${OLLAMA_MODEL} · ${OLLAMA_URL}\n`);
  const rows: Row[] = [];
  for (let i = 0; i < files.length; i++) {
    const row = await runOne(i + 1, join(DIR, files[i]));
    rows.push(row);
    const mark = row.ok ? (row.fieldsOk ? "OK  " : "WARN") : "FAIL";
    console.log(
      `${mark} ${String(row.idx).padStart(2)}/${files.length}  ${(row.ms / 1000).toFixed(1).padStart(5)}s  ${row.file}` +
        (row.ok ? (row.fieldsOk ? "" : `  <- 字段: ${row.fieldNote}`) : `  <- ${row.reason}`)
    );
  }

  const okN = rows.filter((r) => r.ok).length;
  const fieldN = rows.filter((r) => r.ok && r.fieldsOk).length;
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const tokPerSec = "";
  const fails = rows.filter((r) => !r.ok || !r.fieldsOk);

  console.log("\n──────── 统计 ────────");
  const need = Math.ceil(rows.length * 0.9); // W2 判据原为 20 次里的 18 次（90%）
  console.log(`语法合规（JSON+Zod）   ${okN}/${rows.length}${okN >= need ? "  PASS" : "  FAIL"}`);
  console.log(`字段一致（内容对得上） ${fieldN}/${rows.length}`);
  console.log(`中位耗时              ${(med / 1000).toFixed(1)}s${tokPerSec}`);
  if (fails.length) {
    console.log(`\n失败/不符 ${fails.length} 条：`);
    for (const f of fails) {
      console.log(`  - ${f.file}${f.ok ? `  字段不符: ${f.fieldNote}` : `  ${f.reason}`}`);
    }
  }
}

main();
