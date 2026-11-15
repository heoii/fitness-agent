/**
 * 语料遍历与 frontmatter 解析的**唯一出处**。
 *
 * 为什么单独一层：W3 三个动作（遍历计数 / 切片 / 抽训练结构）必须看同一批文件、
 * 用同一套类型判定。否则「条目数」和「chunk 数」会在不同口径上互相印证，看着都对。
 *
 * 注意与 `scripts/samples.ts` 的分工：那个是**评测样本**的口径（20 篇力量记录，
 * 供 compliance/profile 用，已验收、不要再动）；这里是**全量语料**的口径。
 * 两者对「是不是力量记录」的判断规则保持一致（record_type 优先，退化为有没有
 * `## 动作明细`），但用途不同，不合并。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Doc {
  /** 绝对路径 */
  path: string;
  /** 相对语料根目录的路径，用来做引用与排序 */
  rel: string;
  name: string;
  /** frontmatter 里的 date，取不到时退回文件名里的 YYYY-MM-DD */
  date: string | null;
  /** frontmatter 里的 type */
  type: string | null;
  fm: Record<string, string | string[] | number | boolean>;
  /** 去掉 frontmatter 的正文 */
  body: string;
  /** 全文（含 frontmatter） */
  text: string;
}

/** 递归收集目录下所有 .md，返回绝对路径。跳过隐藏目录与 node_modules。 */
export function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".next", ".obsidian", ".trash"]);
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 极简 frontmatter 解析：只认 `key: value`、`key: [a, b]`、`key: "x"`、数字与布尔。
 * 不引 YAML 库是刻意的——语料是我们自己生成的，格式稳定；多一个依赖就多一个
 * 换环境时要解释的东西。
 */
export function parseFrontmatter(text: string): {
  fm: Record<string, string | string[] | number | boolean>;
  body: string;
} {
  const fm: Record<string, string | string[] | number | boolean> = {};
  if (!text.startsWith("---")) return { fm, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm, body: text };
  const block = text.slice(3, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);

  for (const raw of block.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const val = rest.trim();
    if (!val) {
      fm[key] = "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      fm[key] = Number(val);
    } else if (val === "true" || val === "false") {
      fm[key] = val === "true";
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body };
}

export function loadDoc(path: string, root?: string): Doc {
  const raw = readFileSync(path, "utf8");
  // 统一换行符，**不是洁癖**：语料里 235/989 篇是 CRLF（Windows 端写的），
  // 而 `split("\n")` 之后每行末尾还挂着 `\r`。标题正则的 `(.*)$` 里 `.` 不匹配
  // `\r`、`$` 又只认整串结尾，于是这些文件的**每一个标题都匹配失败**：
  // 整篇塌成一个无标题大块、headingPath 变空、检索时引用不到任何小节。
  // 这种错很安静——chunk 数不会崩、每个块都有正文，只有标题结构没了。
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const { fm, body } = parseFrontmatter(text);
  const name = path.split("/").pop() ?? path;
  const fmDate = typeof fm.date === "string" ? fm.date : null;
  const nameDate = name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return {
    path,
    rel: root ? relative(root, path) : path,
    name,
    date: fmDate || nameDate,
    type: typeof fm.type === "string" ? fm.type : null,
    fm,
    body,
    text,
  };
}

/** 力量记录判定：与 scripts/samples.ts 同规则（record_type 优先，退化为有没有动作明细）。 */
export function isStrengthDoc(doc: Doc): boolean {
  const rt = typeof doc.fm.record_type === "string" ? doc.fm.record_type : "";
  if (/^cardio/i.test(rt)) return false;
  if (/^strength/i.test(rt)) return true;
  return doc.body.includes("## 动作明细");
}

/** 取 `## 标题` 下的整段（用于只喂「动作明细」这类要求）。找不到返回 null。 */
export function section(doc: Doc, heading: string): string | null {
  const lines = doc.body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `## ${heading}`) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}
