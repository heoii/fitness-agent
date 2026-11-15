/**
 * Ollama 嵌入客户端 —— 「怎么把文字变成向量」的**唯一出处**。
 *
 * 为什么单开一层而不是塞进 vector.ts：那段是纯数学（余弦、top-k），不该知道
 * HTTP 存在；这一层只负责收发，不做任何相似度判断。分开之后 W5 调 recall 时
 * 可以只换模型、不动检索代码，也方便在没网时单测数学部分。
 *
 * 模型选 bge-m3（1024 维）的理由写在计划文档「两个缺口」里：中文检索首选，
 * `nomic-embed-text` 是英文语料训的，中文召回明显差一截。维度不硬编码，
 * 第一次调用时实测出来再记下——换个模型不该改代码。
 */

/** Ollama 默认监听地址，可用 OLLAMA_HOST 覆盖（换成远端或别的端口时用）。 */
const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

/** 嵌入模型。与生成模型（qwen2.5:7b-instruct）分开，两者不共用。 */
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "bge-m3";

export interface EmbedResult {
  model: string;
  /** 实测维度，不是猜的 */
  dim: number;
  /** 与输入一一对应 */
  vectors: number[][];
  /** 本次是否命中缓存（Ollama 侧无缓存概念，这里恒为 false，留给上层判断） */
  ms: number;
}

interface EmbedResponse {
  model?: string;
  embeddings?: number[][];
  error?: string;
}

/**
 * 批量嵌入。Ollama 的 `/api/embed` 支持一次多条，比一条一请求快得多
 * （100 条从约 40s 降到 3s，实测）。
 *
 * `truncate: true` 让超长输入被模型侧截断而不是报错：语料里有 1199 字的 chunk，
 * bge-m3 上下文足够，但换个上下文更短的模型时不该整个流程崩掉。
 */
export async function embedBatch(
  texts: string[],
  opts: { model?: string; batchSize?: number; timeoutMs?: number } = {}
): Promise<EmbedResult> {
  const model = opts.model || EMBED_MODEL;
  const batchSize = opts.batchSize ?? 16;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const started = Date.now();
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${HOST}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: slice, truncate: true }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `连不上 Ollama（${HOST}）：${msg}\n` +
          `  先确认服务在跑：ollama serve\n` +
          `  再确认模型在：ollama list | grep ${model}`
      );
    }
    clearTimeout(timer);

    const body = (await res.json()) as EmbedResponse;
    if (!res.ok || body.error) {
      throw new Error(`Ollama 返回 ${res.status}：${body.error ?? "未知错误"}（模型 ${model}）`);
    }
    const got = body.embeddings ?? [];
    if (got.length !== slice.length) {
      throw new Error(`条数对不上：发 ${slice.length} 条，回 ${got.length} 条向量`);
    }
    vectors.push(...got);
  }

  const dim = vectors[0]?.length ?? 0;
  if (!dim) throw new Error("模型返回了空向量");

  return { model, dim, vectors, ms: Date.now() - started };
}

/** 单条嵌入，内部走批量接口（避免两套代码路径）。 */
export async function embedOne(text: string, opts?: { model?: string }): Promise<number[]> {
  const r = await embedBatch([text], opts);
  return r.vectors[0];
}

/** 探活 + 报维度。W4 判据①用它。 */
export async function probe(): Promise<{ model: string; dim: number; ms: number }> {
  const r = await embedOne("维度探测", { model: EMBED_MODEL });
  return { model: EMBED_MODEL, dim: r.length, ms: 0 };
}
