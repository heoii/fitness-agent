"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

/**
 * 问答界面（W6 + W7·5 流式）。
 *
 * 每件事对着一条可验证的判据：
 *   ① 输入问题 → /api/ask?stream=1，SSE 逐 token 回
 *   ② 答案里的 [n] 渲染成角标，点一下跳到对应引用卡片   ← 判据「引用可定位」
 *   ③ 引用卡片显示 `文件 > 标题路径` 与原文片段          ← 判据「定位到章节」
 *   ④ 底部显示引用校验：越界引用必须为 0                ← 判据「引用合法」
 *   ⑤ 随时可取消，取消后模型那边也停                    ← 判据「不白烧算力」
 *
 * 为什么先渲染引用再渲染答案：检索 14 ms、生成 2–8 s。先摆出「我用了哪几段资料」，
 * 用户在等待时就能判断系统有没有找对——这比首字快 2 ms 有用得多。
 *
 * 刻意不做：历史记录、多轮上下文、花哨动效。
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

type Route = "retrieve" | "trend" | "count" | "latest";

interface View {
  answer: string;
  citations: Citation[];
  check: Check;
  model: string;
  route: Route;
  ms: { retrieve: number; generate: number; total: number };
}

type Ev =
  | { type: "cites"; citations: Citation[]; route: Route; k: number; retrieveMs: number; model: string }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; check: Check; ms: View["ms"]; route: Route }
  | { type: "error"; reason: string }
  | { type: "aborted" };

const EXAMPLES = [
  "为什么我练胸的时候脖子会酸？",
  "卧推用 8×8 还是 5×5 怎么看",
  "HRV 现在用的是哪一套口径",
  "深蹲最近在涨还是在跌",
  "我这个月一共练了几次腿",
  "我 2019 年的体脂率是多少",
];

const ROUTE_LABEL: Record<Route, string> = {
  retrieve: "",
  trend: "数值入口 · 趋势（算好再答）",
  count: "数值入口 · 计数（遍历全库数）",
  latest: "数值入口 · 定位（取最晚一条）",
};

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

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export default function Home() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [waitMs, setWaitMs] = useState(0);
  const [index, setIndex] = useState<{ chunks: number; docs: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const t0Ref = useRef(0);

  useEffect(() => {
    fetch("/api/ask")
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && d.index) setIndex({ chunks: d.index.chunks, docs: d.index.docs });
      })
      .catch(() => {});
    const preset = new URLSearchParams(window.location.search).get("q");
    if (preset) void submit(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 等待计时：非流式那版只能干等，看不出它是在跑还是卡了
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setWaitMs(Date.now() - t0Ref.current), 100);
    return () => clearInterval(id);
  }, [busy]);

  const apply = useCallback((ev: Ev) => {
    if (ev.type === "cites") {
      setView({
        answer: "",
        citations: ev.citations,
        check: { refs: [], invalid: [], unused: [], noAnswer: false },
        model: ev.model,
        route: ev.route,
        ms: { retrieve: ev.retrieveMs, generate: 0, total: 0 },
      });
    } else if (ev.type === "token") {
      setView((v) => (v ? { ...v, answer: v.answer + ev.text } : v));
    } else if (ev.type === "done") {
      setView((v) =>
        v ? { ...v, answer: ev.answer, check: ev.check, route: ev.route, ms: ev.ms } : v
      );
    } else if (ev.type === "error") {
      setErr(ev.reason);
    } else if (ev.type === "aborted") {
      setCancelled(true);
    }
  }, []);

  async function submit(text?: string) {
    const question = (text ?? q).trim();
    if (!question || busy) return;
    setQ(question);
    setBusy(true);
    setErr(null);
    setCancelled(false);
    setView(null);
    setWaitMs(0);
    t0Ref.current = Date.now();

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await fetch("/api/ask?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: question }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // 按空行切 SSE 事件。不用「以 data: 开头就处理」——那样会在半行上解析
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            apply(JSON.parse(line.slice(6)) as Ev);
          } catch {
            /* 半截 JSON，丢掉即可，下一块会补齐 */
          }
        }
      }
    } catch (e) {
      // 用户主动取消不是错误：不要报警、不要清空已经出来的部分
      if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : "请求失败");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>问我的训练记录</h1>
        <p>
          从 800 多篇训练与健康记录里检索，按原文回答，每条结论标出处。
          答不出来会说「没有找到」——这一条是硬的，不编。
          问「涨还是跌」「一共几次」不走检索，走算好的工具。
        </p>
      </header>

      <div className={styles.form}>
        <div className={styles.row}>
          <textarea
            className={styles.input}
            placeholder="比如：为什么我练胸的时候脖子会酸？"
            value={q}
            rows={2}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          {busy ? (
            <button className={`${styles.submit} ${styles.cancelBtn}`} onClick={cancel}>
              取消
            </button>
          ) : (
            <button className={styles.submit} onClick={() => submit()} disabled={!q.trim()}>
              提问
            </button>
          )}
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

      {busy && !view && (
        <div className={styles.waiting}>
          检索中 <span className={styles.tick}>{(waitMs / 1000).toFixed(1)}s</span>
        </div>
      )}

      {view && (
        <section className={styles.result}>
          {view.citations.length > 0 && (
            <>
              <div className={styles.citesHead}>
                引用 {view.citations.length} 条
                {busy && <span className={styles.hint}> · 先给来源，答案还在生成</span>}
              </div>
              <div className={styles.cites}>
                {view.citations.map((c) => (
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

          <div className={styles.answer}>
            {view.answer ? renderAnswer(view.answer) : <span className={styles.dots}>…</span>}
            {busy && view.answer && <span className={styles.caret} />}
          </div>

          <div className={styles.meta}>
            {!busy && view.ms.total > 0 && (
              <span className={styles.badge}>
                {fmtMs(view.ms.retrieve)} 检索 + {fmtMs(view.ms.generate)} 生成
              </span>
            )}
            {busy && <span className={styles.badge}>已等 {(waitMs / 1000).toFixed(1)}s</span>}
            {cancelled && <span className={`${styles.badge} ${styles.badgeBad}`}>已取消</span>}
            {!busy && !cancelled && view.check.invalid && (
              <span className={`${styles.badge} ${view.check.invalid.length ? styles.badgeBad : styles.badgeOk}`}>
                引用合法 {view.check.invalid.length ? `越界 [${view.check.invalid.join(",")}]` : "✓"}
              </span>
            )}
            {!busy && view.check.noAnswer && <span className={styles.badge}>判定：资料里没有</span>}
            {ROUTE_LABEL[view.route] && <span className={styles.badge}>{ROUTE_LABEL[view.route]}</span>}
            {view.model && <span className={styles.badge}>{view.model}</span>}
          </div>
        </section>
      )}

      <footer className={styles.foot}>
        检索：BM25 + 时间重排（{index ? `${index.chunks} 块 / ${index.docs} 篇` : "索引加载中"}）·
        生成：本机 Ollama，不出本机 · 流式 SSE，可随时取消
        <br />
        命令行等价物：<code>npm run w6:ask</code>（19 题判据）· <code>npm run w7:count</code>（计数工具）·{" "}
        <code>npm run w6:debug -- --q &quot;…&quot;</code>（看检索排名）
      </footer>
    </div>
  );
}
