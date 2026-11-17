/**
 * 排计划会话（2026-11-17）
 *
 * 让「历史页那个输入框」既能问历史、也能排计划。设计纪律与 answer.ts 一致：
 *   - 数字全部由排课引擎算出，模型一个字都不碰（fixedAnswer，不过 7B）
 *   - 意图识别是正则预路由，不让模型自己决定调什么（见 answer.ts 顶部的说明）
 *   - 不写练练 App：用户先在对话里看三档、自己挑；落 App 是下一步的事
 *
 * 为什么不在 pick() 里加分支：pick() 是同步函数，被评测脚本和流式路径共用。
 * 调 Python 引擎是异步的，塞进去会把 pick() 整个改成 async、波及一片。
 * 所以在 ask() / askStream() 入口处先异步试一次，命中就直接用 Plan，否则照旧 pick()。
 *
 * 公开仓红线（AGENTS.md）：路径不写死本机用户名，全部从环境变量推导或用 ~ 拼；
 * 真实健康数据不落盘进仓，checkin 临时文件只写系统临时目录。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type { Citation, Plan, PlanData, PlanTierData, Route } from "./answer";

const execFileAsync = promisify(execFile);

/** 排课引擎 skill 的 scripts 目录。默认从 HOME 拼，不含用户名。 */
const ENGINE_SCRIPTS =
  process.env.FIT_ENGINE_SCRIPTS ||
  path.join(process.env.HOME || "", ".workbuddy", "skills", "training-plan-engine", "scripts");
const ENGINE_ROOT = path.dirname(ENGINE_SCRIPTS);
const CHECKIN_PY = path.join(ENGINE_SCRIPTS, "checkin.py");
const ENGINE_PY = path.join(ENGINE_SCRIPTS, "engine.py");
const PROFILE_JSON =
  process.env.FIT_ENGINE_PROFILE || path.join(ENGINE_ROOT, "examples", "profile.json");
const HISTORY_JSON =
  process.env.FIT_ENGINE_HISTORY || path.join(ENGINE_ROOT, "data", "history.json");

/** 知识库根：KB_DIRS 第一项优先；只有 KB_DIR 时取它的父目录（它指向 01 每日记录）。 */
function kbRoot(): string {
  const dirs = process.env.KB_DIRS || "";
  if (dirs) return dirs.split(",")[0].trim();
  const kbDir = process.env.KB_DIR || "";
  return kbDir ? path.dirname(kbDir) : "";
}

/**
 * 排计划意图。必须够保守：问历史的话绝不能被误判成排计划。
 *
 * 正面：明确的「排/安排/制定 + 计划/训练/课」，或「今天/明天 + 练什么/怎么练/该练」。
 * 负面：带过去时间或复盘词（上次/昨天/练了/记录/历史/几次）的一律不放行——
 *       「今天练了什么」是历史，「今天练什么」才是计划，差一个「了」字。
 */
// 动词与「计划」之间允许插入少量修饰字（「今天的」「一下这周的」），
// 负面词表已挡住历史问题，正面放宽不会误伤。
const PLAN_VERB = /(排|安排|制定|生成|出).{0,6}(训练|计划|课)/;
const TODAY_WHAT = /(今天|明天|今日|明日)\s*(要|该|准备|打算)?\s*(练什么|练啥|怎么练|练哪个|做什么训练|训练什么)/;
const PAST_HINT = /(上次|之前|昨天|前天|练了|练过|记录|历史|几次|多久没|上一次)/;

export function isPlanRequest(q: string): boolean {
  const s = String(q || "").trim();
  if (!s || PAST_HINT.test(s)) return false;
  return PLAN_VERB.test(s) || TODAY_WHAT.test(s);
}

interface PlanAction {
  name: string;
  sets: number;
  reps: number | string;
  weight: number | null;
  weightRange?: [number, number];
  rest?: number;
  toFailure?: boolean;
  warmupText?: string;
  /** 引擎的逐级热身：[{w, reps, hot}]，不占正式组数 */
  warmup?: { w: number; reps: number; hot?: boolean }[];
  bodyweight?: boolean;
  closingRule?: string;
}

interface TierPlan {
  tier: string;
  tierDesc: string;
  judgedTier?: string;
  tierOverridden?: boolean;
  status: string;
  dimensions?: { name: string; level: string; detail: string }[];
  counts?: { red: number; yellow: number; dimensions: number };
  session?: { name: string; part: string | null; daysSinceLast: number | null };
  actions?: PlanAction[];
  error?: string;
}

function fmtWeight(a: PlanAction): string {
  if (a.bodyweight) return "自重";
  if (a.weight == null) return "—";
  const lo = a.weightRange?.[0];
  const hi = a.weightRange?.[1];
  const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  return lo != null && hi != null && lo !== hi ? `${n(lo)}–${n(hi)}kg` : `${n(a.weight)}kg`;
}

