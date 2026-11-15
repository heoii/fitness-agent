/**
 * W5 的另一半：**数值/聚合问答**，与向量检索并列的一条入口。
 *
 * 为什么必须单独做而不是塞进检索：
 * 「史密斯深蹲我多久没练了」的答案是「上一次是 X 月 X 日，距今 N 天」——这是
 * 集合差 + 日期减法，语料里**没有任何一段文字写着这个答案**。向量检索再准也只能
 * 返回「讲史密斯深蹲的那些块」，然后把算日期的活推给下游。把它算进召回率的分母
 * 有两头坏处：拉低向量分数（它本来不该答这类题），同时掩盖真正的语义能力（分母
 * 被稀释）。所以两类问题分开评测、各自报数。
 *
 * 数据口径（与 W3 的解析层一致）：
 *   - 只认 `record_type: strength` 或含 `## 动作明细` 的记录；
 *   - 时长 > 150 分钟判「忘停表」，从 max/均值里剔除（有氧另有阈值，这里不涉及）；
 *   - 「练腿」= 动作集合里出现腿/臀主导动作，用动作名判定，不用 session 标签——
 *     真实数据里 session 标签不可靠（`2026-03-26-训练-01-腹部.md` 里排的是推举）。
 *
 * 用法:
 *   npm run w5:qa
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadDoc, walkMarkdown, isStrengthDoc, type Doc } from "../src/lib/corpus";
import { kbDir } from "./kb-dir";

interface Session {
  doc: Doc;
  date: string;
  acts: string[];
  durMin: number | null;
  durSuspect: boolean;
}

/** 部位判定用的动作关键词。按「主导」判定，一个动作可能同时算腿和臀。 */
const LEG = [
  "深蹲", "腿举", "倒蹬", "腿屈伸", "腿弯举", "提踵", "臀推", "髋外展",
  "罗马尼亚硬拉", "硬拉", "箭步蹲", "分腿",
];
const BACK = ["划船", "下拉", "引体", "硬拉", "山羊挺身", "直臂下压"];

const H3 = /^### (.+?)（kg）.*$/;

