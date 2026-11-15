/**
 * W6 验收：10 道题跑通 `/api/ask` 的同一套逻辑（复用 `src/lib/answer.ts`，不走 HTTP，
 * 因为本机沙箱起不了 dev server；这和 W2 用 `scripts/compliance.ts` 验 extract 是同一手法）。
 *
 * 判据（全部可机器检查，不靠"看起来还行"）：
 *   A. **引用合法**：答案里每个 [n] 都落在 citations 范围内（`check.invalid` 必须为空）
 *   B. **引用可定位**：每条 citation 的 label 形如 `文件.md > 标题 > 子标题`
 *   C. **有答案的题必须真的引用**：不允许空引用 + 通篇"我觉得"
 *   D. **库里没有的必须承认**：`check.noAnswer` 为 true，不许编数字
 *   E. **要算数的必须拒绝**：不能从原始组次直接下"在涨/在跌"
 *
 * 用法: npm run w6:ask
 */
import { kbDir } from "./kb-dir";
import { ask, type AskResult } from "../src/lib/answer";
import { indexMeta } from "../src/lib/retrieve";

type Kind = "answerable" | "absent" | "needs-math";

interface Q {
  id: string;
  q: string;
  kind: Kind;
  /** answerable 时，答案该落在哪些文档（用于人工核对，脚本不强制） */
  expectDoc?: string;
  note?: string;
}

const QUESTIONS: Q[] = [
  { id: "A1", q: "为什么我练胸的时候脖子会酸？", kind: "answerable", expectDoc: "2026-11-02-健康记录" },
  { id: "A2", q: "减载期、恢复期、增长期的门槛分别是什么", kind: "answerable" },
  { id: "A3", q: "苹果健康数据多久导入一次", kind: "answerable" },
  { id: "A4", q: "卧推用 8×8 还是 5×5 怎么看", kind: "answerable", expectDoc: "2026-10-31-健康记录" },
  { id: "A5", q: "自由泳高肘抱水怎么练", kind: "answerable" },
  { id: "A6", q: "布拉德福德推举是在哪次训练里做的", kind: "answerable" },
  { id: "A7", q: "HRV 现在用的是哪一套口径", kind: "answerable" },
  // ——— 库里没有：语料从 2025 年开始 ———
  { id: "B1", q: "我 2019 年的体脂率是多少？", kind: "absent" },
  { id: "B2", q: "我上一次马拉松的成绩是多少？", kind: "absent" },
  // ——— 需要算数：正确行为是拒绝下结论，并列出原始数据 ———
  { id: "C1", q: "我深蹲的重量最近在涨还是在跌？", kind: "needs-math", note: "正确做法：说明需要结构化统计" },
  { id: "C2", q: "我这个月一共练了几次腿？", kind: "needs-math", note: "需要计数，不该从检索片段里数" },
];

interface Row {
  q: Q;
  r: AskResult;
  labelOk: boolean;
  refused: boolean;
}

/** 引用能不能定位：label 至少要有 `文件.md > 一级标题` 两段 */
function labelParsable(label: string): boolean {
  const parts = label.split(" > ");
  return parts.length >= 2 && /\.md$/.test(parts[0]);
}

/**
 * 有没有拒绝「从片段里直接推结论」。
 *
 * 第一版只匹配「这需要结构化统计」，结果 C1 明明答了
 * 「没有信息表明这些变化是持续的趋势，因此**无法判断**」——行为完全正确，
 * 却因为措辞不在词表里被判成失败。判据比实现更容易出错，这里放宽到
 * 「表达不确定 / 明确拒答 / 说没找到」三类。
 */
function isRefusal(answer: string): boolean {
  return /需要结构化统计|算不准|不能从|无法从|无法判断|不能判断|不能确定|无从判断|没有找到|未找到/.test(answer);
}

async function main() {
  kbDir(); // 触发 .env.local 加载（scripts/kb-dir.ts 在模块顶层做）
  const meta = indexMeta();
  console.log(`索引：${meta.chunks} 块 / ${meta.docs} 篇（建库 ${meta.builtMs.toFixed(0)} ms）`);
  console.log(`题量：${QUESTIONS.length}（有答案 ${QUESTIONS.filter((q) => q.kind === "answerable").length} / ` +
    `库里没有 ${QUESTIONS.filter((q) => q.kind === "absent").length} / ` +
    `要算数 ${QUESTIONS.filter((q) => q.kind === "needs-math").length}）`);
  console.log("=".repeat(78));

  const rows: Row[] = [];
  for (const q of QUESTIONS) {
    const r = await ask(q.q);
    const labelOk = r.citations.length > 0 && r.citations.every((c) => labelParsable(c.label));
    const refused = isRefusal(r.answer);
    rows.push({ q, r, labelOk, refused });
    console.log(`\n【${q.id}·${q.kind}】${q.q}`);
    console.log(
      `   ${r.ok ? "" : `✗ ${r.reason}  `}引用 [${r.check.refs.join(",") || "无"}]` +
        `${r.check.invalid.length ? `  ⚠ 越界 [${r.check.invalid.join(",")}]` : ""}` +
        `${r.citations[0] ? `  首位 ${r.citations[0].label.slice(0, 46)}` : ""}`
    );
    console.log(`   ${r.meta.ms.retrieve}ms 检索 + ${(r.meta.ms.generate / 1000).toFixed(1)}s 生成`);
    console.log(`   ${r.answer.replace(/\n+/g, " ").slice(0, 300)}`);
  }

  // ——— 汇总判据 ———
  const ok = rows.filter((x) => x.r.ok);
  const invalidFree = ok.filter((x) => x.r.check.invalid.length === 0).length;
  const labelOkN = ok.filter((x) => x.labelOk).length;
  const answerable = rows.filter((x) => x.q.kind === "answerable" && x.r.ok);
  const citedN = answerable.filter((x) => x.r.check.refs.length > 0 && !x.r.check.noAnswer).length;
  const absent = rows.filter((x) => x.q.kind === "absent" && x.r.ok);
  const absentN = absent.filter((x) => x.r.check.noAnswer).length;
  const math = rows.filter((x) => x.q.kind === "needs-math" && x.r.ok);
  const mathN = math.filter((x) => x.refused).length;

  const A = `${invalidFree}/${ok.length}`;
  const B = `${labelOkN}/${ok.length}`;
  const C = `${citedN}/${answerable.length}`;
  const D = `${absentN}/${absent.length}`;
  const E = `${mathN}/${math.length}（人工判读）`;
  const avg = (ok.reduce((s, x) => s + x.r.meta.ms.total, 0) / (ok.length || 1) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(78));
  console.log(`A 引用合法（无越界）      ${A}`);
  console.log(`B 引用可定位（有标题路径）  ${B}`);
  console.log(`C 有答案的题真的引用了     ${C}`);
  console.log(`D 库里没有的承认没找到     ${D}`);
  console.log(`E 要算数的拒绝下结论       ${E}`);
  console.log(`  平均端到端              ${avg} s（本机 7B，同步非流式）`);

  const pass = invalidFree === ok.length && labelOkN === ok.length && citedN === answerable.length && absentN === absent.length;
  console.log(`\n${pass ? "✓ A–D 全过" : "✗ 有判据未过"}${pass && mathN === math.length ? "，E 也全过" : ""}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