/**
 * 结构化版：同一份引擎结果，按「判档四维 + 三档动作行」摆好，给小程序画表格。
 * 与 renderTiers 共用同一个 tiers 输入，所以两边数字必然一致。
 * 这里只做搬运和格式化，不做任何新的判断或换算。
 */
function buildPlanData(tiers: TierPlan[], date: string): PlanData {
  const first = tiers[0];
  const def = tiers.find((t) => t.tier === first.judgedTier) || first;
  const cnt = first.counts;

  const tierData: PlanTierData[] = tiers.map((t) => {
    const rows = (t.actions || []).map((a) => ({
      name: a.name,
      sets: Number(a.sets) || 0,
      reps: String(a.reps ?? ""),
      weight: fmtWeight(a),
      rest: a.rest ? `${a.rest}s` : "",
      fail: !!a.toFailure,
      warmup: a.warmupText || "",
      // 逐级热身单独给出来：小程序按「2 组：22.5×8 / 30×5」显示。
      // 引擎本来就有这个数组，之前只取了拼好的文本，表格里看不出有几组。
      warmups: (a.warmup || []).map((x) => ({
        weight: Number.isInteger(x.w) ? String(x.w) : String(x.w),
        reps: String(x.reps),
      })),
    }));
    return {
      tier: t.tier,
      isDefault: t === def,
      desc: t.tierDesc || "",
      totalSets: rows.reduce((s, r) => s + r.sets, 0),
      rows,
    };
  });

  return {
    date,
    judge: def.tier,
    statusLine: cnt ? `${first.status} · 红 ${cnt.red} / 黄 ${cnt.yellow}（${cnt.dimensions} 维）` : first.status,
    // 分开给：小程序写知识库时要拼「**判档：X**（状态 · 红N 黄N）」，直接拿这三个字段，
    // 不用去正则拆 statusLine（拆错了会把结论写歪）。
    status: first.status || "",
    counts: cnt ? { red: cnt.red, yellow: cnt.yellow, dimensions: cnt.dimensions } : undefined,
    parts: first.session?.name
      ? first.session.name + (first.session.daysSinceLast != null ? ` · 距上次 ${first.session.daysSinceLast} 天` : "")
      : "",
    dims: (first.dimensions || []).map((d) => ({ name: d.name, level: d.level || "", detail: d.detail || "" })),
    tiers: tierData,
    note: "三档自己挑一档，点下方按钮才会写进练练（不点就只在这里看）。热身组不占正式组数；自重、面拉与小重量动作不另设热身。",
  };
}

/** 把三档渲染成纯文本。数字全来自引擎；不用 [n]，免得被引用校验当成引用。 */
function renderTiers(tiers: TierPlan[]): string {
  if (!tiers.length) return "排课引擎没有返回计划。";
  const first = tiers[0];
  const head: string[] = [];

  const dims = (first.dimensions || [])
    .map((d) => `${d.name} ${d.detail}`)
    .join("；");
  if (dims) head.push(`判档依据：${dims}。`);
  const cnt = first.counts;
  if (cnt) head.push(`${first.status}，${cnt.red} 红 ${cnt.yellow} 黄 / ${cnt.dimensions} 维。`);
  if (first.session?.name) {
    const gap = first.session.daysSinceLast;
    head.push(`部位：${first.session.name}${gap != null ? ` · 距上次 ${gap} 天` : ""}。`);
  }
  // 引擎默认档 = 判档结论那一档（judgedTier），不要看 tierOverridden：
  // 判档本身那档 overridden=false，用它会 find 失败、错标成第一档（正常档），
  // 违背「判档必须体现在排课里」。回退条件里 tierOverridden 也不能加。
  const def = tiers.find((t) => t.tier === first.judgedTier) || first;
  head.push(`判档结论：${def.tier}（引擎默认）。`);

  const blocks = tiers.map((t) => {
    const label = t.tier + (t === def ? "（引擎默认）" : "");
    const lines = (t.actions || []).map((a) => {
      const rest = a.rest ? `，组间 ${a.rest}s` : "";
      const fail = a.toFailure ? "，末组力竭" : "";
      const warm = a.warmupText ? `\n    热身：${a.warmupText}` : "";
      return `  · ${a.name} ${a.sets}×${a.reps} @ ${fmtWeight(a)}${rest}${fail}${warm}`;
    });
    const total = (t.actions || []).reduce((s, a) => s + (Number(a.sets) || 0), 0);
    const tail = total ? `\n  合计 ${total} 组。${t.tierDesc || ""}` : t.tierDesc || "";
    return `【${label}】\n${lines.join("\n") || "  （无动作）"}${tail}`;
  });

  return [
    head.join(" "),
    "",
    ...blocks,
    "",
    "三档自己挑一档。这版只在对话里给计划，不会自动写进练练 App；要做热身组与渐进的细节已含在上面。",
  ].join("\n");
}