function main(): void {
  const DIR = kbDir();
  const files = walkMarkdown(DIR);
  const sessions: Session[] = [];
  const sleep: Array<{ date: string; h: number }> = [];

  for (const f of files) {
    const d = loadDoc(f, DIR);
    if (isStrengthDoc(d)) {
      const acts: string[] = [];
      for (const line of d.body.split("\n")) {
        const m = line.match(H3);
        if (m) acts.push(m[1].trim());
      }
      const dur = typeof d.fm.duration_min === "number" ? d.fm.duration_min : null;
      // >150 分判忘停表：正常力量课极少超过 2h，实测最长有效值 114 分
      const suspect = dur !== null && dur > 150;
      sessions.push({ doc: d, date: d.date ?? "?", acts, durMin: dur, durSuspect: suspect });
    } else {
      const h = d.fm.sleep_hours;
      if (typeof h === "number" && h > 0) sleep.push({ date: d.date ?? "?", h });
    }
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  const valid = sessions.filter((s) => !s.durSuspect);
  const last = sessions[sessions.length - 1].date;
  const dayMs = 86400_000;
  // 基准取「数据末」而不是今天：报告要可复现，跑一年后看到的天数必须还是这个数。
  const daysSince = (d: string) => Math.round((Date.parse(last) - Date.parse(d)) / dayMs);

  const has = (s: Session, kws: string[]) => s.acts.some((a) => kws.some((k) => a.includes(k)));
  const fmt = (s: Session) => `${s.date}（${s.acts.length} 动作 / ${s.durMin ?? "?"} 分）`;

  const lines: string[] = [];
  lines.push(`数据：${sessions.length} 次力量训练（${sessions[0].date} ~ ${last}）+ ${sleep.length} 天睡眠记录`);
  const suspect = sessions.length - valid.length;
  lines.push(`清洗：${suspect} 次时长 >150 分判「忘停表」，不参与 max / 均值`);
  lines.push("");

  // ── N1 ──
  const sq = sessions.filter((s) => s.acts.some((a) => a.includes("史密斯深蹲")));
  const lastSq = sq[sq.length - 1];
  lines.push(`N1  ｜史密斯深蹲我多久没练了`);
  lines.push(`    → 上一次 ${fmt(lastSq)}，距今 ${daysSince(lastSq.date)} 天；共练过 ${sq.length} 次`);
  lines.push("");

  // ── N2 ──
  const cutoff = new Date(Date.parse(last) - 30 * dayMs).toISOString().slice(0, 10);
  const leg30 = sessions.filter((s) => s.date >= cutoff && has(s, LEG));
  lines.push(`N2  ｜过去 30 天练了几次腿`);
  lines.push(`    → ${leg30.length} 次（${cutoff} ~ ${last}）：${leg30.map((s) => s.date.slice(5)).join(" / ")}`);
  lines.push("");

  // ── N3 ──
  const longest = [...valid].sort((a, b) => (b.durMin ?? 0) - (a.durMin ?? 0))[0];
  const dropped = sessions.filter((s) => s.durSuspect).sort((a, b) => (b.durMin ?? 0) - (a.durMin ?? 0))[0];
  lines.push(`N3  ｜哪次训练时长最长`);
  lines.push(`    → ${fmt(longest)}`);
  if (dropped) lines.push(`    （若不洗数据，第一名是 ${dropped.date} 的 ${dropped.durMin} 分 —— 明显忘停表）`);
  lines.push("");

  // ── N4 ──
  const back = sessions.filter((s) => has(s, BACK));
  const lastBack = back[back.length - 1];
  lines.push(`N4  ｜最近一次练背是哪天`);
  lines.push(`    → ${fmt(lastBack)}，距今 ${daysSince(lastBack.date)} 天；${back.length} 次背日里动作最多的一次是 ${
    back.reduce((a, b) => (b.acts.length > a.acts.length ? b : a)).date
  }`);
  lines.push("");

  // ── N5 ──
  const month = "2026-11";
  const ms = sleep.filter((s) => s.date.startsWith(month));
  const avg = ms.reduce((a, b) => a + b.h, 0) / (ms.length || 1);
  const below7 = ms.filter((s) => s.h < 7).length;
  lines.push(`N5  ｜这个月平均睡多少小时`);
  lines.push(`    → ${avg.toFixed(2)} h（${ms.length} 天有记录，其中 ${below7} 天 < 7h）`);
  lines.push("");

  // ── N6 ──
  // 单看「最重一组」会误判：11-07 是 60kg 但掉到 60×6，11-14 是 55kg 却做了 4×8。
  // 所以要看容量。但容量本身还有第二个坑：**热身组算不算**。
  //   App（练练）写入的 `容量` 字段**含热身组** —— 11-07 = 40×8 热身(320) + 1740 工作 = 2060；
  //   11-14 = 35×8 + 45×5 热身(505) + 1760 工作 = 2265。
  // 于是同一个动作，含热身是「+4.9% 基本持平」，剔除热身是「-12.8% 在跌」，结论相反。
  // 涨的那部分全靠 11-14 多插的一组热身撑起来 —— 那不是能力涨。
  // 所以这里必须**两个口径同时报**，挑一个好看的报等于自欺。
  const volOf = (body: string, name: string): number => {
    const m = body.match(new RegExp(`^### ${name}（kg）— 容量 (\\d+)`, "m"));
    return m ? Number(m[1]) : 0;
  };
  /** 按行重算：带「热身」标记的组单独累计，其余算工作容量 */
  const splitVolOf = (body: string, name: string): { work: number; hot: number } => {
    const lines = body.split("\n");
    let inside = false;
    let work = 0;
    let hot = 0;
    for (const line of lines) {
      if (line.startsWith("### ")) {
        inside = line.startsWith(`### ${name}（kg）`);
        continue;
      }
      if (!inside) continue;
      const m = line.match(/组\d+：(\d+(?:\.\d+)?)kg\s*[×x]\s*(\d+)/);
      if (!m) continue;
      const v = Number(m[1]) * Number(m[2]);
      if (line.includes("热身")) hot += v;
      else work += v;
    }
    return { work, hot };
  };
  const topOf = (body: string, name: string): number[] => {
    const lines = body.split("\n");
    const out: number[] = [];
    let inside = false;
    for (const line of lines) {
      if (line.startsWith("### ")) {
        inside = line.startsWith(`### ${name}（kg）`);
        continue;
      }
      if (!inside) continue;
      // 热身组不进「最重一组」——不然 60kg 热身的动作会盖住 55kg 的正式主项
      if (line.includes("热身")) continue;
      for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*kg\s*[×x]\s*\d+/g)) out.push(Number(m[1]));
    }
    return out;
  };
  const w: Array<{ date: string; top: number; appVol: number; work: number; hot: number; degrade: boolean }> = [];
  for (const s of sq) {
    const weights = topOf(s.doc.body, "史密斯深蹲");
    if (!weights.length) continue;
    // 档位写在文件名里（「试探档」「降级」「复训」），是真实数据里唯一可靠的降级标记。
    // 不排除它就会得到「容量在跌」的假结论：10-30 那次只做了 720 容量。
    const degrade = /试探档|降级|复训/.test(s.doc.name);
    const sv = splitVolOf(s.doc.body, "史密斯深蹲");
    w.push({
      date: s.date,
      top: Math.max(...weights),
      appVol: volOf(s.doc.body, "史密斯深蹲"),
      work: sv.work,
      hot: sv.hot,
      degrade,
    });
  }
  const normal = w.filter((x) => !x.degrade);
  const recent = normal.slice(-3);
  const earlier = normal.slice(-8, -3);
  const avgOf = (a: typeof w, pick: (x: (typeof w)[number]) => number) =>
    a.reduce((s, x) => s + pick(x), 0) / (a.length || 1);
  const trend = (a: number, b: number) => (a > b * 1.05 ? "在涨" : a < b * 0.95 ? "在跌" : "基本持平");
  const appR = avgOf(recent, (x) => x.appVol);
  const appE = avgOf(earlier, (x) => x.appVol);
  const workR = avgOf(recent, (x) => x.work);
  const workE = avgOf(earlier, (x) => x.work);
  const degraded = w.filter((x) => x.degrade).slice(-2);
  lines.push(`N6  ｜深蹲重量最近在涨还是在跌`);
  lines.push(
    `    → 正常档最近 ${recent.length} 次：${recent
      .map((x) => `${x.date.slice(5)} 最重${x.top}kg/工作容量${x.work}`)
      .join("　")}`
  );
  lines.push(
    `       口径A 含热身（App 的「容量」字段） 此前 ${earlier.length} 次 ${appE.toFixed(0)} → 最近 ${appR.toFixed(0)}`
  );
  lines.push(`             ${trend(appR, appE)}（${((appR / appE - 1) * 100).toFixed(1)}%）`);
  lines.push(
    `       口径B 剔除热身（只算正式组）       此前 ${earlier.length} 次 ${workE.toFixed(0)} → 最近 ${workR.toFixed(0)}`
  );
  lines.push(`             ${trend(workR, workE)}（${((workR / workE - 1) * 100).toFixed(1)}%）`);
  lines.push(
    `       ⚠ 两个口径结论相反时，**不要挑一个报**。最近 3 次热身占比：` +
      recent.map((x) => `${x.date.slice(5)} ${((x.hot / (x.appVol || 1)) * 100).toFixed(0)}%`).join("、") +
      ` —— 含热身那点涨幅是热身组插进来的，不是能力涨。`
  );
  if (degraded.length)
    lines.push(
      `       已排除的降级课：${degraded.map((x) => `${x.date.slice(5)}（App容量${x.appVol}）`).join("、")} —— 混进来会把趋势拉成「在跌」`
    );
  lines.push(
    `       ⚠ 三个坑一起避开：① 只看最大重量会判成跌（60→55）；② 不排除试探档会判成跌（被 720 拉低）；` +
      `③ 用 App 的容量不看热身占比会判成涨。`
  );

  console.log(lines.join("\n"));
}

main();
