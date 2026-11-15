/**
 * 问答的**唯一一份** prompt 与引用校验（W6）。
 *
 * 和 `extract.ts` 同一个原则：route（HTTP）与脚本（评测）都从这里取，
 * 不许各写一份 prompt —— 否则「线上答得烂、脚本跑得好」这种漂移永远查不出来。
 *
 * 这份 prompt 里的第 4 条是拿实测换来的，不是凭直觉写的：
 * 让模型「自己从组次里判断涨跌」时，它会把健康记录里的 1RM 82kg 当成
 * 「最近一次深蹲重量」，跟 60kg 一比，得出「在涨」——而真实数据是持平或微跌。
 * 所以干脆禁止它算：算数走结构化入口（W7 的工具层），它只负责把数字说成人话。
 */
import { retrieve, type Hit } from "./retrieve";
import { OLLAMA_MODEL, OLLAMA_URL } from "./extract";

export const ASK_NUM_PREDICT = 260;
export const ASK_TIMEOUT_MS = 90_000;
/** 检索几条。5 条是 prompt 长度与召回的经验平衡点，别随手加，token 会线性涨。 */
export const ASK_K = 5;

export interface CitationCheck {
  /** 答案里出现的所有引用编号（去重、按出现顺序） */
  refs: number[];
  /** 越界引用：答案引了 [7] 但只给了 5 条资料 —— 这是编造引用，必须报出来 */
  invalid: number[];
  /** 给了但没被用到的条目 */
  unused: number[];
  /** 模型自己判定「资料里没有」 */
  noAnswer: boolean;
}

export interface Citation {
  n: number;
  doc: string;
  date: string;
  label: string;
  headingPath: string[];
  snippet: string;
  score: number;
}

export interface AskResult {
  ok: boolean;
  answer: string;
  citations: Citation[];
  check: CitationCheck;
  /** 出错时的原因，ok=false 才有 */
  reason?: string;
  meta: {
    model: string;
    ms: { retrieve: number; generate: number; total: number };
    k: number;
  };
}

export function buildAskPrompt(hits: Hit[], question: string): string {
  const ctx = hits
    .map((h) => `[${h.n}] ${h.label}\n${h.text}`)
    .join("\n\n");
  return `你是个人健身与健康记录的问答助手。严格按顺序遵守下面的规则：

1. 只依据「资料」回答，不许用你自己知道的知识补充。
2. 每条结论后面标出处，格式 [1]、[2]，编号对应资料段落。
3. 资料里没有足够信息时，只回答「资料里没有找到相关内容」，不要猜测、不要编造数字。
4. 资料里的组次和重量按原样引用，**不要自己推算总和、平均或趋势**。
   只有当问题本身就在问「涨了还是跌了」「一共几次」「平均多少」这类需要统计的东西时，
   才回答「这需要结构化统计，我从检索到的组次片段里算不准」，并列出相关的原始数据。
   **其他问题不要附加这句话** —— 把它挂到每个回答后面会变成噪声。
5. 用中文回答，不超过 200 字。

资料：
${ctx}

问题：${question}`;
}

export function checkAnswer(answer: string, k: number): CitationCheck {
  const refs: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (!refs.includes(n)) refs.push(n);
  }
  const all = Array.from({ length: k }, (_, i) => i + 1);
  return {
    refs,
    invalid: refs.filter((n) => n < 1 || n > k),
    unused: all.filter((n) => !refs.includes(n)),
    noAnswer: /没有找到|没找到|无相关|资料中没有/.test(answer),
  };
}

function toCitation(h: Hit, snippetChars = 180): Citation {
  return {
    n: h.n,
    doc: h.doc,
    date: h.date,
    label: h.label,
    headingPath: h.headingPath,
    snippet: h.text.slice(0, snippetChars),
    score: Number(h.score.toFixed(2)),
  };
}

/**
 * 一次完整的问答：检索 → 组装 → 生成 → 校验。
 * 不抛异常，失败也返回结构化结果（和 /api/extract 的「永不 500」保持一致）。
 */
export async function ask(question: string, opts: { k?: number } = {}): Promise<AskResult> {
  const k = opts.k ?? ASK_K;
  const t0 = Date.now();

  let hits: Hit[];
  const tR = Date.now();
  try {
    hits = retrieve(question, { k });
  } catch (e) {
    return {
      ok: false,
      answer: "",
      citations: [],
      check: { refs: [], invalid: [], unused: [], noAnswer: false },
      reason: e instanceof Error ? e.message : "检索失败",
      meta: { model: OLLAMA_MODEL, ms: { retrieve: 0, generate: 0, total: Date.now() - t0 }, k },
    };
  }
  const retrieveMs = Date.now() - tR;

  if (!hits.length) {
    return {
      ok: true,
      answer: "资料里没有找到相关内容。",
      citations: [],
      check: { refs: [], invalid: [], unused: [], noAnswer: true },
      meta: { model: OLLAMA_MODEL, ms: { retrieve: retrieveMs, generate: 0, total: Date.now() - t0 }, k },
    };
  }

  const tG = Date.now();
  let answer: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildAskPrompt(hits, question),
        stream: false,
        options: { temperature: 0, num_predict: ASK_NUM_PREDICT },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Ollama 返回 ${res.status}`);
    const json = (await res.json()) as { response?: string };
    answer = (json.response ?? "").trim();
    if (!answer) throw new Error("模型返回空");
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError" ? "模型推理超时" : e instanceof Error ? e.message : "生成失败";
    return {
      ok: false,
      answer: "",
      citations: hits.map((h) => toCitation(h)),
      check: { refs: [], invalid: [], unused: hits.map((h) => h.n), noAnswer: false },
      reason: msg,
      meta: { model: OLLAMA_MODEL, ms: { retrieve: retrieveMs, generate: Date.now() - tG, total: Date.now() - t0 }, k },
    };
  }
  const generateMs = Date.now() - tG;

  return {
    ok: true,
    answer,
    citations: hits.map((h) => toCitation(h)),
    check: checkAnswer(answer, hits.length),
    meta: { model: OLLAMA_MODEL, ms: { retrieve: retrieveMs, generate: generateMs, total: Date.now() - t0 }, k },
  };
}