/**
 * 小程序录入的判档值（2026-11-17）。
 *
 * 字段名与引擎 checkin JSON 不完全一样：深睡录的是**分钟**（引擎要的就是分钟），
 * 但知识库里存的是 `deep_sleep_pct`——换算只在「写回 md」那一步做，判档这一路不换算。
 * 体重/体脂**不参与判档**，只随请求带过来、由 kb-writer 写进记录，别让它们进引擎。
 */
export interface CheckinInput {
  sleep_hours?: number | string;
  deep_sleep_min?: number | string;
  resting_hr?: number | string;
  fatigue?: number | string;
  soreness?: number | string;
  soreness_part?: string;
  weight_kg?: number | string;
  body_fat_pct?: number | string;
}

/** 判档只用这 5 维；少于 2 维不下结论（一个数就敢判档比报错更危险）。 */
const CHECKIN_DIMS = ["sleep_hours", "deep_sleep_min", "resting_hr", "fatigue", "soreness"] as const;

function numOrNull(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 归一化外部录入：只留引擎认识的键，丢弃空值。 */
export function normalizeCheckin(input: CheckinInput | undefined): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!input) return out;
  for (const k of CHECKIN_DIMS) {
    const n = numOrNull(input[k]);
    if (n !== null) out[k] = n;
  }
  if (input.soreness_part) out.soreness_part = String(input.soreness_part).slice(0, 20);
  return out;
}

/** 调 checkin.py 拿当日状态（含深睡百分比→分钟的换算），不落任何文件。 */
async function readCheckin(date: string): Promise<Record<string, unknown>> {
  const root = kbRoot();
  if (!root) throw new Error("没配知识库路径（KB_DIRS / KB_DIR），读不到今天的健康记录");
  const { stdout } = await execFileAsync(
    "python3",
    [CHECKIN_PY, "--kb", root, "--date", date, "--json"],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
  );
  const ck = JSON.parse(stdout) as Record<string, unknown>;
  if (!ck || !Object.keys(ck).length) throw new Error("今天的健康记录还没有可判档的数据");
  return ck;
}

/**
 * 判档输入：**请求体优先，md 兜底**（2026-11-17）。
 *
 * 为什么必须改成这样：小程序录入的值如果还要先落 md 才能被判档，就等于
 * 「不写知识库就没法判档」，跟「录入就直接出三档」冲突。
 * 反过来，网页端/脚本不带 checkin 时应保持旧行为（读当天健康记录），否则一次改动
 * 会把已有的排计划入口全弄坏。
 */
async function resolveCheckin(date: string, override?: CheckinInput): Promise<Record<string, unknown>> {
  const given = normalizeCheckin(override);
  const dims = CHECKIN_DIMS.filter((k) => k in given).length;
  if (dims >= 2) return given;
  if (dims === 1) throw new Error("判档至少要两个维度：只填一个数给不出可信结论");
  return readCheckin(date);
}

/** 调排课引擎出三档。checkin 走系统临时目录——绝不写进代码仓。 */
async function runEngine(date: string, checkin: Record<string, unknown>): Promise<TierPlan[]> {
  const tmp = path.join(tmpdir(), `fit-plan-checkin-${process.pid}-${Date.now()}.json`);
  try {
    await fs.writeFile(tmp, JSON.stringify(checkin), "utf8");
    const { stdout } = await execFileAsync(
      "python3",
      [ENGINE_PY, "--profile", PROFILE_JSON, "--checkin", tmp, "--history", HISTORY_JSON,
       "--date", date, "--all-tiers", "--json"],
      { timeout: 40_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as TierPlan[] | TierPlan;
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

/**
 * 命中排计划意图就返回可直接用的 Plan（prompt=null，不过模型）。
 * 任何失败都返回带 reason 的 Plan，不回落检索——回落会答非所问（返回一段历史文字）。
 */
export async function tryPlanSession(
  question: string,
  opts: { checkin?: CheckinInput } = {}
): Promise<{ plan: Plan } | { error: string } | null> {
  if (!isPlanRequest(question)) return null;
  const t0 = Date.now();
  try {
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const checkin = await resolveCheckin(date, opts.checkin);
    const tiers = await runEngine(date, checkin);
    const bad = tiers.find((t) => t.error);
    if (bad) return { error: `排课引擎：${bad.error}` };
    const answer = renderTiers(tiers);
    const plan: Plan = {
      route: "plan" as Route,
      citations: [] as Citation[],
      k: 0,
      prompt: null,
      fixedAnswer: answer,
      planData: buildPlanData(tiers, date),
      retrieveMs: Date.now() - t0,
      numPredict: 0,
    };
    return { plan };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `排计划没成：${msg}` };
  }
}
