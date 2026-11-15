/**
 * 向量数学：归一化、余弦、top-k —— 纯函数，不碰网络、不碰文件。
 *
 * 为什么手写不引库：一共三个公式，`faiss`/`hnswlib` 那种是给百万级准备的，
 * 这里 2624 个 chunk 暴力算一遍 3ms，引原生依赖反而让换机器时要重装编译。
 *
 * 一个容易错的口径：**bge-m3 的输出不是严格单位长度**（实测 L2 范数在
 * 0.99–1.01 之间浮动）。如果先假设已归一化而直接用点积代替余弦，排序会在
 * 分数接近的候选上出错——所以这里显式归一化一次，余弦就是点积。
 */

/** L2 范数 */
export function norm(v: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** 归一化到单位长度。零向量原样返回（调用方用 norm 判断是否退化）。 */
export function normalize(v: readonly number[]): number[] {
  const n = norm(v);
  if (n === 0) return [...v];
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** 余弦相似度。输入已归一化时退化为点积，结果相同。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`维度不一致：${a.length} vs ${b.length}（是不是换了嵌入模型？）`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * 取 top-k。用部分插入而不是全排序：k=5、n=2624 时省 90% 的比较，
 * 而且调用方永远只要前几条，没必要把整表排序。
 */
export function topK<T>(
  query: readonly number[],
  items: readonly T[],
  vecOf: (item: T) => readonly number[],
  k = 5
): Scored<T>[] {
  const best: Scored<T>[] = [];
  for (const item of items) {
    const score = cosine(query, vecOf(item));
    if (best.length < k) {
      best.push({ item, score });
      best.sort((x, y) => y.score - x.score);
    } else if (score > best[best.length - 1].score) {
      best[best.length - 1] = { item, score };
      best.sort((x, y) => y.score - x.score);
    }
  }
  return best;
}

/** 落在 [-1,1] 之外说明维度顺序错位或混了不同模型的向量，用来做断言。 */
export function inRange(score: number): boolean {
  return score >= -1.0001 && score <= 1.0001;
}
