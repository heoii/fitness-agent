/**
 * 按标题层级切片，产出带 `headingPath` 的 chunk。
 *
 * 为什么不是「按固定字数切」：这个语料的语义边界就是标题——`## 动作明细` 下是
 * 一组动作，`## 摘要` 是一句话结论，硬切字数会把动作从它自己的组次数据里切开。
 * 也不做固定 512 token 的滑动窗口：那种切法在知识库里能把「1RM 的定义」切成
 * 前半句在上一块、后半句在下一块，检索到了也读不懂。
 *
 * 切分单元的选择（两层）：
 *   1. 主边界是 `##`；
 *   2. 若该 `##` 段里还有 `###`，则继续细到 `###` 叶子块，但 headingPath
 *      保留完整父级（`动作明细 > 史密斯深蹲（kg）— 容量 2060`）。
 *      —— 训练记录的 `## 动作明细` 有 8 个动作、700+ 字，整段做成一个 chunk
 *      语义太杂：问「深蹲掉力」会命中整段，前 5 条近邻全是同一篇的其他动作。
 *
 * 过短块（`## 摘要` 那种一句话）不在这里合并：合并策略属于检索调优（W5 看
 * recall 再定），切片阶段只负责不丢内容、可回溯。用 `stub` 标出来供上层筛选。
 */
import type { Doc } from "./corpus";

export interface Chunk {
  doc: Doc;
  /** 从一级到当前标题的完整路径，如 ["动作明细", "史密斯深蹲（kg）— 容量 2060"] */
  headingPath: string[];
  /** 不含标题行的正文 */
  text: string;
  chars: number;
  /** 超长硬切的序号（从 1 开始）；未切为 null */
  part: number | null;
  /** 正文过短（< 20 字），检索时可选择丢弃 */
  stub: boolean;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const STUB_CHARS = 20;
const DEFAULT_MAX = 1200;

/** 单个 chunk 用于 embedding 的文本：标题路径 + 正文，避免「孤立一句没有上下文」。 */
export function flatText(c: Chunk): string {
  return [...c.headingPath, c.text].filter(Boolean).join("\n");
}

/** 引用标识，如 `2026-11-07-训练-01-腿A.md > 动作明细 > 史密斯深蹲` */
export function chunkLabel(c: Chunk): string {
  const base = [...c.headingPath];
  const tail = base.length ? ` > ${base.join(" > ")}` : "";
  const part = c.part ? ` (part ${c.part})` : "";
  return `${c.doc.name}${tail}${part}`;
}

function hardSplit(lines: string[], maxChars: number): string[] {
  const parts: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > maxChars && buf.length) {
      parts.push(buf.join("\n").trim());
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length) parts.push(buf.join("\n").trim());
  return parts.filter(Boolean);
}

export function chunkDoc(doc: Doc, maxChars = DEFAULT_MAX): Chunk[] {
  const lines = doc.body.split("\n");
  const stack: Array<{ level: number; text: string }> = [];
  let buf: string[] = [];
  const out: Chunk[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    const path = stack.map((s) => s.text);
    if (text.length <= maxChars) {
      out.push({
        doc,
        headingPath: path,
        text,
        chars: text.length,
        part: null,
        stub: text.length < STUB_CHARS,
      });
      return;
    }
    const parts = hardSplit(text.split("\n"), maxChars);
    parts.forEach((p, i) => {
      out.push({
        doc,
        headingPath: path,
        text: p,
        chars: p.length,
        part: parts.length > 1 ? i + 1 : null,
        stub: p.length < STUB_CHARS,
      });
    });
  };

  for (const line of lines) {
    const m = line.match(HEADING);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}
