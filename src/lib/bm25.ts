/**
 * BM25 —— 评测用的**稀疏检索 baseline**，不是产品代码。
 *
 * 为什么需要它：一个只说「向量检索 top1 命中」的报告证明不了什么，因为没说
 * 「不用向量会怎样」。没有对照就没有「值不值」的判断，只有「有没有」。BM25 是
 * 最经典、最便宜、零依赖的那条基线——如果它和向量打平，那么 1024 维向量、
 * 63MB 存储、76 秒建库的成本就该被重新审视。
 *
 * 中文分词的刻意简化：不引 jieba，用**字符 bigram**。
 *   理由一：这个语料是中文+器械型号+英文动作名混排，词典分词在「史密斯窄推」
 *   这种词上反而容易切错；
 *   理由二：bigram 是中文 IR 里历史悠久且强得离谱的 baseline，弱化它来衬托向量
 *   是不诚实的做法。**baseline 要按「最强的朴素方法」来搭，不是按「最容易被
 *   打败的方法」来搭。**
 *   单字成段（如「腿」）保留单字，否则「腿」这种一问就中的词会整条丢失。
 */

export interface BM25Doc {
  text: string;
}

const CJK = /[\u4e00-\u9fff]/;
// × 也算词内字符，否则「8×8」会被切成「8」「8」两个 token（见下面的注释）
const WORD = /[a-z0-9×]+/gi;

/** 归一化 + 切成检索单元。中文出 bigram，英文数字出小写词。 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  for (const run of lower.match(/[\u4e00-\u9fff]+|[a-z0-9×]+/g) ?? []) {
    if (CJK.test(run)) {
      if (run.length === 1) out.push(run);
      else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    } else {
      for (const w of run.match(WORD) ?? []) {
        // 丢掉单字符数字。实测：整库里「8」出现在 66.4% 的块里、「5」在 74.1%
        // （重量、卡路里、日期里全是数字），它们不提供任何区分度，却让
        // 「8×8 和 5×5 的区别」这种 query 的排序退化成纯噪声 —— 实测 top8 全是饮食明细。
        // 下面把 × 纳入词内字符后，「8×8」会保持为一个整体 token 而不是被拆成两个「8」。
        if (w.length === 1 && w >= "0" && w <= "9") continue;
        out.push(w);
      }
    }
  }
  return out;
}

export class BM25Index {
  private docs: BM25Doc[] = [];
  private tf: Map<string, number>[] = [];
  private df = new Map<string, number>();
  private len: number[] = [];
  private avgLen = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(docs: BM25Doc[]) {
    this.docs = docs;
    for (const d of docs) {
      const toks = tokenize(d.text);
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / (docs.length || 1);
  }

  /** 某个 token 出现在多少个文档里。给上层做「稀有词」判断用，不影响打分。 */
  documentFrequency(token: string): number {
    return this.df.get(token) ?? 0;
  }

  /** 文档数 */
  get size(): number {
    return this.docs.length;
  }

  /** 返回每个文档的分数（与 docs 同序） */
  score(query: string): number[] {
    const qToks = tokenize(query);
    const N = this.docs.length;
    const out = new Array<number>(N).fill(0);
    for (const t of qToks) {
      const df = this.df.get(t);
      if (!df) continue; // 查询词不在库里 → 该词贡献 0，不惩罚也不加分
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) {
        const tf = this.tf[i].get(t);
        if (!tf) continue;
        const denom = tf + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgLen);
        out[i] += idf * ((tf * (this.k1 + 1)) / denom);
      }
    }
    return out;
  }

  /** top-k 下标，按分数降序 */
  topK(query: string, k = 5): Array<{ i: number; score: number }> {
    const all = this.score(query);
    const idx = all.map((score, i) => ({ i, score }));
    idx.sort((a, b) => b.score - a.score);
    return idx.slice(0, k);
  }
}
