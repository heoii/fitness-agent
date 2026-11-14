import { TrainingRecordSchema, type TrainingRecord } from "../types/training";

/**
 * 结构化抽取的**唯一** prompt 与校验口径。
 *
 * route.ts（HTTP）与 scripts/compliance.ts（20 次合规统计）都从这里取，
 * 不许各写一份 —— 见 SKILL.md 第十一节第 5 条「两套口径互相矛盾」。
 */

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
export const TIMEOUT_MS = 120_000;

/**
 * 输出 token 预算。**不要再调回 900。**
 * 2026-11-14 的 20 次合规统计：900 时 2/20 被截断（done_reason=length，输出正好 900 tok），
 * 放到 2000 后同样两条 930 / 1155 tok 正常收尾（done_reason=stop）。
 * 9 个动作的记录 JSON 就要 900+ tok，游泳这类 cardio 只要 60 tok —— 按最坏情况给预算，
 * 代价只是截断概率归零，不会让短记录变慢（模型 stop 就停，不跑满）。
 */
export const NUM_PREDICT = 2000;

export const SYSTEM_PROMPT = `你是健身训练记录的结构化抽取器。从用户给的文本中抽取训练记录，只输出一个 JSON 对象，不要输出任何其他文字。

JSON 结构（字段口径固定，不得新增/改名）：
{
  "date": "YYYY-MM-DD",
  "session": "训练名称，如 腿A / 游泳",
  "record_type": "strength 或 cardio",
  "duration_min": 数字分钟(可省),
  "calorie": 数字千卡(可省),
  "distance_km": 数字公里(仅 cardio, 可省),
  "exercises": [
    {
      "name": "动作名",
      "sets": [ { "weight": 数字kg或null, "reps": 整数, "rest_s": 休息秒数(可省) } ],
      "volume": 容量数字(可省)
    }
  ]
}

规则：
1. "组3：60kg × 7，休息 150s" → { "weight": 60, "reps": 7, "rest_s": 150 }
2. "组1：自重 × 40" → { "weight": null, "reps": 40 }（自重一律 null，不许写 0）
3. record_type 判定：有动作和组数 → "strength"；游泳/跑步等有氧 → "cardio"，此时 exercises 为空数组
4. 文本没给的字段直接省略，不要编造，不要用 0 顶替
5. 只输出 JSON 本身

session 怎么取（必填，不许省）：
- 优先取文件头部 frontmatter 的 session 字段原值，如 "腿A（股四主导）+腹"
- 没有 frontmatter 就取一级标题「# YYYY-MM-DD 训练 · XXX」里的 XXX
- 正文里的计划说明、教练备注、恢复性训练这类文字**不是** session 名，不要拿它当 session

不许新增上面结构里没有的字段（不是 "notes"、不是 "summary"、不是 "muscle_groups"）。
字段名一个字都不许改。`;

export function buildPrompt(text: string): string {
  return `${SYSTEM_PROMPT}\n\n用户文本：\n${text.slice(0, 6000)}`;
}

export type ExtractResult =
  | { ok: true; data: TrainingRecord }
  | { ok: false; raw: string; issues?: string[] };

/** 第二道闸：JSON 解析 + Zod 校验。永不抛异常。 */
export function validateRaw(raw: string): ExtractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, raw };
  }

  const result = TrainingRecordSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      raw,
      issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: result.data };
}
