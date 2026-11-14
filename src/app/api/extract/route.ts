import { NextRequest, NextResponse } from "next/server";
import {
  OLLAMA_MODEL,
  OLLAMA_URL,
  TIMEOUT_MS,
  NUM_PREDICT,
  buildPrompt,
  validateRaw,
} from "@/lib/extract";

/**
 * POST /api/extract  —— W2：自然语言/训练记录文本 → 结构化 JSON（Zod 校验）
 *
 * 入参: { text: string }
 * 出参: 合规   → { ok: true,  data: TrainingRecord }
 *       不合规 → { ok: false, raw: string, issues?: string[] }   ← 永不 500
 *
 * prompt 与校验口径在 @/lib/extract，和 scripts/compliance.ts 共用一份。
 * 模型走本机 Ollama（qwen2.5:7b-instruct，JSON mode）。
 */

export async function POST(req: NextRequest) {
  let text: string;
  try {
    const body = await req.json();
    text = typeof body?.text === "string" ? body.text : "";
  } catch {
    return NextResponse.json({ ok: false, raw: "请求体不是合法 JSON" }, { status: 200 });
  }

  if (!text.trim()) {
    return NextResponse.json({ ok: false, raw: "text 为空" }, { status: 200 });
  }

  let raw: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildPrompt(text),
        stream: false,
        format: "json", // Ollama JSON mode，保合规的第一道闸
        options: { temperature: 0, num_predict: NUM_PREDICT },
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { ok: false, raw: `Ollama 返回 ${res.status}：${detail.slice(0, 200)}` },
        { status: 200 }
      );
    }
    const json = await res.json();
    raw = typeof json?.response === "string" ? json.response : JSON.stringify(json?.response ?? "");
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "模型推理超时" : "无法连接本机 Ollama";
    return NextResponse.json({ ok: false, raw: msg }, { status: 200 });
  }

  // 第二道闸：Zod 校验（JSON mode 也可能字段跑偏）
  return NextResponse.json(validateRaw(raw));
}
