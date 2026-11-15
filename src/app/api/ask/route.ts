import { NextRequest, NextResponse } from "next/server";
import { ask, ASK_K } from "@/lib/answer";
import { indexMeta } from "@/lib/retrieve";

/**
 * POST /api/ask —— W6：检索增强问答（同步版）
 *
 * 入参: { q: string, k?: number }
 * 出参: 成功   → { ok: true, answer, citations[], check, meta }
 *       失败   → { ok: false, reason, citations[], meta }   ← 永不 500
 *
 * 为什么先做同步、不做流式：流式解决的是「等得难不难受」，不解决「答得对不对」。
 * 而这一层的验收判据是三个可机器检查的东西——
 *   ① answer 里的每个 [n] 都能在 citations 里找到（`check.invalid` 必须为空）
 *   ② citations 的 label 能定位到 `文件 > 标题路径`（前端角标点得开）
 *   ③ 问库里没有的东西时 `check.noAnswer` 为 true，不许编
 * 这三条在同步接口上就能全验完。流式是下一步的事。
 *
 * GET /api/ask 返回索引状态，方便确认「服务起来时用的是哪份语料」。
 */

export async function GET() {
  try {
    const m = indexMeta();
    // 只回规模与耗时，**不回 dir** —— 那个字段是 `01 每日记录` 的绝对路径，
    // 里面带本机用户名和坚果云邮箱。本地跑无所谓，但这一层迟早要部署出去。
    return NextResponse.json({
      ok: true,
      index: { chunks: m.chunks, docs: m.docs, builtMs: Number(m.builtMs.toFixed(0)), builtAt: m.builtAt },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : "索引不可用" },
      { status: 200 }
    );
  }
}

export async function POST(req: NextRequest) {
  let q = "";
  let k = ASK_K;
  try {
    const body = await req.json();
    q = typeof body?.q === "string" ? body.q : "";
    if (typeof body?.k === "number" && body.k >= 1 && body.k <= 10) k = Math.floor(body.k);
  } catch {
    return NextResponse.json({ ok: false, reason: "请求体不是合法 JSON" }, { status: 200 });
  }

  if (!q.trim()) {
    return NextResponse.json({ ok: false, reason: "q 为空" }, { status: 200 });
  }

  const result = await ask(q.trim(), { k });
  return NextResponse.json(result);
}

/** 问答是同步阻塞的（本机 7B 约 5–10 s），给足超时 */
export const maxDuration = 120;
