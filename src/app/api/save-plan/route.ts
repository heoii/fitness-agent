import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth";
import { saveScheduledWorkout } from "@/lib/keepstrong";
import { triggerPublish, updateSavedLine, type Verdict } from "@/lib/kb-writer";

/**
 * POST /api/save-plan —— 把「用户在小程序里选中的那一档」写进练练日历（2026-11-17）
 *
 * 入参: { date: "2026-11-17", tier: "降级档", actions: [{name,sets,reps,weight,rest}] }
 * 出参: { ok, saved, skipped[], dayStr, reason? }  ← 永不 500，失败带 reason
 *
 * 为什么放在这里：练练的 API Key 只在本机（env 或 mcp.json），小程序与云函数都拿不到。
 * 小程序点「确认写入」→ 云函数 → 隧道 → 这里 → 练练。
 *
 * 纪律：动作逐个按名字搜 actionId，匹配不到就跳过并回报，**不臆造 ID**。
 * userConfirmed 固定 true：能走到这里，说明用户已经在界面上见过完整表格并点过确认。
 */
export async function POST(req: NextRequest) {
  const denied = authGuard(req);
  if (denied) return denied;

  let body: {
    date?: string;
    tier?: string;
    dryRun?: boolean;
    // 判档录入页带的原始输入与结论（2026-11-17）。只有带了 checkin 才写知识库，
    // 历史页那条老入口不带，行为保持原样。
    checkin?: Record<string, unknown>;
    verdict?: Verdict;
    tiers?: { tier: string; totalSets: number }[];
    actions?: {
      name?: string;
      sets?: number;
      reps?: string;
      weight?: string;
      rest?: string;
      warmups?: { weight?: string; reps?: string }[];
    }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "请求体不是合法 JSON" }, { status: 200 });
  }

  const date = String(body.date || "");
  const tier = String(body.tier || "");
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (!date || !raw.length) {
    return NextResponse.json({ ok: false, reason: "缺 date 或 actions" }, { status: 200 });
  }

  const actions = raw
    .filter((a) => a && a.name)
    .map((a) => ({
      name: String(a.name),
      sets: Number(a.sets) || 1,
      reps: String(a.reps ?? "8"),
      weight: String(a.weight ?? ""),
      rest: String(a.rest ?? ""),
      warmups: Array.isArray(a.warmups)
        ? a.warmups
            .filter((w) => w && w.weight != null && String(w.weight) !== "")
            .map((w) => ({ weight: String(w.weight), reps: String(w.reps ?? "8") }))
        : [],
    }));

  // 标题：日期 + 档位，练练里一眼知道是哪次排的（≤15 字，留余量）
  const title = (tier ? tier : "训练").slice(0, 12);

  try {
    const r = await saveScheduledWorkout(date, title, actions, !!body.dryRun);
    if (!r.ok || body.dryRun) return NextResponse.json(r);

    // 判档的写入在「确认录入」那一步已经做完了（/api/save-checkin）。
    // 这里只补一行执行结果——不重复写判档块，也不碰 frontmatter。
    const note = await updateSavedLine(date, {
      tier: tier || "训练",
      saved: r.saved,
      dayStr: r.dayStr,
      skipped: r.skipped,
    });
    // 行里多了这一条也要让云端的 markdown 快照跟上，否则首页那份还是旧的
    const publish = note.ok ? triggerPublish() : { started: false };

    return NextResponse.json({ ...r, kb: note, publish });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      saved: 0,
      skipped: [],
      dayStr: date.replace(/-/g, ""),
      reason: e instanceof Error ? e.message : "写入失败",
    });
  }
}

export const maxDuration = 60;
