/**
 * 流式 + 取消自检（W7·5）。
 *
 * 为什么流式要单独验：它有两个「看起来对但实际错」的失败模式——
 *   ① 事件顺序反了：先吐字再给引用，用户等 5 秒才知道资料找错了；
 *   ② 取消是假的：前端不渲染了，后端还在跑完 260 个 token。
 * 第 ② 种从界面上完全看不出来，只能量时间。
 *
 * 判据：
 *   A. `cites` 必须是第一个事件（且带 citations / route / model）
 *   B. token 拼接结果与 `done.answer` 一致（丢了块就会对不上）
 *   C. 取消后 400 ms 内结束，且拿到 `aborted` 而不是 `error`
 *   D. `done` 的 check.invalid 为空
 *
 * 用法: npm run w7:stream
 */
import { kbDir } from "./kb-dir";
import { askStream, type AskEvent } from "../src/lib/answer";

interface Case {
  q: string;
  /** true = 收到几个 token 后主动取消 */
  cancel?: boolean;
}

const CASES: Case[] = [
  { q: "为什么我练胸的时候脖子会酸？" },
  { q: "我这个月一共练了几次腿" },
  { q: "为什么会练到脖子酸，这个能解释一下吗", cancel: true },
];

interface Result {
  c: Case;
  events: AskEvent[];
  order: string[];
  tokens: string;
  done?: Extract<AskEvent, { type: "done" }>;
  aborted?: boolean;
  /** 从发起请求到生成器结束的毫秒数 */
  wallMs: number;
  /** 从取消到生成器结束的毫秒数 */
  cancelMs: number;
}

async function run(c: Case): Promise<Result> {
  const ac = new AbortController();
  const events: AskEvent[] = [];
  const order: string[] = [];
  let tokens = "";
  let done: Result["done"];
  let aborted = false;
  let cancelledAt = 0;
  let endedAt = 0;
  let tokenCount = 0;

  const t0 = Date.now();
  for await (const ev of askStream(c.q, { signal: ac.signal })) {
    events.push(ev);
    order.push(ev.type);
    if (ev.type === "token") {
      tokens += ev.text;
      tokenCount++;
      // 收到第 3 个 token 就取消：模拟用户看了半句觉得不对
      if (c.cancel && tokenCount === 3) {
        cancelledAt = Date.now();
        ac.abort();
      }
    }
    if (ev.type === "done") done = ev;
    if (ev.type === "aborted") aborted = true;
    if (ev.type === "done" || ev.type === "error" || ev.type === "aborted") {
      endedAt = Date.now();
      break;
    }
  }

  return {
    c,
    events,
    order,
    tokens,
    done,
    aborted,
    wallMs: (endedAt || Date.now()) - t0,
    cancelMs: cancelledAt ? (endedAt || Date.now()) - cancelledAt : 0,
  };
}

async function main() {
  kbDir();
  const rows: Result[] = [];
  for (const c of CASES) {
    const r = await run(c);
    rows.push(r);
    console.log(`\n【${c.q}】${c.cancel ? "（中途取消）" : ""}`);
    console.log(`  事件序 ${r.order.slice(0, 6).join(" → ")}${r.order.length > 6 ? ` … ${r.order.at(-1)}` : ""}`);
    console.log(`  引用 ${r.events[0]?.type === "cites" ? r.events[0].citations.length : "—"} 条　token ${r.order.filter((t) => t === "token").length} 个`);
    console.log(`  作答 ${JSON.stringify((r.done?.answer ?? r.tokens).slice(0, 80))}`);
    console.log(
      c.cancel
        ? `  取消 → ${r.aborted ? "aborted" : "没收到 aborted"}　${r.cancelMs}ms 内结束`
        : `  总耗时 ${r.wallMs}ms`
    );
  }

  // ——— 判据 ———
  console.log(`\n${"=".repeat(74)}\n判据`);
  const A = rows.filter((r) => r.order[0] === "cites" && r.events[0]?.type === "cites" &&
    r.events[0].citations !== undefined && !!r.events[0].model).length;
  const finished = rows.filter((r) => !!r.done);
  const B = finished.filter((r) => r.done!.answer === r.tokens.trim()).length;
  const cancelRows = rows.filter((r) => r.c.cancel);
  const C = cancelRows.filter((r) => r.aborted && r.cancelMs < 400).length;
  const D = finished.filter((r) => r.done!.check.invalid.length === 0).length;

  console.log(`A cites 是第一个事件且字段完整   ${A}/${rows.length}`);
  console.log(`B token 拼接 == done.answer      ${B}/${finished.length}（取消的用例没有 done，不计入）`);
  console.log(`C 取消后 400ms 内 aborted 收尾    ${C}/${cancelRows.length}`);
  console.log(`D done 里没有越界引用            ${D}/${finished.length}`);

  const pass = A === rows.length && B === finished.length && C === cancelRows.length && D === finished.length;
  console.log(`\n${pass ? "✓ 流式与取消可用" : "✗ 有判据未过"}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
