/**
 * 本地 7B 的能力边界探针：不是测"快不快"，是测"够不够用"。
 *
 * 三个问题分别对应 RAG 问答里三种真实任务，用**真实检索结果**当上下文（不手编）：
 *   ① 有答案的语义题 —— 看它能不能从 5 段检索结果里挑对、并老实挂引用
 *   ② 库里根本没有的问题 —— 看它会不会编（RAG 最致命的失败形态）
 *   ③ 需要算数的题 —— 看它会不会拿检索到的原始组次自己算，算对没有
 *
 * 每个问题记首 token / 总时长 / 输出。判读靠人，脚本只负责把证据摆齐。
 *
 * 用法: npm run w6:llm
 */
import { walkMarkdown, loadDoc } from "../src/lib/corpus";
import { chunkDoc, flatText, chunkLabel, type Chunk } from "../src/lib/chunk";
import { BM25Index } from "../src/lib/bm25";
import { kbDir } from "./kb-dir";

const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b-instruct";
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";

interface Case {
  id: string;
  q: string;
  /** 该题的检索查询（可以和 q 不同：用户问法 vs 检索用词） */
  search: string;
  expect: string;
}

const CASES: Case[] = [
  // ① 有答案：语料里真有「为什么练胸会脖子酸」的归因
  { id: "Q1", q: "为什么我练胸的时候脖子会酸？", search: "练胸 脖子 酸", expect: "能指出是颈部代偿/斜方肌参与，并给出调整建议" },
  // ② 库里没有：语料从 2025 年开始，2019 年根本不存在
  { id: "Q2", q: "我 2019 年的体脂率是多少？", search: "体脂率 2019", expect: "必须说没找到，不许编一个数字" },
  // ③ 要算数：检索只能给到原始组次，答案得靠算
  { id: "Q3", q: "我深蹲的重量最近在涨还是在跌？", search: "史密斯深蹲 容量", expect: "正确做法是拒答/要求给口径，而不是从单组重量推结论" },
];

async function generate(prompt: string): Promise<{ first: number; total: number; text: string; chunks: number }> {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: true,
      options: { num_predict: 260, temperature: 0 },
    }),
  });
  if (!res.body) throw new Error("无响应体");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let first = -1;
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const d = JSON.parse(line) as { response?: string; done?: boolean };
      if (d.response) {
        if (first < 0) first = Date.now() - t0;
        text += d.response;
        chunks++;
      }
      if (d.done) break;
    }
  }
  return { first, total: Date.now() - t0, text, chunks };
}

async function main() {
  const DIR = kbDir();
  const chunks: Chunk[] = [];
  for (const f of walkMarkdown(DIR)) {
    const doc = loadDoc(f, DIR);
    for (const c of chunkDoc(doc)) if (!c.stub) chunks.push(c);
  }
  const bm25 = new BM25Index(chunks.map((c) => ({ text: flatText(c) })));
  console.log(`库：${chunks.length} 块　模型：${MODEL}\n` + "=".repeat(76));

  const prompts = CASES.map((c) => {
    const hits = bm25.topK(c.search, 5).map((h) => chunks[h.i]);
    const ctx = hits
      .map((h, i) => `[${i + 1}] ${chunkLabel(h)}\n${h.text.slice(0, 420)}`)
      .join("\n\n");
    const prompt = `你是一个只根据资料回答问题的助手。规则：
1. 只能用下面资料里的内容回答，不许用你自己的知识补充。
2. 每条结论后面用 [1][2] 标注它来自哪一段。
3. 如果资料里没有答案，直接回答「资料里没有找到」，不要猜测。
4. 不要自己计算数字。如果问题需要算，说明你需要哪个字段。

资料：
${ctx}

问题：${c.q}`;
    return { hits, prompt };
  });

  // ── warmup：把模型加载进内存，单独计量 ──
  // 这一步是必须的。上一轮我在**模型未加载**时测「带上下文首 token = 2844 ms」，
  // 而紧接着的短问答只要 427 ms —— 差的不是上下文长度，是模型加载。
  // 冷启动和稳态必须分开报，否则会得出「7B 太慢」这个错误结论。
  // 不能拿某个 case 的 prompt 去 warmup —— Ollama 会按 prompt 前缀做缓存，
  // 下一次同 prompt 的首 token 会变成 46ms 这种假数（实测过）。用无关短句预热。
  const warm = await generate("你好");
  console.log(`warmup（模型冷加载 + 首字）  首token ${warm.first} ms　总 ${(warm.total / 1000).toFixed(1)}s`);
  console.log(`  ← 这笔只在新进程第一次提问时出现；keep_alive 期内不会重复付\n`);

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const { hits, prompt } = prompts[i];
    const r = await generate(prompt);
    console.log(`\n【${c.id}】${c.q}`);
    console.log(`   检索 top5 → ${hits.map((h) => chunkLabel(h).split(" > ")[0].slice(0, 24)).join(" | ")}`);
    console.log(
      `   首token ${r.first} ms　总 ${(r.total / 1000).toFixed(1)}s　${r.chunks} chunk　≈${(r.chunks / (r.total / 1000)).toFixed(1)} tok/s（热态）`
    );
    console.log(`   期望：${c.expect}`);
    console.log(`   实际：${r.text.trim().replace(/\n+/g, " ").slice(0, 340)}`);
  }
  console.log("\n" + "=".repeat(76));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
