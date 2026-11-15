"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

/**
 * 问答界面（W6）。
 *
 * 这一页只做四件事，每件都对着一条可验证的判据：
 *   ① 输入问题 → 调 /api/ask（同步，不含流式）
 *   ② 答案里的 [n] 渲染成角标，点一下跳到对应引用卡片   ← 判据「引用可定位」
 *   ③ 引用卡片显示 `文件 > 标题路径` 与原文片段          ← 判据「定位到章节」
 *   ④ 底部显示引用校验：越界引用必须为 0                ← 判据「引用合法」
 *
 * 刻意不做：历史记录、多轮上下文、花哨动效。先把上面四条验干净。
 */

interface Citation {
  n: number;
  doc: string;
  date: string;
  label: string;
  headingPath: string[];
  snippet: string;
  score: number;
}

interface Check {
  refs: number[];
  invalid: number[];
  unused: number[];
  noAnswer: boolean;
}

interface Answer {
  ok: boolean;
  answer: string;
  citations: Citation[];
  check: Check;
  reason?: string;
  meta: { model: string; ms: { retrieve: number; generate: number; total: number }; k: number; route?: "retrieve" | "trend" };
}

const EXAMPLES = [
  "为什么我练胸的时候脖子会酸？",
  "减载期、恢复期、增长区的门槛是什么",
  "卧推用 8×8 还是 5×5 怎么看",
  "HRV 现在用的是哪一套口径",
  "深蹲最近在涨还是在跌",
  "我 2019 年的体脂率是多少",
];

/** 把 [1] [2] 渲染成可点的角标，其余原样 */
function renderAnswer(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup key={i}>
        <a href={`#cite-${m[1]}`}>{m[1]}</a>
      </sup>
    );
  });
}

export default function Home() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [index, setIndex] = useState<{ chunks: number; docs: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/ask")
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && d.index) setIndex({ chunks: d.index.chunks, docs: d.index.docs });
      })
      .catch(() => {});
    // 支持 `/?q=问题` 直接出结果：截图验收与分享链接都靠它，省掉一次点击
    const preset = new URLSearchParams(window.location.search).get("q");
    if (preset) submit(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(text?: string) {
    const question = (text ?? q).trim();
    if (!question || busy) return;
    setQ(question);
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: question }),
      });
      const d = (await r.json()) as Answer;
      if (!d.ok) setErr(d.reason ?? "生成失败");
      else setRes(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>问我的训练记录</h1>
        <p>
          从 800 多篇训练与健康记录里检索，按原文回答，每条结论标出处。
          答不出来会说「没有找到」——这一条是硬的，不编。
        </p>
      </header>

      <div className={styles.form}>
        <div className={styles.row}>
          <textarea
            ref={inputRef}
            className={styles.input}
            placeholder="比如：为什么我练胸的时候脖子会酸？"
            value={q}
            rows={2}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <button className={styles.submit} onClick={() => submit()} disabled={busy || !q.trim()}>
            {busy ? "检索中…" : "提问"}
          </button>
        </div>
        <div className={styles.examples}>
          {EXAMPLES.map((ex) => (
            <button key={ex} className={styles.chip} onClick={() => submit(ex)} disabled={busy}>
              {ex}
            </button>
          ))}
        </div>
      </div>

      {err && <div className={styles.error}>{err}</div>}

      {res && (
        <section className={styles.result}>
          <div className={styles.answer}>{renderAnswer(res.answer)}</div>

          {res.citations.length > 0 && (
            <>
              <div className={styles.citesHead}>引用 {res.citations.length} 条</div>
              <div className={styles.cites}>
                {res.citations.map((c) => (
                  <article key={c.n} id={`cite-${c.n}`} className={styles.cite}>
                    <div className={styles.citeTop}>
                      <span className={styles.citeN}>{c.n}</span>
                      <span className={styles.citeLabel}>{c.label}</span>
                      <span className={styles.citeScore}>{c.score}</span>
                    </div>
                    <div className={styles.citeSnippet}>{c.snippet}</div>
                  </article>
                ))}
              </div>
            </>
          )}

          <div className={styles.meta}>
            <span className={styles.badge}>
              {res.meta.ms.retrieve < 1000
                ? `${res.meta.ms.retrieve}ms`
                : `${(res.meta.ms.retrieve / 1000).toFixed(2)}s`}{" "}
              检索 +{" "}
              {res.meta.ms.generate < 1000
                ? `${res.meta.ms.generate}ms`
                : `${(res.meta.ms.generate / 1000).toFixed(1)}s`}{" "}
              生成
            </span>
            <span className={`${styles.badge} ${res.check.invalid.length ? styles.badgeBad : styles.badgeOk}`}>
              引用合法 {res.check.invalid.length ? `越界 [${res.check.invalid.join(",")}]` : "✓"}
            </span>
            {res.check.noAnswer && <span className={styles.badge}>判定：资料里没有</span>}
            {res.meta.route === "trend" && <span className={styles.badge}>数值入口 · 算好再答</span>}
            <span className={styles.badge}>{res.meta.model}</span>
          </div>
        </section>
      )}

      <footer className={styles.foot}>
        检索：BM25 + 时间重排（{index ? `${index.chunks} 块 / ${index.docs} 篇` : "索引加载中"}）·
        生成：本机 Ollama，不出本机
        <br />
        命令行等价物：<code>npm run w6:ask</code>（10 题判据）· <code>npm run w6:debug -- --q &quot;…&quot;</code>（看检索排名）
      </footer>
    </div>
  );
}
