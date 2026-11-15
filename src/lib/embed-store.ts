/**
 * 向量落盘 / 读回 —— W4 判据②「100 条能读回」靠这一层。
 *
 * **存放位置是硬约束，不是偏好**：这个仓库是公开仓，而 chunk 正文是真实训练
 * 记录（重量、掉力、体重）。所以向量文件连同正文摘要一律写到 `private/`
 * （已在 .gitignore 里，`git_sync.py` 还有一道闸会拦）。默认路径故意不含
 * 任何变量，就是为了让「写到公开仓」这件事在代码上就不容易发生。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** 相对仓库根的私人目录。改这里之前先读文件头。 */
export const PRIVATE_DIR = "private";

export interface StoredItem {
  /** 稳定标识：`文档相对路径#标题路径#part`，跨次运行不变 */
  key: string;
  docRel: string;
  docName: string;
  headingPath: string[];
  part: number | null;
  chars: number;
  /** 预归一化后的向量（读回来直接点积即可） */
  vec: number[];
}

export interface EmbedStore {
  model: string;
  dim: number;
  createdAt: string;
  /** 生成本文件时的语料根，换机器/换库时用来判断是否过期 */
  corpusRoot: string;
  count: number;
  items: StoredItem[];
}

export function storePath(name = "sample100"): string {
  const root = process.cwd();
  return join(root, PRIVATE_DIR, "embeddings", `${name}.json`);
}

export function saveStore(store: EmbedStore, path = storePath()): string {
  mkdirSync(dirname(path), { recursive: true });
  // 不缩进：1024 维 × 100 条缩进后会到 6MB，机器读的东西没必要给人眼友好
  writeFileSync(path, JSON.stringify(store), "utf8");
  return path;
}

export function loadStore(path = storePath()): EmbedStore {
  if (!existsSync(path)) {
    throw new Error(`向量文件不存在：${path}\n  先跑 npm run w4:embed 生成`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as EmbedStore;
  if (!Array.isArray(parsed.items) || typeof parsed.dim !== "number") {
    throw new Error(`向量文件结构不对：${path}（可能是旧版本生成的，删掉重跑）`);
  }
  return parsed;
}

export function storeSize(path: string): string {
  const b = statSync(path).size;
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
}
