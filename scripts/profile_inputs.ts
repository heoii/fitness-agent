/**
 * 只算输入规模，**不跑模型**。样本只有力量训练（口径见 scripts/samples.ts）。
 *
 * 为什么要有这个：11-15 要判断「14 个动作的长记录跑偏」是分块、砍输入还是加反例，
 * 判断依据是「输入多长 → 输出要多长 → 离 2000 上限还有多少」，这三件事都是纯算术。
 * 先花 1 秒把 20 篇的规模摊开，再决定要不要花 12 分钟去跑模型验。
 *
 * 用法:
 *   npx tsx scripts/profile_inputs.ts                 # 20 篇
 *   npx tsx scripts/profile_inputs.ts --n 5           # 只看 5 篇
 *   npx tsx scripts/profile_inputs.ts --fail 10-22    # 高亮已知失败的那篇
 *
 * 「喂入字」是 buildPrompt 实际送进模型的长度（已按记录段切过），
 * 和「全文」的差额就是被切掉的复盘/计划段 —— 这一列是 11-15 那次归因的结论所在。
 *
 * 两个估算值都是**粗估**，用途是排序和看量级，不是精确 token 数：
 *   · 输入 token：中文按 1 字 ≈ 1 tok、其余按 0.28 tok/字符（qwen 大致量级）
 *   · 输出 token：沿用 extract.ts 里已实测的标定 —— 9 个动作的 JSON 约 930 tok，
 *     约 100 tok/动作
 */
import { readFileSync } from "node:fs";
import { NUM_PREDICT, trimToRecord } from "../src/lib/extract";
import { kbDir } from "./kb-dir";
import { pickSamples, samplePath } from "./samples";

const args = process.argv.slice(2);
const argOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const N = Number(argOf("--n") ?? 20) || 20;
const FAIL_MARK = argOf("--fail") ?? "";
const DIR = argOf("--dir") ?? kbDir();

/** 记录正文里的正则口径，与 compliance.ts 的 localParse 保持一致 */
function measure(md: string) {
  const [head, ...restParts] = md.split("## 动作明细");
  const rest = restParts.join("## 动作明细");
  // 动作明细段：到下一个二级标题为止（那之后是教练复盘之类的自由文本）
  const cutAt = rest.search(/\n##\s/);
  const detail = cutAt === -1 ? rest : rest.slice(0, cutAt);
  const tail = cutAt === -1 ? "" : rest.slice(cutAt);

  const reSet = /组(\d+)：(?:(\d+(?:\.\d+)?)kg|自重)\s*×\s*(\d+)(?:，休息\s*(\d+)s)?/g;
  let actions = 0;
  let sets = 0;
  for (const block of detail.split(/^### /m).slice(1)) {
    const hits = [...block.matchAll(reSet)];
    if (hits.length > 0) {
      actions++;
      sets += hits.length;
    }
  }

  // 表行数：复盘里的「处方表」长得跟训练记录一模一样，是最容易骗到模型的第二种结构
  const tableRows = (tail.match(/^\|/gm) ?? []).length;
  const suspicious = ["复盘", "处方", "HRV"].filter((k) => tail.includes(k));

  return {
    headChars: (head ?? "").length,
    detailChars: detail.length,
    tailChars: tail.length,
    actions,
    sets,
    tableRows,
    suspicious,
  };
}

/** 粗估输入 token：CJK 1 字 ≈ 1 tok，其余 0.28 tok/字符 */
function estInTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) if (/[\u3400-\u9fff]/.test(ch)) cjk++;
  return Math.round(cjk + (s.length - cjk) * 0.28);
}

function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u3400-\u9fff]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  console.log(headers.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join("  "));
}

function main() {
  const files = pickSamples(DIR, N);
  if (files.length === 0) {
    console.error(`没有找到训练记录：${DIR}`);
    process.exit(1);
  }

  const rows = files.map((file) => {
    const md = readFileSync(samplePath(DIR, file), "utf8");
    const m = measure(md);
    const fed = trimToRecord(md);
    const estOut = 60 + 100 * m.actions;
    return { file, chars: [...md].length, fedChars: [...fed].length, ...m, estIn: estInTokens(fed), estOut };
  });

  console.log(`样本 ${files.length} 篇 · 模型上下文未计入 · 输出预算 ${NUM_PREDICT} tok（extract.ts）\n`);

  const sorted = [...rows].sort((a, b) => b.chars - a.chars);
  printTable(
    ["全文", "喂入", "明细", "其余", "表行", "动作", "组数", "估出tok", "余量", "文件"],
    sorted.map((r) => [
      String(r.chars),
      String(r.fedChars),
      String(r.detailChars),
      r.tailChars > 0 ? String(r.tailChars) : "-",
      r.tableRows > 0 ? String(r.tableRows) : "-",
      String(r.actions),
      String(r.sets),
      String(r.estOut),
      String(NUM_PREDICT - r.estOut),
      (FAIL_MARK && r.file.includes(FAIL_MARK) ? "✗ " : "  ") + r.file,
    ])
  );

  // 规模分档：看这批样本到底有没有「长尾」，还是全挤在一个区间里
  const buckets: [string, (r: (typeof rows)[number]) => boolean][] = [
    ["≤ 800 字", (r) => r.chars <= 800],
    ["801–1200 字", (r) => r.chars > 800 && r.chars <= 1200],
    ["1201–1600 字", (r) => r.chars > 1200 && r.chars <= 1600],
    ["> 1600 字", (r) => r.chars > 1600],
  ];
  console.log("\n──────── 规模分档 ────────");
  for (const [label, test] of buckets) {
    const g = rows.filter(test);
    if (g.length === 0) continue;
    const act = g.map((r) => r.actions).sort((a, b) => a - b);
    const medAct = act.length ? act[Math.floor(act.length / 2)] : "-";
    console.log(
      `${pad(label, 12)} ${pad(`${g.length} 篇`, 5)}` +
        `  动作数中位 ${medAct}  最大 ${act.length ? act[act.length - 1] : "-"}`
    );
  }

  // 危险区：输出估算逼近预算的样本。注意这是「截断风险」，不是「跑偏风险」
  const risky = rows.filter((r) => r.estOut > NUM_PREDICT * 0.75);
  console.log("\n──────── 截断危险区（估出 > 预算 75%）────────");
  if (risky.length === 0) {
    console.log("无：所有样本的预估输出都在预算的 75% 以内，截断解释不了长记录的失败。");
  } else {
    for (const r of risky) console.log(`  ${r.estOut} tok  ${r.file}`);
  }

  // TODO(判断)：这一步只回答「是不是被截断」。如果不是，那「跑偏」就只能在
  // 分块 / 砍输入 / 加反例 三条里选，而选哪条需要人看失败那篇的原始输出。
  console.log("\n结论只到「量级」为止：够不够 2000 tok 是算术，跑不跑偏是模型行为，得另有证据。");
}

main();
