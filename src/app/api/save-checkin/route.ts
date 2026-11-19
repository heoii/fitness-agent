import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth";
import { triggerPublish, writeCheckinRecord, type Verdict } from "@/lib/kb-writer";

/**
 * POST /api/save-checkin —— 第一个确认：把录入的判档数据写进当天健康记录（2026-11-17）
 *
 * 入参: { date, checkin:{sleep_hours,deep_sleep_min,sleep_awake_min,resting_hr,fatigue,soreness,weight_kg,body_fat_pct},
 *         verdict:{judge,status,red,yellow,dimensions,dims[]}, tiers:[{tier,totalSets}] }
 *         —— sleep_awake_min（清醒时长）只用于算睡眠效率，不进判档维度计数
 * 出参: { ok, kb:{ok,path,reason}, publish:{started,log,reason} }  ← 永不 500
 *
 * 与 /api/save-plan 的分工（用户 2026-11-17 明确）：
 *   - 这个端点：**录完就立即写**，与练练无关。练练写不写、写失败，都不影响这次录入。
 *   - save-plan：只负责把某一档排进练练日历，不再重复写判档（只补一行执行结果）。
 */
export async function POST(req: NextRequest) {
  const denied = authGuard(req);
  if (denied) return denied;

  let body: {
    date?: string;
    checkin?: Record<string, unknown>;
    verdict?: Verdict;
    tiers?: { tier: string; totalSets: number }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "请求体不是合法 JSON" }, { status: 200 });
  }

  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, reason: "date 必须是 YYYY-MM-DD" }, { status: 200 });
  }
  const checkin = body.checkin && typeof body.checkin === "object" ? body.checkin : {};
  const dims = ["sleep_hours", "deep_sleep_min", "resting_hr", "fatigue", "soreness"].filter(
    (k) => checkin[k] !== undefined && checkin[k] !== null && checkin[k] !== ""
  );
  if (dims.length < 2) {
    return NextResponse.json({ ok: false, reason: "至少填两个判档维度才录入" }, { status: 200 });
  }

  try {
    const kb = await writeCheckinRecord({
      date,
      checkin,
      verdict: body.verdict,
      tiers: body.tiers,
      chosenTier: body.verdict?.judge,
    });
    // 录入即推云：首页的「判档」当天就要变（用户 2026-11-17 定为「立即推」）
    const publish = kb.ok ? triggerPublish() : { started: false, reason: "知识库没写成功，先不推" };
    return NextResponse.json({ ok: kb.ok, kb, publish, reason: kb.ok ? "" : kb.reason });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : "写入失败" },
      { status: 200 }
    );
  }
}

export const maxDuration = 60;
