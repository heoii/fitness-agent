import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth";
import { triggerPublish, updateAwakeOnly } from "@/lib/kb-writer";

/**
 * POST /api/save-awake —— 只补清醒时长，算睡眠效率（2026-11-19）
 *
 * 入参: { date: "YYYY-MM-DD", awakeMin: 25 }
 * 出参: { ok, kb:{ok,path,reason,efficiencyPct}, publish:{started,...}, reason }
 *
 * 与 /api/save-checkin 的区别：不重算判档、不重写判档块、不创建新记录。
 * 用于「今早填了清醒但没写进去」「想单独改清醒时长」这类补录。
 */
export async function POST(req: NextRequest) {
  const denied = authGuard(req);
  if (denied) return denied;

  let body: { date?: string; awakeMin?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "请求体不是合法 JSON" }, { status: 200 });
  }

  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, reason: "date 必须是 YYYY-MM-DD" }, { status: 200 });
  }
  const awakeMin = Number(body.awakeMin);
  if (!Number.isFinite(awakeMin) || awakeMin < 0 || awakeMin > 600) {
    return NextResponse.json({ ok: false, reason: "清醒时长要在 0–600 分钟之间" }, { status: 200 });
  }

  try {
    const kb = await updateAwakeOnly(date, awakeMin);
    const publish = kb.ok
      ? triggerPublish()
      : { started: false, reason: "知识库没写成功，先不推" };
    return NextResponse.json({ ok: kb.ok, kb, publish, reason: kb.ok ? "" : kb.reason });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : "写入失败" },
      { status: 200 }
    );
  }
}

export const maxDuration = 60;
